import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../core/config.js";
import { createServerProvider } from "../providers/server/serverProvider.js";
import { storageToMarkdown } from "../core/markdown/storageToMarkdown.js";
import type { ToolArgs, ToolCallContext } from "./registry.js";
import { toolManifests } from "./registry.js";

vi.mock("../core/markdown/storageToMarkdown.js", () => ({
  storageToMarkdown: vi.fn((xhtml: string) => `MD:${xhtml}`),
}));

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
  vi.mocked(storageToMarkdown).mockClear();
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

function pagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "100",
    type: "page",
    title: "Runbook",
    space: { key: "DEV", name: "Development" },
    version: { number: 3, by: { username: "dev1", displayName: "Dev One" }, when: "2026-01-02T03:04:05.000Z" },
    ancestors: [
      { id: "1", title: "Root" },
      { id: "2", title: "Parent" },
    ],
    body: { storage: { value: "<p>Storage body</p>" }, view: { value: "<p>View body</p>" } },
    _links: { base: "/confluence", webui: "/display/DEV/Runbook" },
    ...overrides,
  };
}

function emptyChildren(url: URL): { body: unknown; status?: number } {
  const start = Number(url.searchParams.get("start") ?? "0");
  return { body: { results: [], size: 0, limit: 50, start, _links: {} } };
}

