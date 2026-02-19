import { CONFIG } from "./config.ts";

import { load } from "@std/dotenv";
import { parseArgs } from "@std/cli/parse-args";
import * as djs from "discord.js";
import { initSheets } from "./sheets.ts";
import { ensurePlayerInDatabase } from "./player_database.ts";
import {
  addPlayerToDraft,
  closeDraft,
  getAllDrafts,
  getPlayerCount,
  leaveDraft,
  removeDraftIfEmpty,
} from "./drafts.ts";
import {
  optInForNotifications,
  optOutOfNotifications,
  resetNotificationTimer,
  sendNotificationsForSetCode,
} from "./notifications.ts";
import {
  draftNameExistsInLog,
  getPlayerNameFromDraftLog,
  recordDraftToLog,
} from "./draft_log.ts";
import { createRound1Matchups, getDraftStatus } from "./matchups.ts";
import { reportMatch } from "./matches.ts";

export { CONFIG };

// Load environment variables from .env file
const env = await load({ export: true });

// Parse command line arguments
const args = parseArgs(Deno.args, {
  boolean: ["pretend", "once", "help"],
  string: ["_"], // Positional arguments
  default: { pretend: false, once: false, help: false },
});

// Show help if requested
if (args.help) {
  console.log(`Usage: deno task start <command> [options]
   or: deno run main.ts <command> [options]

Commands:
  bot      Run the Discord bot

Options:
  --pretend  Run in pretend mode
  --once     Run once and exit (instead of looping)
  --help     Show this help message
  `);
  Deno.exit(0);
}

const { pretend, once: _once } = args;
const command = args._[0]; // First positional argument is the command

export const DISCORD_TOKEN = env["DISCORD_TOKEN"];
if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN environment variable is required");
  Deno.exit(1);
}

const client = new djs.Client({
  intents: [
    djs.GatewayIntentBits.Guilds,
    djs.GatewayIntentBits.GuildMembers,
    djs.GatewayIntentBits.GuildMessages,
    djs.GatewayIntentBits.MessageContent,
    djs.GatewayIntentBits.DirectMessages,
  ],
});

let isClientReady = false;

client.once(djs.Events.ClientReady, async (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  isClientReady = true;
  // Initialize Google Sheets client
  await initSheets();
  console.log("Google Sheets client initialized");

  // Send startup message to draft channel if configured
  if (CONFIG.DRAFT_CHANNEL_ID) {
    try {
      const channel = await readyClient.channels.fetch(CONFIG.DRAFT_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await (channel as djs.TextChannel).send(
          "✅ Bot is now online and ready to organize drafts! Use `!help` to see available commands.",
        );
      }
    } catch (error) {
      console.error("Error sending startup message:", error);
      // Don't fail startup if we can't send the message
    }
  }
});

/**
 * Gets the display name for a Discord user, preferring guild display name if available.
 */
function getUserDisplayName(
  user: djs.User,
  member: djs.GuildMember | null,
): string {
  if (member) {
    return member.displayName || user.username;
  }
  return user.username;
}

/**
 * Checks if the message is from the allowed draft channel (if configured)
 */
function isAllowedDraftChannel(message: djs.Message): boolean {
  if (!CONFIG.DRAFT_CHANNEL_ID) {
    return true; // If not configured, allow all channels
  }
  return message.channel.id === CONFIG.DRAFT_CHANNEL_ID;
}

/**
 * Checks if the message is from the allowed matchmaking channel (if configured)
 */
function isAllowedMatchmakingChannel(message: djs.Message): boolean {
  return message.channel.id === CONFIG.MATCHMAKING_CHANNEL_ID;
}

/**
 * Ensures a user is in the Player Database. Should be called whenever a user
 * interacts with the bot to automatically add them if they don't exist.
 *
 * This function can be used by future bot features (button interactions, slash commands, etc.)
 * to automatically register users when they interact with the bot.
 */
export async function ensureUserInDatabase(
  user: djs.User,
  member: djs.GuildMember | null,
): Promise<void> {
  try {
    const userName = getUserDisplayName(user, member);
    await ensurePlayerInDatabase(userName, user.id, pretend);
  } catch (error) {
    console.error("Error ensuring user in database:", error);
    // Don't throw - we don't want to break bot functionality if this fails
  }
}

