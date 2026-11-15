import type { ProviderId } from "./provider.js";

/**
 * Environment-driven configuration. `loadConfig` never throws: anything wrong
 * is reported as a ConfigProblem so the server can still start (and tools can
 * return structured CONFIG_MISSING errors) instead of crashing.
 */

export interface ConfluenceConfig {
  /** Base URL, trailing slash stripped. Undefined when missing/invalid. */
  url?: string;
  provider: ProviderId;
  /** Personal access token -> Authorization: Bearer. */
  token?: string;
  username?: string;
  /** Used with username for `Authorization: Basic base64(user:pass)`. */
  password?: string;
  readOnly: boolean;
  customHeaders: Record<string, string>;
}

export interface ConfigProblem {
  field: string;
  message: string;
  hint?: string;
}

export interface LoadedConfig {
  config: ConfluenceConfig;
  problems: ConfigProblem[];
}

const PROVIDERS: readonly string[] = ["server", "cloud"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const problems: ConfigProblem[] = [];

  const provider = parseProvider(env.CONFLUENCE_PROVIDER, problems);
  const url = normalizeUrl(env.CONFLUENCE_URL, problems);
  const token = optional(env.CONFLUENCE_TOKEN);
  const username = optional(env.CONFLUENCE_USERNAME);
  const password = optional(env.CONFLUENCE_PASSWORD);

  if (!token && !(username && password)) {
    problems.push({
      field: "CONFLUENCE_TOKEN",
      message: "Either CONFLUENCE_TOKEN or both CONFLUENCE_USERNAME and CONFLUENCE_PASSWORD must be set.",
      hint: "Personal access token (Bearer) or credentials (Basic).",
    });
  }

  const { headers, problems: headerProblems } = parseCustomHeaders(env.CONFLUENCE_CUSTOM_HEADERS);
  problems.push(...headerProblems);

  return {
    config: {
      url: url ?? undefined,
      provider,
      token: token ?? undefined,
      username: username ?? undefined,
      password: password ?? undefined,
      readOnly: isTruthy(env.CONFLUENCE_READ_ONLY),
      customHeaders: headers,
    },
    problems,
  };
}

/**
 * Request-path validation. Tools call this before doing work so a misconfigured
 * server answers with a structured error rather than a fetch failure.
 */
export function requireCompleteConfig(config: ConfluenceConfig): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  if (!config.url) {
    problems.push({
      field: "CONFLUENCE_URL",
      message: "CONFLUENCE_URL is required.",
      hint: "e.g. https://confluence.example.com",
    });
  }
  if (!config.token && !(config.username && config.password)) {
    problems.push({
      field: "CONFLUENCE_TOKEN",
      message: "Either CONFLUENCE_TOKEN or both CONFLUENCE_USERNAME and CONFLUENCE_PASSWORD must be set.",
    });
  }
  return problems;
}

/** True when the config carries at least one complete credential set. */
export function hasAuth(config: ConfluenceConfig): boolean {
  return Boolean(config.token || (config.username && config.password));
}

export function isTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function parseCustomHeaders(raw: string | undefined): {
  headers: Record<string, string>;
  problems: ConfigProblem[];
} {
  const headers: Record<string, string> = {};
  const problems: ConfigProblem[] = [];
  const value = raw?.trim();
  if (!value) return { headers, problems };

  for (const part of value.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const sep = entry.indexOf(":");
    if (sep <= 0) {
      problems.push({
        field: "CONFLUENCE_CUSTOM_HEADERS",
        message: `Invalid header entry '${entry}' — expected "Name: Value" pairs separated by commas.`,
      });
      continue;
    }
    const name = entry.slice(0, sep).trim();
    const headerValue = entry.slice(sep + 1).trim();
    if (!name || !headerValue) {
      problems.push({
        field: "CONFLUENCE_CUSTOM_HEADERS",
        message: `Invalid header entry '${entry}' — header name and value must both be non-empty.`,
      });
      continue;
    }
    headers[name] = headerValue;
  }
  return { headers, problems };
}

function optional(raw: string | undefined): string | null {
  const v = raw?.trim();
  return v ? v : null;
}

function normalizeUrl(raw: string | undefined, problems: ConfigProblem[]): string | null {
  const v = optional(raw);
  if (!v) {
    problems.push({
      field: "CONFLUENCE_URL",
      message: "CONFLUENCE_URL is required.",
      hint: "e.g. https://confluence.example.com",
    });
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    problems.push({ field: "CONFLUENCE_URL", message: `'${v}' is not a valid URL.` });
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    problems.push({ field: "CONFLUENCE_URL", message: "URL must start with http:// or https://." });
    return null;
  }
  return parsed.toString().replace(/\/+$/, "");
}

function parseProvider(raw: string | undefined, problems: ConfigProblem[]): ProviderId {
  const v = raw?.trim().toLowerCase();
  if (!v) return "server";
  if (PROVIDERS.includes(v)) return v as ProviderId;
  problems.push({
    field: "CONFLUENCE_PROVIDER",
    message: `Invalid provider '${raw}' — expected one of: ${PROVIDERS.join(", ")}.`,
  });
  return "server";
}
