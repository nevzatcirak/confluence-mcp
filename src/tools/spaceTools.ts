/**
 * Space read tools (Server/DC + Cloud):
 * - cf_get_space             one space by key (description, status, URL)
 * - cf_list_spaces           paged space listing with optional type filter
 * - cf_list_pages_in_space   paged page listing for one space
 *
 * Each tool ships a Server/DC implementation (REST v1 `/rest/api`, numbered
 * start/limit pagination) and a Cloud implementation (v2 `/api/v2`, cursor
 * pagination; the space key is resolved to its numeric space id first) behind
 * one manifest, selected by dispatchByProvider on ctx.provider.id.
 */

import { z } from "zod";
import { asNumber, asRecord, asString, getPath } from "../core/json.js";
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
  cloudGetSpace,
  cloudListPagesInSpace,
  cloudListSpaces,
} from "../providers/cloud/cloudTools.js";
import type { ToolCallContext, ToolManifest } from "./registry.js";

const listSpacesSchema = z.object({
  limit: limitSchema,
  start: startSchema,
  type: z.enum(["global", "personal"]).optional(),
  // Cloud only: opaque cursor from the previous page's nextCursor.
  cursor: cursorSchema,
});

const getSpaceSchema = z.object({
  key: z.string().trim().min(1, "key is required"),
});

const listPagesSchema = z.object({
  spaceKey: z.string().trim().min(1, "spaceKey is required"),
  limit: limitSchema,
  start: startSchema,
  // Cloud only: opaque cursor from the previous page's nextCursor.
  cursor: cursorSchema,
});

/** Extract the space description from either expand shape (plain preferred). */
function spaceDescription(space: unknown): string | null {
  return asString(getPath(space, "description.plain.value")) ?? asString(getPath(space, "description.view.value"));
}

// --- Server/DC implementations -------------------------------------------------

async function serverListSpaces(ctx: ToolCallContext, args: z.infer<typeof listSpacesSchema>): Promise<unknown> {
  const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/space`, {
    query: { ...serverPageQuery({ limit: args.limit, start: args.start }), type: args.type },
  });
  const items = extractPageItems(payload);
  const meta = serverPageMeta(payload, { limit: args.limit, start: args.start }, items.length);
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
}

async function serverGetSpace(ctx: ToolCallContext, args: z.infer<typeof getSpaceSchema>): Promise<unknown> {
  const space = await ctx.provider.client.get(`${SERVER_API_PREFIX}/space/${encodeURIComponent(args.key)}`, {
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
}

async function serverListPagesInSpace(ctx: ToolCallContext, args: z.infer<typeof listPagesSchema>): Promise<unknown> {
  const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content`, {
    query: { type: "page", spaceKey: args.spaceKey, expand: "version", ...serverPageQuery({ limit: args.limit, start: args.start }) },
  });
  const items = extractPageItems(payload);
  const meta = serverPageMeta(payload, { limit: args.limit, start: args.start }, items.length);
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
}

/** Space read tools, served on both the Server/DC and Cloud providers. */
export const spaceToolManifests: ToolManifest[] = [
  {
    name: "cf_list_spaces",
    title: "List spaces",
    description:
      "List Confluence spaces with pagination. Returns a compact card: total size, spaces as " +
      "{key, name, type, url} and a follow-up pointer when more pages exist (nextStart on " +
      "Server/DC, nextCursor on Cloud). An optional type filter narrows the result to global " +
      "or personal spaces.",
    inputSchema: {
      limit: listSpacesSchema.shape.limit.describe("Max spaces per page (1-100, default 25)."),
      start: listSpacesSchema.shape.start.describe("Offset into the space list (Server/DC, default 0)."),
      type: listSpacesSchema.shape.type.describe("Optional filter: \"global\" or \"personal\"."),
      cursor: listSpacesSchema.shape.cursor.describe(
        "Opaque cursor from the previous page's nextCursor (Cloud only).",
      ),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(listSpacesSchema, "cf_list_spaces", {
      server: serverListSpaces,
      cloud: cloudListSpaces,
    }),
  },
  {
    name: "cf_get_space",
    title: "Get space by key",
    description:
      "Fetch one Confluence space by key and return a compact card: key, id (Cloud), name, type, " +
      "status, description and web URL. The description is read from description.plain when the " +
      "instance expands it, falling back to description.view. Fails with NOT_FOUND for unknown " +
      "keys (Cloud resolves the key to its numeric space id first).",
    inputSchema: {
      key: getSpaceSchema.shape.key.describe("Space key, e.g. \"DEV\"."),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(getSpaceSchema, "cf_get_space", {
      server: serverGetSpace,
      cloud: cloudGetSpace,
    }),
  },
  {
    name: "cf_list_pages_in_space",
    title: "List pages in space",
    description:
      "List the pages of one Confluence space with pagination. Returns a compact card: total size, " +
      "pages as {id, title, url, version, when} (last-modified info via the version) and a " +
      "follow-up pointer when more pages exist (nextStart on Server/DC, nextCursor on Cloud; " +
      "Cloud resolves the space key to its numeric space id first).",
    inputSchema: {
      spaceKey: listPagesSchema.shape.spaceKey.describe("Space key, e.g. \"DEV\"."),
      limit: listPagesSchema.shape.limit.describe("Max pages per call (1-100, default 25)."),
      start: listPagesSchema.shape.start.describe("Offset into the page list (Server/DC, default 0)."),
      cursor: listPagesSchema.shape.cursor.describe(
        "Opaque cursor from the previous page's nextCursor (Cloud only).",
      ),
    },
    providers: ["server", "cloud"],
    readOnly: true,
    handler: dispatchByProvider(listPagesSchema, "cf_list_pages_in_space", {
      server: serverListPagesInSpace,
      cloud: cloudListPagesInSpace,
    }),
  },
];
