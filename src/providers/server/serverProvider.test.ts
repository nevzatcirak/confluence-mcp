import { describe, expect, it } from "vitest";
import { createServerProvider, SERVER_API_PREFIX, serverAuthHeaders } from "./serverProvider.js";
import { loadConfig } from "../../core/config.js";

const BASE_CONFIG = {
  CONFLUENCE_URL: "https://confluence.example.com",
  CONFLUENCE_PROVIDER: "server",
} as const;

describe("serverAuthHeaders", () => {
  it("prefers token auth as Bearer", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_TOKEN: "pat-1" });
    expect(serverAuthHeaders(config)).toEqual({ Authorization: "Bearer pat-1" });
  });

  it("falls back to Basic auth from credentials", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_USERNAME: "dev1", CONFLUENCE_PASSWORD: "pw1" });
    expect(serverAuthHeaders(config)).toEqual({
      Authorization: `Basic ${Buffer.from("dev1:pw1").toString("base64")}`,
    });
  });

  it("returns no headers when unauthenticated", () => {
    const { config } = loadConfig(BASE_CONFIG);
    expect(serverAuthHeaders(config)).toEqual({});
  });
});

describe("createServerProvider", () => {
  it("exposes an available server provider with numbered pagination style", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_TOKEN: "t" });
    const provider = createServerProvider(config);
    expect(provider.id).toBe("server");
    expect(provider.available).toBe(true);
    expect(provider.pagination).toEqual({
      limitParam: "limit",
      startParam: "start",
      oneBasedPage: false,
      pageMode: "number",
    });
    expect(provider.client).toBeDefined();
  });

  it("documents the Confluence Server/DC REST prefix", () => {
    expect(SERVER_API_PREFIX).toBe("/rest/api");
  });
});
