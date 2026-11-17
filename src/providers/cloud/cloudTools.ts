/**
 * Cloud implementations of the 15 Confluence tools, selected by the manifest
 * dispatch when `ctx.provider.id === "cloud"`.
 *
 * Endpoints (relative to the `{CONFLUENCE_URL}/wiki` base):
 * - v2 (`/api/v2`): pages, spaces, versions, direct-children, labels (read),
 *   attachments.
 * - v1 (`/rest/api`): CQL search (v2 has no search) and label writes (the v2
 *   label group is read-only).
 *
 * Everything on Cloud pages by cursor: the envelope's `_links.next` carries an
 * opaque `cursor` query parameter which is passed back verbatim; an absent
 * `_links.next` means the listing is exhausted (nextCursor: null).
 *
 * Card normalization vs. the Server/DC cards:
 * - ids are strings (v2 numeric space ids are strings too),
 * - `version.by` carries the author's accountId (Cloud does not return
 *   display names without extra user lookups, which are deliberately not made),
 * - `space` resolves the spaceId back to its key via the shared space
 *   key<->id resolver,
 * - `ancestors` on page cards is always null (the v2 single-page GET has no
 *   ancestor breadcrumb),
 * - list cards report `nextCursor` instead of the Server `nextStart`.
 */

import { ERROR_CODES, ToolError } from "../../core/errors.js";
import { asNumber, asRecord, asString, getPath, truncateString } from "../../core/json.js";
import { extractPageItems, pageMeta } from "../../core/pagination.js";
import type { PageMeta } from "../../core/pagination.js";
import { CLOUD_PAGINATION } from "../../core/provider.js";
import { storageToMarkdown } from "../../core/markdown/storageToMarkdown.js";
import { withOptimisticLock, versionNumberOf } from "../../core/optimisticLock.js";
import type { ToolCallContext } from "../../tools/registry.js";
import { resolveWriteBodyStorage, type WriteBodyFormat } from "../../tools/shared.js";
import { CLOUD_V1_API_PREFIX, CLOUD_V2_API_PREFIX } from "./cloudProvider.js";

const SEARCH_EXCERPT_MAX_CHARS = 200;
/** Page size for each child-page listing while walking the hierarchy. */
const CHILD_PAGE_LIMIT = 50;
/** Safety cap: how many cursor hops are followed per child listing. */
const MAX_PAGES_PER_LEVEL = 10;

/** Cloud (cursor) query parameters: `limit` plus the opaque cursor when present. */
function cloudPageQuery(request: { limit?: number; cursor?: string }): Record<string, string | number> {
  const query: Record<string, string | number> = {
    limit: Math.min(Math.max(request.limit ?? 25, 1), 100),
  };
  const cursor = request.cursor?.trim();
  if (cursor) query.cursor = cursor;
  return query;
}

/** Normalize a Cloud page envelope (v2 or Cloud v1) into a cursor PageMeta. */
function cloudPageMeta(payload: unknown, limit: number, returnedCount: number): PageMeta {
  return pageMeta(payload, 0, limit, returnedCount, CLOUD_PAGINATION);
}

/**
 * Resolve a `_links` entry to an absolute URL. Cloud `_links` are relative to
 * the payload's `_links.base`, which sits under the `/wiki` context path
 * (e.g. "/wiki"); absolute base URLs and absolute links pass through.
 */
export function resolveCloudLink(ctx: ToolCallContext, record: unknown, ...names: readonly string[]): string | null {
  const recordObj = asRecord(record);
  const links = asRecord(recordObj?._links) ?? {};
  for (const name of names) {
    const raw = asString(links[name]) ?? asString(recordObj?.[name]);
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) return raw;

    try {
      const base = asString(links.base) ?? "";
      if (/^https?:\/\//i.test(base)) {
        return new URL(raw.replace(/^\/+/, ""), base.endsWith("/") ? base : `${base}/`).toString();
      }
      const origin = new URL(ctx.config.url ?? "").origin;
      return new URL(`${origin}${base.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Copy a record with `_links.base` filled in from a fallback (the page
 * envelope's base). Search result items carry only a relative `url`; their
 * base context lives on the envelope.
 */
function withLinkBase(record: unknown, base: string | null): unknown {
  const recordObj = asRecord(record) ?? {};
  return {
    ...recordObj,
    _links: { base: base ?? "", ...(asRecord(recordObj._links) ?? {}) },
  };
}

/**
 * Resolve a space key to its numeric v2 space id (GET /spaces?keys=<KEY>).
 * Fails with NOT_FOUND for unknown keys — Cloud v2 endpoints address spaces
 * by numeric id, never by key.
 */
export async function resolveSpaceIdFromKey(ctx: ToolCallContext, key: string): Promise<string> {
  const payload = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/spaces`, {
    query: { keys: key, limit: 1 },
  });
  const space = extractPageItems(payload)[0];
  const id = asString(asRecord(space)?.id);
  if (!id) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, `No Confluence Cloud space with key "${key}" was found.`, { key });
  }
  return id;
}

