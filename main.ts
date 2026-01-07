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
import {
  optInForNotifications,
  optOutOfNotifications,
  resetNotificationTimer,
  getOptedInSetCodes,
  sendNotificationsForSetCode,
} from "./notifications.ts";

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

\`!draft <set_code>\` or \`!draft <set_code1> <set_code2> <set_code3>\` - Join or create a draft
  Examples: \`!draft TLA\` or \`!draft TLA FIN DFT\`
  • Adds you to the draft queue for the specified set(s)
  • Single set: One pack from that set
  • Three sets: One pack from each set (e.g., TLA + FIN + DFT)
  • At 4 players: Notifies all participants with a suggestion for pick 2 drafts
  • At 8 players: Draft is full, generates draftmancer.com link, and closes

\`!leave <set_code>\` or \`!leave <set_code1> <set_code2> <set_code3>\` - Leave a draft
  Examples: \`!leave TLA\` or \`!leave TLA FIN DFT\`
  • Removes you from the specified draft queue
  • Use the same format you used to join (1 or 3 set codes)

\`!notify <set_code>\` or \`!notify <set_code1> <set_code2> <set_code3>\` - Opt in for DM notifications
  Examples: \`!notify TLA\` or \`!notify TLA FIN DFT\`
  • You'll receive a DM when the queue reaches 5+ players for that set
  • Notifications are sent once every 12 hours per set code
  • Use \`!reset <set_code>\` to reset your notification timer

\`!reset <set_code>\` or \`!reset <set_code1> <set_code2> <set_code3>\` - Reset notification timer
  Examples: \`!reset TLA\` or \`!reset TLA FIN DFT\`
  • Resets your notification timer for the specified set code
  • Allows you to receive notifications again immediately

\`!cancel <set_code>\` or \`!cancel <set_code1> <set_code2> <set_code3>\` - Opt out of notifications
  Examples: \`!cancel TLA\` or \`!cancel TLA FIN DFT\`
  • Removes your opt-in for notifications for the specified set code
  • You will no longer receive DMs for this set code

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

  // Draft command: !draft <set_code> or !draft <set_code1> <set_code2> <set_code3>
  if (command === "!draft") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }
    
    // Parse set codes (expect 1 or 3)
    const setCodes = parts.slice(1).filter((part) => part.length > 0);
    
    if (setCodes.length === 0) {
      await message.reply(
        "Please provide 1 or 3 set codes. Examples: `!draft TLA` or `!draft TLA FIN DFT`",
      );
      return;
    }

    if (setCodes.length !== 1 && setCodes.length !== 3) {
      await message.reply(
        "Please provide exactly 1 or 3 set codes. Examples: `!draft TLA` or `!draft TLA FIN DFT`",
      );
      return;
    }

    // Validate all codes are 3 letters
    const upperCodes = setCodes.map((code) => code.toUpperCase());
    for (const code of upperCodes) {
      if (code.length !== 3) {
        await message.reply(
          `Invalid code: \`${code}\`. All set codes must be exactly 3 letters.`,
        );
        return;
      }
    }

    // Create draft key: single code stays as-is, multiple codes joined with dashes
    const draftKey = upperCodes.length === 1 
      ? upperCodes[0] 
      : upperCodes.join("-");
    
    // Display format for messages
    const draftDisplay = upperCodes.join(" ");

    // Check if user is already in the draft
    const existingDraft = getAllDrafts().get(draftKey);
    if (existingDraft && existingDraft.has(message.author.id)) {
      await message.reply(
        `${message.author}, you are already in \`${draftDisplay}\`.`,
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
    );

    if (!wasAdded) {
      await message.reply(
        `${message.author}, you are already in \`${draftDisplay}\`.`,
      );
      return;
    }

    const count = getPlayerCount(draftKey);
    await message.reply(
      `${message.author} has joined \`${draftDisplay}\`.\nCurrent players: **${count}**`,
    );

    // Ping at 4 players
    if (count === 4) {
      const draft = getAllDrafts().get(draftKey);
      if (draft) {
        const mentions = Array.from(draft.keys())
          .map((uid) => `<@${uid}>`)
          .join(" ");
        await message.reply(
          `🎉 Draft \`${draftDisplay}\` now has **4 players**!\n${mentions}`,
        );
        await message.reply(
          "Why not consider a pick 2 draft on draftmancer.com if finding 8 is difficult?",
        );
      }
    }

    // Send notifications at 5+ players
    if (count >= 5) {
      await sendNotificationsForSetCode(draftKey, count, client);
    }

    // Ping and close at 8 players
    if (count === 8) {
      const draft = getAllDrafts().get(draftKey);
      if (draft) {
        const mentions = Array.from(draft.keys())
          .map((uid) => `<@${uid}>`)
          .join(" ");
        await message.reply(
          `🔥 Draft \`${draftDisplay}\` is FULL (**8 players**)!\n${mentions}`,
        );

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

  // Leave command: !leave <set_code> or !leave <set_code1> <set_code2> <set_code3>
  if (command === "!leave") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }
    
    // Parse set codes (expect 1 or 3, matching the draft format)
    const setCodes = parts.slice(1).filter((part) => part.length > 0);
    
    if (setCodes.length === 0) {
      await message.reply(
        "Usage: `!leave TLA` or `!leave TLA FIN DFT` — remove yourself from that draft",
      );
      return;
    }

    if (setCodes.length !== 1 && setCodes.length !== 3) {
      await message.reply(
        "Please provide exactly 1 or 3 set codes to match the draft format.",
      );
      return;
    }

    // Validate all codes are 3 letters
    const upperCodes = setCodes.map((code) => code.toUpperCase());
    for (const code of upperCodes) {
      if (code.length !== 3) {
        await message.reply(
          `Invalid code: \`${code}\`. All set codes must be exactly 3 letters.`,
        );
        return;
      }
    }

    // Create draft key: single code stays as-is, multiple codes joined with dashes
    const draftKey = upperCodes.length === 1 
      ? upperCodes[0] 
      : upperCodes.join("-");
    
    // Display format for messages
    const draftDisplay = upperCodes.join(" ");

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

  // Notify command: !notify <set_code>
  if (command === "!notify") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    // Parse set code
    const setCode = parts[1];
    if (!setCode) {
      await message.reply(
        "Please provide a set code. Usage: `!notify TLA` or `!notify TLA FIN DFT`",
      );
      return;
    }

    // Validate set code format (can be 1 or 3 codes, matching draft format)
    const setCodes = parts.slice(1).filter((part) => part.length > 0);
    if (setCodes.length !== 1 && setCodes.length !== 3) {
      await message.reply(
        "Please provide exactly 1 or 3 set codes. Examples: `!notify TLA` or `!notify TLA FIN DFT`",
      );
      return;
    }

    // Validate all codes are 3 letters
    const upperCodes = setCodes.map((code) => code.toUpperCase());
    for (const code of upperCodes) {
      if (code.length !== 3) {
        await message.reply(
          `Invalid code: \`${code}\`. All set codes must be exactly 3 letters.`,
        );
        return;
      }
    }

    // Create draft key: single code stays as-is, multiple codes joined with dashes
    const draftKey = upperCodes.length === 1 
      ? upperCodes[0] 
      : upperCodes.join("-");
    
    // Display format for messages
    const draftDisplay = upperCodes.join(" ");

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

  // Reset command: !reset <set_code>
  if (command === "!reset") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    // Parse set code
    const setCodes = parts.slice(1).filter((part) => part.length > 0);
    if (setCodes.length === 0) {
      await message.reply(
        "Please provide a set code. Usage: `!reset TLA` or `!reset TLA FIN DFT`",
      );
      return;
    }

    if (setCodes.length !== 1 && setCodes.length !== 3) {
      await message.reply(
        "Please provide exactly 1 or 3 set codes. Examples: `!reset TLA` or `!reset TLA FIN DFT`",
      );
      return;
    }

    // Validate all codes are 3 letters
    const upperCodes = setCodes.map((code) => code.toUpperCase());
    for (const code of upperCodes) {
      if (code.length !== 3) {
        await message.reply(
          `Invalid code: \`${code}\`. All set codes must be exactly 3 letters.`,
        );
        return;
      }
    }

    // Create draft key: single code stays as-is, multiple codes joined with dashes
    const draftKey = upperCodes.length === 1 
      ? upperCodes[0] 
      : upperCodes.join("-");
    
    // Display format for messages
    const draftDisplay = upperCodes.join(" ");

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

  // Cancel command: !cancel <set_code>
  if (command === "!cancel") {
    // Check if command is from allowed channel
    if (!isAllowedDraftChannel(message)) {
      return;
    }

    // Parse set code
    const setCodes = parts.slice(1).filter((part) => part.length > 0);
    if (setCodes.length === 0) {
      await message.reply(
        "Please provide a set code. Usage: `!cancel TLA` or `!cancel TLA FIN DFT`",
      );
      return;
    }

    if (setCodes.length !== 1 && setCodes.length !== 3) {
      await message.reply(
        "Please provide exactly 1 or 3 set codes. Examples: `!cancel TLA` or `!cancel TLA FIN DFT`",
      );
      return;
    }

    // Validate all codes are 3 letters
    const upperCodes = setCodes.map((code) => code.toUpperCase());
    for (const code of upperCodes) {
      if (code.length !== 3) {
        await message.reply(
          `Invalid code: \`${code}\`. All set codes must be exactly 3 letters.`,
        );
        return;
      }
    }

    // Create draft key: single code stays as-is, multiple codes joined with dashes
    const draftKey = upperCodes.length === 1 
      ? upperCodes[0] 
      : upperCodes.join("-");
    
    // Display format for messages
    const draftDisplay = upperCodes.join(" ");

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

