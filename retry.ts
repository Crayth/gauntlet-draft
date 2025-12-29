import { delay } from "@std/async";

const MAX_RETRY_DELAY = 128_000; // milliseconds
const DEFAULT_JITTER = 64; // milliseconds

/**
 * Executes an async operation with exponential backoff and jitter retry logic.
 *
 * @param operation - The async function to execute with retry logic, receives a function to disable retries
 * @param maxRetryDelay - Maximum delay between retries in milliseconds (default: 128,000)
 * @param jitter - Random jitter in milliseconds added to delay (default: 64)
 * @returns Promise that resolves to the operation result or rejects with the last error
 */
export async function withRetry<T>(
  operation: (disableRetry: () => void) => Promise<T>,
  maxRetryDelay: number = MAX_RETRY_DELAY,
  jitter: number = DEFAULT_JITTER,
): Promise<T> {
  let lastError: unknown;
  let disabled = false;

  const disableRetry = () => {
    disabled = true;
  };

  for (let retryDelay = 1000; retryDelay < maxRetryDelay; retryDelay *= 2) {
    try {
      return await operation(disableRetry);
    } catch (e) {
      lastError = e;
      if (disabled) {
        break;
      }
      console.error("Retrying after error:", e);
      await delay(retryDelay + Math.random() * jitter);
    }
  }
  throw lastError;
}

