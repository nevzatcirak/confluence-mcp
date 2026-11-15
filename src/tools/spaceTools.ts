/**
 * Space read tools for Confluence Server / Data Center:
 * - cf_get_space             one space by key (description, status, URL)
 * - cf_list_spaces           paged space listing with optional type filter
 * - cf_list_pages_in_space   paged page listing for one space
 *
 * All tools speak the Server/DC REST v1 API under `/rest/api`, use numbered
 * start/limit pagination and emit compact cards.
 */

import { z } from "zod";
import { asNumber, asRecord, asString, getPath } from "../core/json.js";
import { extractPageItems, parseToolArgs, resolveLink, serverPageMeta, serverPageQuery, startSchema, limitSchema } from "./shared.js";
import { SERVER_API_PREFIX } from "../providers/server/serverProvider.js";
import type { ToolManifest } from "./registry.js";

const listSpacesSchema = z.object({
  limit: limitSchema,
  start: startSchema,
  type: z.enum(["global", "personal"]).optional(),
});

const getSpaceSchema = z.object({
  key: z.string().trim().min(1, "key is required"),
});

const listPagesSchema = z.object({
  spaceKey: z.string().trim().min(1, "spaceKey is required"),
  limit: limitSchema,
  start: startSchema,
});

/** Extract the space description from either expand shape (plain preferred). */
function spaceDescription(space: unknown): string | null {
  return asString(getPath(space, "description.plain.value")) ?? asString(getPath(space, "description.view.value"));
}

/** Phase 1 space read tools for the Server/DC provider. */
export const spaceToolManifests: ToolManifest[] = [
  {
    name: "cf_list_spaces",
    title: "List spaces",
    description:
      "List Confluence spaces with numbered pagination. Returns a compact card: total size, spaces as " +
      "{key, name, type, url} and nextStart when more pages follow. An optional type filter narrows " +
      "the result to global or personal spaces. Confluence Server / Data Center only.",
    inputSchema: {
      limit: listSpacesSchema.shape.limit.describe("Max spaces per page (1-100, default 25)."),
      start: listSpacesSchema.shape.start.describe("Offset into the space list (default 0)."),
      type: listSpacesSchema.shape.type.describe("Optional filter: \"global\" or \"personal\"."),
    },
    providers: ["server"],
    readOnly: true,
    handler: async (args, ctx) => {
      const { limit, start, type } = parseToolArgs(listSpacesSchema, args, "cf_list_spaces");
      const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/space`, {
        query: { ...serverPageQuery({ limit, start }), type },
      });
      const items = extractPageItems(payload);
      const meta = serverPageMeta(payload, { limit, start }, items.length);
      return {
        size: meta.size,
        spaces: items.map((item) => ({
          key: asString(getPath(item, "key")),
          name: asString(getPath(item, "name")),
          type: asString(getPath(item, "type")),
          url: resolveLink(ctx, item, "webui"),
        })),
        nextStart: meta.nextPageStart,
      };
    },
  },
  {
    name: "cf_get_space",
    title: "Get space by key",
    description:
      "Fetch one Confluence space by key and return a compact card: key, name, type, status, " +
      "description and web URL. The description is read from description.plain when the instance " +
      "expands it, falling back to description.view. Fails with NOT_FOUND for unknown keys. " +
      "Confluence Server / Data Center only.",
    inputSchema: {
      key: getSpaceSchema.shape.key.describe("Space key, e.g. \"DEV\"."),
    },
    providers: ["server"],
    readOnly: true,
    handler: async (args, ctx) => {
      const { key } = parseToolArgs(getSpaceSchema, args, "cf_get_space");
      const space = await ctx.provider.client.get(`${SERVER_API_PREFIX}/space/${encodeURIComponent(key)}`, {
        query: { expand: "description.plain,description.view" },
      });
      return {
        key: asString(getPath(space, "key")),
        name: asString(getPath(space, "name")),
        type: asString(getPath(space, "type")),
        status: asString(getPath(space, "status")),
        description: spaceDescription(space),
        url: resolveLink(ctx, space, "webui"),
      };
    },
  },
  {
    name: "cf_list_pages_in_space",
    title: "List pages in space",
    description:
      "List the pages of one Confluence space with numbered pagination. Returns a compact card: " +
      "total size, pages as {id, title, url, version, when} (last-modified info via the version " +
      "expand) and nextStart when more pages exist. Confluence Server / Data Center only.",
    inputSchema: {
      spaceKey: listPagesSchema.shape.spaceKey.describe("Space key, e.g. \"DEV\"."),
      limit: listPagesSchema.shape.limit.describe("Max pages per call (1-100, default 25)."),
      start: listPagesSchema.shape.start.describe("Offset into the page list (default 0)."),
    },
    providers: ["server"],
    readOnly: true,
    handler: async (args, ctx) => {
      const { spaceKey, limit, start } = parseToolArgs(listPagesSchema, args, "cf_list_pages_in_space");
      const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content`, {
        query: { type: "page", spaceKey, expand: "version", ...serverPageQuery({ limit, start }) },
      });
      const items = extractPageItems(payload);
      const meta = serverPageMeta(payload, { limit, start }, items.length);
      return {
        size: meta.size,
        pages: items.map((item) => {
          const record = asRecord(item) ?? {};
          return {
            id: asString(record.id),
            title: asString(record.title),
            url: resolveLink(ctx, item, "webui"),
            version: asNumber(getPath(record, "version.number")),
            when: asString(getPath(record, "version.when")),
          };
        }),
        nextStart: meta.nextPageStart,
      };
    },
  },
];
