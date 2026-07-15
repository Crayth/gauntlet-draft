import * as djs from "discord.js";
import { CONFIG } from "./config.ts";
import { getPlayerNamesForPod } from "./draft_log.ts";
import { getPlayerName } from "./player_database.ts";
import { sheets, sheetsAppend, sheetsRead, sheetsWrite } from "./sheets.ts";

const POD_RESULTS_SHEET = "Pod Results";
const POD_RESULTS_RANGE = `${POD_RESULTS_SHEET}!A:E`;
const POD_RESULTS_HEADERS = [
  "Pod ID",
  "Player Name",
  "Discord ID",
  "Wins",
  "Place",
];

const RAW_DATA_LEADERBOARD_SHEET = "Raw Data Leaderboard";
const QUALIFIED_LEADERBOARD_SHEET = "Qualified Leaderboard";
const headersReady = new Set<string>();
/** Best N pod win totals used for the Qualified Leaderboard primary average. */
const LEADERBOARD_BEST_PODS = 3;
/** Minimum completed pods required for the Qualified Leaderboard. */
const LEADERBOARD_MIN_PODS_TO_QUALIFY = 3;
const LEADERBOARD_HEADERS = [
  "Rank",
  "Player Name",
  "Discord ID",
  "Pods Played",
  "Average Wins",
];
const QUALIFIED_LEADERBOARD_HEADERS = [
  ...LEADERBOARD_HEADERS,
  "Average Wins (4)",
  "Average Wins (5)",
  "Games Won",
];
const MATCHES_SHEET = "Matches";

export interface PodStanding {
  readonly userId: string;
  readonly wins: number;
  readonly place: number;
}

interface MatchOutcomeRow {
  readonly p1: string;
  readonly p2: string;
  readonly winner: string;
}

interface LeaderboardEntry {
  discordId: string;
  name: string;
  podsPlayed: number;
  averageWins: number;
  averageWins4?: number;
  averageWins5?: number;
  gamesWon?: number;
}

/**
 * Computes final pod standings from all match rows: wins descending,
 * competition-ranking places (ties share a place, next place skips).
 */
export function computePodStandings(
  rows: readonly MatchOutcomeRow[],
): PodStanding[] {
  const winCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.p1) winCounts.set(row.p1, winCounts.get(row.p1) ?? 0);
    if (row.p2) winCounts.set(row.p2, winCounts.get(row.p2) ?? 0);
    if (row.winner) {
      winCounts.set(row.winner, (winCounts.get(row.winner) ?? 0) + 1);
    }
  }

  const sorted = [...winCounts.entries()].sort((a, b) => b[1] - a[1]);
  const standings: PodStanding[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const [userId, wins] = sorted[i];
    const place = i === 0 || wins < sorted[i - 1][1]
      ? i + 1
      : standings[i - 1].place;
    standings.push({ userId, wins, place });
  }
  return standings;
}

async function ensurePodResultsHeaders(): Promise<void> {
  if (headersReady.has(POD_RESULTS_SHEET)) return;

  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${POD_RESULTS_SHEET}!A1:E1`,
    "UNFORMATTED_VALUE",
  );
  const values = response.values;
  const hasHeaders = values &&
    values.length > 0 &&
    values[0] &&
    values[0].length > 0 &&
    String(values[0][0]).trim() === "Pod ID";

  if (!hasHeaders) {
    await sheetsWrite(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `${POD_RESULTS_SHEET}!A1:E1`,
      [POD_RESULTS_HEADERS],
    );
  }
  headersReady.add(POD_RESULTS_SHEET);
}

function leaderboardHeadersForSheet(sheetName: string): readonly string[] {
  return sheetName === QUALIFIED_LEADERBOARD_SHEET
    ? QUALIFIED_LEADERBOARD_HEADERS
    : LEADERBOARD_HEADERS;
}

function leaderboardLastColumn(sheetName: string): string {
  return sheetName === QUALIFIED_LEADERBOARD_SHEET ? "H" : "E";
}

/**
 * Parses a winner-perspective result ("2-0" / "2-1") into game wins for each side.
 */
function gamesFromMatchResult(
  result: string,
): { winnerGames: number; loserGames: number } | null {
  const parts = result.split("-").map((part) => parseInt(part, 10));
  if (parts.length !== 2 || parts.some((n) => isNaN(n))) return null;
  return { winnerGames: parts[0], loserGames: parts[1] };
}

/**
 * Tallies individual games won per player from the Matches sheet, limited to
 * completed pods (those present in Pod Results).
 */
async function loadGamesWonByPlayer(
  completedPodIds: ReadonlySet<string>,
): Promise<Map<string, number>> {
  const gamesWonByPlayer = new Map<string, number>();
  if (completedPodIds.size === 0) return gamesWonByPlayer;

  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${MATCHES_SHEET}!A2:D`,
    "UNFORMATTED_VALUE",
  );

  for (const row of response.values || []) {
    if (!row || row.length < 4) continue;
    const winnerId = String(row[0] ?? "").trim();
    const loserId = String(row[1] ?? "").trim();
    const result = String(row[2] ?? "").trim();
    const podId = String(row[3] ?? "").trim().toLowerCase();
    if (!winnerId || !loserId || !podId || !completedPodIds.has(podId)) {
      continue;
    }

    const games = gamesFromMatchResult(result);
    if (!games) continue;

    gamesWonByPlayer.set(
      winnerId,
      (gamesWonByPlayer.get(winnerId) ?? 0) + games.winnerGames,
    );
    gamesWonByPlayer.set(
      loserId,
      (gamesWonByPlayer.get(loserId) ?? 0) + games.loserGames,
    );
  }

  return gamesWonByPlayer;
}

