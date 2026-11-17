/**
 * Confluence Cloud adapter.
 *
 * Base path: `<CONFLUENCE_URL>/wiki`. The v2 REST API lives under
 * `/wiki/api/v2`, the legacy v1 REST API under `/wiki/rest/api`; both coexist
 * and both accept the same auth. v2 has no search endpoint, so Cloud search
 * (and all label writes) go through v1 — everything else is v2.
 *
 * Auth: CONFLUENCE_CLOUD_EMAIL + CONFLUENCE_CLOUD_API_TOKEN ->
 *       `Authorization: Basic base64(email:apiToken)` (primary), or
 *       CONFLUENCE_TOKEN -> `Authorization: Bearer <token>` (OAuth access token).
 * Config validation guarantees exactly one of the two.
 *
 * Pagination: Cloud pages exclusively by cursor — `limit` plus the opaque
 * `cursor` token from the envelope's `_links.next` URL (v2 and Cloud v1
 * alike). The cursor is passed back verbatim; an absent `_links.next` means
 * the listing is exhausted.
 */

import type { ConfluenceConfig } from "../../core/config.js";
import type { ProviderContext } from "../../core/provider.js";
import { CLOUD_PAGINATION } from "../../core/provider.js";
import { RestClient } from "../../core/restClient.js";

/** Cloud v2 REST API path prefix (relative to the `/wiki` base). */
export const CLOUD_V2_API_PREFIX = "/api/v2";

/** Cloud legacy v1 REST API path prefix (relative to the `/wiki` base). */
export const CLOUD_V1_API_PREFIX = "/rest/api";

/** Full REST base: the instance URL plus Confluence Cloud's `/wiki` context path. */
export function cloudBaseUrl(config: ConfluenceConfig): string {
  return config.url ? `${config.url}/wiki` : "";
}

export function cloudAuthHeaders(config: ConfluenceConfig): Record<string, string> {
  if (config.cloudEmail && config.cloudApiToken) {
    const basic = Buffer.from(`${config.cloudEmail}:${config.cloudApiToken}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  if (config.token) {
    return { Authorization: `Bearer ${config.token}` };
  }
  return {};
}

export function createCloudProvider(config: ConfluenceConfig): ProviderContext {
  return {
    id: "cloud",
    available: true,
    client: new RestClient(cloudBaseUrl(config), {
      authHeaders: cloudAuthHeaders(config),
      defaultHeaders: config.customHeaders,
    }),
    pagination: CLOUD_PAGINATION,
  };
}
