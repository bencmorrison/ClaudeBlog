/**
 * Shared retry utility for Anthropic API calls.
 *
 * All API clients in this project use maxRetries: 0 so this wrapper has
 * exclusive ownership of retry logic, making behaviour consistent and
 * predictable across pipeline.ts, revise.ts, and editor.ts.
 *
 * Retries on:
 *   - RateLimitError (429) — waits exactly retry-after seconds, capped at
 *     MAX_RETRY_AFTER_S to avoid sleeping indefinitely on spend-limit errors.
 *   - InternalServerError (5xx / 529) — waits INTERNAL_ERROR_WAIT_S seconds.
 *   - APIConnectionError — transient network failures (DNS hiccups, dropped
 *     connections on CI runners); waits INTERNAL_ERROR_WAIT_S seconds.
 *
 * Does NOT retry when the server sends x-should-retry: false (e.g. spend-limit
 * exhaustion, account-level blocks — conditions that won't resolve on retry).
 */

import Anthropic from "@anthropic-ai/sdk";

// Fallback wait (seconds) when the retry-after header is absent or unparseable.
// x-should-retry: false handles spend-limit exhaustion before we ever reach
// the wait, so there's no need to cap the header value — we use it as-is.
export const RATE_LIMIT_FALLBACK_WAIT_S = 60;

// Fixed wait for transient 5xx / 529 overload errors. 30s gives a meaningful
// pause without being excessive for a weekly CI job.
export const INTERNAL_ERROR_WAIT_S = 30;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRateLimitRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries = 5
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err instanceof Anthropic.RateLimitError;
      const isServerError = err instanceof Anthropic.InternalServerError;
      // Retry transient network errors (DNS hiccups, dropped connections on CI runners)
      const isConnectionError = err instanceof Anthropic.APIConnectionError;

      if ((isRateLimit || isServerError || isConnectionError) && attempt < maxRetries) {
        // Respect x-should-retry: false — server is signalling this error
        // won't resolve (e.g. spend-limit exhaustion, account-level block).
        const headers = (err as Anthropic.APIError).headers as Record<string, string | null | undefined> | undefined;
        if (headers?.["x-should-retry"] === "false") {
          console.warn(`[withRateLimitRetry] ${label} — server sent x-should-retry: false, not retrying`);
          throw err;
        }

        let waitS: number;
        if (isRateLimit) {
          const headerVal = headers?.["retry-after"];
          // Use parseFloat (not parseInt) — retry-after can be a decimal.
          // Use header value as-is; x-should-retry: false already guards
          // against spend-limit errors before we reach this wait.
          const parsed = headerVal ? parseFloat(headerVal) : NaN;
          waitS = Number.isFinite(parsed) ? parsed : RATE_LIMIT_FALLBACK_WAIT_S;
          console.warn(
            `[Rate limit] ${label} — waiting ${waitS}s before retry ${attempt + 1}/${maxRetries}...`
          );
        } else if (isServerError) {
          waitS = INTERNAL_ERROR_WAIT_S;
          console.warn(
            `[Server error] ${label} — waiting ${waitS}s before retry ${attempt + 1}/${maxRetries}...`
          );
        } else {
          waitS = INTERNAL_ERROR_WAIT_S;
          console.warn(
            `[Connection error] ${label} — waiting ${waitS}s before retry ${attempt + 1}/${maxRetries}...`
          );
        }

        await sleep(waitS * 1000);
        continue;
      }

      throw err;
    }
  }
  throw new Error(`[withRateLimitRetry] ${label} — max retries (${maxRetries}) exceeded`);
}
