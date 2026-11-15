/**
 * Content discovery read tools for Confluence Server / Data Center:
 * - cf_search_cql          CQL search via /rest/api/search (excerpt results)
 * - cf_get_labels          labels attached to a piece of content
 * - cf_list_attachments    attachments of a piece of content
 *
 * All tools speak the Server/DC REST v1 API, use numbered start/limit
 * pagination and emit compact cards. cf_search_cql passes the caller's CQL
 * string straight through — the calling agent authors the query.
 */

import { z } from "zod";
import { asNumber, asRecord, asString, getPath, truncateString } from "../core/json.js";
import { extractPageItems, parseToolArgs, resolveLink, serverPageMeta, serverPageQuery, startSchema, limitSchema } from "./shared.js";
import { SERVER_API_PREFIX } from "../providers/server/serverProvider.js";
import type { ToolManifest } from "./registry.js";

const SEARCH_EXCERPT_MAX_CHARS = 200;

const searchCqlSchema = z.object({
  cql: z.string().trim().min(1, "cql is required"),
  limit: limitSchema,
  start: startSchema,
});

const getLabelsSchema = z.object({
  id: z.string().trim().min(1, "id is required"),
  limit: limitSchema,
  start: startSchema,
});

const listAttachmentsSchema = z.object({
  id: z.string().trim().min(1, "id is required"),
  limit: limitSchema,
  start: startSchema,
  filename: z.string().trim().min(1).optional(),
});

/** Phase 1 content discovery read tools for the Server/DC provider. */
export const contentToolManifests: ToolManifest[] = [
  {
    name: "cf_search_cql",
    title: "Search with CQL",
    description:
      "Run a CQL query against Confluence (e.g. 'type=page AND space=DEV AND text ~ \"onboarding\"') " +
      "and return a compact result card per hit: {id, title, url, space (key), excerpt}. The CQL " +
      "string is passed through as authored — the caller builds the query. Results are numbered-" +
      "paged (size + nextStart). Confluence Server / Data Center only.",
    inputSchema: {
      cql: searchCqlSchema.shape.cql.describe("CQL query string, e.g. 'type=page AND space=DEV ORDER BY lastmodified'."),
      limit: searchCqlSchema.shape.limit.describe("Max results per page (1-100, default 25)."),
      start: searchCqlSchema.shape.start.describe("Offset into the result list (default 0)."),
    },
    providers: ["server"],
    readOnly: true,
    handler: async (args, ctx) => {
      const { cql, limit, start } = parseToolArgs(searchCqlSchema, args, "cf_search_cql");
      const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/search`, {
        query: { cql, ...serverPageQuery({ limit, start }) },
      });
      const items = extractPageItems(payload);
      const meta = serverPageMeta(payload, { limit, start }, items.length);
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
    },
  },
  {
    name: "cf_get_labels",
    title: "Get content labels",
    description:
      "List the labels attached to a piece of Confluence content (page, blog post, ...) as compact " +
      "{id, name, prefix} entries with numbered pagination (size + nextStart). Confluence Server / " +
      "Data Center only.",
    inputSchema: {
      id: getLabelsSchema.shape.id.describe("Confluence content id."),
      limit: getLabelsSchema.shape.limit.describe("Max labels per page (1-100, default 25)."),
      start: getLabelsSchema.shape.start.describe("Offset into the label list (default 0)."),
    },
    providers: ["server"],
    readOnly: true,
    handler: async (args, ctx) => {
      const { id, limit, start } = parseToolArgs(getLabelsSchema, args, "cf_get_labels");
      const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}/label`, {
        query: serverPageQuery({ limit, start }),
      });
      const items = extractPageItems(payload);
      const meta = serverPageMeta(payload, { limit, start }, items.length);
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
    },
  },
  {
    name: "cf_list_attachments",
    title: "List content attachments",
    description:
      "List the attachments of a piece of Confluence content with numbered pagination: compact " +
      "{id, title, mediaType, fileSize, downloadUrl, comment} entries. downloadUrl is resolved to an " +
      "absolute URL against the instance base URL / the payload's _links.base; an optional filename " +
      "filter narrows the listing. Attachments are downloaded directly from downloadUrl (no separate " +
      "download tool). Confluence Server / Data Center only.",
    inputSchema: {
      id: listAttachmentsSchema.shape.id.describe("Confluence content id."),
      limit: listAttachmentsSchema.shape.limit.describe("Max attachments per page (1-100, default 25)."),
      start: listAttachmentsSchema.shape.start.describe("Offset into the attachment list (default 0)."),
      filename: listAttachmentsSchema.shape.filename.describe("Optional exact-name filter, e.g. \"report.pdf\"."),
    },
    providers: ["server"],
    readOnly: true,
    handler: async (args, ctx) => {
      const { id, limit, start, filename } = parseToolArgs(listAttachmentsSchema, args, "cf_list_attachments");
      const payload = await ctx.provider.client.get(
        `${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}/child/attachment`,
        { query: { ...serverPageQuery({ limit, start }), filename } },
      );
      const items = extractPageItems(payload);
      const meta = serverPageMeta(payload, { limit, start }, items.length);
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
    },
  },
];
