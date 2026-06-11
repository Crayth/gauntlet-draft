import { CONFIG } from "./config.ts";

import { load } from "@std/dotenv";
import { parseArgs } from "@std/cli/parse-args";
import * as djs from "discord.js";
import { initSheets } from "./sheets.ts";
import { ensurePlayerInDatabase } from "./player_database.ts";
import {
  addPlayerToDraft,
  closeDraft,
  getDraft,
  getPlayerCount,
  getQueueUserIds,
  leaveDraft,
  removeDraftIfEmpty,
} from "./drafts.ts";
import {
  optInForNotifications,
  optOutOfNotifications,
  resetNotificationTimer,
  sendQueueNotifications,
} from "./notifications.ts";
import {
  generatePodId,
  getPlayerNameFromDraftLog,
  recordDraftToLog,
} from "./draft_log.ts";
import { createRound1Matchups, getDraftStatus } from "./matchups.ts";
import { reportMatch } from "./matches.ts";
import { rebuildLeaderboard } from "./leaderboard.ts";

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
  await initSheets();
  console.log("Google Sheets client initialized");

  if (!pretend) {
    try {
      await rebuildLeaderboard();
      console.log("Leaderboards refreshed on startup");
    } catch (error) {
      console.error("Error refreshing leaderboard on startup:", error);
    }
  }

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
    }
  }
});

function getUserDisplayName(
  user: djs.User,
  member: djs.GuildMember | null,
): string {
  if (member) {
    return member.displayName || user.username;
  }
  return user.username;
}

function isAllowedDraftChannel(message: djs.Message): boolean {
  if (!CONFIG.DRAFT_CHANNEL_ID) {
    return true;
  }
  return message.channel.id === CONFIG.DRAFT_CHANNEL_ID;
}

function isAllowedMatchmakingChannel(message: djs.Message): boolean {
  return message.channel.id === CONFIG.MATCHMAKING_CHANNEL_ID;
}

export async function ensureUserInDatabase(
  user: djs.User,
  member: djs.GuildMember | null,
): Promise<void> {
  try {
    const userName = getUserDisplayName(user, member);
    await ensurePlayerInDatabase(userName, user.id, pretend);
  } catch (error) {
    console.error("Error ensuring user in database:", error);
  }
}

function buildDraftmancerSetLink(): string {
  if (!CONFIG.QUEST_ANNOUNCEMENT_CHANNEL_ID) {
    throw new Error(
      "QUEST_ANNOUNCEMENT_CHANNEL_ID must be configured to link to the draft set message",
    );
  }
  return `https://discord.com/channels/${CONFIG.GUILD_ID}/${CONFIG.QUEST_ANNOUNCEMENT_CHANNEL_ID}/${CONFIG.DRAFTMANCER_SET_MESSAGE_ID}`;
}

/**
 * Fires the draft queue: records pod, creates matchups (if 8 players), posts Draftmancer link.
 */
async function fireDraftQueue(
  reply: (content: string) => Promise<djs.Message>,
): Promise<boolean> {
  const draft = getDraft();
  if (!draft || draft.size === 0) {
    return false;
  }

  const userIds = getQueueUserIds();

  let podId: string;
  try {
    podId = await generatePodId(pretend);
  } catch (error) {
    console.error("Failed to generate pod ID:", error);
    await reply(
      "Failed to generate a pod ID. The queue was not closed — please try again.",
    );
    return false;
  }

  let setLink: string;
  try {
    setLink = buildDraftmancerSetLink();
  } catch (error) {
    console.error("Failed to build draft set message link:", error);
    await reply(
      "Failed to build draft set message link. The queue was not closed — check bot configuration.",
    );
    return false;
  }

  const mentions = userIds.map((uid) => `<@${uid}>`).join(" ");

  await reply(
    `🔥 Draft pod \`${podId}\` is ready (**${userIds.length} players**)!\n${mentions}`,
  );

  await recordDraftToLog(podId, userIds, client, pretend);

  let seatText = "";
  if (userIds.length === 8) {
    const seatOrder = await createRound1Matchups(
      podId,
      userIds,
      pretend,
      client,
    );
    const seatLines: string[] = [];
    for (let i = 0; i < seatOrder.length; i++) {
      const name = (await getPlayerNameFromDraftLog(seatOrder[i], podId)) ??
        `<@${seatOrder[i]}>`;
      seatLines.push(`${i + 1}. ${name}`);
    }
    if (seatLines.length > 0) {
      seatText = `\n**Seat order:**\n${seatLines.join("\n")}`;
    }
  } else {
    seatText = `\n*(Matchups will be created when a full 8-player pod fires.)*`;
  }

  await reply(
    `Use the draftmancer link in the announcement channel to start the draft, and share with your fellow opponents: ${setLink}${seatText}\n\n` +
      `Pod ID: \`${podId}\` — use \`!report ${podId} @opponent 2-0\` and \`!status ${podId}\` for match tracking.`,
  );

  closeDraft();
  await reply(
    "The draft queue has closed. Use `!draft` to join the next pod.",
  );
  return true;
}

