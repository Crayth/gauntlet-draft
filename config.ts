import rawConfig from "./private/config.json" with { type: "json" };

export const CONFIG: Config = rawConfig;

export interface Config {
  readonly OWNER_ID: string;
  readonly GUILD_ID: string;
  readonly LIVE_SHEET_ID: string;
  readonly DRAFT_CHANNEL_ID?: string;
  readonly MATCHMAKING_CHANNEL_ID?: string;
  readonly QUEST_ANNOUNCEMENT_CHANNEL_ID?: string;
  readonly DRAFTMANCER_SET_MESSAGE_ID: string;
}
