import { CONFIG } from "./config.ts";
import { DraftLeague } from "./draft_league.ts";

export const liveLeague = new DraftLeague(CONFIG.LIVE_SHEET_ID, "live");

let upcomingLeague: DraftLeague | undefined;

/** The next season's spreadsheet, if configured. */
export function getUpcomingLeague(): DraftLeague | undefined {
  if (!CONFIG.UPCOMING_SHEET_ID) return undefined;
  upcomingLeague ??= new DraftLeague(CONFIG.UPCOMING_SHEET_ID, "upcoming");
  return upcomingLeague;
}

const archiveLeagues = new Map<string, DraftLeague>();

/** Past season spreadsheets for record-keeping and pod lookups. */
export function getArchiveLeagues(): readonly DraftLeague[] {
  for (const sheetId of CONFIG.ARCHIVE_SHEET_IDS ?? []) {
    if (!archiveLeagues.has(sheetId)) {
      archiveLeagues.set(
        sheetId,
        new DraftLeague(sheetId, `archive:${sheetId.slice(0, 8)}`),
      );
    }
  }
  return [...archiveLeagues.values()];
}

/** Leagues that accept new pods and player registrations. */
export function getActiveLeagues(): readonly DraftLeague[] {
  const upcoming = getUpcomingLeague();
  return upcoming ? [liveLeague, upcoming] : [liveLeague];
}

/** Every configured league spreadsheet (active + archived). */
export function getAllLeagues(): readonly DraftLeague[] {
  return [...getActiveLeagues(), ...getArchiveLeagues()];
}

/**
 * Finds which league's Draft Log contains a pod ID.
 * Searches active leagues first, then archives.
 */
export async function resolveLeagueForPodId(
  podId: string,
): Promise<DraftLeague | undefined> {
  for (const league of getAllLeagues()) {
    if (await league.podIdExistsInLog(podId)) {
      return league;
    }
  }
  return undefined;
}
