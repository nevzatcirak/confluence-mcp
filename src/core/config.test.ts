import { describe, expect, it } from "vitest";
import { hasAuth, loadConfig, parseCustomHeaders, requireCompleteConfig } from "./config.js";

const FULL_ENV = {
  CONFLUENCE_URL: "https://confluence.example.com/",
  CONFLUENCE_PROVIDER: "server",
  CONFLUENCE_TOKEN: "tok-1",
  CONFLUENCE_READ_ONLY: "true",
  CONFLUENCE_CUSTOM_HEADERS: "X-Trace: abc, X-Tenant : t1",
};

describe("loadConfig", () => {
  it("loads a complete configuration and normalizes the URL", () => {
    const { config, problems } = loadConfig(FULL_ENV);
    expect(problems).toEqual([]);
    expect(config.url).toBe("https://confluence.example.com");
    expect(config.provider).toBe("server");
    expect(config.token).toBe("tok-1");
    expect(config.readOnly).toBe(true);
    expect(config.customHeaders).toEqual({ "X-Trace": "abc", "X-Tenant": "t1" });
  });

  it("defaults the provider to server when unset", () => {
    const { config, problems } = loadConfig({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_TOKEN: "t",
    });
    expect(config.provider).toBe("server");
    expect(problems).toEqual([]);
  });

  it("reports a problem for an invalid provider but still defaults to server", () => {
    const { config, problems } = loadConfig({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_TOKEN: "t",
      CONFLUENCE_PROVIDER: "gitea",
    });
    expect(config.provider).toBe("server");
    expect(problems).toHaveLength(1);
    expect(problems[0].field).toBe("CONFLUENCE_PROVIDER");
    expect(problems[0].message).toContain("gitea");
  });

  it("accepts username+password auth without a token", () => {
    const { config, problems } = loadConfig({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_USERNAME: "dev1",
      CONFLUENCE_PASSWORD: "pass1",
    });
    expect(problems).toEqual([]);
    expect(hasAuth(config)).toBe(true);
    expect(config.token).toBeUndefined();
  });

  it("reports a problem when no credential set is complete", () => {
    const { config, problems } = loadConfig({ CONFLUENCE_URL: "https://confluence.example.com" });
    expect(hasAuth(config)).toBe(false);
    expect(problems.some((p) => p.field === "CONFLUENCE_TOKEN")).toBe(true);
  });

  it("reports problems for a missing or invalid URL", () => {
    const missing = loadConfig({ CONFLUENCE_TOKEN: "t" });
    expect(missing.config.url).toBeUndefined();
    expect(missing.problems.some((p) => p.field === "CONFLUENCE_URL")).toBe(true);

    const invalid = loadConfig({ CONFLUENCE_URL: "ftp://confluence.example.com", CONFLUENCE_TOKEN: "t" });
    expect(invalid.problems.some((p) => p.message.includes("http:// or https://"))).toBe(true);

    const unparsable = loadConfig({ CONFLUENCE_URL: "::not a url::", CONFLUENCE_TOKEN: "t" });
    expect(unparsable.problems.some((p) => p.field === "CONFLUENCE_URL")).toBe(true);
  });
});

describe("loadConfig (cloud)", () => {
  it("accepts the cloud provider with a token and the instance URL", () => {
    const { config, problems } = loadConfig({
      CONFLUENCE_PROVIDER: "cloud",
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_TOKEN: "tok-2",
    });
    expect(problems).toEqual([]);
    expect(config.provider).toBe("cloud");
    expect(config.url).toBe("https://confluence.example.com");
  });

  it("accepts a username+password pair on cloud too", () => {
    const { problems } = loadConfig({
      CONFLUENCE_PROVIDER: "cloud",
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_USERNAME: "dev1",
      CONFLUENCE_PASSWORD: "pass1",
    });
    expect(problems).toEqual([]);
  });

  it("reports a problem when no cloud credential set is complete", () => {
    const { problems } = loadConfig({
      CONFLUENCE_PROVIDER: "cloud",
      CONFLUENCE_URL: "https://confluence.example.com",
    });
    expect(problems.some((p) => p.field === "CONFLUENCE_TOKEN")).toBe(true);
  });

  it("requireCompleteConfig still requires the URL on cloud (instance-specific base)", () => {
    const { config } = loadConfig({ CONFLUENCE_PROVIDER: "cloud", CONFLUENCE_TOKEN: "tok-2" });
    const fields = requireCompleteConfig(config).map((p) => p.field);
    expect(fields).toContain("CONFLUENCE_URL");
  });
});

describe("requireCompleteConfig", () => {
  it("is empty for a complete config", () => {
    const { config } = loadConfig(FULL_ENV);
    expect(requireCompleteConfig(config)).toEqual([]);
  });

  it("flags missing URL and auth on the request path", () => {
    const { config } = loadConfig({});
    const problems = requireCompleteConfig(config);
    expect(problems.map((p) => p.field).sort()).toEqual(["CONFLUENCE_TOKEN", "CONFLUENCE_URL"]);
  });
});

describe("parseCustomHeaders", () => {
  it("parses comma-separated Name: Value pairs", () => {
    const { headers, problems } = parseCustomHeaders("A: 1, B : 2");
    expect(headers).toEqual({ A: "1", B: "2" });
    expect(problems).toEqual([]);
  });

  it("reports malformed entries", () => {
    const { headers, problems } = parseCustomHeaders("no-colon, A:, : 3, B: ok");
    expect(headers).toEqual({ B: "ok" });
    expect(problems).toHaveLength(3);
    expect(problems.every((p) => p.field === "CONFLUENCE_CUSTOM_HEADERS")).toBe(true);
  });

  it("returns empty for unset values", () => {
    const { headers, problems } = parseCustomHeaders(undefined);
    expect(headers).toEqual({});
    expect(problems).toEqual([]);
  });
});
