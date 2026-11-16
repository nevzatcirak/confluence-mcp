/**
 * Write tools for Confluence Server / Data Center (Phase 2):
 * - cf_create_page   POST   /rest/api/content
 * - cf_update_page   PUT    /rest/api/content/{id}   (mandatory optimistic lock)
 * - cf_delete_page   DELETE /rest/api/content/{id}   (moves to trash only)
 * - cf_add_label     POST   /rest/api/content/{id}/label
 * - cf_remove_label  DELETE /rest/api/content/{id}/label?name=
 *
 * All write manifests declare `providers: ["server"]` and `readOnly: false`,
 * so the registry hides them under CONFLUENCE_READ_ONLY=true and on the
 * (unimplemented) cloud provider. Bodies default to Markdown and are
 * converted with markdownToStorage (src/core/markdown) — anything outside the
 * supported subset is rejected with a structured VALIDATION error;
 * bodyFormat "storage" passes the caller's XHTML through verbatim.
 *
 * cf_delete_page only moves a page to the Confluence trash; permanent purge
 * is a separate server-side operation and is intentionally not exposed here.
 */

import { z } from "zod";
import { ERROR_CODES, ToolError } from "../core/errors.js";
import { asNumber, asRecord, asString, getPath } from "../core/json.js";
import { markdownToStorage } from "../core/markdown/markdownToStorage.js";
import { withOptimisticLock, versionNumberOf } from "../core/optimisticLock.js";
import { SERVER_API_PREFIX } from "../providers/server/serverProvider.js";
import { extractPageItems, parseToolArgs, resolveLink } from "./shared.js";
import type { ToolCallContext, ToolManifest } from "./registry.js";

/** Body formats accepted by the write tools (read tools additionally accept "view"). */
const WRITE_BODY_FORMATS = ["markdown", "storage"] as const;
export type WriteBodyFormat = (typeof WRITE_BODY_FORMATS)[number];

const bodyFormatSchema = z.enum(WRITE_BODY_FORMATS).default("markdown");

const idSchema = z.string().trim().min(1, "id is required");

const createPageSchema = z.object({
  spaceKey: z.string().trim().min(1, "spaceKey is required"),
  title: z.string().trim().min(1, "title is required"),
  body: z.string().min(1, "body is required"),
  bodyFormat: bodyFormatSchema,
  parent: z.string().trim().min(1).optional(),
});

const updatePageArgs = z.object({
  id: z.string().trim().min(1, "id is required"),
  title: z.string().trim().min(1).optional(),
  body: z.string().min(1).optional(),
  bodyFormat: bodyFormatSchema,
  message: z.string().trim().optional(),
});

const updatePageSchema = updatePageArgs.refine(
  (value) => value.title !== undefined || value.body !== undefined,
  { message: "At least one of title or body is required." },
);

const pageIdSchema = z.object({ id: idSchema });

const labelNameSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1, "name is required"),
});

/** Convert the caller's body to storage XHTML: markdown converts, storage passes through. */
function resolveBodyStorage(body: string, bodyFormat: WriteBodyFormat): string {
  return bodyFormat === "storage" ? body : markdownToStorage(body);
}

/** Page title of a fetched payload, for update requests that only change the body. */
function titleOf(payload: unknown): string {
  return asString(asRecord(payload)?.title) ?? "";
}

/** Compact page card for write results: id, title, web URL, version and space. */
function pageWriteCard(
  ctx: ToolCallContext,
  payload: unknown,
  fallback: { title?: string; spaceKey?: string } = {},
): Record<string, unknown> {
  const record = asRecord(payload) ?? {};
  return {
    id: asString(record.id),
    title: asString(record.title) ?? fallback.title ?? null,
    url: resolveLink(ctx, payload, "webui"),
    version: asNumber(getPath(record, "version.number")),
    space: asString(getPath(record, "space.key")) ?? fallback.spaceKey ?? null,
  };
}

