/**
 * Simulates a full 8-player pod lifecycle against the live Google Sheet:
 * pod fire → round 1–3 match reports → Pod Results + Leaderboard writes.
 *
 * Usage:
 *   deno task simulate-pod
 *   deno task simulate-pod -- --pretend
 */

import { delay } from "@std/async";
import { parseArgs } from "@std/cli/parse-args";
import { load } from "@std/dotenv";
import * as djs from "discord.js";
import { CONFIG } from "./config.ts";
import { generatePodId, recordDraftToLog } from "./draft_log.ts";
import { computePodStandings } from "./leaderboard.ts";
import { createRound1Matchups } from "./matchups.ts";
import { reportMatch } from "./matches.ts";
import { ensurePlayerInDatabase } from "./player_database.ts";
import { initSheets, sheets, sheetsRead } from "./sheets.ts";

await load({ export: true });

const args = parseArgs(Deno.args, {
  boolean: ["pretend", "help"],
  default: { pretend: false, help: false },
});

if (args.help) {
  console.log(
    `Simulate a full pod through match reporting and leaderboard updates.

Usage:
  deno task simulate-pod
  deno task simulate-pod -- --pretend

Options:
  --pretend  Log actions only for pod fire; match reporting requires real writes
  --help     Show this help message

Requires Google Application Default Credentials and sheet tabs:
  Draft Log, Matchups, Matches, Pod Results, Raw Data Leaderboard, Qualified Leaderboard
`,
  );
  Deno.exit(0);
}

const pretend = args.pretend;

/** Fake players — IDs are synthetic snowflakes for simulation only. */
const SIM_PLAYERS = [
  { id: "900000000000000001", name: "Sim Alice" },
  { id: "900000000000000002", name: "Sim Bob" },
  { id: "900000000000000003", name: "Sim Carol" },
  { id: "900000000000000004", name: "Sim Dave" },
  { id: "900000000000000005", name: "Sim Eve" },
  { id: "900000000000000006", name: "Sim Frank" },
  { id: "900000000000000007", name: "Sim Grace" },
  { id: "900000000000000008", name: "Sim Henry" },
] as const;

const nameById = new Map<string, string>(
  SIM_PLAYERS.map((p) => [p.id, p.name]),
);

const stubClient = {
  users: {
    fetch: async (id: string) => ({
      username: nameById.get(id) ?? `Unknown (${id})`,
    }),
  },
} as unknown as djs.Client;

interface OpenMatch {
  matchNum: number;
  p1: string;
  p2: string;
}

async function getOpenMatches(podId: string): Promise<OpenMatch[]> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    "Matchups!A2:G",
    "UNFORMATTED_VALUE",
  );

  const podLower = podId.toLowerCase();
  const open: OpenMatch[] = [];

  for (const row of response.values ?? []) {
    if (!row || row.length < 5) continue;
    if (String(row[0] ?? "").trim().toLowerCase() !== podLower) continue;
    if (String(row[5] ?? "").trim() !== "") continue;

    const matchNum = parseInt(String(row[2] ?? ""), 10);
    if (isNaN(matchNum)) continue;

    open.push({
      matchNum,
      p1: String(row[3] ?? "").trim(),
      p2: String(row[4] ?? "").trim(),
    });
  }

  return open.sort((a, b) => a.matchNum - b.matchNum);
}

async function reportAllOpenMatches(
  podId: string,
  roundLabel: string,
): Promise<number> {
  const matches = await getOpenMatches(podId);
  if (matches.length === 0) {
    console.log(`  No open matches for ${roundLabel}`);
    return 0;
  }

  console.log(`\n${roundLabel} — reporting ${matches.length} match(es):`);

  for (const match of matches) {
    const winner = match.p1;
    const loser = match.p2;
    const result = await reportMatch(podId, winner, loser, "2-0", false);
    if (!result.ok) {
      throw new Error(`Match ${match.matchNum} failed: ${result.error}`);
    }
    console.log(
      `  Match ${match.matchNum}: ${nameById.get(winner) ?? winner} beat ${
        nameById.get(loser) ?? loser
      } 2-0`,
    );
    await delay(500);
  }

  return matches.length;
}