function parseQueueTimeoutHours(parts: string[]): number | undefined {
  const arg = parts[1];
  if (!arg) return undefined;
  const timeoutNum = parseInt(arg, 10);
  if (!isNaN(timeoutNum) && timeoutNum >= 1 && timeoutNum <= 12) {
    return timeoutNum;
  }
  return undefined;
}

client.on(djs.Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild || !message.member) return;

  await ensureUserInDatabase(message.author, message.member);

  const content = message.content.trim();
  const parts = content.split(/\s+/);
  const command = parts[0];

  if (command === "!help") {
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const helpMessage = `**Available Commands:**

\`!draft\` - Join the draft queue
  • Optional \`<hours>\` (1-12): Remove me if queue doesn't reach 8 in that time (e.g. \`!draft 4\`)
  • At 8 players: queue fires with a Draftmancer link and pod ID for match reporting

\`!leave\` - Leave the draft queue

\`!notify\` - Opt in for DM notifications when queue reaches 5+ players (once per 12 hours)

\`!reset\` - Reset notification timer to receive notifications immediately

\`!cancel\` - Opt out of notifications

\`!available\` - Show current queue player count

\`!report <pod_id> @opponent 2-0\` or \`!report <pod_id> @opponent 2-1\` - Report a match result (e.g. \`!report P4827 @opponent 2-0\`)

\`!status <pod_id>\` - Show current round and matchup status

\`!fire\` - (Testing) Fire the queue immediately with current players

\`!help\` - Show this help message

**Notes:**
• Draft commands must be used in the designated draft channel (if configured)
• \`!report\` and \`!status\` must be used in the designated matchmaking channel (if configured)
• Round matchups and pod final standings are announced in the matchmaking channel
• After 1 hour in the queue (without a queue timeout), you'll receive a DM to confirm. Respond in DMs with \`!yes\` within 5 minutes or \`!leave\` to leave
• Players are automatically removed if they don't respond to the inactivity reminder
• Drafts are cleared when the bot goes offline`;

    await message.reply(helpMessage);
    return;
  }

  if (command === "!draft") {
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const queueTimeoutHours = parseQueueTimeoutHours(parts);

    const existingDraft = getDraft();
    if (existingDraft?.has(message.author.id)) {
      await message.reply(
        `${message.author}, you are already in the draft queue.`,
      );
      return;
    }

    if (!message.channel.isTextBased() || message.channel.isDMBased()) {
      return;
    }
    const textChannel = message.channel as djs.TextChannel;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would add ${message.author} to the draft queue`,
      );
      return;
    }

    const wasAdded = addPlayerToDraft(
      message.author.id,
      textChannel,
      client,
      pretend,
      queueTimeoutHours,
    );

    if (!wasAdded) {
      await message.reply(
        `${message.author}, you are already in the draft queue.`,
      );
      return;
    }

    const count = getPlayerCount();
    const timeoutNote = queueTimeoutHours !== undefined
      ? ` You will be removed if the queue doesn't reach 8 in ${queueTimeoutHours} hour(s).`
      : "";
    await message.reply(
      `${message.author} has joined the draft queue.\nCurrent players: **${count}**${timeoutNote}`,
    );

    if (count >= 5) {
      await sendQueueNotifications(count, client);
    }

    if (count === 8) {
      await fireDraftQueue((text) => message.reply(text));
    }
    return;
  }

  if (command === "!leave") {
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const draft = getDraft();
    if (!draft) {
      await message.reply("There is no active draft queue to leave.");
      return;
    }

    if (!draft.has(message.author.id)) {
      await message.reply(`${message.author}, you are not in the draft queue.`);
      return;
    }

    if (!message.channel.isTextBased() || message.channel.isDMBased()) {
      return;
    }
    const textChannel = message.channel as djs.TextChannel;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would remove ${message.author} from the draft queue`,
      );
      return;
    }

    await leaveDraft(message.author.id, textChannel, pretend);
    const count = getPlayerCount();
    await message.reply(
      `${message.author} has left the draft queue.\nRemaining players: **${count}**`,
    );

    if (count === 0) {
      removeDraftIfEmpty();
      await message.reply("The draft queue is now empty and has been removed.");
    }
    return;
  }

  if (command === "!fire") {
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    if (!message.channel.isTextBased() || message.channel.isDMBased()) {
      return;
    }

    const count = getPlayerCount();
    if (count === 0) {
      await message.reply("The draft queue is empty — nothing to fire.");
      return;
    }

    if (pretend) {
      await message.reply(
        `[PRETEND] Would fire the draft queue with ${count} player(s).`,
      );
      return;
    }

    await fireDraftQueue((text) => message.reply(text));
    return;
  }

  if (command === "!report") {
    if (!isAllowedMatchmakingChannel(message)) {
      return;
    }

    const podId = parts[1];
    const mentionedUsers = message.mentions.users.filter((u) => !u.bot);
    const resultMatch = content.match(/2-0|2-1/);

    if (!podId) {
      await message.reply(
        "Usage: `!report <pod_id> @opponent 2-0` or `!report <pod_id> @opponent 2-1`",
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
      podId,
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

  if (command === "!status") {
    if (!isAllowedMatchmakingChannel(message)) {
      return;
    }

    const podId = parts[1];
    if (!podId) {
      await message.reply(
        "Usage: `!status <pod_id>` — shows current round and matchup status",
      );
      return;
    }

    const status = await getDraftStatus(podId);

    if (!status.ok) {
      await message.reply(status.error);
      return;
    }

    if ("complete" in status && status.complete) {
      await message.reply(
        `**Pod \`${podId}\`** — Tournament complete. All rounds finished.`,
      );
      return;
    }

    if (!status.ok || !("round" in status)) {
      await message.reply("Unable to load pod status.");
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
      const playerName = await getPlayerNameFromDraftLog(id, podId);
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
      `**Round ${round} status for pod \`${podId}\`:**\n${lines.join("\n")}`,
    );
    return;
  }

  if (command === "!available") {
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    const count = getPlayerCount();
    if (count === 0) {
      await message.reply("The draft queue is currently empty.");
      return;
    }

    await message.reply(
      `**Draft queue:** ${count} player(s) waiting (fires at 8).`,
    );
    return;
  }

  if (command === "!notify") {
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    if (pretend) {
      await message.reply(
        `[PRETEND] Would opt ${message.author} in for draft queue notifications`,
      );
      return;
    }

    optInForNotifications(message.author.id);
    await message.reply(
      "✅ You've been opted in for draft queue notifications. " +
        "You'll receive a DM when the queue reaches 5+ players (once every 12 hours). " +
        "Use `!reset` to reset your notification timer.",
    );
    return;
  }

  if (command === "!reset") {
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    if (pretend) {
      await message.reply(
        `[PRETEND] Would reset notification timer for ${message.author}`,
      );
      return;
    }

    const wasReset = resetNotificationTimer(message.author.id);
    if (wasReset) {
      await message.reply(
        "✅ Your notification timer has been reset. " +
          "You can now receive notifications again if the queue reaches 5+ players.",
      );
    } else {
      await message.reply(
        "❌ You haven't opted in for notifications. Use `!notify` to opt in first.",
      );
    }
    return;
  }

  if (command === "!cancel") {
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    if (pretend) {
      await message.reply(
        `[PRETEND] Would opt ${message.author} out of notifications`,
      );
      return;
    }

    const wasOptedOut = optOutOfNotifications(message.author.id);
    if (wasOptedOut) {
      await message.reply(
        "✅ You've been opted out of draft queue notifications.",
      );
    } else {
      await message.reply(
        "❌ You haven't opted in for notifications. Use `!notify` to opt in first.",
      );
    }
    return;
  }
});

async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully...`);

  if (isClientReady && CONFIG.DRAFT_CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(CONFIG.DRAFT_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await (channel as djs.TextChannel).send(
          "⚠️ Bot is going offline. All active drafts will be cleared.",
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error("Error sending shutdown message:", error);
    }
  }

  client.destroy();
  Deno.exit(0);
}

if (command === "bot") {
  Deno.addSignalListener("SIGINT", () => {
    gracefulShutdown("SIGINT").catch((error) => {
      console.error("Error during shutdown:", error);
      Deno.exit(1);
    });
  });

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