client.on(djs.Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Only process commands in guild channels (not DMs)
  if (!message.guild || !message.member) return;

  // Ensure the user is in the Player Database before processing any interaction
  await ensureUserInDatabase(message.author, message.member);

  const content = message.content.trim();
  const parts = content.split(/\s+/);
  const command = parts[0];

  // Help command: !help
  if (command === "!help") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const helpMessage = `**Available Commands:**

\`!draft <draft_name>\` - Join a draft queue
  Examples: \`!draft TLA\` or \`!draft Pod1 4\`
  • Draft name must be one word (no spaces), e.g. set code or Pod1
  • Optional \`<hours>\` (1-12): Remove me if queue doesn't reach 8 in that time (e.g. \`!draft TLA 4\`)
  • At 8 players: Draft closes with draftmancer.com link and is recorded for match reporting

\`!leave <draft_name>\` - Leave a draft queue

\`!notify <draft_name>\` - Opt in for DM notifications when queue reaches 5+ players (once per 12 hours)

\`!reset <draft_name>\` - Reset notification timer to receive notifications immediately

\`!cancel <draft_name>\` - Opt out of notifications

\`!available\` - List all active drafts and player counts

\`!fire <draft_name>\` - *(Owner only, testing)* Close a queue early and record players to Draft Log

\`!report <draft_name> @opponent 2-0\` or \`!report <draft_name> @opponent 2-1\` - Report a match result (you = winner, tagged = loser)

\`!status <draft_name>\` - Show current round and matchup status

\`!help\` - Show this help message

**Notes:**
• Draft commands must be used in the designated draft channel (if configured)
• Match reporting (\`!report\`) must be used in the designated matchmaking channel (if configured)
• After 1 hour in a draft (without a queue timeout), you'll receive a DM to confirm. Respond in DMs with \`!yes\` within 5 minutes or \`!leave <draft_name>\` to leave
• Players are automatically removed if they don't respond to the inactivity reminder
• Drafts are cleared when the bot goes offline`;

    await message.reply(helpMessage);
    return;
  }

  // Draft command: !draft <draft_name> or !draft <draft_name> <hours>
  // where hours (1-12) removes you from queue if it hasn't reached 8 players in that time
  if (command === "!draft") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    // Parse draft name (single token, no spaces); optional number 1-12 = queue timeout in hours
    const rawParts = parts.slice(1).filter((part) => part.length > 0);
    let queueTimeoutHours: number | undefined;
    let draftName: string;

    const firstPart = rawParts[0];
    const lastPart = rawParts[rawParts.length - 1];
    const timeoutNum = lastPart ? parseInt(lastPart, 10) : NaN;
    if (
      rawParts.length >= 2 &&
      !isNaN(timeoutNum) &&
      timeoutNum >= 1 &&
      timeoutNum <= 12
    ) {
      queueTimeoutHours = timeoutNum;
      draftName = firstPart ?? "";
    } else {
      draftName = firstPart ?? "";
    }

    if (!draftName) {
      await message.reply(
        "Please provide a draft name (one word, no spaces). Examples: `!draft TLA` or `!draft Pod1 4`",
      );
      return;
    }

    const draftKey = draftName;
    const draftDisplay = draftKey;

    // Check if user is already in the draft
    const existingDraft = getAllDrafts().get(draftKey);
    if (existingDraft && existingDraft.has(message.author.id)) {
      await message.reply(
        `${message.author}, you are already in \`${draftDisplay}\`.`,
      );
      return;
    }

    // Check if draft name is already used (completed pod in Draft Log)
    if (!existingDraft) {
      const nameTaken = await draftNameExistsInLog(draftKey);
      if (nameTaken) {
        await message.reply(
          `Draft name \`${draftDisplay}\` has already been used. Please choose a different name.`,
        );
        return;
      }
    }

    // Add player to draft
    if (!message.channel.isTextBased() || message.channel.isDMBased()) {
      return;
    }
    const textChannel = message.channel as djs.TextChannel;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would add ${message.author} to draft \`${draftDisplay}\``,
      );
      return;
    }

    const wasAdded = addPlayerToDraft(
      draftKey,
      message.author.id,
      textChannel,
      client,
      pretend,
      queueTimeoutHours,
    );

    if (!wasAdded) {
      await message.reply(
        `${message.author}, you are already in \`${draftDisplay}\`.`,
      );
      return;
    }

    const count = getPlayerCount(draftKey);
    const timeoutNote = queueTimeoutHours !== undefined
      ? ` You will be removed if the queue doesn't reach 8 in ${queueTimeoutHours} hour(s).`
      : "";
    await message.reply(
      `${message.author} has joined \`${draftDisplay}\`.\nCurrent players: **${count}**${timeoutNote}`,
    );

    // Send notifications at 5+ players
    if (count >= 5) {
      await sendNotificationsForSetCode(draftKey, count, client);
    }

    // Ping and close at 8 players
    if (count === 8) {
      const draft = getAllDrafts().get(draftKey);
      if (draft) {
        const userIds = Array.from(draft.keys());
        const mentions = userIds.map((uid) => `<@${uid}>`).join(" ");
        await message.reply(
          `🔥 Draft \`${draftDisplay}\` is FULL (**8 players**)!\n${mentions}`,
        );

        // Record to Draft Log for match reporting
        await recordDraftToLog(draftKey, userIds, client, pretend);

        // Create Round 1 bracket (4 matchups) in Matchups sheet
        await createRound1Matchups(draftKey, userIds, pretend, client);

        // Generate UUID for draftmancer.com session
        const draftUuid = crypto.randomUUID();
        await message.reply(
          `Please visit https://draftmancer.com/?session=${draftUuid} to start the draft.`,
        );

        // Close the draft
        closeDraft(draftKey);
        await message.reply(
          `Draft \`${draftDisplay}\` has closed and been removed.`,
        );
      }
    }
    return;
  }

  // Leave command: !leave <draft_name>
  if (command === "!leave") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const draftName = parts[1];
    if (!draftName) {
      await message.reply(
        "Usage: `!leave <draft_name>` — draft name is one word, e.g. `!leave TLA`",
      );
      return;
    }

    const draftKey = draftName;
    const draftDisplay = draftName;

    const draft = getAllDrafts().get(draftKey);
    if (!draft) {
      await message.reply(
        `There is no active \`${draftDisplay}\` draft to leave.`,
      );
      return;
    }

    if (!draft.has(message.author.id)) {
      await message.reply(
        `${message.author}, you are not in \`${draftDisplay}\`.`,
      );
      return;
    }

    if (!message.channel.isTextBased() || message.channel.isDMBased()) {
      return;
    }
    const textChannel = message.channel as djs.TextChannel;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would remove ${message.author} from draft \`${draftDisplay}\``,
      );
      return;
    }

    await leaveDraft(draftKey, message.author.id, textChannel, pretend);
    const count = getPlayerCount(draftKey);
    await message.reply(
      `${message.author} has left \`${draftDisplay}\`.\nRemaining players: **${count}**`,
    );

    if (count === 0) {
      removeDraftIfEmpty(draftKey);
      await message.reply(
        `The \`${draftDisplay}\` draft is now empty and has been removed.`,
      );
    }
    return;
  }

  // Fire command: !fire <draft_name> — testing only, owner-only. Closes a queue early and records to Draft Log.
  if (command === "!fire") {
    if (message.author.id !== CONFIG.OWNER_ID) {
      return; // Silent ignore for non-owners
    }
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const draftName = parts[1];
    if (!draftName) {
      await message.reply(
        "Usage: `!fire <draft_name>` — closes the queue early and records players to Draft Log (testing).",
      );
      return;
    }

    const draftKey = draftName;
    const draftDisplay = draftName;
    const draft = getAllDrafts().get(draftKey);

    if (!draft || draft.size === 0) {
      await message.reply(
        `There is no active \`${draftDisplay}\` draft to fire.`,
      );
      return;
    }

    if (!message.channel.isTextBased() || message.channel.isDMBased()) {
      return;
    }

    const userIds = Array.from(draft.keys());
    const count = userIds.length;
    const mentions = userIds.map((uid) => `<@${uid}>`).join(" ");

    await message.reply(
      `🔥 Draft \`${draftDisplay}\` fired early (**${count} player(s)**)!\n${mentions}`,
    );

    await recordDraftToLog(draftKey, userIds, client, pretend);

    if (userIds.length === 8) {
      await createRound1Matchups(draftKey, userIds, pretend, client);
    }

    const draftUuid = crypto.randomUUID();
    await message.reply(
      `Please visit https://draftmancer.com/?session=${draftUuid} to start the draft.`,
    );

    closeDraft(draftKey);
    await message.reply(
      `Draft \`${draftDisplay}\` has closed and been removed.`,
    );
    return;
  }

  // Report command: !report <draft_name> @opponent 2-0 or 2-1 (only in matchmaking channel)
  if (command === "!report") {
    if (!isAllowedMatchmakingChannel(message)) {
      return;
    }

    const draftName = parts[1];
    const mentionedUsers = message.mentions.users.filter((u) => !u.bot);
    const content = message.content.trim();
    const resultMatch = content.match(/2-0|2-1/);

    if (!draftName) {
      await message.reply(
        "Usage: `!report <draft_name> @opponent 2-0` or `!report <draft_name> @opponent 2-1`",
      );
      return;
    }

    if (mentionedUsers.size !== 1) {
      await message.reply(
        "Please tag exactly one player (your opponent, the loser).",
      );
      return;
    }

    const loserId = mentionedUsers.first()!.id;
    if (loserId === message.author.id) {
      await message.reply("You cannot report a match against yourself.");
      return;
    }

    if (
      !resultMatch || (resultMatch[0] !== "2-0" && resultMatch[0] !== "2-1")
    ) {
      await message.reply(
        "Please include the result: `2-0` or `2-1` (you are the winner).",
      );
      return;
    }

    const result = resultMatch[0] as "2-0" | "2-1";
    const winnerId = message.author.id;

    const reportResult = await reportMatch(
      draftName,
      winnerId,
      loserId,
      result,
      pretend,
      client,
    );

    if (reportResult.ok) {
      await message.reply(
        pretend
          ? `[PRETEND] Would record match: you beat <@${loserId}> ${result}.`
          : `Match recorded: you beat <@${loserId}> ${result}.`,
      );
    } else {
      await message.reply(reportResult.error);
    }
    return;
  }

  // Status command: !status <draft_name> (in matchmaking channel)
  if (command === "!status") {
    if (!isAllowedMatchmakingChannel(message)) {
      return;
    }

    const draftName = parts[1];
    if (!draftName) {
      await message.reply(
        "Usage: `!status <draft_name>` — shows current round and matchup status",
      );
      return;
    }

    const status = await getDraftStatus(draftName);

    if (!status.ok) {
      await message.reply(status.error);
      return;
    }

    if ("complete" in status && status.complete) {
      await message.reply(
        `**\`${draftName}\`** — Tournament complete. All rounds finished.`,
      );
      return;
    }

    const { round, matches } = status;
    const userIds = new Set<string>();
    for (const m of matches) {
      userIds.add(m.p1);
      userIds.add(m.p2);
      if (m.winner) userIds.add(m.winner);
    }
    const nameMap = new Map<string, string>();
    for (const id of userIds) {
      const playerName = await getPlayerNameFromDraftLog(id, draftName);
      nameMap.set(id, playerName ?? "Unknown");
    }
    const name = (id: string) => nameMap.get(id) ?? "Unknown";
    const lines = matches.map((m) => {
      if (m.completed && m.winner && m.result) {
        return `Match ${m.matchNum}: ${name(m.p1)} vs ${name(m.p2)} — ${
          name(m.winner)
        } won ${m.result}`;
      }
      return `Match ${m.matchNum}: ${name(m.p1)} vs ${
        name(m.p2)
      } — In progress`;
    });
    await message.reply(
      `**Round ${round} status for \`${draftName}\`:**\n${lines.join("\n")}`,
    );
    return;
  }

  // Available command: !available
  if (command === "!available") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }
    const allDrafts = getAllDrafts();
    if (allDrafts.size === 0) {
      await message.reply("There are currently no active drafts.");
      return;
    }

    const messageLines = ["**Active Drafts:**"];
    for (const [draftKey, players] of allDrafts) {
      // Convert draft key to display format (dash-separated to space-separated)
      const draftDisplay = draftKey.includes("-")
        ? draftKey.split("-").join(" ")
        : draftKey;
      messageLines.push(`- \`${draftDisplay}\`: ${players.size} player(s)`);
    }
    await message.reply(messageLines.join("\n"));
    return;
  }

  // Notify command: !notify <draft_name>
  if (command === "!notify") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const draftName = parts[1];
    if (!draftName) {
      await message.reply(
        "Please provide a draft name (one word). Usage: `!notify TLA`",
      );
      return;
    }

    const draftKey = draftName;
    const draftDisplay = draftName;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would opt ${message.author} in for notifications for \`${draftDisplay}\``,
      );
      return;
    }

    optInForNotifications(message.author.id, draftKey);
    await message.reply(
      `✅ You've been opted in for notifications for \`${draftDisplay}\`. ` +
        `You'll receive a DM when the queue reaches 5+ players (once every 12 hours). ` +
        `Use \`!reset ${draftDisplay}\` to reset your notification timer.`,
    );
    return;
  }

  // Reset command: !reset <draft_name>
  if (command === "!reset") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const draftName = parts[1];
    if (!draftName) {
      await message.reply(
        "Please provide a draft name (one word). Usage: `!reset TLA`",
      );
      return;
    }

    const draftKey = draftName;
    const draftDisplay = draftName;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would reset notification timer for ${message.author} for \`${draftDisplay}\``,
      );
      return;
    }

    const wasReset = resetNotificationTimer(message.author.id, draftKey);
    if (wasReset) {
      await message.reply(
        `✅ Your notification timer for \`${draftDisplay}\` has been reset. ` +
          `You can now receive notifications again if the queue reaches 5+ players.`,
      );
    } else {
      await message.reply(
        `❌ You haven't opted in for notifications for \`${draftDisplay}\`. ` +
          `Use \`!notify ${draftDisplay}\` to opt in first.`,
      );
    }
    return;
  }

  // Cancel command: !cancel <draft_name>
  if (command === "!cancel") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const draftName = parts[1];
    if (!draftName) {
      await message.reply(
        "Please provide a draft name (one word). Usage: `!cancel TLA`",
      );
      return;
    }

    const draftKey = draftName;
    const draftDisplay = draftName;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would opt ${message.author} out of notifications for \`${draftDisplay}\``,
      );
      return;
    }

    const wasOptedOut = optOutOfNotifications(message.author.id, draftKey);
    if (wasOptedOut) {
      await message.reply(
        `✅ You've been opted out of notifications for \`${draftDisplay}\`. ` +
          `You will no longer receive DMs for this set code.`,
      );
    } else {
      await message.reply(
        `❌ You haven't opted in for notifications for \`${draftDisplay}\`. ` +
          `Use \`!notify ${draftDisplay}\` to opt in first.`,
      );
    }
    return;
  }
});

