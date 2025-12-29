import { CONFIG } from "./config.ts";

import { load } from "@std/dotenv";
import { parseArgs } from "@std/cli/parse-args";
import * as djs from "discord.js";
import { initSheets } from "./sheets.ts";
import { ensurePlayerInDatabase } from "./player_database.ts";
import {
  addPlayerToDraft,
  leaveDraft,
  getAllDrafts,
  getPlayerCount,
  closeDraft,
  removeDraftIfEmpty,
} from "./drafts.ts";

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
  ],
});

let isClientReady = false;

client.once(djs.Events.ClientReady, async (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  isClientReady = true;
  // Initialize Google Sheets client
  await initSheets();
  console.log("Google Sheets client initialized");
});

/**
 * Gets the display name for a Discord user, preferring guild display name if available.
 */
function getUserDisplayName(user: djs.User, member: djs.GuildMember | null): string {
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

\`!draft <set_code>\` - Join or create a draft for a 3-letter set code
  Example: \`!draft TLA\`
  • Adds you to the draft queue for the specified set
  • At 4 players: Notifies all participants with a suggestion for pick 2 drafts
  • At 3 players: Draft is full, generates draftmancer.com link, and closes

\`!leave <set_code>\` - Leave a draft
  Example: \`!leave TLA\`
  • Removes you from the specified draft queue

\`!available\` - List all active drafts
  • Shows all current draft queues and their player counts

\`!help\` - Show this help message

**Notes:**
• All draft commands must be used in the designated draft channel (if configured)
• After 1 hour in a draft, you'll be pinged to confirm you still want to stay
• Respond with \`!yes\` within 5 minutes to reset your timer, or \`!leave <set_code>\` to leave
• Players are automatically removed if they don't respond to the inactivity reminder
• Drafts are cleared when the bot goes offline`;

    await message.reply(helpMessage);
    return;
  }

  // Draft command: !draft <set_code>
  if (command === "!draft") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }
    const formatAcronym = parts[1];
    if (!formatAcronym) {
      await message.reply("Please provide a 3-letter set code. Example: `!draft TLA`");
      return;
    }

    const upperAcronym = formatAcronym.toUpperCase();
    if (upperAcronym.length !== 3) {
      await message.reply("Invalid code. Use a 3-letter code.");
      return;
    }

    // Check if user is already in the draft
    const existingDraft = getAllDrafts().get(upperAcronym);
    if (existingDraft && existingDraft.has(message.author.id)) {
      await message.reply(
        `${message.author}, you are already in \`${upperAcronym}\`.`,
      );
      return;
    }

    // Add player to draft
    if (!message.channel.isTextBased() || message.channel.isDMBased()) {
      return;
    }
    const textChannel = message.channel as djs.TextChannel;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would add ${message.author} to draft \`${upperAcronym}\``,
      );
      return;
    }

    const wasAdded = addPlayerToDraft(
      upperAcronym,
      message.author.id,
      textChannel,
      client,
      pretend,
    );

    if (!wasAdded) {
      await message.reply(
        `${message.author}, you are already in \`${upperAcronym}\`.`,
      );
      return;
    }

    const count = getPlayerCount(upperAcronym);
    await message.reply(
      `${message.author} has joined \`${upperAcronym}\`.\nCurrent players: **${count}**`,
    );

    // Ping at 4 players
    if (count === 4) {
      const draft = getAllDrafts().get(upperAcronym);
      if (draft) {
        const mentions = Array.from(draft.keys())
          .map((uid) => `<@${uid}>`)
          .join(" ");
        await message.reply(
          `🎉 Draft \`${upperAcronym}\` now has **4 players**!\n${mentions}`,
        );
        await message.reply(
          "Why not consider a pick 2 draft on draftmancer.com if finding 8 is difficult?",
        );
      }
    }

    // Ping and close at 3 players (changed from 8 for testing)
    if (count === 3) {
      const draft = getAllDrafts().get(upperAcronym);
      if (draft) {
        const mentions = Array.from(draft.keys())
          .map((uid) => `<@${uid}>`)
          .join(" ");
        await message.reply(
          `🔥 Draft \`${upperAcronym}\` is FULL (**3 players**)!\n${mentions}`,
        );

        // Generate UUID for draftmancer.com session
        const draftUuid = crypto.randomUUID();
        await message.reply(
          `Please visit https://draftmancer.com/?session=${draftUuid} to start the draft.`,
        );

        // Close the draft
        closeDraft(upperAcronym);
        await message.reply(
          `Draft \`${upperAcronym}\` has closed and been removed.`,
        );
      }
    }
    return;
  }

  // Leave command: !leave <set_code>
  if (command === "!leave") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }
    const formatAcronym = parts[1];
    if (!formatAcronym) {
      await message.reply(
        "Usage: `!leave TLA` — remove yourself from that draft",
      );
      return;
    }

    const upperAcronym = formatAcronym.toUpperCase();
    const draft = getAllDrafts().get(upperAcronym);
    if (!draft) {
      await message.reply(
        `There is no active \`${upperAcronym}\` draft to leave.`,
      );
      return;
    }

    if (!draft.has(message.author.id)) {
      await message.reply(
        `${message.author}, you are not in \`${upperAcronym}\`.`,
      );
      return;
    }

    if (!message.channel.isTextBased() || message.channel.isDMBased()) {
      return;
    }
    const textChannel = message.channel as djs.TextChannel;

    if (pretend) {
      await message.reply(
        `[PRETEND] Would remove ${message.author} from draft \`${upperAcronym}\``,
      );
      return;
    }

    await leaveDraft(upperAcronym, message.author.id, textChannel, pretend);
    const count = getPlayerCount(upperAcronym);
    await message.reply(
      `${message.author} has left \`${upperAcronym}\`.\nRemaining players: **${count}**`,
    );

    if (count === 0) {
      removeDraftIfEmpty(upperAcronym);
      await message.reply(
        `The \`${upperAcronym}\` draft is now empty and has been removed.`,
      );
    }
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
    for (const [draftName, players] of allDrafts) {
      messageLines.push(`- \`${draftName}\`: ${players.size} player(s)`);
    }
    await message.reply(messageLines.join("\n"));
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

