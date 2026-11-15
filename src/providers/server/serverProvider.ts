/**
 * Confluence Server / Data Center adapter.
 *
 * Auth: personal access token -> `Authorization: Bearer <token>`,
 *       username + password      -> `Authorization: Basic base64(user:pass)`.
 * REST: `<CONFLUENCE_URL>/rest/api`, zero-based `start`/`limit` pagination
 * with numbered envelopes ({ results, size, limit, start, _links }).
 */

import type { ConfluenceConfig } from "../../core/config.js";
import type { ProviderContext } from "../../core/provider.js";
import { SERVER_PAGINATION } from "../../core/provider.js";
import { RestClient } from "../../core/restClient.js";

/** REST API path prefix for Confluence Server / Data Center. */
export const SERVER_API_PREFIX = "/rest/api";

export function serverAuthHeaders(config: ConfluenceConfig): Record<string, string> {
  if (config.token) {
    return { Authorization: `Bearer ${config.token}` };
  }
  if (config.username && config.password) {
    const basic = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}

export function createServerProvider(config: ConfluenceConfig): ProviderContext {
  return {
    id: "server",
    available: true,
    client: new RestClient(config.url ?? "", {
      authHeaders: serverAuthHeaders(config),
      defaultHeaders: config.customHeaders,
    }),
    pagination: SERVER_PAGINATION,
  };
}
