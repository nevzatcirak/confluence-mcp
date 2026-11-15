import { describe, expect, it, vi } from "vitest";
import { cloudAuthHeaders, cloudBaseUrl, cloudUnavailableError, createCloudProvider } from "./cloudProvider.js";
import { ERROR_CODES } from "../../core/errors.js";
import { loadConfig } from "../../core/config.js";

const BASE_CONFIG = {
  CONFLUENCE_URL: "https://confluence.example.com",
  CONFLUENCE_PROVIDER: "cloud",
} as const;

describe("createCloudProvider", () => {
  it("returns an unavailable seam provider with cursor pagination style", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_TOKEN: "t" });
    const provider = createCloudProvider(config);
    expect(provider.id).toBe("cloud");
    expect(provider.available).toBe(false);
    expect(provider.pagination).toEqual({
      limitParam: "limit",
      startParam: "cursor",
      oneBasedPage: false,
      pageMode: "cursor",
    });
    expect(provider.client).toBeDefined();
    expect(cloudBaseUrl(config)).toBe("https://confluence.example.com");
  });
});

describe("cloudAuthHeaders", () => {
  it("prefers Bearer for a token", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_TOKEN: "pat-tok" });
    expect(cloudAuthHeaders(config)).toEqual({ Authorization: "Bearer pat-tok" });
  });

  it("falls back to Basic from username + password", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_USERNAME: "dev1", CONFLUENCE_PASSWORD: "tok2" });
    expect(cloudAuthHeaders(config)).toEqual({
      Authorization: `Basic ${Buffer.from("dev1:tok2").toString("base64")}`,
    });
  });

  it("returns no auth header without credentials", () => {
    expect(cloudAuthHeaders(loadConfig({ CONFLUENCE_URL: "https://confluence.example.com" }).config)).toEqual({});
  });
});

describe("cloud seam behavior", () => {
  it("fails every client call with structured PROVIDER_UNAVAILABLE", async () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_TOKEN: "t" });
    const provider = createCloudProvider(config);

    const err = await provider.client.get("/wiki/api/v2/pages").catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "ToolError",
      code: ERROR_CODES.PROVIDER_UNAVAILABLE,
      message: expect.stringContaining("Phase 4"),
    });
  });

  it("refuses all HTTP verbs, not just GET", async () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_TOKEN: "t" });
    const { client } = createCloudProvider(config);

    await expect(client.post("/x", { body: {} })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(client.put("/x")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(client.delete("/x")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("exposes the shared unavailable error via cloudUnavailableError()", () => {
    expect(cloudUnavailableError()).toMatchObject({ code: ERROR_CODES.PROVIDER_UNAVAILABLE });
  });
});

describe("no network access through the seam", () => {
  it("never invokes fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_TOKEN: "t" });
      const { client } = createCloudProvider(config);
      await expect(client.get("/wiki/api/v2/pages")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
