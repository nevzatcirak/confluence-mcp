import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../core/config.js";
import { createServerProvider } from "../providers/server/serverProvider.js";
import type { ToolArgs, ToolCallContext } from "./registry.js";
import { toolManifests } from "./registry.js";

interface CapturedRequest {
  url: URL;
  method: string;
  body: unknown;
}

interface RouteResult {
  body?: unknown;
  status?: number;
}

type Route = (url: URL, method: string) => RouteResult;

/**
 * Fetch stub that records method + parsed JSON body of every call. Routes see
 * the request count via closure state, which the optimistic-lock tests use to
 * answer 409 on the first PUT and 200 on the second.
 */
function stubFetchRoute(route: Route): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      const rawBody = typeof init?.body === "string" ? init.body : null;
      captured.push({ url, method, body: rawBody ? (JSON.parse(rawBody) as unknown) : null });
      const { body, status = 200 } = route(url, method);
      // 204 must be constructed without a body.
      return new Response(status === 204 ? undefined : JSON.stringify(body ?? null), { status });
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

function pagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "100",
    type: "page",
    title: "Runbook",
    space: { key: "DEV" },
    version: { number: 3 },
    _links: { base: "/confluence", webui: "/display/DEV/Runbook" },
    ...overrides,
  };
}

function labelPayload(names: string[]): unknown {
  return {
    results: names.map((name, index) => ({ id: String(10 + index), prefix: "global", name })),
    size: names.length,
    limit: 100,
    start: 0,
    _links: {},
  };
}

