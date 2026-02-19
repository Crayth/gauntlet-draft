import * as djs from "discord.js";
import { CONFIG } from "./config.ts";
import { sheets, sheetsAppend, sheetsRead, sheetsWrite } from "./sheets.ts";
import { getPlayerName } from "./player_database.ts";

const DRAFT_LOG_SHEET = "Draft Log";
const DRAFT_LOG_RANGE = `${DRAFT_LOG_SHEET}!A:C`;
const DRAFT_LOG_HEADERS = ["Player Name", "Discord ID", "Draft Name"];

/**
 * Ensures the Draft Log sheet has headers. If the sheet is empty, appends them.
 */
async function ensureDraftLogHeaders(): Promise<void> {
  const response = await sheetsRead(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    `${DRAFT_LOG_SHEET}!A1:C1`,
    "UNFORMATTED_VALUE",
  );
  const values = response.values;
  const hasHeaders = values &&
    values.length > 0 &&
    values[0] &&
    values[0].length > 0 &&
    String(values[0][0]).trim() === "Player Name";

  if (!hasHeaders) {
    await sheetsWrite(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `${DRAFT_LOG_SHEET}!A1:C1`,
      [DRAFT_LOG_HEADERS],
    );
  }
}

/**
 * Gets the Player Name from Draft Log for a Discord ID in a specific draft.
 * Draft Log columns: A=Player Name, B=Discord ID, C=Draft Name.
 *
 * @returns Player Name, or null if not found
 */
export async function getPlayerNameFromDraftLog(
  discordId: string,
  draftName: string,
): Promise<string | null> {
  try {
    const response = await sheetsRead(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `${DRAFT_LOG_SHEET}!A2:C`,
      "UNFORMATTED_VALUE",
    );
    const values = response.values || [];
    for (const row of values) {
      if (row && row.length >= 3) {
        const playerName = String(row[0] ?? "").trim();
        const rowDiscordId = String(row[1] ?? "").trim();
        const rowDraftName = String(row[2] ?? "").trim();
        if (
          rowDiscordId === discordId &&
          rowDraftName.toLowerCase() === draftName.toLowerCase()
        ) {
          return playerName || null;
        }
      }
    }
    return null;
  } catch (error) {
    console.error("Error looking up player name from Draft Log:", error);
    return null;
  }
}

/**
 * Checks if a draft name already exists in the Draft Log (case-sensitive).
 * Used to prevent duplicate draft names that would mix pod data.
 */
export async function draftNameExistsInLog(
  draftName: string,
): Promise<boolean> {
  try {
    const response = await sheetsRead(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `${DRAFT_LOG_SHEET}!C2:C`,
      "UNFORMATTED_VALUE",
    );
    const values = response.values || [];
    for (const row of values) {
      if (row && row.length > 0 && String(row[0] ?? "").trim() === draftName) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error("Error checking draft name uniqueness:", error);
    return false; // On error, allow (don't block due to sheet read failure)
  }
}

/**
 * Records a completed draft pod to the Draft Log sheet.
 * Each of the 8 players gets a row: Player Name, Discord ID, Draft Name.
 *
 * @param draftName - The name of the draft (the queue parameter)
 * @param userIds - The 8 Discord user IDs in the pod
 * @param client - Discord client for fetching usernames if Player Database lookup fails
 * @param pretend - If true, only logs what would be done
 */
export async function recordDraftToLog(
  draftName: string,
  userIds: readonly string[],
  client: djs.Client,
  pretend: boolean,
): Promise<void> {
  if (pretend) {
    console.log(
      `[PRETEND] Would record draft "${draftName}" with ${userIds.length} players to Draft Log`,
    );
    return;
  }

  await ensureDraftLogHeaders();

  const rows: string[][] = [];
  for (const userId of userIds) {
    let playerName = await getPlayerName(userId);
    if (playerName === null) {
      try {
        const user = await client.users.fetch(userId);
        playerName = user.username;
      } catch {
        playerName = `Unknown (${userId})`;
      }
    }
    rows.push([playerName, userId, draftName]);
  }

  await sheetsAppend(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    DRAFT_LOG_RANGE,
    rows,
  );

  console.log(
    `Recorded draft "${draftName}" with ${rows.length} players to Draft Log`,
  );
}