/**
 * Resolve a space id back to its key (GET /spaces/{id}). Cloud page payloads
 * carry only spaceId; server cards expose the space key, so page cards make
 * the extra lookup. Unresolvable ids degrade to null.
 */
export async function resolveSpaceKeyFromId(ctx: ToolCallContext, spaceId: unknown): Promise<string | null> {
  const id = asString(spaceId);
  if (!id) return null;
  try {
    const space = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/spaces/${encodeURIComponent(id)}`);
    return asString(asRecord(space)?.key);
  } catch {
    return null;
  }
}

/** Build the compact page card for a v2 page payload (same shape as the Server card). */
async function cloudPageCard(ctx: ToolCallContext, page: unknown, format: "storage" | "view" | "markdown") {
  const record = asRecord(page);
  if (!record) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, "Confluence returned no page payload.");
  }

  const storage = asString(getPath(record, "body.storage.value"));
  const view = asString(getPath(record, "body.view.value"));
  const body =
    format === "storage" ? storage : format === "view" ? view : storageToMarkdown(storage ?? "");

  return {
    id: asString(record.id),
    title: asString(record.title),
    space: await resolveSpaceKeyFromId(ctx, record.spaceId),
    url: resolveCloudLink(ctx, record, "webui"),
    // Cloud has no display names here: `by` carries the author accountId.
    version: {
      number: asNumber(getPath(record, "version.number")),
      by: asString(getPath(record, "version.authorId")),
      when: asString(getPath(record, "version.createdAt")),
    },
    // Cloud-absent: the v2 single-page payload carries no ancestor breadcrumb.
    ancestors: null,
    body,
  };
}

/** Fetch one page by id with a specific v2 body-format (storage | view). */
async function fetchV2PageWithBody(ctx: ToolCallContext, id: string, bodyFormat: string): Promise<unknown> {
  return ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(id)}`, {
    query: { "body-format": bodyFormat },
  });
}

/** Cloud body format for a requested tool format (markdown is rendered from storage). */
function bodyFormatFor(format: "storage" | "view" | "markdown"): string {
  return format === "markdown" ? "storage" : format;
}

/** Cloud version of a fetched page payload (for updates). */
async function fetchCloudPageVersion(
  ctx: ToolCallContext,
  id: string,
): Promise<{ page: unknown; version: number }> {
  const page = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(id)}`);
  const version = versionNumberOf(page);
  if (version === null) {
    throw new ToolError(
      ERROR_CODES.UPSTREAM_ERROR,
      "Confluence Cloud returned a page payload without a version number; refusing to write.",
      { id },
    );
  }
  return { page, version };
}

/** One page of labels (up to 100), compact {id, name, prefix} entries. */
async function fetchCloudLabels(ctx: ToolCallContext, id: string): Promise<Array<Record<string, unknown>>> {
  const payload = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(id)}/labels`, {
    query: { limit: 100 },
  });
  return extractPageItems(payload).map((item) => {
    const record = asRecord(item) ?? {};
    return {
      id: asString(record.id),
      name: asString(record.name),
      prefix: asString(record.prefix),
    };
  });
}

/**
 * Fetch all (type=page) children of one page, following the cursor within the
 * level; non-page child objects (folders, whiteboards, ...) are filtered out.
 * `truncated` is true when the per-level page cap was hit while more pages
 * still followed.
 */
async function fetchCloudChildren(ctx: ToolCallContext, id: string): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_LEVEL; pageNumber++) {
    const payload = await ctx.provider.client.get(
      `${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(id)}/direct-children`,
      { query: cloudPageQuery({ limit: CHILD_PAGE_LIMIT, cursor }) },
    );
    const batch = extractPageItems(payload).filter((item) => asRecord(item)?.type === "page");
    items.push(...batch);
    const meta = cloudPageMeta(payload, CHILD_PAGE_LIMIT, batch.length);
    if (meta.isLastPage || meta.nextCursor === null) {
      return { items, truncated: false };
    }
    cursor = meta.nextCursor;
  }
  return { items, truncated: true };
}

