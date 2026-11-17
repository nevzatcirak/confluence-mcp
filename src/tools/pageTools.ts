/**
 * Page read tools (Server/DC + Cloud):
 * - cf_get_page            fetch one page by content id
 * - cf_get_page_by_title   resolve a page by space key + title
 * - cf_get_page_history    version history of a page
 * - cf_get_page_hierarchy  depth-limited child-page tree
 *
 * Each tool ships two implementations behind one manifest — Server/DC REST v1
 * (`/rest/api`, numbered start/limit pagination) and Cloud (v2 `/api/v2`,
 * cursor pagination; see src/providers/cloud/cloudTools.ts) — selected by
 * dispatchByProvider on ctx.provider.id. All tools emit compact cards — raw
 * Confluence payloads are never forwarded to the LLM.
 *
 * Body formats: "markdown" (default) converts the storage-format XHTML via
 * storageToMarkdown (src/core/markdown), "storage" and "view" pass the raw
 * Confluence body values through.
 */

import { z } from "zod";
import { ERROR_CODES, ToolError } from "../core/errors.js";
import { asNumber, asRecord, asString, getPath } from "../core/json.js";
import { extractPageItems, resolveLink, serverPageMeta, startSchema, limitSchema, cursorSchema, dispatchByProvider } from "./shared.js";
import { storageToMarkdown } from "../core/markdown/storageToMarkdown.js";
import { SERVER_API_PREFIX } from "../providers/server/serverProvider.js";
import {
  cloudGetPage,
  cloudGetPageByTitle,
  cloudGetPageHistory,
  cloudGetPageHierarchy,
} from "../providers/cloud/cloudTools.js";
import type { ToolCallContext, ToolManifest } from "./registry.js";
import type { Card } from "../core/compactCard.js";

/** Body formats accepted by the page tools. */
export const PAGE_FORMATS = ["storage", "view", "markdown"] as const;
export type PageFormat = (typeof PAGE_FORMATS)[number];

const pageFormatSchema = z.enum(PAGE_FORMATS).default("markdown");

const idSchema = z.string().trim().min(1, "id is required");

/** Expand set for a full single-page payload (body in both formats + metadata). */
const PAGE_EXPAND = "body.storage,body.view,version,ancestors,space";

/**
 * Build the compact card for a single page payload. Shared by the Server
 * cf_get_page and cf_get_page_by_title so both tools format identically.
 */
function pageCard(ctx: ToolCallContext, page: unknown, format: PageFormat): Card {
  const record = asRecord(page);
  if (!record) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, "Confluence returned no page payload.");
  }

  const storage = asString(getPath(record, "body.storage.value"));
  const body =
    format === "storage"
      ? storage
      : format === "view"
        ? asString(getPath(record, "body.view.value"))
        : storageToMarkdown(storage ?? "");

  const ancestors = Array.isArray(record.ancestors) ? record.ancestors : [];
  const breadcrumb = ancestors
    .map((ancestor) => asString(asRecord(ancestor)?.title))
    .filter((title): title is string => title !== null)
    .join(" > ");

  return {
    id: asString(record.id),
    title: asString(record.title),
    space: asString(getPath(record, "space.key")),
    url: resolveLink(ctx, record, "webui"),
    version: {
      number: asNumber(getPath(record, "version.number")),
      by: asString(getPath(record, "version.by.displayName")) ?? asString(getPath(record, "version.by.username")),
      when: asString(getPath(record, "version.when")),
    },
    ancestors: breadcrumb.length > 0 ? breadcrumb : null,
    body,
  };
}

/** Fetch a single page by id with the full expand set, or fail with NOT_FOUND. */
async function fetchFullPage(ctx: ToolCallContext, id: string): Promise<unknown> {
  return ctx.provider.client.get(`${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}`, {
    query: { expand: PAGE_EXPAND },
  });
}

const getPageSchema = z.object({
  id: idSchema,
  format: pageFormatSchema,
});

const getPageByTitleSchema = z.object({
  spaceKey: z.string().trim().min(1, "spaceKey is required"),
  title: z.string().trim().min(1, "title is required"),
  format: pageFormatSchema,
});

const getPageHistorySchema = z.object({
  id: idSchema,
  limit: limitSchema,
  start: startSchema,
  // Cloud only: opaque cursor from the previous page's nextCursor.
  cursor: cursorSchema,
});

const getPageHierarchySchema = z.object({
  id: idSchema,
  /** Tree depth: how many levels of children to traverse below the page. */
  depth: z.number().int().min(1, "depth must be at least 1").max(5, "depth must be at most 5").default(2),
});

