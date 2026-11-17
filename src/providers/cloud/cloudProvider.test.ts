import { describe, expect, it, vi } from "vitest";
import { cloudAuthHeaders, cloudBaseUrl, createCloudProvider } from "./cloudProvider.js";
import { loadConfig } from "../../core/config.js";

const BASE_CONFIG = {
  CONFLUENCE_URL: "https://confluence.example.com",
  CONFLUENCE_PROVIDER: "cloud",
} as const;

describe("createCloudProvider", () => {
  it("returns an available provider with cursor pagination style and the /wiki base", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_CLOUD_EMAIL: "dev@example.com", CONFLUENCE_CLOUD_API_TOKEN: "t" });
    const provider = createCloudProvider(config);
    expect(provider.id).toBe("cloud");
    expect(provider.available).toBe(true);
    expect(provider.pagination).toEqual({
      limitParam: "limit",
      startParam: "cursor",
      oneBasedPage: false,
      pageMode: "cursor",
    });
    expect(provider.client).toBeDefined();
    expect(cloudBaseUrl(config)).toBe("https://confluence.example.com/wiki");
  });

  it("answers requests against {CONFLUENCE_URL}/wiki with the configured auth headers", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { config } = loadConfig({
        ...BASE_CONFIG,
        CONFLUENCE_CLOUD_EMAIL: "dev@example.com",
        CONFLUENCE_CLOUD_API_TOKEN: "atok",
        CONFLUENCE_CUSTOM_HEADERS: "X-Trace: abc",
      });
      const { client } = createCloudProvider(config);
      await client.get("/api/v2/pages/100");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toBe("https://confluence.example.com/wiki/api/v2/pages/100");
      expect(init.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from("dev@example.com:atok").toString("base64")}`,
        "X-Trace": "abc",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("cloudAuthHeaders", () => {
  it("uses Basic base64(email:apiToken) for the email + API-token pair", () => {
    const { config } = loadConfig({
      ...BASE_CONFIG,
      CONFLUENCE_CLOUD_EMAIL: "dev@example.com",
      CONFLUENCE_CLOUD_API_TOKEN: "atok",
    });
    expect(cloudAuthHeaders(config)).toEqual({
      Authorization: `Basic ${Buffer.from("dev@example.com:atok").toString("base64")}`,
    });
  });

  it("prefers Basic (the primary Cloud credential) over the Bearer token", () => {
    const { config } = loadConfig({
      ...BASE_CONFIG,
      CONFLUENCE_CLOUD_EMAIL: "dev@example.com",
      CONFLUENCE_CLOUD_API_TOKEN: "atok",
      CONFLUENCE_TOKEN: "oauth",
    });
    expect(cloudAuthHeaders(config).Authorization).toBe(`Basic ${Buffer.from("dev@example.com:atok").toString("base64")}`);
  });

  it("sends CONFLUENCE_TOKEN as Bearer (OAuth access token)", () => {
    const { config } = loadConfig({ ...BASE_CONFIG, CONFLUENCE_TOKEN: "pat-tok" });
    expect(cloudAuthHeaders(config)).toEqual({ Authorization: "Bearer pat-tok" });
  });

  it("returns no auth header without credentials", () => {
    expect(cloudAuthHeaders(loadConfig({ CONFLUENCE_URL: "https://confluence.example.com" }).config)).toEqual({});
  });
});
