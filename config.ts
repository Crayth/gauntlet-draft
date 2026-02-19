import rawConfig from "./private/config.json" with { type: "json" };

export const CONFIG: Config = rawConfig;

export interface Config {
  readonly OWNER_ID: string;
  readonly GUILD_ID: string;
  readonly LIVE_SHEET_ID: string;
  readonly DRAFT_CHANNEL_ID?: string; // Optional - if not set, drafts can be used in any channel
  readonly MATCHMAKING_CHANNEL_ID?: string; // Optional - if set, !report only works in this channel
}
