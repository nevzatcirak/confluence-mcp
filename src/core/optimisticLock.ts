/**
 * Optimistic-locking retry wrapper.
 *
 * Confluence write endpoints carry the current page version (a numeric
 * counter, exposed as `version.number` on page payloads); concurrent writers
 * cause HTTP 409 conflicts. This wrapper re-fetches the current resource,
 * applies the mutation against the fresh version and retries exactly once
 * (default) before giving up.
 *
 * Confluence returns the version nested as `version.number`; use
 * `versionNumberOf` to flatten a raw payload into the `{ version: number }`
 * shape this wrapper works with.
 */

import { asNumber, asRecord } from "./json.js";
import { RestError } from "./restClient.js";

export interface OptimisticLockOptions<T> {
  /** Fetch the current resource, including its `version`. */
  fetchCurrent: () => Promise<Record<string, unknown> & { version: number }>;
  /** Apply the write against the (fresh) current resource. */
  apply: (current: Record<string, unknown> & { version: number }) => Promise<T>;
  /** How many retries after the first conflict. Default: 1. */
  maxRetries?: number;
  /** Observability hook: called before each retry attempt. */
  onRetry?: (attempt: number, error: RestError) => void;
}

export async function withOptimisticLock<T>(options: OptimisticLockOptions<T>): Promise<T> {
  const maxRetries = options.maxRetries ?? 1;
  let current = await options.fetchCurrent();

  for (let attempt = 0; ; attempt++) {
    try {
      return await options.apply(current);
    } catch (err) {
      const isConflict = err instanceof RestError && err.status === 409;
      if (!isConflict || attempt >= maxRetries) throw err;
      options.onRetry?.(attempt + 1, err);
      current = await options.fetchCurrent();
    }
  }
}

/**
 * Extract the numeric version from a Confluence payload. Handles both the
 * nested page shape (`version: { number: 3 }`) and an already-flattened
 * `version: 3`.
 */
export function versionNumberOf(resource: unknown): number | null {
  const record = asRecord(resource);
  if (!record) return null;
  const direct = asNumber(record.version);
  if (direct !== null) return direct;
  return asNumber(asRecord(record.version)?.number);
}