/** Recursively build one hierarchy node (same depth/truncation semantics as Server). */
async function buildCloudHierarchyNode(
  ctx: ToolCallContext,
  raw: unknown,
  remainingDepth: number,
): Promise<{ node: Record<string, unknown>; truncated: boolean }> {
  const record = asRecord(raw);
  const id = asString(record?.id) ?? "";
  const title = asString(record?.title) ?? "";

  if (remainingDepth <= 0) {
    return { node: { id, title, hasChildren: null, children: [] }, truncated: true };
  }

  const { items, truncated: levelTruncated } = await fetchCloudChildren(ctx, id);
  const children = await Promise.all(
    items.map((child) => buildCloudHierarchyNode(ctx, child, remainingDepth - 1)),
  );

  return {
    node: {
      id,
      title,
      hasChildren: items.length > 0,
      children: children.map((child) => child.node),
    },
    truncated: levelTruncated || children.some((child) => child.truncated),
  };
}

// ---------------------------------------------------------------------------
// Page tools
// ---------------------------------------------------------------------------

export async function cloudGetPage(
  ctx: ToolCallContext,
  args: { id: string; format: "storage" | "view" | "markdown" },
): Promise<unknown> {
  // GET /pages/{id} omits the body unless body-format is passed.
  const page = await fetchV2PageWithBody(ctx, args.id, bodyFormatFor(args.format));
  return cloudPageCard(ctx, page, args.format);
}

export async function cloudGetPageByTitle(
  ctx: ToolCallContext,
  args: { spaceKey: string; title: string; format: "storage" | "view" | "markdown" },
): Promise<{ id: string | null; title: string | null; space: string | null; url: string | null; version: Record<string, unknown>; ancestors: null; body: string | null }> {
  const spaceId = await resolveSpaceIdFromKey(ctx, args.spaceKey);
  const found = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/pages`, {
    query: { "space-id": spaceId, title: args.title, limit: 1 },
  });
  const match = extractPageItems(found)[0];
  const matchId = asString(asRecord(match)?.id);
  if (!matchId) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `No page titled "${args.title}" was found in space "${args.spaceKey}".`,
      { spaceKey: args.spaceKey, title: args.title },
    );
  }
  const page = await fetchV2PageWithBody(ctx, matchId, bodyFormatFor(args.format));
  return cloudPageCard(ctx, page, args.format);
}

export async function cloudGetPageHistory(
  ctx: ToolCallContext,
  args: { id: string; limit: number; cursor?: string },
): Promise<unknown> {
  // First fetch validates existence and supplies title + current version.
  const page = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(args.id)}`);
  const payload = await ctx.provider.client.get(
    `${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(args.id)}/versions`,
    { query: cloudPageQuery({ limit: args.limit, cursor: args.cursor }) },
  );
  const items = extractPageItems(payload);
  const meta = cloudPageMeta(payload, args.limit, items.length);

  return {
    id: asString(asRecord(page)?.id),
    title: asString(asRecord(page)?.title),
    currentVersion: asNumber(getPath(page, "version.number")),
    versions: items.map((raw) => {
      const record = asRecord(raw) ?? {};
      // Cloud `authorId` is an accountId, included as-is (no user lookups).
      return {
        version: asNumber(record.number),
        by: asString(record.authorId),
        when: asString(record.createdAt),
        message: asString(record.message),
      };
    }),
    size: meta.size,
    nextCursor: meta.nextCursor,
  };
}

export async function cloudGetPageHierarchy(
  ctx: ToolCallContext,
  args: { id: string; depth: number },
): Promise<unknown> {
  // Root fetch validates existence and supplies id + title.
  const root = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(args.id)}`);
  const built = await buildCloudHierarchyNode(ctx, root, args.depth);
  return { ...built.node, depth: args.depth, truncated: built.truncated };
}

// ---------------------------------------------------------------------------
// Space tools
// ---------------------------------------------------------------------------

export async function cloudListSpaces(
  ctx: ToolCallContext,
  args: { limit: number; type?: "global" | "personal"; cursor?: string },
): Promise<unknown> {
  const payload = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/spaces`, {
    query: { type: args.type, ...cloudPageQuery({ limit: args.limit, cursor: args.cursor }) },
  });
  const items = extractPageItems(payload);
  const meta = cloudPageMeta(payload, args.limit, items.length);
  return {
    size: meta.size,
    spaces: items.map((item) => {
      const record = asRecord(item) ?? {};
      return {
        key: asString(record.key),
        name: asString(record.name),
        type: asString(record.type),
        url: resolveCloudLink(ctx, record, "webui"),
      };
    }),
    nextCursor: meta.nextCursor,
  };
}

