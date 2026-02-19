import * as djs from "discord.js";
import { CONFIG } from "./config.ts";
import { sheets, sheetsAppend, sheetsRead, sheetsWrite } from "./sheets.ts";

const MATCHUPS_SHEET = "Matchups";
const MATCHUPS_RANGE = `${MATCHUPS_SHEET}!A:G`;
const MATCHUPS_HEADERS = [
  "Draft Name",
  "Round",
  "Match #",
  "Player 1",
  "Player 2",
  "Winner",
  "Match Result",
];

/**
 * Fisher-Yates shuffle for randomizing array order.
 */
function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Ensures the Matchups sheet has headers.
 */
async function ensureMatchupsHeaders(): Promise<void> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${MATCHUPS_SHEET}!A1:G1`,
    "UNFORMATTED_VALUE",
  );
  const values = response.values;
  const hasHeaders = values &&
    values.length > 0 &&
    values[0] &&
    values[0].length > 0 &&
    String(values[0][0]).trim() === "Draft Name";

  if (!hasHeaders) {
    await sheetsWrite(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `${MATCHUPS_SHEET}!A1:G1`,
      [MATCHUPS_HEADERS],
    );
  }
}

/**
 * Creates Round 1 matchups (4 matches) for an 8-player draft.
 * Randomizes the pairings: Match 1 = P1 vs P2, Match 2 = P3 vs P4, etc.
 * Player 1 and Player 2 store Discord IDs for linking to Draft Log and Matches.
 *
 * @param draftName - The name of the draft
 * @param userIds - The 8 Discord user IDs (will be randomized and paired)
 * @param pretend - If true, only logs what would be done
 * @param client - Discord client for sending round announcement (optional)
 */
export async function createRound1Matchups(
  draftName: string,
  userIds: readonly string[],
  pretend: boolean,
  client?: djs.Client,
): Promise<void> {
  if (userIds.length !== 8) {
    console.error(
      `createRound1Matchups requires 8 players, got ${userIds.length}`,
    );
    return;
  }

  if (pretend) {
    console.log(
      `[PRETEND] Would create Round 1 matchups for draft "${draftName}"`,
    );
    return;
  }

  await ensureMatchupsHeaders();

  const shuffled = shuffleArray(Array.from(userIds));

  const rows: (string | number)[][] = [];
  for (let i = 0; i < 4; i++) {
    const p1 = shuffled[i * 2];
    const p2 = shuffled[i * 2 + 1];
    rows.push([
      draftName,
      1,
      i + 1,
      p1,
      p2,
      "", // Winner - filled when match is reported
      "", // Match Result - filled when match is reported
    ]);
  }

  await sheetsAppend(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    MATCHUPS_RANGE,
    rows,
  );

  console.log(
    `Created Round 1 matchups (4 matches) for draft "${draftName}"`,
  );

  if (client) {
    await sendRoundAnnouncement(client, draftName, 1, rows);
  }
}

/** Match row: [Draft Name, Round, Match #, Player 1, Player 2, Winner, Match Result] */
interface MatchupRow {
  draftName: string;
  round: number;
  matchNum: number;
  p1: string;
  p2: string;
  winner: string;
  result: string;
}

function parseMatchupRow(row: unknown[]): MatchupRow | null {
  if (!row || row.length < 7) return null;
  const round = parseInt(String(row[1] ?? ""), 10);
  const matchNum = parseInt(String(row[2] ?? ""), 10);
  if (isNaN(round) || isNaN(matchNum)) return null;
  return {
    draftName: String(row[0] ?? "").trim(),
    round,
    matchNum,
    p1: String(row[3] ?? "").trim(),
    p2: String(row[4] ?? "").trim(),
    winner: String(row[5] ?? "").trim(),
    result: String(row[6] ?? "").trim(),
  };
}

export interface MatchStatus {
  matchNum: number;
  p1: string;
  p2: string;
  completed: boolean;
  winner?: string;
  result?: string; // "2-0" or "2-1"
}

export type DraftStatusResult =
  | { ok: true; round: number; matches: MatchStatus[] }
  | { ok: true; complete: true }
  | { ok: false; error: string };

/**
 * Gets the current round and match status for a draft.
 */
export async function getDraftStatus(
  draftName: string,
): Promise<DraftStatusResult> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${MATCHUPS_SHEET}!A2:G`,
    "UNFORMATTED_VALUE",
  );

  const draftLower = draftName.toLowerCase();
  const values = response.values || [];
  const rows: MatchupRow[] = [];
  for (let i = 0; i < values.length; i++) {
    const parsed = parseMatchupRow(values[i]);
    console.log(parsed);
    if (parsed && parsed.draftName.toLowerCase() === draftLower) {
      rows.push(parsed);
    }
  }

  if (rows.length === 0) {
    return {
      ok: false,
      error: `No matchups found for draft \`${draftName}\`.`,
    };
  }

  const r1 = rows.filter((r) => r.round === 1);
  const r2 = rows.filter((r) => r.round === 2);
  const r3 = rows.filter((r) => r.round === 3);

  const r1Complete = r1.length === 4 && r1.every((r) => r.winner !== "");
  const r2Complete = r2.length === 4 && r2.every((r) => r.winner !== "");
  const r3Complete = r3.length === 4 && r3.every((r) => r.winner !== "");

  if (r3Complete) {
    return { ok: true, complete: true };
  }

  if (r2Complete && r3.length > 0) {
    const matches: MatchStatus[] = r3.map((r) => ({
      matchNum: r.matchNum,
      p1: r.p1,
      p2: r.p2,
      completed: r.winner !== "",
      winner: r.winner || undefined,
      result: r.result || undefined,
    }));
    return { ok: true, round: 3, matches };
  }

  if (r1Complete && r2.length > 0) {
    const matches: MatchStatus[] = r2.map((r) => ({
      matchNum: r.matchNum,
      p1: r.p1,
      p2: r.p2,
      completed: r.winner !== "",
      winner: r.winner || undefined,
      result: r.result || undefined,
    }));
    return { ok: true, round: 2, matches };
  }

  const matches: MatchStatus[] = r1.map((r) => ({
    matchNum: r.matchNum,
    p1: r.p1,
    p2: r.p2,
    completed: r.winner !== "",
    winner: r.winner || undefined,
    result: r.result || undefined,
  }));
  return { ok: true, round: 1, matches };
}

