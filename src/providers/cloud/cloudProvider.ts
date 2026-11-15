/**
 * Confluence Cloud adapter — seam only (Phase 0).
 *
 * The Cloud v2 REST API adapter arrives in Phase 4. Until then:
 * - the provider is advertised as `available: false`, so the registry refuses
 *   every tool call with a structured PROVIDER_UNAVAILABLE error, and
 * - the client itself also fails every call with the same error, so nothing
 *   can reach the network through this provider even if invoked directly.
 *
 * Wire details recorded for the Phase 4 adapter:
 * - REST base: `<CONFLUENCE_URL>/wiki/api/v2` (v2) and `<CONFLUENCE_URL>/wiki/rest/api` (v1).
 * - Auth: CONFLUENCE_TOKEN -> Bearer, or CONFLUENCE_USERNAME +
 *   CONFLUENCE_PASSWORD -> Basic.
 * - Pagination: `limit` + opaque cursor from `_links.next` (CLOUD_PAGINATION).
 */

import type { ConfluenceConfig } from "../../core/config.js";
import { ERROR_CODES, ToolError } from "../../core/errors.js";
import type { ProviderContext } from "../../core/provider.js";
import { CLOUD_PAGINATION } from "../../core/provider.js";
import { RestClient, type RequestOptions } from "../../core/restClient.js";

/** Structured failure used for every Cloud call until the Phase 4 adapter lands. */
export function cloudUnavailableError(): ToolError {
  return new ToolError(
    ERROR_CODES.PROVIDER_UNAVAILABLE,
    "The Confluence Cloud adapter is not implemented yet — Cloud v2 API arrives in Phase 4.",
    { provider: "cloud" },
  );
}

/** REST client that fails every request with PROVIDER_UNAVAILABLE. */
class CloudSeamClient extends RestClient {
  override async request<T = unknown>(_path: string, _opts: RequestOptions = {}): Promise<T> {
    throw cloudUnavailableError();
  }
}

export function cloudBaseUrl(config: ConfluenceConfig): string {
  // Unlike Server/DC there is no public default: the instance URL is required.
  return config.url ?? "";
}

export function cloudAuthHeaders(config: ConfluenceConfig): Record<string, string> {
  if (config.token) {
    return { Authorization: `Bearer ${config.token}` };
  }
  if (config.username && config.password) {
    const basic = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}

export function createCloudProvider(config: ConfluenceConfig): ProviderContext {
  return {
    id: "cloud",
    available: false,
    client: new CloudSeamClient(cloudBaseUrl(config), {
      authHeaders: cloudAuthHeaders(config),
      defaultHeaders: config.customHeaders,
    }),
    pagination: CLOUD_PAGINATION,
  };
}
