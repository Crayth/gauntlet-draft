import { CONFIG } from "./config.ts";
import { sheets, sheetsAppend, sheetsRead } from "./sheets.ts";

/**
 * Gets the Player Name for a Discord ID from the Player Database sheet.
 *
 * @param discordId - The Discord ID to look up
 * @returns Promise that resolves to the player name, or null if not found
 */
export async function getPlayerName(discordId: string): Promise<string | null> {
  try {
    const response = await sheetsRead(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      "Player Database!A2:B",
      "UNFORMATTED_VALUE",
    );

    const values = response.values || [];
    for (const row of values) {
      if (row && row.length >= 2 && row[1] === discordId) {
        return String(row[0]);
      }
    }
    return null;
  } catch (error) {
    console.error("Error getting player name:", error);
    return null;
  }
}

/**
 * Checks if a Discord ID exists in the Player Database sheet.
 *
 * @param discordId - The Discord ID to check
 * @returns Promise that resolves to true if the user exists, false otherwise
 */
export async function playerExists(discordId: string): Promise<boolean> {
  try {
    // Read all Discord IDs from column B (starting from row 2 to skip header)
    const response = await sheetsRead(
      sheets,
      CONFIG.LIVE_SHEET_ID,
      "Player Database!B2:B",
      "UNFORMATTED_VALUE",
    );

    const values = response.values || [];

    // Check if any row contains the Discord ID
    for (const row of values) {
      if (row && row.length > 0 && row[0] === discordId) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("Error checking if player exists:", error);
    throw error;
  }
}

/**
 * Ensures a user exists in the Player Database. If they don't exist, adds them.
 * If they already exist, does nothing.
 *
 * @param userName - The display name or username of the user
 * @param discordId - The Discord ID of the user
 * @param pretend - If true, only logs what would be done without actually doing it
 * @returns Promise that resolves to true if the user was added, false if they already existed
 */
export async function ensurePlayerInDatabase(
  userName: string,
  discordId: string,
  pretend: boolean = false,
): Promise<boolean> {
  // Check if player already exists
  const exists = await playerExists(discordId);

  if (exists) {
    return false; // Already exists, nothing to do
  }

  if (pretend) {
    console.log(
      `[PRETEND] Would add player: ${userName} (${discordId}) to Player Database`,
    );
    return true;
  }

  // Add the player to the sheet
  // Column A is Name, Column B is Discord ID
  await sheetsAppend(
    sheets,
    CONFIG.LIVE_SHEET_ID,
    "Player Database!A:B",
    [[userName, discordId]],
  );

  console.log(`Added player: ${userName} (${discordId}) to Player Database`);
  return true;
}
