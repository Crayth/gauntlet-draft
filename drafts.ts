import * as djs from "discord.js";

/**
 * Configuration constants for draft management
 */
const REMINDER_DELAY_MS = 3600 * 1000; // 1 hour in milliseconds
const REMOVAL_DELAY_MS = 300 * 1000; // 5 minutes in milliseconds

/**
 * Information about a player in a draft
 */
export interface PlayerInfo {
  joinTime: Date;
  reminderTimerId: number | null;
}

/**
 * Draft state - maps user IDs to their player info
 */
type DraftState = Map<string, PlayerInfo>;

/**
 * All active drafts - maps format acronym (e.g., "TLA") to draft state
 */
const drafts = new Map<string, DraftState>();

/**
 * Gets or creates a draft for the given format acronym
 */
export function getOrCreateDraft(formatAcronym: string): DraftState {
  let draft = drafts.get(formatAcronym);
  if (!draft) {
    draft = new Map();
    drafts.set(formatAcronym, draft);
  }
  return draft;
}

/**
 * Gets a draft if it exists
 */
export function getDraft(formatAcronym: string): DraftState | undefined {
  return drafts.get(formatAcronym);
}

/**
 * Removes a draft if it's empty
 */
export function removeDraftIfEmpty(formatAcronym: string): boolean {
  const draft = drafts.get(formatAcronym);
  if (draft && draft.size === 0) {
    drafts.delete(formatAcronym);
    return true;
  }
  return false;
}

/**
 * Gets all active drafts
 */
export function getAllDrafts(): Map<string, DraftState> {
  return drafts;
}

/**
 * Starts the inactivity reminder timer for a player in a draft
 */
export function startReminderTimer(
  formatAcronym: string,
  userId: string,
  channel: djs.TextChannel,
  client: djs.Client,
  pretend: boolean,
): number {
  const timerId = setTimeout(async () => {
    const draft = getDraft(formatAcronym);
    if (!draft || !draft.has(userId)) {
      return; // Draft or player no longer exists
    }

    const userMention = `<@${userId}>`;
    await channel.send(
      `${userMention}, you have been in the \`${formatAcronym}\` draft for 1 hour. ` +
        `Do you still want to stay? Respond with \`!yes\` to remain, or \`!leave ${formatAcronym}\` to leave the draft.`,
    );

    // Wait for response
    const collector = channel.createMessageCollector({
      filter: (m) =>
        m.author.id === userId &&
        (m.content.toLowerCase() === "!yes" ||
          m.content.toLowerCase() === `!leave ${formatAcronym.toLowerCase()}`),
      time: REMOVAL_DELAY_MS,
      max: 1,
    });

    collector.on("collect", async (message) => {
      collector.stop(); // Stop collecting after first message
      
      if (message.content.toLowerCase() === "!yes") {
        // User wants to stay - restart timer
        const draft = getDraft(formatAcronym);
        if (draft && draft.has(userId)) {
          const playerInfo = draft.get(userId)!;
          // Start new timer
          playerInfo.reminderTimerId = startReminderTimer(
            formatAcronym,
            userId,
            channel,
            client,
            pretend,
          );
          await channel.send(
            `${userMention}, your timer has been reset for 1 more hour.`,
          );
        }
      } else {
        // User wants to leave
        await leaveDraft(formatAcronym, userId, channel, pretend);
      }
    });

    collector.on("end", async (collected) => {
      if (collected.size === 0) {
        // No response - remove for inactivity
        await leaveDraft(formatAcronym, userId, channel, pretend);
        await channel.send(
          `${userMention} has been removed from \`${formatAcronym}\` due to inactivity.`,
        );

        const draft = getDraft(formatAcronym);
        if (!draft || draft.size === 0) {
          drafts.delete(formatAcronym);
          await channel.send(
            `The \`${formatAcronym}\` draft is now empty and has been removed.`,
          );
        }
      }
    });
  }, REMINDER_DELAY_MS);

  return timerId as unknown as number; // Deno/Node setTimeout returns a number
}

/**
 * Cancels a reminder timer
 */
export function cancelReminderTimer(timerId: number | null): void {
  if (timerId !== null) {
    clearTimeout(timerId);
  }
}

/**
 * Adds a player to a draft
 */
export function addPlayerToDraft(
  formatAcronym: string,
  userId: string,
  channel: djs.TextChannel,
  client: djs.Client,
  pretend: boolean,
): boolean {
  const draft = getOrCreateDraft(formatAcronym);

  if (draft.has(userId)) {
    return false; // Player already in draft
  }

  const reminderTimerId = startReminderTimer(
    formatAcronym,
    userId,
    channel,
    client,
    pretend,
  );

  draft.set(userId, {
    joinTime: new Date(),
    reminderTimerId,
  });

  return true;
}

/**
 * Removes a player from a draft
 */
export async function leaveDraft(
  formatAcronym: string,
  userId: string,
  channel: djs.TextChannel,
  pretend: boolean,
): Promise<boolean> {
  const draft = getDraft(formatAcronym);
  if (!draft || !draft.has(userId)) {
    return false; // Draft or player doesn't exist
  }

  const playerInfo = draft.get(userId)!;
  cancelReminderTimer(playerInfo.reminderTimerId);
  draft.delete(userId);

  return true;
}

/**
 * Cancels all reminder timers for a draft and removes it
 */
export function closeDraft(formatAcronym: string): void {
  const draft = drafts.get(formatAcronym);
  if (!draft) {
    return;
  }

  // Cancel all reminder timers
  for (const playerInfo of draft.values()) {
    cancelReminderTimer(playerInfo.reminderTimerId);
  }

  // Remove the draft
  drafts.delete(formatAcronym);
}

/**
 * Gets the player count for a draft
 */
export function getPlayerCount(formatAcronym: string): number {
  const draft = getDraft(formatAcronym);
  return draft ? draft.size : 0;
}

