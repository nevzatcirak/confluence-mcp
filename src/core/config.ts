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
  /** Personal access token -> Authorization: Bearer. Server primary; Cloud secondary (OAuth). */
  token?: string;
  username?: string;
  /** Used with username for `Authorization: Basic base64(user:pass)`. Server/DC only. */
  password?: string;
  /** Atlassian account email; with cloudApiToken -> `Authorization: Basic base64(email:token)`. Cloud primary. */
  cloudEmail?: string;
  /** Confluence Cloud API token; only valid together with cloudEmail. Cloud primary. */
  cloudApiToken?: string;
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
  const credentials = {
    token: optional(env.CONFLUENCE_TOKEN),
    username: optional(env.CONFLUENCE_USERNAME),
    password: optional(env.CONFLUENCE_PASSWORD),
    cloudEmail: optional(env.CONFLUENCE_CLOUD_EMAIL),
    cloudApiToken: optional(env.CONFLUENCE_CLOUD_API_TOKEN),
  };
  problems.push(...credentialProblems(provider, credentials));

  const { headers, problems: headerProblems } = parseCustomHeaders(env.CONFLUENCE_CUSTOM_HEADERS);
  problems.push(...headerProblems);

  return {
    config: {
      url: url ?? undefined,
      provider,
      token: credentials.token ?? undefined,
      username: credentials.username ?? undefined,
      password: credentials.password ?? undefined,
      cloudEmail: credentials.cloudEmail ?? undefined,
      cloudApiToken: credentials.cloudApiToken ?? undefined,
      readOnly: isTruthy(env.CONFLUENCE_READ_ONLY),
      customHeaders: headers,
    },
    problems,
  };
}

/**
 * Provider-conditional credential validation, shared by loadConfig and
 * requireCompleteConfig.
 *
 * - Server/DC: either CONFLUENCE_TOKEN (Bearer) or the CONFLUENCE_USERNAME +
 *   CONFLUENCE_PASSWORD pair (Basic).
 * - Cloud: EXACTLY ONE of { CONFLUENCE_CLOUD_EMAIL + CONFLUENCE_CLOUD_API_TOKEN
 *   pair (Basic), CONFLUENCE_TOKEN (Bearer OAuth) }. One half of the pair
 *   alone is a problem, both credential sets together are a problem, and the
 *   Server/DC username/password pair is rejected as server-only.
 */
function credentialProblems(
  provider: ProviderId,
  creds: {
    token: string | null;
    username: string | null;
    password: string | null;
    cloudEmail: string | null;
    cloudApiToken: string | null;
  },
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const cloudPairSet = Boolean(creds.cloudEmail || creds.cloudApiToken);
  const cloudPairComplete = Boolean(creds.cloudEmail && creds.cloudApiToken);
  const serverBasicComplete = Boolean(creds.username && creds.password);

  if (provider === "cloud") {
    if (creds.username || creds.password) {
      problems.push({
        field: "CONFLUENCE_USERNAME",
        message:
          "CONFLUENCE_USERNAME and CONFLUENCE_PASSWORD are Server/DC-only credentials. " +
          "On Cloud, use CONFLUENCE_CLOUD_EMAIL + CONFLUENCE_CLOUD_API_TOKEN (Basic) or CONFLUENCE_TOKEN (Bearer).",
      });
    }
    if (cloudPairSet && creds.token) {
      problems.push({
        field: "CONFLUENCE_TOKEN",
        message:
          "Set exactly one Cloud credential: either CONFLUENCE_CLOUD_EMAIL + CONFLUENCE_CLOUD_API_TOKEN " +
          "or CONFLUENCE_TOKEN — not both.",
      });
    } else if (cloudPairSet && !cloudPairComplete) {
      problems.push({
        field: creds.cloudEmail ? "CONFLUENCE_CLOUD_API_TOKEN" : "CONFLUENCE_CLOUD_EMAIL",
        message: "CONFLUENCE_CLOUD_EMAIL and CONFLUENCE_CLOUD_API_TOKEN must be set together.",
        hint: "Cloud API-token Basic auth needs both the account email and the API token.",
      });
    } else if (!cloudPairSet && !creds.token) {
      problems.push({
        field: "CONFLUENCE_TOKEN",
        message: "Cloud requires CONFLUENCE_CLOUD_EMAIL + CONFLUENCE_CLOUD_API_TOKEN or CONFLUENCE_TOKEN.",
        hint: "API-token Basic auth (email + token) or an OAuth access token (Bearer).",
      });
    }
    return problems;
  }

  if (!creds.token && !serverBasicComplete) {
    problems.push({
      field: "CONFLUENCE_TOKEN",
      message: "Either CONFLUENCE_TOKEN or both CONFLUENCE_USERNAME and CONFLUENCE_PASSWORD must be set.",
      hint: "Personal access token (Bearer) or credentials (Basic).",
    });
  }
  return problems;
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
  problems.push(
    ...credentialProblems(config.provider, {
      token: config.token ?? null,
      username: config.username ?? null,
      password: config.password ?? null,
      cloudEmail: config.cloudEmail ?? null,
      cloudApiToken: config.cloudApiToken ?? null,
    }),
  );
  return problems;
}

/** True when the config carries at least one complete credential set for its provider. */
export function hasAuth(config: ConfluenceConfig): boolean {
  if (config.provider === "cloud") {
    return Boolean(config.token || (config.cloudEmail && config.cloudApiToken));
  }
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
