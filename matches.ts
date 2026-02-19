import * as djs from "discord.js";
import { CONFIG } from "./config.ts";
import { createNextRoundIfReady } from "./matchups.ts";
import { sheets, sheetsAppend, sheetsRead, sheetsWrite } from "./sheets.ts";

const MATCHUPS_SHEET = "Matchups";
const MATCHES_SHEET = "Matches";
const MATCHES_RANGE = `${MATCHES_SHEET}!A:E`;
const MATCHES_HEADERS = [
  "Winner",
  "Loser",
  "Result",
  "Draft Name",
  "Bot Handled",
];

export type ReportResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Ensures the Matches sheet has headers.
 */
async function ensureMatchesHeaders(): Promise<void> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${MATCHES_SHEET}!A1:E1`,
    "UNFORMATTED_VALUE",
  );
  const values = response.values;
  const hasHeaders = values &&
    values.length > 0 &&
    values[0] &&
    values[0].length > 0 &&
    String(values[0][0]).trim() === "Winner";

  if (!hasHeaders) {
    await sheetsWrite(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `${MATCHES_SHEET}!A1:E1`,
      [MATCHES_HEADERS],
    );
  }
}

/**
 * Reports a match result: records to Matches sheet and updates Matchups sheet.
 * Validates that both players are in a valid matchup for the draft with no winner yet.
 *
 * @param draftName - The draft name being reported for
 * @param winnerId - Discord ID of the winner (message sender)
 * @param loserId - Discord ID of the loser (tagged player)
 * @param result - "2-0" or "2-1"
 * @param pretend - If true, only validates, does not write
 * @returns ReportResult indicating success or error
 */
export async function reportMatch(
  draftName: string,
  winnerId: string,
  loserId: string,
  result: "2-0" | "2-1",
  pretend: boolean,
  client?: djs.Client,
): Promise<ReportResult> {
  if (winnerId === loserId) {
    return { ok: false, error: "Winner and loser must be different players." };
  }

  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${MATCHUPS_SHEET}!A2:G`,
    "UNFORMATTED_VALUE",
  );

  const values = response.values || [];
  let matchRowIndex: number | null = null;

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row || row.length < 7) continue;

    const rowDraft = String(row[0] ?? "").trim();
    const p1 = String(row[3] ?? "").trim();
    const p2 = String(row[4] ?? "").trim();
    const winner = String(row[5] ?? "").trim();

    if (rowDraft !== draftName) continue;
    if (winner !== "") continue; // Already has a winner

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
        "No valid matchup found. Both players must be paired in a matchup for this draft that hasn't been reported yet.",
    };
  }

  if (pretend) {
    return {
      ok: true,
    };
  }

  await ensureMatchesHeaders();

  await sheetsAppend(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    MATCHES_RANGE,
    [[winnerId, loserId, result, draftName, "Yes"]],
  );

  const sheetRow = matchRowIndex + 2;
  await sheetsWrite(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${MATCHUPS_SHEET}!F${sheetRow}:G${sheetRow}`,
    [[winnerId, result]],
  );

  await createNextRoundIfReady(draftName, pretend, client);

  return { ok: true };
}
