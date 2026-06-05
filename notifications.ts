import * as djs from "discord.js";

/**
 * Notification cooldown period: 12 hours in milliseconds
 */
const NOTIFICATION_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Tracks when a user was last notified for the draft queue
 */
interface NotificationRecord {
  lastNotified: number;
}

const notificationRecords = new Map<string, NotificationRecord>();

/**
 * Opts a user in for draft queue notifications
 */
export function optInForNotifications(userId: string): void {
  if (!notificationRecords.has(userId)) {
    notificationRecords.set(userId, { lastNotified: 0 });
  }
}

/**
 * Opts a user out of draft queue notifications
 */
export function optOutOfNotifications(userId: string): boolean {
  return notificationRecords.delete(userId);
}

/**
 * Checks if a user has opted in for notifications
 */
export function hasOptedIn(userId: string): boolean {
  return notificationRecords.has(userId);
}

/**
 * Checks if a user can be notified (hasn't been notified in the last 12 hours)
 */
export function canNotify(userId: string): boolean {
  const record = notificationRecords.get(userId);
  if (!record) {
    return false;
  }
  return Date.now() - record.lastNotified >= NOTIFICATION_COOLDOWN_MS;
}

/**
 * Marks a user as notified
 */
export function markAsNotified(userId: string): void {
  const record = notificationRecords.get(userId);
  if (record) {
    record.lastNotified = Date.now();
  }
}

/**
 * Resets the notification timer for a user
 */
export function resetNotificationTimer(userId: string): boolean {
  const record = notificationRecords.get(userId);
  if (!record) {
    return false;
  }
  record.lastNotified = 0;
  return true;
}

/**
 * Gets all users who have opted in for notifications
 */
export function getUsersOptedIn(): string[] {
  return Array.from(notificationRecords.keys());
}

/**
 * Sends notification DMs to all eligible users when the queue reaches 5+ players
 */
export async function sendQueueNotifications(
  playerCount: number,
  client: djs.Client,
): Promise<void> {
  for (const userId of getUsersOptedIn()) {
    if (!canNotify(userId)) {
      continue;
    }

    try {
      const user = await client.users.fetch(userId);
      await user.send(
        `🔔 **Draft Notification**\n\n` +
          `The draft queue now has **${playerCount} players** and is close to firing!\n\n` +
          `Use \`!draft\` to join if you're interested.`,
      );
      markAsNotified(userId);
    } catch (error) {
      console.error(`Failed to send notification DM to user ${userId}:`, error);
    }
  }
}