/**
 * Gracefully shuts down the bot, sending a message to the draft channel if configured
 */
async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully...`);

  if (isClientReady && CONFIG.DRAFT_CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(CONFIG.DRAFT_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await (channel as djs.TextChannel).send(
          "⚠️ Bot is going offline. All active drafts will be cleared.",
        );
        // Give the message a moment to send
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error("Error sending shutdown message:", error);
    }
  }

  // Destroy the client
  client.destroy();
  Deno.exit(0);
}

// Set up signal handlers for graceful shutdown
if (command === "bot") {
  // Handle SIGINT (Ctrl+C) - supported on all platforms
  Deno.addSignalListener("SIGINT", () => {
    gracefulShutdown("SIGINT").catch((error) => {
      console.error("Error during shutdown:", error);
      Deno.exit(1);
    });
  });

  // SIGTERM is only supported on Unix-like systems (Linux, macOS)
  // Windows only supports SIGINT, SIGBREAK, and SIGUP
  if (Deno.build.os !== "windows") {
    Deno.addSignalListener("SIGTERM", () => {
      gracefulShutdown("SIGTERM").catch((error) => {
        console.error("Error during shutdown:", error);
        Deno.exit(1);
      });
    });
  }

  await client.login(DISCORD_TOKEN);
} else {
  console.error(`Unknown command: ${command || "(none)"}`);
  console.log("Use --help for usage information");
  Deno.exit(1);
}