async function printPodResults(podId: string): Promise<void> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    "Pod Results!A2:E",
    "UNFORMATTED_VALUE",
  );

  const podLower = podId.toLowerCase();
  const rows = (response.values ?? []).filter(
    (row) =>
      row &&
      row.length >= 5 &&
      String(row[0] ?? "").trim().toLowerCase() === podLower,
  );

  console.log(`\nPod Results for ${podId}:`);
  if (rows.length === 0) {
    console.log("  (no rows found)");
    return;
  }

  for (const row of rows) {
    console.log(
      `  ${row[1]}: ${row[3]} wins, place ${row[4]}`,
    );
  }
}

async function printLeaderboards(): Promise<void> {
  for (const sheetName of ["Raw Data Leaderboard", "Qualified Leaderboard"]) {
    const response = await sheetsRead(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `'${sheetName}'!A2:E`,
      "UNFORMATTED_VALUE",
    );

    console.log(`\n${sheetName}:`);
    const rows = response.values ?? [];
    if (rows.length === 0 || rows.every((row) => !row || !row[0])) {
      console.log("  (empty)");
      continue;
    }

    for (const row of rows) {
      if (!row || !row[0]) continue;
      console.log(
        `  #${row[0]} ${row[1]} — ${row[3]} pod(s), avg wins ${row[4]}`,
      );
    }
  }
}

console.log("Initializing Google Sheets...");
await initSheets();
console.log(`Sheet: ${CONFIG.LIVE_SHEET_ID}`);
console.log(`Mode: ${pretend ? "pretend (partial)" : "live writes"}`);

if (pretend) {
  console.log(
    "\n--pretend only dry-runs pod fire. Run without --pretend for full simulation.",
  );
}

console.log("\n1. Registering sim players in Player Database...");
for (const player of SIM_PLAYERS) {
  await ensurePlayerInDatabase(player.name, player.id, pretend);
}

console.log("\n2. Generating pod ID...");
const podId = await generatePodId(pretend);
console.log(`   Pod ID: ${podId}`);

console.log("\n3. Firing pod (Draft Log + Round 1 matchups)...");
const userIds = SIM_PLAYERS.map((p) => p.id);
await recordDraftToLog(podId, userIds, stubClient, pretend);
const seatOrder = await createRound1Matchups(podId, userIds, pretend);
console.log(
  `   Round 1 created. Seat order: ${
    seatOrder.map((id, i) => `${i + 1}. ${nameById.get(id) ?? id}`).join(", ")
  }`,
);

if (pretend) {
  console.log("\nStopping after pretend pod fire. Re-run without --pretend.");
  Deno.exit(0);
}

console.log("\n4. Reporting Round 1...");
await reportAllOpenMatches(podId, "Round 1");

console.log("\n5. Reporting Round 2...");
await reportAllOpenMatches(podId, "Round 2");

console.log("\n6. Reporting Round 3 (triggers Pod Results + Leaderboard)...");
const r3Count = await reportAllOpenMatches(podId, "Round 3");
if (r3Count !== 4) {
  console.warn(`  Expected 4 round-3 matches, reported ${r3Count}`);
}

// Show computed standings from match data for verification
const allMatchRows = await sheetsRead(
  sheets,
  CONFIG.LIVE_SHEET_ID,
  "Matchups!A2:G",
  "UNFORMATTED_VALUE",
);
const podLower = podId.toLowerCase();
const podRows = (allMatchRows.values ?? [])
  .filter((row) =>
    row && String(row[0] ?? "").trim().toLowerCase() === podLower
  )
  .map((row) => ({
    p1: String(row![3] ?? "").trim(),
    p2: String(row![4] ?? "").trim(),
    winner: String(row![5] ?? "").trim(),
  }));

const standings = computePodStandings(podRows);
console.log("\nComputed final standings:");
for (const s of standings) {
  console.log(
    `  ${s.place}. ${nameById.get(s.userId) ?? s.userId} — ${s.wins} wins`,
  );
}

await printPodResults(podId);
await printLeaderboards();

console.log("\nSimulation complete.");