describe("cf_get_page", () => {
  it("returns a compact card with resolved URL, breadcrumb and markdown body by default", async () => {
    stubFetchRoute(() => ({ body: pagePayload() }));

    const card = (await callTool("cf_get_page", { id: "100" }, serverCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      id: "100",
      title: "Runbook",
      space: "DEV",
      url: "https://confluence.example.com/confluence/display/DEV/Runbook",
      version: { number: 3, by: "Dev One", when: "2026-01-02T03:04:05.000Z" },
      ancestors: "Root > Parent",
      body: "MD:<p>Storage body</p>",
    });
    expect(storageToMarkdown).toHaveBeenCalledWith("<p>Storage body</p>");
  });

  it("requests the full expand set on /rest/api/content/{id}", async () => {
    const { captured } = stubFetchRoute(() => ({ body: pagePayload() }));

    await callTool("cf_get_page", { id: "100" }, serverCtx());

    expect(captured[0].url.pathname).toBe("/rest/api/content/100");
    expect(captured[0].url.searchParams.get("expand")).toBe("body.storage,body.view,version,ancestors,space");
  });

  it.each([
    ["storage", "<p>Storage body</p>"],
    ["view", "<p>View body</p>"],
    ["markdown", "MD:<p>Storage body</p>"],
  ])("passes the body through per format=%s", async (format, expected) => {
    stubFetchRoute(() => ({ body: pagePayload() }));

    const card = (await callTool("cf_get_page", { id: "100", format }, serverCtx())) as Record<string, unknown>;
    expect(card.body).toBe(expected);
  });

  it.each([
    ["missing id", {}],
    ["blank id", { id: "  " }],
    ["invalid format", { id: "100", format: "bogus" }],
  ])("rejects invalid arguments (%s) with a VALIDATION ToolError", async (_name, args) => {
    await expect(callTool("cf_get_page", args, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("surfaces NOT_FOUND when the page does not exist", async () => {
    stubFetchRoute(() => ({ body: { message: "No content found" }, status: 404 }));

    await expect(callTool("cf_get_page", { id: "999" }, serverCtx())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("cf_get_page_by_title", () => {
  it("resolves via the content search endpoint and formats like cf_get_page", async () => {
    const { captured } = stubFetchRoute(() => ({ body: { results: [pagePayload()], size: 1, limit: 25, start: 0, _links: {} } }));

    const card = (await callTool(
      "cf_get_page_by_title",
      { spaceKey: "DEV", title: "Runbook" },
      serverCtx(),
    )) as Record<string, unknown>;

    expect(card).toMatchObject({ id: "100", title: "Runbook", body: "MD:<p>Storage body</p>" });
    expect(captured[0].url.pathname).toBe("/rest/api/content");
    expect(captured[0].url.searchParams.get("spaceKey")).toBe("DEV");
    expect(captured[0].url.searchParams.get("title")).toBe("Runbook");
    expect(captured[0].url.searchParams.get("expand")).toBe("body.storage,body.view,version,ancestors,space");
  });

  it("rejects with a clean NOT_FOUND when no page matches", async () => {
    stubFetchRoute(() => ({ body: { results: [], size: 0, limit: 25, start: 0, _links: {} } }));

    await expect(
      callTool("cf_get_page_by_title", { spaceKey: "DEV", title: "Missing" }, serverCtx()),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("Missing") });
  });

  it("rejects invalid arguments with VALIDATION", async () => {
    await expect(callTool("cf_get_page_by_title", { title: "No space" }, serverCtx())).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("cf_get_page_history", () => {
  const VERSIONS = [
    { number: 1, by: { username: "dev1", displayName: "Dev One" }, when: "2026-01-01T00:00:00.000Z", message: "init" },
    { number: 2, by: { username: "dev2", displayName: "Dev Two" }, when: "2026-01-02T00:00:00.000Z" },
    { number: 3, by: { username: "dev1", displayName: "Dev One" }, when: "2026-01-03T00:00:00.000Z", message: "fix" },
  ];

  function stubHistory(): { captured: CapturedRequest[] } {
    return stubFetchRoute((url) => {
      if (url.pathname.endsWith("/rest/api/content/100/history")) {
        const limit = Number(url.searchParams.get("limit") ?? "25");
        return { body: { latest: true, versions: VERSIONS.slice(0, limit), _links: {} } };
      }
      if (url.pathname.endsWith("/rest/api/content/100")) {
        return { body: pagePayload() };
      }
      return { body: {}, status: 404 };
    });
  }

  it("returns the version list with author, timestamp and optional message", async () => {
    stubHistory();

    const card = (await callTool("cf_get_page_history", { id: "100" }, serverCtx())) as Record<string, unknown>;

    expect(card).toMatchObject({
      id: "100",
      title: "Runbook",
      currentVersion: 3,
      size: 3,
      start: 0,
      nextStart: null,
    });
    expect(card.versions).toEqual([
      { version: 1, by: "Dev One", when: "2026-01-01T00:00:00.000Z", message: "init" },
      { version: 2, by: "Dev Two", when: "2026-01-02T00:00:00.000Z", message: null },
      { version: 3, by: "Dev One", when: "2026-01-03T00:00:00.000Z", message: "fix" },
    ]);
  });

  it.each([
    // A full page of versions is treated as "possibly more follow".
    [{ id: "100", limit: 2 }, 2, 2],
    // Fewer versions than the limit means this is the last page.
    [{ id: "100", limit: 25 }, 3, null],
  ])("computes nextStart for args %j", async (args, expectedSize, expectedNextStart) => {
    stubHistory();

    const card = (await callTool("cf_get_page_history", args, serverCtx())) as Record<string, unknown>;
    expect(card.size).toBe(expectedSize);
    expect(card.nextStart).toBe(expectedNextStart);
  });

  it("surfaces NOT_FOUND when the page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));

    await expect(callTool("cf_get_page_history", { id: "404" }, serverCtx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects invalid arguments with VALIDATION", async () => {
    await expect(callTool("cf_get_page_history", { id: "100", limit: 0 }, serverCtx())).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("cf_get_page_hierarchy", () => {
  function child(id: string): Record<string, unknown> {
    return { id, type: "page", title: `Child ${id}`, _links: { base: "/confluence" } };
  }

  it("builds a nested tree capped by depth and marks the cut as truncated", async () => {
    const { captured } = stubFetchRoute((url) => {
      if (url.pathname.endsWith("/rest/api/content/1/child/page")) return emptyChildren(url);
      if (url.pathname === "/rest/api/content/1") return { body: pagePayload({ id: "1", title: "Root", ancestors: [] }) };
      return { body: {}, status: 404 };
    });

    const tree = (await callTool("cf_get_page_hierarchy", { id: "1", depth: 2 }, serverCtx())) as Record<string, unknown>;

    expect(tree).toMatchObject({
      id: "1",
      title: "Root",
      depth: 2,
      hasChildren: false,
      truncated: false,
    });
    expect(captured.map((request) => request.url.pathname)).toEqual([
      "/rest/api/content/1",
      "/rest/api/content/1/child/page",
    ]);
  });

  it("follows _links.next within a level and merges the pages", async () => {
    const { captured } = stubFetchRoute((url) => {
      if (url.pathname.endsWith("/rest/api/content/1/child/page")) {
        const start = Number(url.searchParams.get("start") ?? "0");
        if (start === 0) {
          return {
            body: {
              results: [child("10"), child("11")],
              size: 2,
              limit: 50,
              start: 0,
              _links: { next: "/rest/api/content/1/child/page?limit=50&start=2" },
            },
          };
        }
        return { body: { results: [child("12")], size: 1, limit: 50, start: 2, _links: {} } };
      }
      if (url.pathname.includes("/child/page")) return emptyChildren(url);
      if (url.pathname === "/rest/api/content/1") return { body: pagePayload({ id: "1", title: "Root", ancestors: [] }) };
      return { body: {}, status: 404 };
    });

    const tree = (await callTool("cf_get_page_hierarchy", { id: "1", depth: 2 }, serverCtx())) as Record<string, unknown>;

    const children = tree.children as Array<Record<string, unknown>>;
    expect(children.map((c) => c.id)).toEqual(["10", "11", "12"]);
    expect(tree.truncated).toBe(false);

    const rootChildCalls = captured.filter((request) => request.url.pathname === "/rest/api/content/1/child/page");
    expect(rootChildCalls.map((request) => request.url.searchParams.get("start"))).toEqual(["0", "2"]);
    // Depth 2: each child's own children are inspected once.
    const grandchildCalls = captured.filter(
      (request) => request.url.pathname.includes("/child/page") && request.url.pathname !== "/rest/api/content/1/child/page",
    );
    expect(grandchildCalls).toHaveLength(3);
  });

  it.each([
    // depth 1: children are listed but their own subtrees are not inspected.
    [{ id: "1", depth: 1 }, 1, null, true],
    // default depth is 2: the child's own children are inspected (none here).
    [{ id: "1" }, 1, false, false],
  ])("applies depth capping for args %j", async (args, expectedChildren, expectedHasChildren, expectedTruncated) => {
    stubFetchRoute((url) => {
      if (url.pathname === "/rest/api/content/1/child/page") {
        return {
          body: { results: [child("10")], size: 1, limit: 50, start: 0, _links: {} },
        };
      }
      if (url.pathname.includes("/child/page")) return emptyChildren(url);
      if (url.pathname === "/rest/api/content/1") return { body: pagePayload({ id: "1", title: "Root", ancestors: [] }) };
      return { body: {}, status: 404 };
    });

    const tree = (await callTool("cf_get_page_hierarchy", args, serverCtx())) as Record<string, unknown>;
    const children = tree.children as Array<Record<string, unknown>>;

    expect(children).toHaveLength(expectedChildren);
    expect(children[0].hasChildren).toBe(expectedHasChildren);
    expect(tree.truncated).toBe(expectedTruncated);
  });

  it.each([
    ["missing depth bounds", { id: "1", depth: 6 }],
    ["non-integer depth", { id: "1", depth: 1.5 }],
  ])("rejects invalid arguments (%s) with VALIDATION", async (_name, args) => {
    await expect(callTool("cf_get_page_hierarchy", args, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("surfaces NOT_FOUND when the root page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));

    await expect(callTool("cf_get_page_hierarchy", { id: "404" }, serverCtx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
