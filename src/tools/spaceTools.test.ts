import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../core/config.js";
import { createServerProvider } from "../providers/server/serverProvider.js";
import type { ToolArgs, ToolCallContext } from "./registry.js";
import { toolManifests } from "./registry.js";

interface CapturedRequest {
  url: URL;
  init: RequestInit;
}

type Route = (url: URL) => { body: unknown; status?: number };

function stubFetchRoute(route: Route): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      captured.push({ url, init: init ?? {} });
      const { body, status = 200 } = route(url);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return { captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function serverCtx(): ToolCallContext {
  const { config } = loadConfig({ CONFLUENCE_URL: "https://confluence.example.com", CONFLUENCE_TOKEN: "t" });
  return { config, provider: createServerProvider(config) };
}

function callTool(name: string, args: unknown, ctx: ToolCallContext): Promise<unknown> {
  const manifest = toolManifests.find((m) => m.name === name);
  if (!manifest) throw new Error(`manifest not found: ${name}`);
  return manifest.handler(args as ToolArgs, ctx);
}

describe("cf_list_spaces", () => {
  function spacePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "1",
      key: "DEV",
      name: "Development",
      type: "global",
      _links: { base: "/confluence", webui: "/display/DEV" },
      ...overrides,
    };
  }

  it("returns a compact card with resolved space URLs", async () => {
    stubFetchRoute(() => ({ body: { results: [spacePayload()], size: 1, limit: 25, start: 0, _links: {} } }));

    const card = (await callTool("cf_list_spaces", {}, serverCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      size: 1,
      spaces: [{ key: "DEV", name: "Development", type: "global", url: "https://confluence.example.com/confluence/display/DEV" }],
      nextStart: null,
    });
  });

  it.each([
    // _links.next present -> follow-up offset (start + items on this page).
    [{ results: [spacePayload()], size: 1, limit: 25, start: 0, _links: { next: "/rest/api/space?limit=25&start=25" } }, 1],
    // no _links.next -> last page.
    [{ results: [spacePayload()], size: 1, limit: 25, start: 0, _links: {} }, null],
  ])("derives nextStart from the envelope (_links.next: %j)", async (envelope, expectedNextStart) => {
    stubFetchRoute(() => ({ body: envelope }));

    const card = (await callTool("cf_list_spaces", {}, serverCtx())) as Record<string, unknown>;
    expect(card.nextStart).toBe(expectedNextStart);
  });

  it("forwards the type filter and paging params as query parameters", async () => {
    const { captured } = stubFetchRoute(() => ({
      body: { results: [], size: 0, limit: 10, start: 20, _links: {} },
    }));

    await callTool("cf_list_spaces", { type: "personal", limit: 10, start: 20 }, serverCtx());

    const query = captured[0].url.searchParams;
    expect(query.get("type")).toBe("personal");
    expect(query.get("limit")).toBe("10");
    expect(query.get("start")).toBe("20");
  });

  it("omits the type filter when not requested", async () => {
    const { captured } = stubFetchRoute(() => ({ body: { results: [], size: 0, limit: 25, start: 0, _links: {} } }));

    await callTool("cf_list_spaces", {}, serverCtx());

    expect(captured[0].url.searchParams.has("type")).toBe(false);
  });

  it("rejects an out-of-range limit with VALIDATION", async () => {
    await expect(callTool("cf_list_spaces", { limit: 101 }, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("cf_get_space", () => {
  function spacePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      key: "DEV",
      name: "Development",
      type: "global",
      status: "current",
      _links: { base: "/confluence", webui: "/display/DEV" },
      ...overrides,
    };
  }

  it.each([
    // plain description preferred when the instance expands it.
    [{ description: { plain: { value: "Plain text" }, view: { value: "<p>HTML</p>" } } }, "Plain text"],
    // view fallback when plain is missing.
    [{ description: { view: { value: "<p>HTML</p>" } } }, "<p>HTML</p>"],
    // neither present -> null.
    [{}, null],
  ])("extracts the description defensively (%j)", async (overrides, expected) => {
    stubFetchRoute(() => ({ body: spacePayload(overrides) }));

    const card = (await callTool("cf_get_space", { key: "DEV" }, serverCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      key: "DEV",
      name: "Development",
      type: "global",
      status: "current",
      description: expected,
      url: "https://confluence.example.com/confluence/display/DEV",
    });
  });

  it("requests both description expands", async () => {
    const { captured } = stubFetchRoute(() => ({ body: spacePayload() }));

    await callTool("cf_get_space", { key: "DEV" }, serverCtx());

    expect(captured[0].url.pathname).toBe("/rest/api/space/DEV");
    expect(captured[0].url.searchParams.get("expand")).toBe("description.plain,description.view");
  });

  it("surfaces NOT_FOUND for an unknown space key", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));

    await expect(callTool("cf_get_space", { key: "NOPE" }, serverCtx())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a blank key with VALIDATION", async () => {
    await expect(callTool("cf_get_space", { key: "" }, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("cf_list_pages_in_space", () => {
  function pagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "100",
      type: "page",
      title: "Runbook",
      version: { number: 3, by: { displayName: "Dev One" }, when: "2026-01-02T03:04:05.000Z" },
      _links: { base: "/confluence", webui: "/display/DEV/Runbook" },
      ...overrides,
    };
  }

  it("lists pages with version/lastModified info and resolved URLs", async () => {
    stubFetchRoute(() => ({ body: { results: [pagePayload()], size: 1, limit: 25, start: 0, _links: {} } }));

    const card = (await callTool("cf_list_pages_in_space", { spaceKey: "DEV" }, serverCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      size: 1,
      pages: [
        {
          id: "100",
          title: "Runbook",
          url: "https://confluence.example.com/confluence/display/DEV/Runbook",
          version: 3,
          when: "2026-01-02T03:04:05.000Z",
        },
      ],
      nextStart: null,
    });
  });

  it("requests type=page with the space filter and version expand", async () => {
    const { captured } = stubFetchRoute(() => ({ body: { results: [], size: 0, limit: 25, start: 0, _links: {} } }));

    await callTool("cf_list_pages_in_space", { spaceKey: "DEV" }, serverCtx());

    const query = captured[0].url.searchParams;
    expect(captured[0].url.pathname).toBe("/rest/api/content");
    expect(query.get("type")).toBe("page");
    expect(query.get("spaceKey")).toBe("DEV");
    expect(query.get("expand")).toBe("version");
  });

  it.each([
    [{ results: [pagePayload()], size: 1, limit: 5, start: 5, _links: { next: "/rest/api/content?type=page&start=6" } }, 6],
    [{ results: [], size: 0, limit: 5, start: 5, _links: {} }, null],
  ])("derives nextStart from the envelope (_links.next: %j)", async (envelope, expectedNextStart) => {
    stubFetchRoute(() => ({ body: envelope }));

    const card = (await callTool("cf_list_pages_in_space", { spaceKey: "DEV", limit: 5, start: 5 }, serverCtx())) as Record<
      string,
      unknown
    >;
    expect(card.nextStart).toBe(expectedNextStart);
  });

  it("rejects a blank spaceKey with VALIDATION", async () => {
    await expect(callTool("cf_list_pages_in_space", { spaceKey: " " }, serverCtx())).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