/** Fetch a page with its version (the optimistic-lock re-fetch step). */
async function fetchPageVersion(ctx: ToolCallContext, id: string): Promise<{ page: unknown; version: number }> {
  const page = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}`, {
    query: { expand: "version" },
  });
  const version = versionNumberOf(page);
  if (version === null) {
    throw new ToolError(
      ERROR_CODES.UPSTREAM_ERROR,
      "Confluence returned a page payload without a version number; refusing to write.",
      { id },
    );
  }
  return { page, version };
}

/** Single page of labels (up to 100): compact {id, name, prefix} entries. */
async function fetchLabels(ctx: ToolCallContext, id: string): Promise<Array<Record<string, unknown>>> {
  const payload = await ctx.provider.client.get(`${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}/label`, {
    query: { limit: 100, start: 0 },
  });
  return extractPageItems(payload).map((item) => {
    const record = asRecord(item) ?? {};
    return {
      // Some Server builds nest the label payload under a `label` key.
      id: asString(getPath(record, "label.id")) ?? asString(record.id),
      name: asString(record.name) ?? asString(getPath(record, "label.name")),
      prefix: asString(record.prefix) ?? asString(getPath(record, "label.prefix")),
    };
  });
}

/** Phase 2 write tools for the Server/DC provider. */
export const writeToolManifests: ToolManifest[] = [
  {
    name: "cf_create_page",
    title: "Create page",
    description:
      "Create a Confluence page in a space and return a compact card (id, title, url, version, space). " +
      "body defaults to Markdown and is converted to storage format with a strict writer-friendly " +
      "subset (headings, paragraphs, one-level lists, fenced code, bold/italic/inline code, links); " +
      "unsupported Markdown is rejected with VALIDATION — pass bodyFormat \"storage\" to author raw " +
      "Confluence storage XHTML instead. An optional parent page id nests the new page under that " +
      "ancestor. Confluence Server / Data Center only.",
    inputSchema: {
      spaceKey: createPageSchema.shape.spaceKey.describe("Space key to create the page in, e.g. \"DEV\"."),
      title: createPageSchema.shape.title.describe("Page title."),
      body: createPageSchema.shape.body.describe(
        "Page body as Markdown (default) or raw storage XHTML when bodyFormat is \"storage\".",
      ),
      bodyFormat: createPageSchema.shape.bodyFormat.describe(
        "\"markdown\" (default, converted with the supported subset) or \"storage\" (raw XHTML passed through).",
      ),
      parent: createPageSchema.shape.parent.describe(
        "Optional content id of the parent page; the new page becomes its child.",
      ),
    },
    providers: ["server"],
    readOnly: false,
    handler: async (args, ctx) => {
      const { spaceKey, title, body, bodyFormat, parent } = parseToolArgs(createPageSchema, args, "cf_create_page");

      const payload: Record<string, unknown> = {
        type: "page",
        title,
        space: { key: spaceKey },
        body: { storage: { value: resolveBodyStorage(body, bodyFormat), representation: "storage" } },
      };
      if (parent !== undefined) payload.ancestors = [{ id: parent }];

      const page = await ctx.provider.client.post(`${SERVER_API_PREFIX}/content`, { body: payload });
      return pageWriteCard(ctx, page, { title, spaceKey });
    },
  },
  {
    name: "cf_update_page",
    title: "Update page",
    description:
      "Update a Confluence page's title and/or body with a mandatory optimistic lock: the current " +
      "page version is fetched, the write carries version.number + 1, and on HTTP 409 (concurrent " +
      "edit) the page is re-fetched and the write retried exactly once — a second conflict surfaces " +
      "a structured CONFLICT error instead of retrying again. body follows the same Markdown-subset / " +
      "storage rules as cf_create_page; an optional message is stored as the version message. " +
      "Confluence Server / Data Center only.",
    inputSchema: {
      id: updatePageArgs.shape.id.describe("Confluence content id of the page."),
      title: updatePageArgs.shape.title.describe("New page title (optional)."),
      body: updatePageArgs.shape.body.describe(
        "New page body as Markdown (default) or raw storage XHTML when bodyFormat is \"storage\" (optional).",
      ),
      bodyFormat: updatePageArgs.shape.bodyFormat.describe(
        "\"markdown\" (default, converted with the supported subset) or \"storage\" (raw XHTML passed through).",
      ),
      message: updatePageArgs.shape.message.describe("Optional version message, e.g. \"added runbook section\"."),
    },
    providers: ["server"],
    readOnly: false,
    handler: async (args, ctx) => {
      const { id, title, body, bodyFormat, message } = parseToolArgs(updatePageSchema, args, "cf_update_page");
      const storageBody = body === undefined ? undefined : resolveBodyStorage(body, bodyFormat);

      const updated = await withOptimisticLock({
        fetchCurrent: () => fetchPageVersion(ctx, id),
        apply: async (current) => {
          const version: Record<string, unknown> = { number: current.version + 1 };
          if (message !== undefined) version.message = message;

          const payload: Record<string, unknown> = {
            id,
            type: "page",
            version,
            title: title ?? titleOf(current.page),
          };
          if (storageBody !== undefined) {
            payload.body = { storage: { value: storageBody, representation: "storage" } };
          }
          return ctx.provider.client.put(`${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}`, { body: payload });
        },
      });

      return pageWriteCard(ctx, updated);
    },
  },
  {
    name: "cf_delete_page",
    title: "Delete page (to trash)",
    description:
      "Move a Confluence page to the trash (DELETE /rest/api/content/{id}) and return a trashed " +
      "confirmation card. The page is NOT permanently purged: restoring or purging trashed pages " +
      "is a separate server-side administration operation this tool deliberately does not expose. " +
      "Confluence Server / Data Center only.",
    inputSchema: {
      id: pageIdSchema.shape.id.describe("Confluence content id of the page."),
    },
    providers: ["server"],
    readOnly: false,
    handler: async (args, ctx) => {
      const { id } = parseToolArgs(pageIdSchema, args, "cf_delete_page");
      await ctx.provider.client.delete(`${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}`);
      return {
        id,
        status: "trashed",
        trashed: true,
        note:
          "The page was moved to the Confluence trash. Permanent purge is a separate server-side " +
          "operation and is not performed by this tool.",
      };
    },
  },
  {
    name: "cf_add_label",
    title: "Add label",
    description:
      "Add a single global label to a piece of Confluence content (one call adds one label; call " +
      "again for more) and return the labels now on the page as compact {id, name, prefix} entries. " +
      "Confluence Server / Data Center only.",
    inputSchema: {
      id: labelNameSchema.shape.id.describe("Confluence content id."),
      name: labelNameSchema.shape.name.describe("Label name to add, e.g. \"runbook\"."),
    },
    providers: ["server"],
    readOnly: false,
    handler: async (args, ctx) => {
      const { id, name } = parseToolArgs(labelNameSchema, args, "cf_add_label");
      await ctx.provider.client.post(`${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}/label`, {
        body: [{ prefix: "global", name }],
      });
      const labels = await fetchLabels(ctx, id);
      return { id, added: name, size: labels.length, labels };
    },
  },
  {
    name: "cf_remove_label",
    title: "Remove label",
    description:
      "Remove one label (by name) from a piece of Confluence content and return the labels that " +
      "remain as compact {id, name, prefix} entries. Confluence Server / Data Center only.",
    inputSchema: {
      id: labelNameSchema.shape.id.describe("Confluence content id."),
      name: labelNameSchema.shape.name.describe("Name of the label to remove."),
    },
    providers: ["server"],
    readOnly: false,
    handler: async (args, ctx) => {
      const { id, name } = parseToolArgs(labelNameSchema, args, "cf_remove_label");
      await ctx.provider.client.delete(`${SERVER_API_PREFIX}/content/${encodeURIComponent(id)}/label`, {
        query: { name },
      });
      const labels = await fetchLabels(ctx, id);
      return { id, removed: name, size: labels.length, labels };
    },
  },
];