export async function cloudGetSpace(
  ctx: ToolCallContext,
  args: { key: string },
): Promise<unknown> {
  const spaceId = await resolveSpaceIdFromKey(ctx, args.key);
  const space = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/spaces/${encodeURIComponent(spaceId)}`, {
    query: { "description-format": "plain" },
  });
  const record = asRecord(space) ?? {};
  return {
    id: asString(record.id),
    key: asString(record.key) ?? args.key,
    name: asString(record.name),
    type: asString(record.type),
    status: asString(record.status),
    description:
      asString(getPath(space, "description.plain.value")) ?? asString(getPath(space, "description.view.value")),
    url: resolveCloudLink(ctx, space, "webui"),
  };
}

export async function cloudListPagesInSpace(
  ctx: ToolCallContext,
  args: { spaceKey: string; limit: number; cursor?: string },
): Promise<unknown> {
  const spaceId = await resolveSpaceIdFromKey(ctx, args.spaceKey);
  const payload = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/spaces/${encodeURIComponent(spaceId)}/pages`, {
    query: cloudPageQuery({ limit: args.limit, cursor: args.cursor }),
  });
  const items = extractPageItems(payload);
  const meta = cloudPageMeta(payload, args.limit, items.length);
  return {
    size: meta.size,
    pages: items.map((item) => {
      const record = asRecord(item) ?? {};
      return {
        id: asString(record.id),
        title: asString(record.title),
        url: resolveCloudLink(ctx, item, "webui"),
        version: asNumber(getPath(record, "version.number")),
        when: asString(getPath(record, "version.createdAt")),
      };
    }),
    nextCursor: meta.nextCursor,
  };
}

// ---------------------------------------------------------------------------
// Content discovery tools
// ---------------------------------------------------------------------------

export async function cloudSearchCql(
  ctx: ToolCallContext,
  args: { cql: string; limit: number; cursor?: string },
): Promise<unknown> {
  // v2 has no search endpoint; Cloud v1 search is cursor-paginated too.
  const payload = await ctx.provider.client.get(`${CLOUD_V1_API_PREFIX}/search`, {
    query: { cql: args.cql, ...cloudPageQuery({ limit: args.limit, cursor: args.cursor }) },
  });
  const items = extractPageItems(payload);
  const meta = cloudPageMeta(payload, args.limit, items.length);
  // Search items expose only a relative url; the base context is on the envelope.
  const envelopeBase = asString(getPath(payload, "_links.base"));
  return {
    size: meta.size,
    results: items.map((item) => {
      const record = asRecord(item) ?? {};
      const excerpt = asString(record.excerpt);
      return {
        id:
          asString(getPath(record, "content.id")) ??
          asString(getPath(record, "space.id")) ??
          asString(getPath(record, "user.accountId")),
        title: asString(record.title),
        url: resolveCloudLink(ctx, withLinkBase(item, envelopeBase), "webui", "url"),
        // When the hit is not a space, the space key is absent; fall back to
        // the content's spaceId (v1 search does not expand space on content).
        space: asString(getPath(record, "space.key")) ?? asString(getPath(record, "content.spaceId")),
        excerpt: excerpt ? truncateString(excerpt, SEARCH_EXCERPT_MAX_CHARS) : null,
      };
    }),
    nextCursor: meta.nextCursor,
  };
}

export async function cloudGetLabels(
  ctx: ToolCallContext,
  args: { id: string; limit: number; cursor?: string },
): Promise<unknown> {
  const payload = await ctx.provider.client.get(`${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(args.id)}/labels`, {
    query: cloudPageQuery({ limit: args.limit, cursor: args.cursor }),
  });
  const items = extractPageItems(payload);
  const meta = cloudPageMeta(payload, args.limit, items.length);
  return {
    size: meta.size,
    labels: items.map((item) => {
      const record = asRecord(item) ?? {};
      return {
        id: asString(record.id),
        name: asString(record.name),
        prefix: asString(record.prefix),
      };
    }),
    nextCursor: meta.nextCursor,
  };
}

