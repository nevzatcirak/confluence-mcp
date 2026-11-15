/**
 * Structured MCP tool results. Every tool returns plain JSON via `mcpText`
 * or a structured error via `mcpError` — a tool handler never throws past
 * the registry, so the server process never crashes on a tool failure.
 */

import { RestError } from "./restClient.js";

export interface TextContent {
  type: "text";
  text: string;
}

/** Index signature keeps this structurally assignable to the SDK's CallToolResult. */
export interface McpToolResult {
  [key: string]: unknown;
  content: TextContent[];
  isError?: boolean;
}

export const ERROR_CODES = {
  CONFIG_MISSING: "CONFIG_MISSING",
  READ_ONLY: "READ_ONLY",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  DELETE_REFUSED: "DELETE_REFUSED",
  AUTH_FAILED: "AUTH_FAILED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION: "VALIDATION",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
  TIMEOUT: "TIMEOUT",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export function mcpText(result: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export function mcpError(code: string, message: string, details?: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, details } }, null, 2) }],
    isError: true,
  };
}

/**
 * Domain-level tool error: a failure that is not an HTTP status mapping
 * (e.g. a Cloud call against the unimplemented adapter) but must still
 * surface as a structured, stable error code to the MCP client.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

export function toMcpError(err: unknown): McpToolResult {
  if (err instanceof RestError) {
    return mcpError(err.code, err.message, err.details);
  }
  if (err instanceof ToolError) {
    return mcpError(err.code, err.message, err.details);
  }
  if (err instanceof Error) {
    return mcpError(ERROR_CODES.INTERNAL_ERROR, err.message);
  }
  return mcpError(ERROR_CODES.INTERNAL_ERROR, String(err));
}
