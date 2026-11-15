/**
 * Shared plumbing for the Confluence read tools: argument validation with
 * structured VALIDATION errors, Server/DC numbered-pagination helpers and
 * absolute link resolution against the configured CONFLUENCE_URL.
 *
 * Every read tool manifest declares `providers: ["server"]` and emits compact
 * cards; the helpers here keep the cards' pagination blocks uniform
 * ({ size, nextStart }) across all list-style tools.
 */

import { z } from "zod";
import { ERROR_CODES, ToolError } from "../core/errors.js";
import { asRecord, asString } from "../core/json.js";
import { DEFAULT_PAGE_LIMIT, extractPageItems, pageMeta, pageQuery } from "../core/pagination.js";
import type { PageMeta } from "../core/pagination.js";
import { SERVER_PAGINATION } from "../core/provider.js";
import type { ToolArgs, ToolCallContext } from "./registry.js";

/** Shared `start` argument for numbered (Server/DC) pagination. */
export const startSchema = z.number().int().min(0).default(0);

/** Shared `limit` argument: page size, clamped to the read-tool cap of 100. */
export const limitSchema = z.number().int().min(1).max(100).default(DEFAULT_PAGE_LIMIT);

/**
 * Parse and validate tool arguments against a manifest's schema. The MCP SDK
 * already rejects malformed calls at the protocol boundary, but handlers
 * validate defensively too, so direct invocation (tests, programmatic use)
 * surfaces the same structured VALIDATION error as the wire path.
 */
export function parseToolArgs<S extends z.ZodTypeAny>(schema: S, args: ToolArgs, toolName: string): z.infer<S> {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new ToolError(ERROR_CODES.VALIDATION, `Invalid arguments for ${toolName}.`, issues);
  }
  return result.data;
}

/** Server/DC query parameters (`limit`/`start`) for a numbered page request. */
export function serverPageQuery(request: { limit?: number; start?: number }): Record<string, string | number> {
  return pageQuery(request, SERVER_PAGINATION);
}

/** Normalize a Server/DC page envelope into a PageMeta. */
export function serverPageMeta(
  payload: unknown,
  request: { limit?: number; start?: number },
  returnedCount: number,
): PageMeta {
  return pageMeta(payload, request.start ?? 0, request.limit ?? DEFAULT_PAGE_LIMIT, returnedCount, SERVER_PAGINATION);
}

export { extractPageItems };

/**
 * Resolve a link to an absolute URL. Server/DC `_links` entries are relative
 * to the payload's `_links.base` context path (e.g. "/confluence"), which
 * itself sits under the instance origin from CONFLUENCE_URL — absolute links
 * pass through untouched. Each candidate name is checked against `_links`
 * first, then against the record's top-level fields (the search endpoint
 * exposes `url` at the top level, attachments use `_links.download`).
 */
export function resolveLink(ctx: ToolCallContext, record: unknown, ...names: readonly string[]): string | null {
  const links = asRecord(asRecord(record)?._links) ?? {};
  for (const name of names) {
    const raw = asString(links[name]) ?? asString(asRecord(record)?.[name]);
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) return raw;

    const configUrl = ctx.config.url ?? "";
    if (!configUrl) return null;
    try {
      const origin = new URL(configUrl).origin;
      const contextPath = (asString(links.base) ?? "").replace(/\/+$/, "");
      return new URL(`${origin}${contextPath}/${raw.replace(/^\/+/, "")}`).toString();
    } catch {
      return null;
    }
  }
  return null;
}