function getLoser(row: MatchupRow): string {
  return row.winner === row.p1 ? row.p2 : row.p1;
}

/**
 * Creates Round 2 matchups (matches 5-8) from Round 1 results.
 * Match 5: W1 vs W2, Match 6: W3 vs W4, Match 7: L1 vs L2, Match 8: L3 vs L4
 */
function buildRound2Rows(
  draftName: string,
  r1: MatchupRow[],
): (string | number)[][] {
  const m1 = r1.find((r) => r.matchNum === 1)!;
  const m2 = r1.find((r) => r.matchNum === 2)!;
  const m3 = r1.find((r) => r.matchNum === 3)!;
  const m4 = r1.find((r) => r.matchNum === 4)!;

  const w1 = m1.winner,
    w2 = m2.winner,
    w3 = m3.winner,
    w4 = m4.winner;
  const l1 = getLoser(m1),
    l2 = getLoser(m2),
    l3 = getLoser(m3),
    l4 = getLoser(m4);

  return [
    [draftName, 2, 5, w1, w2, "", ""],
    [draftName, 2, 6, w3, w4, "", ""],
    [draftName, 2, 7, l1, l2, "", ""],
    [draftName, 2, 8, l3, l4, "", ""],
  ];
}

/**
 * Creates Round 3 matchups (matches 9-12) from Round 2 results.
 * Match 9: W5 vs W6, Match 10: W7 vs W8, Match 11: L5 vs L6, Match 12: L7 vs L8
 */
