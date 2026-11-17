/**
 * Content discovery read tools (Server/DC + Cloud):
 * - cf_search_cql          CQL search via /rest/api/search (excerpt results)
 * - cf_get_labels          labels attached to a piece of content
 * - cf_list_attachments    attachments of a piece of content
 *
 * Each tool ships a Server/DC implementation (REST v1, numbered start/limit
 * pagination) and a Cloud implementation behind one manifest, selected by
 * dispatchByProvider on ctx.provider.id. Cloud search uses the v1 endpoint
 * (v2 has no search) and is cursor-paginated; Cloud labels/attachments are
 * served by v2 and also cursor-paginated. cf_search_cql passes the caller's
 * CQL string straight through — the calling agent authors the query.
 */

import { z } from "zod";
import { asNumber, asRecord, asString, getPath, truncateString } from "../core/json.js";
import {
  cursorSchema,
  dispatchByProvider,
  extractPageItems,
  resolveLink,
  serverPageMeta,
  serverPageQuery,
  startSchema,
  limitSchema,
} from "./shared.js";
import { SERVER_API_PREFIX } from "../providers/server/serverProvider.js";
import {
  cloudGetLabels,
  cloudListAttachments,
  cloudSearchCql,
} from "../providers/cloud/cloudTools.js";
import type { ToolCallContext, ToolManifest } from "./registry.js";

const SEARCH_EXCERPT_MAX_CHARS = 200;

const searchCqlSchema = z.object({
  cql: z.string().trim().min(1, "cql is required"),
  limit: limitSchema,
  start: startSchema,
  // Cloud only: opaque cursor from the previous page's nextCursor.
  cursor: cursorSchema,
});

const getLabelsSchema = z.object({
  id: z.string().trim().min(1, "id is required"),
  limit: limitSchema,
  start: startSchema,
  // Cloud only: opaque cursor from the previous page's nextCursor.
  cursor: cursorSchema,
});

const listAttachmentsSchema = z.object({
  id: z.string().trim().min(1, "id is required"),
  limit: limitSchema,
  start: startSchema,
  // Cloud only: opaque cursor from the previous page's nextCursor.
  cursor: cursorSchema,
  filename: z.string().trim().min(1).optional(),
});

// --- Server/DC implementations -------------------------------------------------

async function serverSearchCql(ctx: ToolCallContext, args: z.infer<typeof searchCqlSchema>): Promise<unknown> {
  const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/search`, {
    query: { cql: args.cql, ...serverPageQuery({ limit: args.limit, start: args.start }) },
  });
  const items = extractPageItems(payload);
  const meta = serverPageMeta(payload, { limit: args.limit, start: args.start }, items.length);
  return {
    size: meta.size,
    results: items.map((item) => {
      const record = asRecord(item) ?? {};
      const excerpt = asString(record.excerpt);
      return {
        id: asString(getPath(record, "content.id")) ?? asString(getPath(record, "space.id")),
        title: asString(record.title),
        url: resolveLink(ctx, item, "webui", "url"),
        space: asString(getPath(record, "space.key")),
        excerpt: excerpt ? truncateString(excerpt, SEARCH_EXCERPT_MAX_CHARS) : null,
      };
    }),
    nextStart: meta.nextPageStart,
  };
}

async function serverGetLabels(ctx: ToolCallContext, args: z.infer<typeof getLabelsSchema>): Promise<unknown> {
  const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content/${encodeURIComponent(args.id)}/label`, {
    query: serverPageQuery({ limit: args.limit, start: args.start }),
  });
  const items = extractPageItems(payload);
  const meta = serverPageMeta(payload, { limit: args.limit, start: args.start }, items.length);
  return {
    size: meta.size,
    labels: items.map((item) => {
      const record = asRecord(item) ?? {};
      return {
        // Some Server builds nest the label payload under a `label` key;
        // prefer the top-level fields and fall back defensively.
        id: asString(getPath(record, "label.id")) ?? asString(record.id),
        name: asString(record.name) ?? asString(getPath(record, "label.name")),
        prefix: asString(record.prefix) ?? asString(getPath(record, "label.prefix")),
      };
    }),
    nextStart: meta.nextPageStart,
  };
}