/** Page size for each child-page listing while walking the hierarchy. */
const CHILD_PAGE_LIMIT = 50;
/** Safety cap: how many `_links.next` hops are followed per child listing. */
const MAX_PAGES_PER_LEVEL = 10;

/**
 * Fetch all children of one page, following `_links.next` within the level.
 * `truncated` is true when the per-level page cap was hit while the endpoint
 * still reported more pages.
 */
async function fetchChildren(
  ctx: ToolCallContext,
  id: string,
): Promise<{ items: unknown[]; truncated: boolean }> {
  const items: unknown[] = [];
  let start = 0;
  for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_LEVEL; pageNumber++) {
    const payload = await ctx.provider.client.get(
      `${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}/child/page`,
      { query: { limit: CHILD_PAGE_LIMIT, start } },
    );
    const batch = extractPageItems(payload);
    items.push(...batch);
    const meta = serverPageMeta(payload, { limit: CHILD_PAGE_LIMIT, start }, batch.length);
    if (meta.isLastPage || meta.nextPageStart === null) {
      return { items, truncated: false };
    }
    start = meta.nextPageStart;
  }
  return { items, truncated: true };
}

/**
 * Recursively build one hierarchy node. `hasChildren` is null when the depth
 * budget was spent before the node's own children could be inspected; the
 * result's `truncated` flag propagates both depth cuts and page-limit cuts.
 */
async function buildHierarchyNode(
  ctx: ToolCallContext,
  raw: unknown,
  remainingDepth: number,
): Promise<{ node: Card; truncated: boolean }> {
  const record = asRecord(raw);
  const id = asString(record?.id) ?? "";
  const title = asString(record?.title) ?? "";

  if (remainingDepth <= 0) {
    return { node: { id, title, hasChildren: null, children: [] }, truncated: true };
  }

  const { items, truncated: levelTruncated } = await fetchChildren(ctx, id);
  const children = await Promise.all(items.map((child) => buildHierarchyNode(ctx, child, remainingDepth - 1)));

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

// --- Server/DC implementations -------------------------------------------------

async function serverGetPage(
  ctx: ToolCallContext,
  args: z.infer<typeof getPageSchema>,
): Promise<unknown> {
  const page = await fetchFullPage(ctx, args.id);
  return pageCard(ctx, page, args.format);
}

async function serverGetPageByTitle(
  ctx: ToolCallContext,
  args: z.infer<typeof getPageByTitleSchema>,
): Promise<unknown> {
  const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content`, {
    query: { spaceKey: args.spaceKey, title: args.title, expand: PAGE_EXPAND },
  });
  const page = extractPageItems(payload)[0];
  if (!asRecord(page)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `No page titled "${args.title}" was found in space "${args.spaceKey}".`,
      { spaceKey: args.spaceKey, title: args.title },
    );
  }
  return pageCard(ctx, page, args.format);
}

async function serverGetPageHistory(
  ctx: ToolCallContext,
  args: z.infer<typeof getPageHistorySchema>,
): Promise<unknown> {
  // First fetch validates existence and supplies title + current version.
  const page = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content/${encodeURIComponent(args.id)}`, {
    query: { expand: "version" },
  });
  const history = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content/${encodeURIComponent(args.id)}/history`, {
    query: { expand: "versions", limit: args.limit, start: args.start },
  });

  const rawVersions = Array.isArray(asRecord(history)?.versions) ? (asRecord(history)!.versions as unknown[]) : [];
  const versions = rawVersions.map((raw) => {
    const record = asRecord(raw) ?? {};
    return {
      version: asNumber(record.number) ?? asNumber(getPath(record, "version.number")),
      by: asString(getPath(record, "by.displayName")) ?? asString(getPath(record, "by.username")),
      when: asString(record.when),
      message: asString(record.message),
    };
  });

  const size = versions.length;
  return {
    id: asString(asRecord(page)?.id),
    title: asString(asRecord(page)?.title),
    currentVersion: asNumber(getPath(page, "version.number")),
    versions,
    size,
    start: args.start,
    // The Server history endpoint applies start/limit to the expanded
    // versions collection but does not expose _links.next for it, so a
    // full page of versions is treated as "possibly more follow".
    nextStart: size === args.limit ? args.start + size : null,
  };
}

async function serverGetPageHierarchy(
  ctx: ToolCallContext,
  args: z.infer<typeof getPageHierarchySchema>,
): Promise<unknown> {
  // Root fetch validates existence and supplies id + title.
  const root = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content/${encodeURIComponent(args.id)}`);
  const built = await buildHierarchyNode(ctx, root, args.depth);

  return { ...built.node, depth: args.depth, truncated: built.truncated };
}

