import { delay } from "@std/async";
import { load } from "@std/dotenv";
import { auth, Sheets } from "sheets";
import { withRetry } from "./retry.ts";
import { GoogleApiError } from "googleapis";

export const env = await load({ export: true });

/** Minimum gap between Sheets API calls (~40 requests/min). */
const MIN_REQUEST_INTERVAL_MS = 1_500;

let lastRequestAt = 0;
let requestQueue: Promise<unknown> = Promise.resolve();

/**
 * Serializes Sheets API calls with a minimum delay between requests.
 */
function throttleSheetsRequest<T>(operation: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(async () => {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < MIN_REQUEST_INTERVAL_MS) {
      await delay(MIN_REQUEST_INTERVAL_MS - elapsed);
    }
    lastRequestAt = Date.now();
    return await operation();
  });
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}

function withSmartRetry<T>(
  operation: (disable: () => void) => Promise<T>,
): Promise<T> {
  return throttleSheetsRequest(() =>
    withRetry(async (disable) => {
      try {
        return await operation(disable);
      } catch (e) {
        if (e instanceof GoogleApiError && e.code === 400) {
          disable();
        }
        throw e;
      }
    })
  );
}

/**
 * Appends values to a Google Sheets range with retry logic.
 *
 * @param sheets - Authenticated Sheets client instance
 * @param sheetId - The Google Sheets document ID
 * @param range - The range to append to in A1 notation (e.g., "Sheet1!A:A") or R1C1 notation
 * @param values - 2D array of string values to append
 * @param valueInputOption - RAW strings or USER_ENTERED; RAW is default here
 * @returns Promise that resolves to the append response
 */
export function sheetsAppend(
  sheets: Sheets,
  sheetId: string,
  range: string,
  values: unknown[][],
  valueInputOption?: "RAW" | "USER_ENTERED",
) {
  return withSmartRetry(() =>
    sheets.spreadsheetsValuesAppend(
      range,
      sheetId,
      { values },
      { valueInputOption: valueInputOption ?? "RAW" },
    )
  );
}

/**
 * Writes values to a Google Sheets range with retry logic.
 *
 * @param sheets - Authenticated Sheets client instance
 * @param sheetId - The Google Sheets document ID
 * @param range - The range to write to in A1 notation (e.g., "Sheet1!A1:C10")
 * @param values - 2D array of values to write
 * @param valueInputOption - RAW strings or USER_ENTERED; RAW is default here
 * @returns Promise that resolves to the update response
 */
export function sheetsWrite(
  sheets: Sheets,
  sheetId: string,
  range: string,
  values: unknown[][],
  valueInputOption?: "RAW" | "USER_ENTERED",
) {
  return withSmartRetry(() =>
    sheets.spreadsheetsValuesUpdate(
      range,
      sheetId,
      { values },
      { valueInputOption: valueInputOption ?? "RAW" },
    )
  );
}

/**
 * Reads values from a Google Sheets range with retry logic.
 *
 * @param sheets - Authenticated Sheets client instance
 * @param sheetId - The Google Sheets document ID
 * @param range - The range to read in A1 notation (e.g., "Sheet1!A1:C10") or R1C1 notation
 * @param valueRenderOption - How values should be rendered (default: "FORMATTED_VALUE")
 * @returns Promise that resolves to the spreadsheet values response
 */
export function sheetsRead(
  sheets: Sheets,
  sheetId: string,
  range: string,
  valueRenderOption: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA" =
    "FORMATTED_VALUE",
) {
  return withSmartRetry(() =>
    sheets.spreadsheetsValuesGet(
      range,
      sheetId,
      { valueRenderOption },
    )
  );
}

/**
 * Global Sheets client instance. Must be initialized with `initSheets()` before use.
 * Will throw an error if accessed before initialization.
 */
export let sheets: Sheets;

/**
 * Initializes the global sheets client with application default credentials.
 *
 * @returns Promise that resolves when the sheets client is initialized
 */
export const initSheets = async () =>
  sheets ??= new Sheets((await auth.getApplicationDefault()).credential);