async function ensureLeaderboardHeaders(sheetName: string): Promise<void> {
  if (headersReady.has(sheetName)) return;

  const headers = leaderboardHeadersForSheet(sheetName);
  const lastColumn = leaderboardLastColumn(sheetName);
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `'${sheetName}'!A1:${lastColumn}1`,
    "UNFORMATTED_VALUE",
  );
  const values = response.values;
  const row = values?.[0] ?? [];
  const hasHeaders = row.length > 0 &&
    headers.every((header, index) => String(row[index] ?? "").trim() === header);

  if (!hasHeaders) {
    await sheetsWrite(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `'${sheetName}'!A1:${lastColumn}1`,
      [[...headers]],
    );
  }
  headersReady.add(sheetName);
}

async function podResultsExist(podId: string): Promise<boolean> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${POD_RESULTS_SHEET}!A2:A`,
    "UNFORMATTED_VALUE",
  );
  const podLower = podId.toLowerCase();
  for (const row of response.values || []) {
    if (
      row && row.length > 0 &&
      String(row[0] ?? "").trim().toLowerCase() === podLower
    ) {
      return true;
    }
  }
  return false;
}

async function resolvePlayerName(
  userId: string,
  _podId: string,
  draftLogNames: ReadonlyMap<string, string>,
  client?: djs.Client,
): Promise<string> {
  const fromDraftLog = draftLogNames.get(userId);
  if (fromDraftLog) return fromDraftLog;

  const fromDatabase = await getPlayerName(userId);
  if (fromDatabase) return fromDatabase;

  if (client) {
    try {
      const user = await client.users.fetch(userId);
      return user.username;
    } catch {
      // fall through
    }
  }
  return "Unknown";
}

function averageWinsForPods(
  winsByPod: readonly number[],
  bestPods?: number,
): number {
  const wins = bestPods != null
    ? [...winsByPod].sort((a, b) => b - a).slice(0, bestPods)
    : winsByPod;
  if (wins.length === 0) return 0;
  return wins.reduce((sum, w) => sum + w, 0) / wins.length;
}

function roundAverage(value: number): number {
  return Math.round(value * 100) / 100;
}

function computeLeaderboardEntries(
  aggregates: Map<string, { name: string; winsByPod: number[] }>,
  bestPods?: number,
): LeaderboardEntry[] {
  return [...aggregates.entries()]
    .map(([discordId, agg]) => ({
      discordId,
      name: agg.name,
      podsPlayed: agg.winsByPod.length,
      averageWins: averageWinsForPods(agg.winsByPod, bestPods),
    }))
    .sort((a, b) => b.averageWins - a.averageWins);
}

function computeQualifiedLeaderboardEntries(
  aggregates: Map<string, { name: string; winsByPod: number[] }>,
  gamesWonByPlayer: ReadonlyMap<string, number>,
): LeaderboardEntry[] {
  return [...aggregates.entries()]
    .map(([discordId, agg]) => ({
      discordId,
      name: agg.name,
      podsPlayed: agg.winsByPod.length,
      averageWins: averageWinsForPods(agg.winsByPod, LEADERBOARD_BEST_PODS),
      averageWins4: averageWinsForPods(agg.winsByPod, 4),
      averageWins5: averageWinsForPods(agg.winsByPod, 5),
      gamesWon: gamesWonByPlayer.get(discordId) ?? 0,
    }))
    .filter((entry) => entry.podsPlayed >= LEADERBOARD_MIN_PODS_TO_QUALIFY)
    .sort((a, b) => b.averageWins - a.averageWins);
}

function leaderboardRowForEntry(
  entry: LeaderboardEntry,
  index: number,
  sheetName: string,
): (string | number)[] {
  const row: (string | number)[] = [
    index + 1,
    entry.name,
    entry.discordId,
    entry.podsPlayed,
    roundAverage(entry.averageWins),
  ];
  if (sheetName === QUALIFIED_LEADERBOARD_SHEET) {
    row.push(
      roundAverage(entry.averageWins4!),
      roundAverage(entry.averageWins5!),
      entry.gamesWon ?? 0,
    );
  }
  return row;
}

function emptyLeaderboardRow(sheetName: string): string[] {
  const columnCount = leaderboardHeadersForSheet(sheetName).length;
  return Array.from({ length: columnCount }, () => "");
}

async function writeLeaderboardSheet(
  sheetName: string,
  entries: readonly LeaderboardEntry[],
): Promise<void> {
  await ensureLeaderboardHeaders(sheetName);

  const lastColumn = leaderboardLastColumn(sheetName);
  const existing = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `'${sheetName}'!A2:${lastColumn}`,
    "UNFORMATTED_VALUE",
  );
  const previousRowCount = existing.values?.length ?? 0;

  const leaderboardRows: (string | number)[][] = entries.map((entry, index) =>
    leaderboardRowForEntry(entry, index, sheetName)
  );

  if (leaderboardRows.length === 0) {
    if (previousRowCount > 0) {
      await sheetsWrite(
        sheets,
        CONFIG.LIVE_SHEET_ID,
        `'${sheetName}'!A2:${lastColumn}${previousRowCount + 1}`,
        Array.from({ length: previousRowCount }, () =>
          emptyLeaderboardRow(sheetName)
        ),
      );
    }
    return;
  }

  await sheetsWrite(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `'${sheetName}'!A2:${lastColumn}${leaderboardRows.length + 1}`,
    leaderboardRows,
  );

  if (previousRowCount > leaderboardRows.length) {
    const clearCount = previousRowCount - leaderboardRows.length;
    await sheetsWrite(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `'${sheetName}'!A${leaderboardRows.length + 2}:${lastColumn}${
        leaderboardRows.length + 1 + clearCount
      }`,
      Array.from({ length: clearCount }, () => emptyLeaderboardRow(sheetName)),
    );
  }
}

/**
 * Records per-player pod results and rebuilds the leaderboard sheets.
 * Called when all three rounds for a pod are complete.
 */
export async function recordPodResultsAndUpdateLeaderboard(
  podId: string,
  rows: readonly MatchOutcomeRow[],
  pretend: boolean,
  client?: djs.Client,
): Promise<void> {
  const standings = computePodStandings(rows);

  if (pretend) {
    console.log(
      `[PRETEND] Would record pod results for "${podId}" and rebuild leaderboards`,
    );
    for (const s of standings) {
      console.log(`  ${s.userId}: ${s.wins} wins, place ${s.place}`);
    }
    return;
  }

  if (await podResultsExist(podId)) {
    console.log(`Pod results for "${podId}" already recorded, skipping`);
    return;
  }

  await ensurePodResultsHeaders();

  const draftLogNames = await getPlayerNamesForPod(podId);

  const resultRows: (string | number)[][] = [];
  for (const standing of standings) {
    const playerName = await resolvePlayerName(
      standing.userId,
      podId,
      draftLogNames,
      client,
    );
    resultRows.push([
      podId,
      playerName,
      standing.userId,
      standing.wins,
      standing.place,
    ]);
  }

  await sheetsAppend(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    POD_RESULTS_RANGE,
    resultRows,
  );

  console.log(
    `Recorded ${resultRows.length} pod result rows for "${podId}"`,
  );

  await rebuildLeaderboard();
}

/**
 * Rebuilds leaderboard sheets from all Pod Results rows (and Matches for
 * games-won totals).
 * Raw Data Leaderboard: all players ranked by average wins across every pod.
 * Qualified Leaderboard: players with at least 3 completed pods, ranked by
 * best-3 average wins, with best-4/best-5 averages and total games won.
 */
export async function rebuildLeaderboard(): Promise<void> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${POD_RESULTS_SHEET}!A2:E`,
    "UNFORMATTED_VALUE",
  );

  const aggregates = new Map<
    string,
    { name: string; winsByPod: number[] }
  >();
  const completedPodIds = new Set<string>();

  for (const row of response.values || []) {
    if (!row || row.length < 4) continue;
    const podId = String(row[0] ?? "").trim().toLowerCase();
    const playerName = String(row[1] ?? "").trim();
    const discordId = String(row[2] ?? "").trim();
    const wins = parseInt(String(row[3] ?? ""), 10);
    if (!discordId || isNaN(wins)) continue;
    if (podId) completedPodIds.add(podId);

    const existing = aggregates.get(discordId);
    if (existing) {
      existing.winsByPod.push(wins);
      if (playerName && existing.name === "Unknown") {
        existing.name = playerName;
      }
    } else {
      aggregates.set(discordId, {
        name: playerName || "Unknown",
        winsByPod: [wins],
      });
    }
  }

  const gamesWonByPlayer = await loadGamesWonByPlayer(completedPodIds);
  const allEntries = computeLeaderboardEntries(aggregates);
  const qualifiedEntries = computeQualifiedLeaderboardEntries(
    aggregates,
    gamesWonByPlayer,
  );

  await writeLeaderboardSheet(RAW_DATA_LEADERBOARD_SHEET, allEntries);
  await writeLeaderboardSheet(QUALIFIED_LEADERBOARD_SHEET, qualifiedEntries);

  console.log(
    `Rebuilt leaderboards: ${allEntries.length} raw, ${qualifiedEntries.length} qualified`,
  );
}