async function serverListAttachments(ctx: ToolCallContext, args: z.infer<typeof listAttachmentsSchema>): Promise<unknown> {
  const payload = await ctx.provider.client.get(
    `${SERVER_API_PREFIX}/content/${encodeURIComponent(args.id)}/child/attachment`,
    { query: { ...serverPageQuery({ limit: args.limit, start: args.start }), filename: args.filename } },
  );
  const items = extractPageItems(payload);
  const meta = serverPageMeta(payload, { limit: args.limit, start: args.start }, items.length);
  return {
    size: meta.size,
    attachments: items.map((item) => {
      const record = asRecord(item) ?? {};
      return {
        id: asString(record.id),
        title: asString(record.title),
        mediaType: asString(getPath(record, "metadata.mediaType")),
        fileSize: asNumber(getPath(record, "extensions.fileSize")),
        downloadUrl: resolveLink(ctx, item, "download"),
        comment: asString(getPath(record, "metadata.comment")),
      };
    }),
    nextStart: meta.nextPageStart,
  };
}

/** Content discovery read tools, served on both the Server/DC and Cloud providers. */
export const contentToolManifests: ToolManifest[] = [
  {
    name: "cf_search_cql",
    title: "Search with CQL",
    description:
      "Run a CQL query against Confluence (e.g. 'type=page AND space=DEV AND text ~ \"onboarding\"') " +
      "and return a compact result card per hit: {id, title, url, space, excerpt}. The CQL " +
      "string is passed through as authored — the caller builds the query. Results are paged " +
      "(nextStart on Server/DC, nextCursor on Cloud — both providers' search is cursor- or " +
      "offset-paginated respectively). On Cloud, when the hit is not a space the `space` field " +
      "carries the content's spaceId instead of a key (v1 search does not expand it).",
    inputSchema: {
      cql: searchCqlSchema.shape.cql.describe("CQL query string, e.g. 'type=page AND space=DEV ORDER BY lastmodified'."),
      limit: searchCqlSchema.shape.limit.describe("Max results per page (1-100, default 25)."),
      start: searchCqlSchema.shape.start.describe("Offset into the result list (Server/DC, default 0)."),
      cursor: searchCqlSchema.shape.cursor.describe(
        "Opaque cursor from the previous page's nextCursor (Cloud only).",
      ),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(searchCqlSchema, "cf_search_cql", {
      server: serverSearchCql,
      cloud: cloudSearchCql,
    }),
  },
  {
    name: "cf_get_labels",
    title: "Get content labels",
    description:
      "List the labels attached to a piece of Confluence content (page, blog post, ...) as compact " +
      "{id, name, prefix} entries with pagination (nextStart on Server/DC, nextCursor on Cloud; " +
      "Cloud reads v2 /pages/{id}/labels).",
    inputSchema: {
      id: getLabelsSchema.shape.id.describe("Confluence content id."),
      limit: getLabelsSchema.shape.limit.describe("Max labels per page (1-100, default 25)."),
      start: getLabelsSchema.shape.start.describe("Offset into the label list (Server/DC, default 0)."),
      cursor: getLabelsSchema.shape.cursor.describe(
        "Opaque cursor from the previous page's nextCursor (Cloud only).",
      ),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(getLabelsSchema, "cf_get_labels", {
      server: serverGetLabels,
      cloud: cloudGetLabels,
    }),
  },
  {
    name: "cf_list_attachments",
    title: "List content attachments",
    description:
      "List the attachments of a piece of Confluence content with pagination: compact " +
      "{id, title, mediaType, fileSize, downloadUrl, comment} entries, with a follow-up pointer " +
      "when more pages exist (nextStart on Server/DC, nextCursor on Cloud). downloadUrl is " +
      "resolved to an absolute URL; an optional filename filter narrows the listing. The download " +
      "URL requires the same authenticated session (it is not a public signed URL). Attachments " +
      "are downloaded directly from downloadUrl (no separate download tool).",
    inputSchema: {
      id: listAttachmentsSchema.shape.id.describe("Confluence content id."),
      limit: listAttachmentsSchema.shape.limit.describe("Max attachments per page (1-100, default 25)."),
      start: listAttachmentsSchema.shape.start.describe("Offset into the attachment list (Server/DC, default 0)."),
      cursor: listAttachmentsSchema.shape.cursor.describe(
        "Opaque cursor from the previous page's nextCursor (Cloud only).",
      ),
      filename: listAttachmentsSchema.shape.filename.describe("Optional exact-name filter, e.g. \"report.pdf\"."),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(listAttachmentsSchema, "cf_list_attachments", {
      server: serverListAttachments,
      cloud: cloudListAttachments,
    }),
  },
];
