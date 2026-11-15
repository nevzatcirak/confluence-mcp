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

describe("cf_search_cql", () => {
  it("passes the CQL through and returns compact result cards", async () => {
    const { captured } = stubFetchRoute(() => ({
      body: {
        results: [
          {
            content: { id: "42", type: "page" },
            title: "Onboarding",
            excerpt: "How to onboard new engineers without losing them in the wiki.",
            url: "/display/DEV/Onboarding",
            space: { key: "DEV", name: "Development" },
          },
          {
            space: { id: "7", key: "HR" },
            title: "People Space",
            excerpt: "Space-level hit",
            url: "/display/HR",
          },
        ],
        size: 2,
        limit: 25,
        start: 0,
        _links: {},
      },
    }));

    const card = (await callTool("cf_search_cql", { cql: "type=page AND space=DEV" }, serverCtx())) as Record<
      string,
      unknown
    >;

    expect(card).toEqual({
      size: 2,
      results: [
        {
          id: "42",
          title: "Onboarding",
          url: "https://confluence.example.com/display/DEV/Onboarding",
          space: "DEV",
          excerpt: "How to onboard new engineers without losing them in the wiki.",
        },
        {
          id: "7",
          title: "People Space",
          url: "https://confluence.example.com/display/HR",
          space: "HR",
          excerpt: "Space-level hit",
        },
      ],
      nextStart: null,
    });
    expect(captured[0].url.pathname).toBe("/rest/api/search");
    expect(captured[0].url.searchParams.get("cql")).toBe("type=page AND space=DEV");
  });

  it("truncates long excerpts and reports nextStart when more pages exist", async () => {
    stubFetchRoute(() => ({
      body: {
        results: [
          {
            content: { id: "42", type: "page" },
            title: "Onboarding",
            excerpt: "x".repeat(500),
            url: "/display/DEV/Onboarding",
          },
        ],
        size: 1,
        limit: 1,
        start: 0,
        _links: { next: "/rest/api/search?cql=x&start=1" },
      },
    }));

    const card = (await callTool("cf_search_cql", { cql: "type=page", limit: 1 }, serverCtx())) as Record<string, unknown>;
    const results = card.results as Array<Record<string, unknown>>;

    expect((results[0].excerpt as string).length).toBeLessThanOrEqual(200);
    expect((results[0].excerpt as string).endsWith("…")).toBe(true);
    expect(card.nextStart).toBe(1);
  });

  it("rejects an empty CQL with VALIDATION", async () => {
    await expect(callTool("cf_search_cql", { cql: "" }, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("cf_get_labels", () => {
  it("lists labels as compact {id, name, prefix} entries, handling both payload shapes", async () => {
    const { captured } = stubFetchRoute(() => ({
      body: {
        results: [
          { id: "l1", name: "api", prefix: "global" },
          // Some Server builds nest the label under a `label` key.
          { label: { id: "l2", name: "draft", prefix: "team" } },
        ],
        size: 2,
        limit: 25,
        start: 0,
        _links: {},
      },
    }));

    const card = (await callTool("cf_get_labels", { id: "100" }, serverCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      size: 2,
      labels: [
        { id: "l1", name: "api", prefix: "global" },
        { id: "l2", name: "draft", prefix: "team" },
      ],
      nextStart: null,
    });
    expect(captured[0].url.pathname).toBe("/rest/api/content/100/label");
  });

  it.each([
    [{ results: [{ id: "l1", name: "api", prefix: "global" }], size: 1, limit: 1, start: 0, _links: { next: "/rest/api/content/100/label?start=1" } }, 1],
    [{ results: [{ id: "l1", name: "api", prefix: "global" }], size: 1, limit: 25, start: 0, _links: {} }, null],
  ])("derives nextStart from the envelope (_links.next: %j)", async (envelope, expectedNextStart) => {
    stubFetchRoute(() => ({ body: envelope }));

    const card = (await callTool("cf_get_labels", { id: "100" }, serverCtx())) as Record<string, unknown>;
    expect(card.nextStart).toBe(expectedNextStart);
  });

  it("surfaces NOT_FOUND when the content does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));

    await expect(callTool("cf_get_labels", { id: "404" }, serverCtx())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a missing id with VALIDATION", async () => {
    await expect(callTool("cf_get_labels", {}, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("cf_list_attachments", () => {
  function attachmentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "att1",
      type: "attachment",
      title: "report.pdf",
      metadata: { mediaType: "application/pdf", comment: "Q3 report" },
      extensions: { fileSize: 2048 },
      _links: { base: "/confluence", webui: "/pages/viewpageattachments.action?pageId=100" },
      ...overrides,
    };
  }

  it.each([
    // relative download link resolved against _links.base
    [
      { _links: { base: "/confluence", download: "/download/attachments/100/report.pdf" } },
      "https://confluence.example.com/confluence/download/attachments/100/report.pdf",
    ],
    // absolute download link passes through untouched
    [
      { _links: { base: "/confluence", download: "https://files.example.com/attachments/report.pdf" } },
      "https://files.example.com/attachments/report.pdf",
    ],
    // no download link -> null
    [{ _links: { base: "/confluence" } }, null],
  ])("resolves the download link (%j)", async (overrides, expectedUrl) => {
    stubFetchRoute(() => ({ body: { results: [attachmentPayload(overrides)], size: 1, limit: 25, start: 0, _links: {} } }));

    const card = (await callTool("cf_list_attachments", { id: "100" }, serverCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      size: 1,
      attachments: [
        {
          id: "att1",
          title: "report.pdf",
          mediaType: "application/pdf",
          fileSize: 2048,
          downloadUrl: expectedUrl,
          comment: "Q3 report",
        },
      ],
      nextStart: null,
    });
  });

  it("forwards the filename filter and paging params", async () => {
    const { captured } = stubFetchRoute(() => ({ body: { results: [], size: 0, limit: 10, start: 5, _links: {} } }));

    await callTool("cf_list_attachments", { id: "100", filename: "report.pdf", limit: 10, start: 5 }, serverCtx());

    const query = captured[0].url.searchParams;
    expect(captured[0].url.pathname).toBe("/rest/api/content/100/child/attachment");
    expect(query.get("filename")).toBe("report.pdf");
    expect(query.get("limit")).toBe("10");
    expect(query.get("start")).toBe("5");
  });

  it("omits the filename filter when not requested", async () => {
    const { captured } = stubFetchRoute(() => ({ body: { results: [], size: 0, limit: 25, start: 0, _links: {} } }));

    await callTool("cf_list_attachments", { id: "100" }, serverCtx());

    expect(captured[0].url.searchParams.has("filename")).toBe(false);
  });

  it("reports nextStart when more pages exist", async () => {
    stubFetchRoute(() => ({
      body: {
        results: [attachmentPayload()],
        size: 1,
        limit: 1,
        start: 0,
        _links: { next: "/rest/api/content/100/child/attachment?start=1" },
      },
    }));

    const card = (await callTool("cf_list_attachments", { id: "100", limit: 1 }, serverCtx())) as Record<string, unknown>;
    expect(card.nextStart).toBe(1);
  });

  it("rejects a missing id with VALIDATION", async () => {
    await expect(callTool("cf_list_attachments", {}, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
