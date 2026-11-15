/**
 * Thin REST wrapper around fetch: auth headers, custom headers, query
 * serialization, timeouts and error normalization. Transport-agnostic —
 * provider adapters construct it with their own auth strategy.
 */

export type RestErrorCode =
  | "AUTH_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "NOT_IMPLEMENTED";

export class RestError extends Error {
  readonly status: number;
  readonly code: RestErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: RestErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "RestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorCodeForStatus(status: number): RestErrorCode {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 400 || status === 422) return "VALIDATION";
  return "UPSTREAM_ERROR";
}

/** Best-effort message extraction from known Confluence error envelopes. */
export function extractUpstreamMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;

  // Server/DC and Cloud v2: { errors: [{ message }] }
  if (Array.isArray(record.errors)) {
    const messages = record.errors
      .map((e) => (typeof e === "object" && e !== null ? (e as Record<string, unknown>).message : undefined))
      .filter((m): m is string => typeof m === "string");
    if (messages.length > 0) return messages.join("; ");
  }
  // Cloud 1.0-style: { error: { message } }
  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  // Server/DC single-error envelope: { message, statusCode }
  if (typeof record.message === "string") return record.message;
  return undefined;
}

export interface RestClientOptions {
  /** Headers that implement auth, e.g. `Authorization`. Set by the provider adapter. */
  authHeaders?: Record<string, string>;
  /** Extra headers appended to every request (CONFLUENCE_CUSTOM_HEADERS). */
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class RestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly options: RestClientOptions = {},
  ) {}

  async request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(
      path.replace(/^\/+/, ""),
      this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`,
    );
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.options.authHeaders,
      ...this.options.defaultHeaders,
      ...opts.headers,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: opts.method ?? "GET",
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new RestError(0, "TIMEOUT", `Request to ${url.pathname} timed out.`);
        }
        throw new RestError(
          0,
          "NETWORK_ERROR",
          `Network error while calling ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const text = await response.text();
      const parsed: unknown = text ? safeJson(text) : null;

      if (!response.ok) {
        const upstream = extractUpstreamMessage(parsed);
        throw new RestError(
          response.status,
          errorCodeForStatus(response.status),
          `Confluence request failed (HTTP ${response.status})${upstream ? `: ${upstream}` : ""}`,
          parsed,
        );
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async get<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "GET" });
  }

  async post<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "POST" });
  }

  async put<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "PUT" });
  }

  async delete<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "DELETE" });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
