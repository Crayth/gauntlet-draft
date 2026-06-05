import * as djs from "discord.js";

/**
 * Single draft queue key — all players join this one queue.
 */
export const QUEUE_KEY = "queue";

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
 * All active drafts - single queue uses QUEUE_KEY
 */
const drafts = new Map<string, DraftState>();

/**
 * Gets or creates the draft queue
 */
export function getOrCreateDraft(): DraftState {
  let draft = drafts.get(QUEUE_KEY);
  if (!draft) {
    draft = new Map();
    drafts.set(QUEUE_KEY, draft);
  }
  return draft;
}

/**
 * Gets the draft queue if it exists
 */
export function getDraft(): DraftState | undefined {
  return drafts.get(QUEUE_KEY);
}

/**
 * Removes the draft queue if it's empty
 */
export function removeDraftIfEmpty(): boolean {
  const draft = drafts.get(QUEUE_KEY);
  if (draft && draft.size === 0) {
    drafts.delete(QUEUE_KEY);
    return true;
  }
  return false;
}

/**
 * Gets all active drafts (at most one queue)
 */
export function getAllDrafts(): Map<string, DraftState> {
  return drafts;
}

/**
 * Starts the inactivity reminder timer for a player in the queue.
 * After 1 hour, DMs the user to confirm; listens for response in DMs.
 */
export function startReminderTimer(
  userId: string,
  channel: djs.TextChannel,
  client: djs.Client,
  _pretend: boolean,
): number {
  const timerId = setTimeout(async () => {
    const draft = getDraft();
    if (!draft || !draft.has(userId)) {
      return;
    }

    const userMention = `<@${userId}>`;
    const reminderMessage = `You have been in the draft queue for 1 hour. ` +
      `Do you still want to stay? Respond with \`!yes\` to remain, or \`!leave\` to leave the queue.`;

    let responseChannel: djs.TextBasedChannel;
    try {
      const user = await client.users.fetch(userId);
      const dmChannel = await user.createDM();
      await dmChannel.send(reminderMessage);
      responseChannel = dmChannel;
    } catch (error) {
      console.error(`Failed to DM user ${userId} for inactivity check:`, error);
      await channel.send(`${userMention}, ${reminderMessage}`);
      responseChannel = channel;
    }

    const collector = responseChannel.createMessageCollector({
      filter: (m) => {
        if (m.author.id !== userId) return false;
        const content = m.content.toLowerCase().trim();
        return content === "!yes" || content === "!leave";
      },
      time: REMOVAL_DELAY_MS,
      max: 1,
    });

    collector.on("collect", async (message) => {
      collector.stop();

      if (message.content.toLowerCase() === "!yes") {
        const draft = getDraft();
        if (draft && draft.has(userId)) {
          const playerInfo = draft.get(userId)!;
          playerInfo.reminderTimerId = startReminderTimer(
            userId,
            channel,
            client,
            _pretend,
          );
          await message.reply("Your timer has been reset for 1 more hour.");
        }
      } else {
        await leaveDraft(userId, channel, _pretend);
        if (responseChannel.isDMBased()) {
          await message.reply("You've left the queue.");
        }
        await channel.send(
          `${userMention} has left the draft queue.\nRemaining players: **${getPlayerCount()}**`,
        );
        if (getDraft()?.size === 0) {
          drafts.delete(QUEUE_KEY);
          await channel.send(
            "The draft queue is now empty and has been removed.",
          );
        }
      }
    });

    collector.on("end", async (collected) => {
      if (collected.size === 0) {
        await leaveDraft(userId, channel, _pretend);
        await channel.send(
          `${userMention} has been removed from the draft queue due to inactivity.`,
        );

        if (!getDraft() || getDraft()!.size === 0) {
          drafts.delete(QUEUE_KEY);
          await channel.send(
            "The draft queue is now empty and has been removed.",
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
  userId: string,
  channel: djs.TextChannel,
  pretend: boolean,
  hours: number,
): number {
  const ms = hours * 60 * 60 * 1000;
  const timerId = setTimeout(async () => {
    const draft = getDraft();
    if (!draft || !draft.has(userId)) {
      return;
    }
    if (draft.size >= 8) {
      return;
    }

    const userMention = `<@${userId}>`;
    await leaveDraft(userId, channel, pretend);
    await channel.send(
      `${userMention} has been removed from the draft queue after ${hours} hour(s) — the queue did not reach 8 players.`,
    );

    if (draft.size === 0) {
      drafts.delete(QUEUE_KEY);
      await channel.send(
        "The draft queue is now empty and has been removed.",
      );
    }
  }, ms);

  return timerId as unknown as number;
}

/**
 * Adds a player to the draft queue
 * @param queueTimeoutHours Optional 1-12; if set, player is removed after this many hours if queue hasn't reached 8
 */
export function addPlayerToDraft(
  userId: string,
  channel: djs.TextChannel,
  client: djs.Client,
  pretend: boolean,
  queueTimeoutHours?: number,
): boolean {
  const draft = getOrCreateDraft();

  if (draft.has(userId)) {
    return false;
  }

  const reminderTimerId =
    !queueTimeoutHours || queueTimeoutHours < 1 || queueTimeoutHours > 12
      ? startReminderTimer(userId, channel, client, pretend)
      : null;

  const queueTimeoutTimerId =
    queueTimeoutHours && queueTimeoutHours >= 1 && queueTimeoutHours <= 12
      ? startQueueTimeoutTimer(userId, channel, pretend, queueTimeoutHours)
      : null;

  draft.set(userId, {
    joinTime: new Date(),
    reminderTimerId,
    queueTimeoutTimerId,
  });

  return true;
}

/**
 * Removes a player from the draft queue
 */
export function leaveDraft(
  userId: string,
  _channel: djs.TextChannel,
  _pretend: boolean,
): boolean {
  const draft = getDraft();
  if (!draft || !draft.has(userId)) {
    return false;
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
 * Cancels all timers and removes the draft queue
 */
export function closeDraft(): void {
  const draft = drafts.get(QUEUE_KEY);
  if (!draft) {
    return;
  }

  for (const playerInfo of draft.values()) {
    if (playerInfo.reminderTimerId !== null) {
      cancelReminderTimer(playerInfo.reminderTimerId);
    }
    cancelQueueTimeoutTimer(playerInfo.queueTimeoutTimerId);
  }

  drafts.delete(QUEUE_KEY);
}

/**
 * Gets the player count for the draft queue
 */
export function getPlayerCount(): number {
  const draft = getDraft();
  return draft ? draft.size : 0;
}

/**
 * Gets the user IDs currently in the draft queue
 */
export function getQueueUserIds(): string[] {
  const draft = getDraft();
  return draft ? Array.from(draft.keys()) : [];
}
