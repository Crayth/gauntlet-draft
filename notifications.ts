import * as djs from "discord.js";

/**
 * Notification cooldown period: 12 hours in milliseconds
 */
const NOTIFICATION_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * Tracks when a user was last notified for a specific set code
 */
interface NotificationRecord {
  lastNotified: number; // Timestamp in milliseconds
}

/**
 * Maps user ID -> set code -> notification record
 */
const notificationRecords = new Map<string, Map<string, NotificationRecord>>();

/**
 * Opts a user in for notifications for a specific set code
 */
export function optInForNotifications(userId: string, setCode: string): void {
  const upperSetCode = setCode.toUpperCase();
  let userNotifications = notificationRecords.get(userId);
  if (!userNotifications) {
    userNotifications = new Map();
    notificationRecords.set(userId, userNotifications);
  }
  
  // Initialize with a very old timestamp so they can be notified immediately
  if (!userNotifications.has(upperSetCode)) {
    userNotifications.set(upperSetCode, {
      lastNotified: 0, // 0 means never notified
    });
  }
}

/**
 * Opts a user out of notifications for a specific set code
 */
export function optOutOfNotifications(userId: string, setCode: string): boolean {
  const upperSetCode = setCode.toUpperCase();
  const userNotifications = notificationRecords.get(userId);
  if (!userNotifications) {
    return false; // Not opted in
  }
  
  const wasOptedIn = userNotifications.has(upperSetCode);
  if (wasOptedIn) {
    userNotifications.delete(upperSetCode);
    
    // Clean up empty user notification maps
    if (userNotifications.size === 0) {
      notificationRecords.delete(userId);
    }
  }
  
  return wasOptedIn;
}

/**
 * Checks if a user has opted in for notifications for a specific set code
 */
export function hasOptedIn(userId: string, setCode: string): boolean {
  const upperSetCode = setCode.toUpperCase();
  const userNotifications = notificationRecords.get(userId);
  return userNotifications?.has(upperSetCode) ?? false;
}

/**
 * Gets all set codes a user has opted in for
 */
export function getOptedInSetCodes(userId: string): string[] {
  const userNotifications = notificationRecords.get(userId);
  if (!userNotifications) {
    return [];
  }
  return Array.from(userNotifications.keys());
}

/**
 * Checks if a user can be notified (hasn't been notified in the last 12 hours)
 */
export function canNotify(userId: string, setCode: string): boolean {
  const upperSetCode = setCode.toUpperCase();
  const userNotifications = notificationRecords.get(userId);
  if (!userNotifications) {
    return false;
  }
  
  const record = userNotifications.get(upperSetCode);
  if (!record) {
    return false; // Not opted in
  }
  
  const now = Date.now();
  const timeSinceLastNotification = now - record.lastNotified;
  return timeSinceLastNotification >= NOTIFICATION_COOLDOWN_MS;
}

/**
 * Marks a user as notified for a specific set code
 */
export function markAsNotified(userId: string, setCode: string): void {
  const upperSetCode = setCode.toUpperCase();
  const userNotifications = notificationRecords.get(userId);
  if (!userNotifications) {
    return;
  }
  
  const record = userNotifications.get(upperSetCode);
  if (record) {
    record.lastNotified = Date.now();
  }
}

/**
 * Resets the notification timer for a user and set code
 */
export function resetNotificationTimer(userId: string, setCode: string): boolean {
  const upperSetCode = setCode.toUpperCase();
  const userNotifications = notificationRecords.get(userId);
  if (!userNotifications) {
    return false; // Not opted in
  }
  
  const record = userNotifications.get(upperSetCode);
  if (!record) {
    return false; // Not opted in for this set
  }
  
  record.lastNotified = 0; // Reset to 0 so they can be notified immediately
  return true;
}

/**
 * Gets all users who have opted in for notifications for a specific set code
 */
export function getUsersOptedInForSetCode(setCode: string): string[] {
  const upperSetCode = setCode.toUpperCase();
  const userIds: string[] = [];
  
  for (const [userId, userNotifications] of notificationRecords.entries()) {
    if (userNotifications.has(upperSetCode)) {
      userIds.push(userId);
    }
  }
  
  return userIds;
}

/**
 * Sends notification DMs to all eligible users for a set code
 */
export async function sendNotificationsForSetCode(
  setCode: string,
  playerCount: number,
  client: djs.Client,
): Promise<void> {
  const upperSetCode = setCode.toUpperCase();
  const eligibleUsers = getUsersOptedInForSetCode(upperSetCode);
  
  // Convert draft key to display format (dash-separated to space-separated)
  const setDisplay = upperSetCode.includes("-")
    ? upperSetCode.split("-").join(" ")
    : upperSetCode;
  
  for (const userId of eligibleUsers) {
    if (!canNotify(userId, upperSetCode)) {
      continue; // Skip if on cooldown
    }
    
    try {
      const user = await client.users.fetch(userId);
      await user.send(
        `🔔 **Draft Notification**\n\n` +
        `The \`${setDisplay}\` draft queue now has **${playerCount} players** and is close to firing!\n\n` +
        `Use \`!draft ${setDisplay}\` to join if you're interested.`
      );
      
      // Mark as notified
      markAsNotified(userId, upperSetCode);
    } catch (error) {
      // User might have DMs disabled or blocked the bot
      console.error(`Failed to send notification DM to user ${userId}:`, error);
      // Continue with other users even if one fails
    }
  }
}
