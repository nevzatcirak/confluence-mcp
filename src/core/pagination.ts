/**
 * Pagination helpers shared by all providers.
 *
 * The wire envelope is provider-specific but normalized here:
 * - Server/DC: { results: [...], size, limit, start, _links: { next? } }
 * - Cloud v2:  { results: [...], size, limit, _links: { next? } } (cursor)
 *
 * Tools always receive a normalized PageMeta with `isLastPage` and either
 * `nextPageStart` (number mode) or `nextCursor` (cursor mode) so MCP clients
 * can page with a single convention.
 */

import { asNumber, asRecord, asString } from "./json.js";
import type { PaginationStyle } from "./provider.js";

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 1000;

export interface PageRequest {
  start?: number;
  limit?: number;
  /** Opaque cursor for cursor-mode providers (from PageMeta.nextCursor). */
  cursor?: string;
}

/** Normalized page descriptor returned alongside every list tool result. */
export interface PageMeta {
  readonly size: number;
  readonly limit: number;
  readonly start: number;
  readonly isLastPage: boolean;
  /** Follow-up offset for number-mode providers. Always null in cursor mode. */
  readonly nextPageStart: number | null;
  /**
   * Opaque follow-up cursor for cursor-mode providers (extracted from the
   * envelope's `_links.next` URL). Always null for number-mode providers.
   */
  readonly nextCursor: string | null;
}

/** Clamp + translate a PageRequest into the provider's query parameter names. */
export function pageQuery(request: PageRequest, style: PaginationStyle): Record<string, string | number> {
  const limit = Math.min(Math.max(request.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  if (style.pageMode === "cursor") {
    // Cursor mode: only the limit plus, when present, the opaque cursor.
    // Numeric offsets are meaningless against these endpoints.
    const query: Record<string, string | number> = { [style.limitParam]: limit };
    const cursor = request.cursor?.trim();
    if (cursor) query[style.startParam] = cursor;
    return query;
  }
  const start = Math.max(0, request.start ?? 0);
  if (style.oneBasedPage) {
    return { [style.limitParam]: limit, [style.startParam]: Math.floor(start / limit) + 1 };
  }
  return { [style.limitParam]: limit, [style.startParam]: start };
}

/**
 * Normalize a raw provider page envelope into PageMeta. Missing fields fall
 * back to the request defaults and the number of items actually returned.
 *
 * Confluence envelopes do not carry `isLastPage`; the presence of a
 * `_links.next` entry signals more pages. An explicit `isLastPage` boolean is
 * still honored when an endpoint provides one.
 */
export function pageMeta(
  payload: unknown,
  fallbackStart: number,
  fallbackLimit: number,
  returnedCount: number,
  style: PaginationStyle,
): PageMeta {
  const record = asRecord(payload);
  const size = asNumber(record?.size) ?? returnedCount;
  const limit = asNumber(record?.limit) ?? fallbackLimit;
  const start = asNumber(record?.start) ?? fallbackStart;

  const links = asRecord(record?._links);
  const nextUrl = asString(record?.next) ?? asString(links?.next);

  const explicitIsLast = typeof record?.isLastPage === "boolean" ? record.isLastPage : null;
  const isLastPage = explicitIsLast ?? nextUrl === null;

  if (style.pageMode === "cursor") {
    return {
      size,
      limit,
      start,
      isLastPage,
      nextPageStart: null,
      nextCursor: nextUrl === null ? null : (cursorFromNextUrl(nextUrl) ?? nextUrl),
    };
  }

  const explicitNext = asNumber(record?.nextPageStart);
  const nextPageStart = explicitNext ?? (isLastPage ? null : start + size);
  return { size, limit, start, isLastPage, nextPageStart, nextCursor: null };
}

/**
 * Extract the cursor from a `_links.next` value, preferring the `cursor`
 * query parameter. Handles absolute URLs and relative paths alike
 * (e.g. "/wiki/api/v2/pages?limit=25&cursor=abc&_=/x").
 */
export function cursorFromNextUrl(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const qIndex = raw.indexOf("?");
  if (qIndex !== -1) {
    const cursor = new URLSearchParams(raw.slice(qIndex + 1)).get("cursor");
    if (cursor) return cursor;
  }
  try {
    const url = new URL(raw);
    return url.searchParams.get("cursor") ?? raw;
  } catch {
    // Not an absolute URL and no cursor param — treat the last path segment
    // as the cursor.
    const segments = raw.split("/").filter(Boolean);
    return segments.length > 0 ? (segments[segments.length - 1] ?? null) : null;
  }
}

/** Pull the item array out of a page envelope across known key names. */
export function extractPageItems(payload: unknown, keys: readonly string[] = ["results"]): unknown[] {
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}