function buildRound3Rows(
  draftName: string,
  r2: MatchupRow[],
): (string | number)[][] {
  const m5 = r2.find((r) => r.matchNum === 5)!;
  const m6 = r2.find((r) => r.matchNum === 6)!;
  const m7 = r2.find((r) => r.matchNum === 7)!;
  const m8 = r2.find((r) => r.matchNum === 8)!;

  const w5 = m5.winner,
    w6 = m6.winner,
    w7 = m7.winner,
    w8 = m8.winner;
  const l5 = getLoser(m5),
    l6 = getLoser(m6),
    l7 = getLoser(m7),
    l8 = getLoser(m8);

  return [
    [draftName, 3, 9, w5, w6, "", ""],
    [draftName, 3, 10, w7, w8, "", ""],
    [draftName, 3, 11, l5, l6, "", ""],
    [draftName, 3, 12, l7, l8, "", ""],
  ];
}

/**
 * Sends an announcement of round matchups to the matchmaking channel.
 */
async function sendRoundAnnouncement(
  client: djs.Client,
  draftName: string,
  round: number,
  rows: (string | number)[][],
): Promise<void> {
  if (!CONFIG.MATCHMAKING_CHANNEL_ID) return;
  try {
    const channel = await client.channels.fetch(CONFIG.MATCHMAKING_CHANNEL_ID);
    if (!channel?.isTextBased() || channel.isDMBased()) return;

    const lines = rows.map(
      (r) => `Match ${r[2]}: <@${r[3]}> vs <@${r[4]}>`,
    );
    const message = `**Round ${round} matchups for \`${draftName}\`:**\n${
      lines.join("\n")
    }`;
    await channel.send(message);
  } catch (error) {
    console.error("Failed to send round announcement:", error);
  }
}

/**
 * If the previous round for this draft is complete, creates the next round's matchups.
 * Call after a match is reported.
 *
 * @param draftName - The draft name
 * @param pretend - If true, only checks, does not write
 * @param client - Discord client for sending round announcement (optional)
 * @returns true if a new round was created
 */
export async function createNextRoundIfReady(
  draftName: string,
  pretend: boolean,
  client?: djs.Client,
): Promise<boolean> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${MATCHUPS_SHEET}!A2:G`,
    "UNFORMATTED_VALUE",
  );

  const draftLower = draftName.toLowerCase();
  const values = response.values || [];
  const rows: MatchupRow[] = [];
  for (let i = 0; i < values.length; i++) {
    const parsed = parseMatchupRow(values[i]);
    if (parsed && parsed.draftName.toLowerCase() === draftLower) {
      rows.push(parsed);
    }
  }

  const r1 = rows.filter((r) => r.round === 1);
  const r2 = rows.filter((r) => r.round === 2);
  const r3 = rows.filter((r) => r.round === 3);

  const r1Complete = r1.length === 4 && r1.every((r) => r.winner !== "");
  const r2Complete = r2.length === 4 && r2.every((r) => r.winner !== "");

  if (r1Complete && r2.length === 0) {
    if (pretend) {
      console.log(
        `[PRETEND] Would create Round 2 matchups for draft "${draftName}"`,
      );
      return true;
    }
    await ensureMatchupsHeaders();
    const round2Rows = buildRound2Rows(draftName, r1);
    await sheetsAppend(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      MATCHUPS_RANGE,
      round2Rows,
    );
    console.log(
      `Created Round 2 matchups (4 matches) for draft "${draftName}"`,
    );
    if (client) {
      await sendRoundAnnouncement(client, draftName, 2, round2Rows);
    }
    return true;
  }

  if (r2Complete && r3.length === 0) {
    if (pretend) {
      console.log(
        `[PRETEND] Would create Round 3 matchups for draft "${draftName}"`,
      );
      return true;
    }
    await ensureMatchupsHeaders();
    const round3Rows = buildRound3Rows(draftName, r2);
    await sheetsAppend(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      MATCHUPS_RANGE,
      round3Rows,
    );
    console.log(
      `Created Round 3 matchups (4 matches) for draft "${draftName}"`,
    );
    if (client) {
      await sendRoundAnnouncement(client, draftName, 3, round3Rows);
    }
    return true;
  }

  return false;
}