export async function cloudListAttachments(
  ctx: ToolCallContext,
  args: { id: string; limit: number; cursor?: string; filename?: string },
): Promise<unknown> {
  const payload = await ctx.provider.client.get(
    `${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(args.id)}/attachments`,
    { query: { filename: args.filename, ...cloudPageQuery({ limit: args.limit, cursor: args.cursor }) } },
  );
  const items = extractPageItems(payload);
  const meta = cloudPageMeta(payload, args.limit, items.length);
  return {
    size: meta.size,
    attachments: items.map((item) => {
      const record = asRecord(item) ?? {};
      return {
        id: asString(record.id),
        title: asString(record.title),
        mediaType: asString(record.mediaType),
        fileSize: asNumber(record.fileSize),
        // Requires the same authenticated session — not a public signed URL.
        downloadUrl: resolveCloudLink(ctx, item, "download", "downloadLink"),
        comment: asString(record.comment),
      };
    }),
    nextCursor: meta.nextCursor,
  };
}

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

export async function cloudCreatePage(
  ctx: ToolCallContext,
  args: { spaceKey: string; title: string; body: string; bodyFormat: WriteBodyFormat; parent?: string },
): Promise<unknown> {
  const spaceId = await resolveSpaceIdFromKey(ctx, args.spaceKey);

  const payload: Record<string, unknown> = {
    spaceId,
    status: "current",
    title: args.title,
    body: { representation: "storage", value: resolveWriteBodyStorage(args.body, args.bodyFormat) },
  };
  if (args.parent !== undefined) payload.parentId = args.parent;

  const page = await ctx.provider.client.post(`${CLOUD_V2_API_PREFIX}/pages`, { body: payload });
  const record = asRecord(page) ?? {};
  return {
    id: asString(record.id),
    title: asString(record.title) ?? args.title,
    url: resolveCloudLink(ctx, page, "webui"),
    version: asNumber(getPath(page, "version.number")),
    space: (await resolveSpaceKeyFromId(ctx, record.spaceId)) ?? args.spaceKey,
  };
}

export async function cloudUpdatePage(
  ctx: ToolCallContext,
  args: { id: string; title?: string; body?: string; bodyFormat: WriteBodyFormat; message?: string },
): Promise<unknown> {
  const storageBody = args.body === undefined ? undefined : resolveWriteBodyStorage(args.body, args.bodyFormat);

  const updated = await withOptimisticLock({
    fetchCurrent: () => fetchCloudPageVersion(ctx, args.id),
    apply: async (current) => {
      // Cloud v2 PUT requires the CURRENT version number in the payload.
      const version: Record<string, unknown> = { number: current.version + 1 };
      if (args.message !== undefined) version.message = args.message;

      const payload: Record<string, unknown> = {
        id: args.id,
        status: "current",
        title: args.title ?? asString(asRecord(current.page)?.title) ?? "",
        version,
      };
      if (storageBody !== undefined) {
        payload.body = { representation: "storage", value: storageBody };
      }
      return ctx.provider.client.put(`${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(args.id)}`, {
        body: payload,
      });
    },
  });

  const record = asRecord(updated) ?? {};
  return {
    id: asString(record.id) ?? args.id,
    title: asString(record.title) ?? null,
    url: resolveCloudLink(ctx, updated, "webui"),
    version: asNumber(getPath(updated, "version.number")),
    space: await resolveSpaceKeyFromId(ctx, record.spaceId),
  };
}

export async function cloudDeletePage(ctx: ToolCallContext, args: { id: string }): Promise<unknown> {
  // Default = move to trash; never pass purge.
  await ctx.provider.client.delete(`${CLOUD_V2_API_PREFIX}/pages/${encodeURIComponent(args.id)}`);
  return {
    id: args.id,
    status: "trashed",
    trashed: true,
    note:
      "The page was moved to the Confluence trash. Permanent purge is a separate server-side " +
      "operation and is not performed by this tool.",
  };
}

export async function cloudAddLabel(ctx: ToolCallContext, args: { id: string; name: string }): Promise<unknown> {
  // The v2 label group is read-only — label writes go through v1.
  await ctx.provider.client.post(`${CLOUD_V1_API_PREFIX}/content/${encodeURIComponent(args.id)}/label`, {
    body: [{ prefix: "global", name: args.name }],
  });
  const labels = await fetchCloudLabels(ctx, args.id);
  return { id: args.id, added: args.name, size: labels.length, labels };
}

export async function cloudRemoveLabel(ctx: ToolCallContext, args: { id: string; name: string }): Promise<unknown> {
  await ctx.provider.client.delete(`${CLOUD_V1_API_PREFIX}/content/${encodeURIComponent(args.id)}/label`, {
    query: { name: args.name },
  });
  const labels = await fetchCloudLabels(ctx, args.id);
  return { id: args.id, removed: args.name, size: labels.length, labels };
}
