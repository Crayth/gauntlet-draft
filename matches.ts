import * as djs from "discord.js";
import type { DraftLeague } from "./draft_league.ts";
import { createNextRoundIfReady } from "./matchups.ts";

const MATCHUPS_SHEET = "Matchups";
const MATCHES_SHEET = "Matches";
const MATCHES_RANGE = `${MATCHES_SHEET}!A:E`;
const MATCHES_HEADERS = [
  "Winner",
  "Loser",
  "Result",
  "Pod ID",
  "Bot Handled",
];

export type MatchResult = "2-0" | "2-1";
export type ReportedScore = MatchResult | "0-2" | "1-2";

export type ReportResult =
  | { ok: true }
  | { ok: false; error: string };

const SCORE_PATTERN = /(?:2-0|2-1|0-2|1-2)/;

/**
 * Parses a reported score from the message. Either player may report;
 * 2-0/2-1 means the reporter won, 0-2/1-2 means the reporter lost.
 */
export function parseReportedScore(
  content: string,
): ReportedScore | null {
  const match = content.match(SCORE_PATTERN);
  if (!match) return null;
  const score = match[0];
  if (
    score === "2-0" || score === "2-1" || score === "0-2" || score === "1-2"
  ) {
    return score;
  }
  return null;
}

/**
 * Resolves winner, loser, and normalized result (always from winner's perspective).
 */
export function resolveMatchReport(
  reporterId: string,
  opponentId: string,
  reportedScore: ReportedScore,
): { winnerId: string; loserId: string; result: MatchResult } {
  if (reportedScore === "2-0" || reportedScore === "2-1") {
    return {
      winnerId: reporterId,
      loserId: opponentId,
      result: reportedScore,
    };
  }
  return {
    winnerId: opponentId,
    loserId: reporterId,
    result: reportedScore === "0-2" ? "2-0" : "2-1",
  };
}

/**
 * Finds the reporter's current open matchup in a pod.
 * Each player has at most one unreported match at a time (one per round).
 */
export async function findOpenMatchupForReporter(
  league: DraftLeague,
  podId: string,
  reporterId: string,
): Promise<
  | { ok: true; opponentId: string; round: number; matchNum: number }
  | { ok: false; error: string }
> {
  const response = await league.read(`${MATCHUPS_SHEET}!A2:G`);

  const podLower = podId.toLowerCase();
  const openMatches: {
    round: number;
    matchNum: number;
    opponentId: string;
  }[] = [];

  for (const row of response.values || []) {
    if (!row || row.length < 5) continue;

    const rowPodId = String(row[0] ?? "").trim();
    if (rowPodId.toLowerCase() !== podLower) continue;

    const winner = String(row[5] ?? "").trim();
    if (winner !== "") continue;

    const p1 = String(row[3] ?? "").trim();
    const p2 = String(row[4] ?? "").trim();
    const round = parseInt(String(row[1] ?? ""), 10);
    const matchNum = parseInt(String(row[2] ?? ""), 10);

    let opponentId: string | null = null;
    if (p1 === reporterId) opponentId = p2;
    else if (p2 === reporterId) opponentId = p1;

    if (!opponentId || isNaN(round) || isNaN(matchNum)) continue;

    openMatches.push({ round, matchNum, opponentId });
  }

  if (openMatches.length === 0) {
    return {
      ok: false,
      error:
        `You don't have an open matchup to report in pod \`${podId}\`. Use \`!status ${podId}\` to check progress.`,
    };
  }

  if (openMatches.length > 1) {
    return {
      ok: false,
      error:
        "Multiple open matchups found — tag your opponent to disambiguate.",
    };
  }

  const match = openMatches[0];
  return {
    ok: true,
    opponentId: match.opponentId,
    round: match.round,
    matchNum: match.matchNum,
  };
}

async function ensureMatchesHeaders(league: DraftLeague): Promise<void> {
  const response = await league.read(`${MATCHES_SHEET}!A1:E1`);
  const values = response.values;
  const hasHeaders = values &&
    values.length > 0 &&
    values[0] &&
    values[0].length > 0 &&
    String(values[0][0]).trim() === "Winner";

  if (!hasHeaders) {
    await league.write(`${MATCHES_SHEET}!A1:E1`, [MATCHES_HEADERS]);
  }
}

/**
 * Reports a match result: records to Matches sheet and updates Matchups sheet.
 * Validates that both players are in a valid matchup for the draft with no winner yet.
 */
export async function reportMatch(
  league: DraftLeague,
  podId: string,
  winnerId: string,
  loserId: string,
  result: MatchResult,
  pretend: boolean,
  client?: djs.Client,
): Promise<ReportResult> {
  if (winnerId === loserId) {
    return { ok: false, error: "Winner and loser must be different players." };
  }

  const response = await league.read(`${MATCHUPS_SHEET}!A2:G`);

  const podLower = podId.toLowerCase();
  const values = (response.values || []).map((row) => row ? [...row] : row);
  let matchRowIndex: number | null = null;

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row || row.length < 5) continue;

    const rowPodId = String(row[0] ?? "").trim();
    const p1 = String(row[3] ?? "").trim();
    const p2 = String(row[4] ?? "").trim();
    const winner = String(row[5] ?? "").trim();

    if (rowPodId.toLowerCase() !== podLower) continue;
    if (winner !== "") continue;

    const pair = new Set([p1, p2]);
    const reported = new Set([winnerId, loserId]);
    if (
      pair.size === reported.size && [...pair].every((id) => reported.has(id))
    ) {
      matchRowIndex = i;
      break;
    }
  }

  if (matchRowIndex === null) {
    return {
      ok: false,
      error:
        "No valid matchup found. Both players must be paired in a matchup for this pod that hasn't been reported yet.",
    };
  }

  if (pretend) {
    return { ok: true };
  }

  await ensureMatchesHeaders(league);

  await league.append(
    MATCHES_RANGE,
    [[winnerId, loserId, result, podId, "Yes"]],
  );

  const sheetRow = matchRowIndex + 2;
  await league.write(
    `${MATCHUPS_SHEET}!F${sheetRow}:G${sheetRow}`,
    [[winnerId, result]],
  );

  const updatedRow = values[matchRowIndex];
  if (updatedRow) {
    updatedRow[5] = winnerId;
    updatedRow[6] = result;
  }

  await createNextRoundIfReady(league, podId, pretend, client, values);

  return { ok: true };
}
