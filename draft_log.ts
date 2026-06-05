import * as djs from "discord.js";
import { CONFIG } from "./config.ts";
import { sheets, sheetsAppend, sheetsRead, sheetsWrite } from "./sheets.ts";
import { getPlayerName } from "./player_database.ts";

const DRAFT_LOG_SHEET = "Draft Log";
const DRAFT_LOG_RANGE = `${DRAFT_LOG_SHEET}!A:C`;
const DRAFT_LOG_HEADERS = ["Player Name", "Discord ID", "Pod ID"];

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
 * Gets all player names for a pod in one sheet read.
 */
export async function getPlayerNamesForPod(
  podId: string,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const response = await sheetsRead(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `${DRAFT_LOG_SHEET}!A2:C`,
      "UNFORMATTED_VALUE",
    );
    const podLower = podId.toLowerCase();
    for (const row of response.values || []) {
      if (row && row.length >= 3) {
        const playerName = String(row[0] ?? "").trim();
        const discordId = String(row[1] ?? "").trim();
        const rowPodId = String(row[2] ?? "").trim();
        if (rowPodId.toLowerCase() === podLower && discordId) {
          names.set(discordId, playerName || "Unknown");
        }
      }
    }
  } catch (error) {
    console.error("Error loading player names for pod:", error);
  }
  return names;
}

/**
 * Gets the Player Name from Draft Log for a Discord ID in a specific pod.
 * Draft Log columns: A=Player Name, B=Discord ID, C=Pod ID.
 *
 * @returns Player Name, or null if not found
 */
export async function getPlayerNameFromDraftLog(
  discordId: string,
  podId: string,
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
        const rowPodId = String(row[2] ?? "").trim();
        if (
          rowDiscordId === discordId &&
          rowPodId.toLowerCase() === podId.toLowerCase()
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
 * Checks whether a pod ID already exists in the Draft Log (case-insensitive).
 */
export async function podIdExistsInLog(podId: string): Promise<boolean> {
  try {
    const response = await sheetsRead(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      `${DRAFT_LOG_SHEET}!C2:C`,
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
  } catch (error) {
    console.error("Error checking pod ID uniqueness:", error);
    return false;
  }
}

/**
 * Generates a short, human-friendly pod ID like `P4827`.
 * Format: P + 4 digits (1000–9999), checked against the Draft Log for collisions.
 */
export async function generatePodId(pretend: boolean): Promise<string> {
  if (pretend) {
    return "P0000";
  }

  for (let attempt = 0; attempt < 25; attempt++) {
    const n = 1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000);
    const id = `P${n}`;
    if (!(await podIdExistsInLog(id))) {
      return id;
    }
  }

  throw new Error("Failed to generate a unique pod ID");
}

/**
 * Records a completed draft pod to the Draft Log sheet.
 * Each player gets a row: Player Name, Discord ID, Pod ID.
 *
 * @param podId - Unique identifier for this pod
 * @param userIds - Discord user IDs in the pod
 * @param client - Discord client for fetching usernames if Player Database lookup fails
 * @param pretend - If true, only logs what would be done
 */
export async function recordDraftToLog(
  podId: string,
  userIds: readonly string[],
  client: djs.Client,
  pretend: boolean,
): Promise<void> {
  if (pretend) {
    console.log(
      `[PRETEND] Would record pod "${podId}" with ${userIds.length} players to Draft Log`,
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
    rows.push([playerName, userId, podId]);
  }

  await sheetsAppend(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    DRAFT_LOG_RANGE,
    rows,
  );

  console.log(
    `Recorded pod "${podId}" with ${rows.length} players to Draft Log`,
  );
}