describe("cf_create_page", () => {
  it("POSTs storage-format body and returns a compact card (markdown converted)", async () => {
    const { captured } = stubFetchRoute(() => ({
      body: pagePayload({ id: "200", title: "New page", version: { number: 1 } }),
    }));

    const card = (await callTool(
      "cf_create_page",
      { spaceKey: "DEV", title: "New page", body: "# Hello" },
      serverCtx(),
    )) as Record<string, unknown>;

    expect(card).toEqual({
      id: "200",
      title: "New page",
      url: "https://confluence.example.com/confluence/display/DEV/Runbook",
      version: 1,
      space: "DEV",
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].url.pathname).toBe("/rest/api/content");
    expect(captured[0].body).toEqual({
      type: "page",
      title: "New page",
      space: { key: "DEV" },
      body: { storage: { value: "<h1>Hello</h1>", representation: "storage" } },
    });
    // No parent -> no ancestors key at all.
    expect(captured[0].body).not.toHaveProperty("ancestors");
  });

  it("sends ancestors when a parent id is given", async () => {
    const { captured } = stubFetchRoute(() => ({ body: pagePayload({ id: "201", title: "Child" }) }));

    await callTool(
      "cf_create_page",
      { spaceKey: "DEV", title: "Child", body: "text", parent: "42" },
      serverCtx(),
    );

    expect(captured[0].body).toMatchObject({ ancestors: [{ id: "42" }] });
  });

  it("passes a storage body through verbatim (no markdown conversion)", async () => {
    const { captured } = stubFetchRoute(() => ({ body: pagePayload({ id: "202" }) }));

    await callTool(
      "cf_create_page",
      { spaceKey: "DEV", title: "Raw", body: "<p>Raw <ac:emoticon ac:name='smile'/></p>", bodyFormat: "storage" },
      serverCtx(),
    );

    expect(getStorageValue(captured[0].body)).toBe("<p>Raw <ac:emoticon ac:name='smile'/></p>");
  });

  it.each([
    ["missing title", { spaceKey: "DEV", body: "x" }],
    ["missing body", { spaceKey: "DEV", title: "T" }],
    ["invalid bodyFormat", { spaceKey: "DEV", title: "T", body: "x", bodyFormat: "view" }],
  ])("rejects invalid arguments (%s) with VALIDATION", async (_name, args) => {
    await expect(callTool("cf_create_page", args, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("surfaces upstream VALIDATION when Confluence rejects the payload", async () => {
    stubFetchRoute(() => ({ body: { message: "bad space" }, status: 400 }));
    await expect(callTool("cf_create_page", { spaceKey: "X", title: "T", body: "x" }, serverCtx())).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("rejects unsupported markdown with VALIDATION before any request is made", async () => {
    const { captured } = stubFetchRoute(() => ({ body: {} }));
    await expect(
      callTool("cf_create_page", { spaceKey: "DEV", title: "T", body: "| a | b |\n| --- | --- |\n| 1 | 2 |" }, serverCtx()),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(captured).toHaveLength(0);
  });
});

describe("cf_update_page", () => {
  it("fetches the current version and PUTs version.number + 1 with title and converted body", async () => {
    const { captured } = stubFetchRoute((url, method) => {
      if (method === "PUT") return { body: pagePayload({ version: { number: 4 } }) };
      expect(url.pathname).toBe("/rest/api/content/100");
      return { body: pagePayload() };
    });

    const card = (await callTool(
      "cf_update_page",
      { id: "100", title: "Renamed", body: "# New body", message: "rewrite" },
      serverCtx(),
    )) as Record<string, unknown>;

    expect(card).toMatchObject({ id: "100", title: "Runbook", version: 4 });
    expect(captured.map((request) => request.method)).toEqual(["GET", "PUT"]);

    const putBody = captured[1].body as Record<string, unknown>;
    expect(putBody).toMatchObject({
      id: "100",
      type: "page",
      title: "Renamed",
      body: { storage: { value: "<h1>New body</h1>", representation: "storage" } },
    });
    expect(putBody.version).toEqual({ number: 4, message: "rewrite" });
  });

  it("keeps the fetched title when only the body changes and omits the message when absent", async () => {
    const { captured } = stubFetchRoute((_url, method) =>
      method === "PUT" ? { body: pagePayload({ version: { number: 4 } }) } : { body: pagePayload() },
    );

    await callTool("cf_update_page", { id: "100", body: "- item" }, serverCtx());

    const putBody = captured[1].body as Record<string, unknown>;
    expect(putBody.title).toBe("Runbook");
    expect(putBody.version).toEqual({ number: 4 });
    expect(getStorageValue(captured[1].body)).toBe("<ul><li>item</li></ul>");
  });

  it("passes a storage body through verbatim", async () => {
    const { captured } = stubFetchRoute((_url, method) =>
      method === "PUT" ? { body: pagePayload({ version: { number: 4 } }) } : { body: pagePayload() },
    );

    await callTool(
      "cf_update_page",
      { id: "100", body: "<ac:structured-macro ac:name='toc'/>", bodyFormat: "storage" },
      serverCtx(),
    );

    expect(getStorageValue(captured[1].body)).toBe("<ac:structured-macro ac:name='toc'/>");
  });

  it("retries exactly once on 409: re-fetches, PUTs the bumped version and succeeds", async () => {
    let putCalls = 0;
    const { captured } = stubFetchRoute((_url, method) => {
      if (method === "PUT") {
        putCalls += 1;
        if (putCalls === 1) return { body: { message: "version conflict" }, status: 409 };
        return { body: pagePayload({ version: { number: 4 } }) };
      }
      return { body: pagePayload() };
    });

    const card = (await callTool("cf_update_page", { id: "100", body: "fresh" }, serverCtx())) as Record<string, unknown>;

    expect(card).toMatchObject({ id: "100", version: 4 });
    // Exactly 2 PUTs (never a third) and the retry used the re-fetched version 3 -> 4.
    expect(putCalls).toBe(2);
    expect(captured.filter((request) => request.method === "GET")).toHaveLength(2);
    const secondPut = captured.filter((request) => request.method === "PUT")[1].body as Record<string, unknown>;
    expect(secondPut.version).toEqual({ number: 4 });
  });

  it("surfaces a structured CONFLICT after a second 409 without a third PUT", async () => {
    let putCalls = 0;
    const { captured } = stubFetchRoute((_url, method) => {
      if (method === "PUT") {
        putCalls += 1;
        return { body: { message: "version conflict" }, status: 409 };
      }
      return { body: pagePayload() };
    });

    await expect(callTool("cf_update_page", { id: "100", body: "fresh" }, serverCtx())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(putCalls).toBe(2);
    expect(captured.filter((request) => request.method === "GET")).toHaveLength(2);
  });

  it("surfaces NOT_FOUND when the page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));
    await expect(callTool("cf_update_page", { id: "999", title: "x" }, serverCtx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects a call without title and body with VALIDATION before any request", async () => {
    const { captured } = stubFetchRoute(() => ({ body: {} }));
    await expect(callTool("cf_update_page", { id: "100" }, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
    expect(captured).toHaveLength(0);
  });
});

describe("cf_delete_page", () => {
  it("DELETEs the page and returns a trash-only confirmation card", async () => {
    const { captured } = stubFetchRoute(() => ({ body: null, status: 204 }));

    const card = (await callTool("cf_delete_page", { id: "100" }, serverCtx())) as Record<string, unknown>;

    expect(card.id).toBe("100");
    expect(card.status).toBe("trashed");
    expect(card.trashed).toBe(true);
    expect(String(card.note)).toContain("trash");
    expect(String(card.note)).toContain("not performed by this tool");

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("DELETE");
    expect(captured[0].url.pathname).toBe("/rest/api/content/100");
  });

  it("surfaces NOT_FOUND when the page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));
    await expect(callTool("cf_delete_page", { id: "999" }, serverCtx())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects invalid arguments with VALIDATION", async () => {
    await expect(callTool("cf_delete_page", {}, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("cf_add_label", () => {
  it("POSTs a single global label and returns the labels now on the page", async () => {
    const { captured } = stubFetchRoute((url, method) => {
      if (method === "POST") return { body: [{ id: "12", prefix: "global", name: "runbook" }] };
      expect(url.pathname).toBe("/rest/api/content/100/label");
      return { body: labelPayload(["docs", "runbook"]) };
    });

    const card = (await callTool("cf_add_label", { id: "100", name: "runbook" }, serverCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      id: "100",
      added: "runbook",
      size: 2,
      labels: [
        { id: "10", name: "docs", prefix: "global" },
        { id: "11", name: "runbook", prefix: "global" },
      ],
    });

    expect(captured.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(captured[0].body).toEqual([{ prefix: "global", name: "runbook" }]);
    expect(captured[1].url.searchParams.get("limit")).toBe("100");
  });

  it("rejects invalid arguments with VALIDATION", async () => {
    await expect(callTool("cf_add_label", { id: "100" }, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("surfaces upstream errors from the label endpoint", async () => {
    stubFetchRoute(() => ({ body: { message: "no such content" }, status: 404 }));
    await expect(callTool("cf_add_label", { id: "999", name: "x" }, serverCtx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("cf_remove_label", () => {
  it("DELETEs by name and returns the remaining labels", async () => {
    const { captured } = stubFetchRoute((url, method) => {
      if (method === "DELETE") {
        expect(url.searchParams.get("name")).toBe("docs");
        return { body: null, status: 204 };
      }
      return { body: labelPayload(["runbook"]) };
    });

    const card = (await callTool("cf_remove_label", { id: "100", name: "docs" }, serverCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      id: "100",
      removed: "docs",
      size: 1,
      labels: [{ id: "10", name: "runbook", prefix: "global" }],
    });
    expect(captured[0].method).toBe("DELETE");
    expect(captured[0].url.pathname).toBe("/rest/api/content/100/label");
  });

  it("rejects invalid arguments with VALIDATION", async () => {
    await expect(callTool("cf_remove_label", { id: "100" }, serverCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

/** Pull body.storage.value out of a captured request body. */
function getStorageValue(requestBody: unknown): string {
  const record = requestBody as Record<string, unknown>;
  const body = record.body as Record<string, unknown>;
  const storage = body.storage as Record<string, unknown>;
  return storage.value as string;
}
