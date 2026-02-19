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
  /** Timer for 1hr inactivity check (DM to confirm); null if user has queue timeout */
  reminderTimerId: number | null;
  /** Timer for queue timeout - removes player if queue hasn't reached 8 in N hours */
  queueTimeoutTimerId: number | null;
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
 * Starts the inactivity reminder timer for a player in a draft (users without queue timeout only).
 * After 1 hour, DMs the user to confirm; listens for response in DMs.
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
    const draftDisplay = formatAcronym.includes("-")
      ? formatAcronym.split("-").join(" ")
      : formatAcronym;

    const reminderMessage =
      `You have been in the \`${draftDisplay}\` draft for 1 hour. ` +
      `Do you still want to stay? Respond with \`!yes\` to remain, or \`!leave ${draftDisplay}\` to leave the draft.`;

    let responseChannel: djs.TextBasedChannel;
    try {
      const user = await client.users.fetch(userId);
      const dmChannel = await user.createDM();
      await dmChannel.send(reminderMessage);
      responseChannel = dmChannel;
    } catch (error) {
      // DM failed (user has DMs disabled, etc.) - fall back to channel
      console.error(`Failed to DM user ${userId} for inactivity check:`, error);
      await channel.send(`${userMention}, ${reminderMessage}`);
      responseChannel = channel;
    }

    const collector = responseChannel.createMessageCollector({
      filter: (m) => {
        if (m.author.id !== userId) return false;
        const content = m.content.toLowerCase().trim();
        if (content === "!yes") return true;
        if (content === `!leave ${draftDisplay.toLowerCase()}`) return true;
        if (content === `!leave ${formatAcronym.toLowerCase()}`) return true;
        return false;
      },
      time: REMOVAL_DELAY_MS,
      max: 1,
    });

    collector.on("collect", async (message) => {
      collector.stop();

      if (message.content.toLowerCase() === "!yes") {
        const draft = getDraft(formatAcronym);
        if (draft && draft.has(userId)) {
          const playerInfo = draft.get(userId)!;
          playerInfo.reminderTimerId = startReminderTimer(
            formatAcronym,
            userId,
            channel,
            client,
            pretend,
          );
          await message.reply("Your timer has been reset for 1 more hour.");
        }
      } else {
        await leaveDraft(formatAcronym, userId, channel, pretend);
        if (responseChannel.isDMBased()) {
          await message.reply("You've left the draft.");
        }
        await channel.send(
          `${userMention} has left \`${draftDisplay}\`.\nRemaining players: **${
            getPlayerCount(formatAcronym)
          }**`,
        );
        const remainingDraft = getDraft(formatAcronym);
        if (remainingDraft?.size === 0) {
          drafts.delete(formatAcronym);
          await channel.send(
            `The \`${draftDisplay}\` draft is now empty and has been removed.`,
          );
        }
      }
    });

    collector.on("end", async (collected) => {
      if (collected.size === 0) {
        await leaveDraft(formatAcronym, userId, channel, pretend);
        await channel.send(
          `${userMention} has been removed from \`${draftDisplay}\` due to inactivity.`,
        );

        const draft = getDraft(formatAcronym);
        if (!draft || draft.size === 0) {
          drafts.delete(formatAcronym);
          await channel.send(
            `The \`${draftDisplay}\` draft is now empty and has been removed.`,
          );
        }
      }
    });
  }, REMINDER_DELAY_MS);

  return timerId as unknown as number;
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
 * Cancels a queue timeout timer
 */
function cancelQueueTimeoutTimer(timerId: number | null): void {
  if (timerId !== null) {
    clearTimeout(timerId);
  }
}

/**
 * Starts the queue timeout timer - removes player if queue hasn't reached 8 in N hours
 */
function startQueueTimeoutTimer(
  formatAcronym: string,
  userId: string,
  channel: djs.TextChannel,
  pretend: boolean,
  hours: number,
): number {
  const ms = hours * 60 * 60 * 1000;
  const timerId = setTimeout(async () => {
    const draft = getDraft(formatAcronym);
    if (!draft || !draft.has(userId)) {
      return; // Draft or player no longer exists (e.g., draft filled and closed)
    }
    if (draft.size >= 8) {
      return; // Draft is full, don't remove
    }

    const userMention = `<@${userId}>`;
    const draftDisplay = formatAcronym.includes("-")
      ? formatAcronym.split("-").join(" ")
      : formatAcronym;

    await leaveDraft(formatAcronym, userId, channel, pretend);
    await channel.send(
      `${userMention} has been removed from \`${draftDisplay}\` after ${hours} hour(s) — the queue did not reach 8 players.`,
    );

    if (draft.size === 0) {
      drafts.delete(formatAcronym);
      await channel.send(
        `The \`${draftDisplay}\` draft is now empty and has been removed.`,
      );
    }
  }, ms);

  return timerId as unknown as number;
}

/**
 * Adds a player to a draft
 * @param queueTimeoutHours Optional 1-12; if set, player is removed after this many hours if queue hasn't reached 8
 */
export function addPlayerToDraft(
  formatAcronym: string,
  userId: string,
  channel: djs.TextChannel,
  client: djs.Client,
  pretend: boolean,
  queueTimeoutHours?: number,
): boolean {
  const draft = getOrCreateDraft(formatAcronym);

  if (draft.has(userId)) {
    return false; // Player already in draft
  }

  // Only start 1hr reminder for users without queue timeout (they have no auto-removal)
  const reminderTimerId =
    !queueTimeoutHours || queueTimeoutHours < 1 || queueTimeoutHours > 12
      ? startReminderTimer(
        formatAcronym,
        userId,
        channel,
        client,
        pretend,
      )
      : null;

  const queueTimeoutTimerId =
    queueTimeoutHours && queueTimeoutHours >= 1 && queueTimeoutHours <= 12
      ? startQueueTimeoutTimer(
        formatAcronym,
        userId,
        channel,
        pretend,
        queueTimeoutHours,
      )
      : null;

  draft.set(userId, {
    joinTime: new Date(),
    reminderTimerId,
    queueTimeoutTimerId,
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
  if (playerInfo.reminderTimerId !== null) {
    cancelReminderTimer(playerInfo.reminderTimerId);
  }
  cancelQueueTimeoutTimer(playerInfo.queueTimeoutTimerId);
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

  // Cancel all reminder and queue timeout timers
  for (const playerInfo of draft.values()) {
    if (playerInfo.reminderTimerId !== null) {
      cancelReminderTimer(playerInfo.reminderTimerId);
    }
    cancelQueueTimeoutTimer(playerInfo.queueTimeoutTimerId);
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
