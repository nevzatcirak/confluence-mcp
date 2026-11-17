/**
 * Provider seam: the server supports Confluence Server / Data Center and
 * Confluence Cloud. Both adapters are fully implemented; every tool manifest
 * declares which providers it supports, and tools whose manifest does not
 * list the active provider are never advertised to the MCP client.
 */

import type { RestClient } from "./restClient.js";

export type ProviderId = "server" | "cloud";

/** How a provider paginates responses. */
export type PageMode = "number" | "cursor";

/**
 * How a provider expresses pagination as query parameters.
 * - Server/DC: `?limit=25&start=0` (zero-based offset, pageMode "number").
 *   Envelopes carry `size` plus a `_links.next` path when more pages exist.
 * - Cloud: `?limit=25` with cursor-style follow-up via the `cursor` token
 *   extracted from the `_links.next` URL (pageMode "cursor").
 */
export interface PaginationStyle {
  readonly limitParam: string;
  readonly startParam: string;
  /** True when the start parameter is a one-based page number instead of an offset. */
  readonly oneBasedPage: boolean;
  /**
   * "number": follow-up pages are addressed by numeric offset/page params.
   * "cursor": follow-up pages come from an opaque cursor (the Cloud
   * `_links.next` URL). Consumers must not assume nextPageStart is meaningful
   * when pageMode is "cursor" — use nextCursor instead.
   */
  readonly pageMode: PageMode;
}

export const SERVER_PAGINATION: PaginationStyle = {
  limitParam: "limit",
  startParam: "start",
  oneBasedPage: false,
  pageMode: "number",
};

export const CLOUD_PAGINATION: PaginationStyle = {
  limitParam: "limit",
  startParam: "cursor",
  oneBasedPage: false,
  pageMode: "cursor",
};

/** Runtime handle a tool uses to talk to the active deployment. */
export interface ProviderContext {
  readonly id: ProviderId;
  /**
   * False when the provider context is not usable (defensive gate — both
   * built-in providers construct themselves as available). Calls against an
   * unavailable provider return a structured PROVIDER_UNAVAILABLE error
   * instead of crashing.
   */
  readonly available: boolean;
  readonly client: RestClient;
  readonly pagination: PaginationStyle;
}