/** Page read tools, served on both the Server/DC and Cloud providers. */
export const pageToolManifests: ToolManifest[] = [
  {
    name: "cf_get_page",
    title: "Get page by id",
    description:
      "Fetch one Confluence page by content id and return a compact card: title, space key, web URL, " +
      "version (number/author/when), ancestor breadcrumb and the body in the requested format " +
      "(markdown | storage | view; markdown is the default and converts the storage XHTML). " +
      "Works on Confluence Server / Data Center and Cloud (Cloud: v2 GET /pages/{id}; the ancestor " +
      "breadcrumb and author display name are Server/DC-only — Cloud returns the author accountId).",
    inputSchema: {
      id: getPageSchema.shape.id.describe("Confluence content id of the page."),
      format: getPageSchema.shape.format.describe(
        "Body format: \"markdown\" (default, storage XHTML converted to Markdown), \"storage\" (raw XHTML) or \"view\" (rendered HTML).",
      ),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(getPageSchema, "cf_get_page", {
      server: serverGetPage,
      cloud: cloudGetPage,
    }),
  },
  {
    name: "cf_get_page_by_title",
    title: "Get page by space and title",
    description:
      "Resolve a Confluence page by space key + exact title (at most one match) and return the same " +
      "compact card as cf_get_page. Fails with NOT_FOUND when no page with that title exists in the " +
      "space. Server/DC uses the content search; Cloud resolves the space key to its id and then " +
      "queries v2 /pages by space-id + exact title (no CQL).",
    inputSchema: {
      spaceKey: getPageByTitleSchema.shape.spaceKey.describe("Space key, e.g. \"DEV\"."),
      title: getPageByTitleSchema.shape.title.describe("Exact page title."),
      format: getPageByTitleSchema.shape.format.describe(
        "Body format: \"markdown\" (default, storage XHTML converted to Markdown), \"storage\" (raw XHTML) or \"view\" (rendered HTML).",
      ),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(getPageByTitleSchema, "cf_get_page_by_title", {
      server: serverGetPageByTitle,
      cloud: cloudGetPageByTitle,
    }),
  },
  {
    name: "cf_get_page_history",
    title: "Get page version history",
    description:
      "Fetch the version history of a Confluence page: current version plus a paged list of versions " +
      "with author, timestamp and optional commit-style message. Server/DC pages by start/limit " +
      "(nextStart); Cloud (v2 /pages/{id}/versions) pages by opaque cursor — pass the previous " +
      "nextCursor back as `cursor`. Cloud returns author accountIds instead of display names.",
    inputSchema: {
      id: getPageHistorySchema.shape.id.describe("Confluence content id of the page."),
      limit: getPageHistorySchema.shape.limit.describe("Max versions to return (1-100, default 25)."),
      start: getPageHistorySchema.shape.start.describe("Offset into the version list (Server/DC, default 0)."),
      cursor: getPageHistorySchema.shape.cursor.describe(
        "Opaque cursor from the previous page's nextCursor (Cloud only).",
      ),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(getPageHistorySchema, "cf_get_page_history", {
      server: serverGetPageHistory,
      cloud: cloudGetPageHistory,
    }),
  },
  {
    name: "cf_get_page_hierarchy",
    title: "Get page tree",
    description:
      "Walk the child-page tree below a Confluence page and return a nested compact tree " +
      "({id, title, hasChildren, children}). depth controls how many levels are traversed " +
      "(1-5, default 2); within each level pagination is followed up to a safety cap. " +
      "hasChildren is null on nodes whose children were not inspected because the depth " +
      "budget ran out; truncated is true whenever the depth or a page cap cut the walk short. " +
      "Server/DC walks /child/page; Cloud walks v2 /pages/{id}/direct-children and keeps only " +
      "type=page children.",
    inputSchema: {
      id: getPageHierarchySchema.shape.id.describe("Confluence content id of the root page."),
      depth: getPageHierarchySchema.shape.depth.describe("How many levels of children to traverse (1-5, default 2)."),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(getPageHierarchySchema, "cf_get_page_hierarchy", {
      server: serverGetPageHierarchy,
      cloud: cloudGetPageHierarchy,
    }),
  },
];
