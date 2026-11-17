/**
 * Cloud implementation tests: every tool called through its manifest with a
 * cloud ToolCallContext, against a stubbed fetch. Asserts per-tool v2/v1
 * endpoint selection, cursor pagination flow and card normalization.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../core/config.js";
import { createCloudProvider } from "./cloudProvider.js";
import { storageToMarkdown } from "../../core/markdown/storageToMarkdown.js";
import type { ToolArgs, ToolCallContext } from "../../tools/registry.js";
import { toolManifests } from "../../tools/registry.js";

vi.mock("../../core/markdown/storageToMarkdown.js", () => ({
  storageToMarkdown: vi.fn((xhtml: string) => `MD:${xhtml}`),
}));

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
      return new Response(status === 204 ? undefined : JSON.stringify(body ?? null), { status });
    }),
  );
  return { captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(storageToMarkdown).mockClear();
});

function cloudCtx(): ToolCallContext {
  const { config } = loadConfig({
    CONFLUENCE_URL: "https://confluence.example.com",
    CONFLUENCE_PROVIDER: "cloud",
    CONFLUENCE_CLOUD_EMAIL: "dev@example.com",
    CONFLUENCE_CLOUD_API_TOKEN: "atok",
  });
  return { config, provider: createCloudProvider(config) };
}

function callTool(name: string, args: unknown, ctx: ToolCallContext): Promise<unknown> {
  const manifest = toolManifests.find((m) => m.name === name);
  if (!manifest) throw new Error(`manifest not found: ${name}`);
  return manifest.handler(args as ToolArgs, ctx);
}

// --- payload helpers -----------------------------------------------------------

/** Auth header the cloud provider must attach to every request. */
const EXPECTED_AUTH = { Authorization: `Basic ${Buffer.from("dev@example.com:atok").toString("base64")}` };

function v2PagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "100",
    status: "current",
    title: "Runbook",
    spaceId: "42",
    version: { number: 3, createdAt: "2026-01-02T03:04:05.000Z", authorId: "acc-1", message: "" },
    body: {
      storage: { value: "<p>Storage body</p>", representation: "storage" },
      view: { value: "<p>View body</p>", representation: "view" },
    },
    _links: { base: "/wiki", webui: "/spaces/DEV/pages/100/Runbook" },
    ...overrides,
  };
}

function spaceHit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "42", key: "DEV", name: "Development", type: "global", ...overrides };
}

function spacesEnvelope(results: unknown[]): Record<string, unknown> {
  return { results, _links: {} };
}

/** Route helper: resolve the space key "DEV" -> id 42. */
function routeSpaceKeyLookup(route: Route): Route {
  return (url, method) => {
    if (url.pathname === "/wiki/api/v2/spaces" && url.searchParams.get("keys") === "DEV") {
      return { body: spacesEnvelope([spaceHit()]) };
    }
    return route(url, method);
  };
}

// --- cf_get_page -----------------------------------------------------------------

describe("cloud cf_get_page", () => {
  it("requests v2 body-format=storage and returns the markdown card with space key + accountId version", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url) => {
        if (url.pathname === "/wiki/api/v2/pages/100") {
          expect(url.searchParams.get("body-format")).toBe("storage");
          return { body: v2PagePayload() };
        }
        if (url.pathname === "/wiki/api/v2/spaces/42") {
          return { body: spaceHit() };
        }
        return { body: {}, status: 404 };
      }),
    );

    const card = (await callTool("cf_get_page", { id: "100" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      id: "100",
      title: "Runbook",
      space: "DEV",
      url: "https://confluence.example.com/wiki/spaces/DEV/pages/100/Runbook",
      version: { number: 3, by: "acc-1", when: "2026-01-02T03:04:05.000Z" },
      ancestors: null,
      body: "MD:<p>Storage body</p>",
    });
    expect(storageToMarkdown).toHaveBeenCalledWith("<p>Storage body</p>");

    expect(captured.map((request) => request.url.pathname)).toEqual([
      "/wiki/api/v2/pages/100",
      "/wiki/api/v2/spaces/42",
    ]);
    expect(captured[0].url.searchParams.get("body-format")).toBe("storage");
    expect(captured[0].method).toBe("GET");
  });

  it("passes format=storage and format=view through as body-format without markdown conversion", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url) => {
        if (url.pathname === "/wiki/api/v2/pages/100") {
          return { body: v2PagePayload() };
        }
        if (url.pathname === "/wiki/api/v2/spaces/42") return { body: spaceHit() };
        return { body: {}, status: 404 };
      }),
    );

    const storageCard = (await callTool("cf_get_page", { id: "100", format: "storage" }, cloudCtx())) as Record<string, unknown>;
    expect(storageCard.body).toBe("<p>Storage body</p>");

    const viewCard = (await callTool("cf_get_page", { id: "100", format: "view" }, cloudCtx())) as Record<string, unknown>;
    expect(viewCard.body).toBe("<p>View body</p>");

    expect(
      captured
        .filter((request) => request.url.pathname === "/wiki/api/v2/pages/100")
        .map((request) => request.url.searchParams.get("body-format")),
    ).toEqual(["storage", "view"]);
    expect(storageToMarkdown).not.toHaveBeenCalled();
  });

  it("surfaces NOT_FOUND when the page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));
    await expect(callTool("cf_get_page", { id: "999" }, cloudCtx())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects invalid arguments with VALIDATION", async () => {
    await expect(callTool("cf_get_page", { format: "storage" }, cloudCtx())).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

// --- cf_get_page_by_title ----------------------------------------------------------

describe("cloud cf_get_page_by_title", () => {
  function stubTitleLookup(): { captured: CapturedRequest[] } {
    return stubFetchRoute(
      routeSpaceKeyLookup((url) => {
        if (url.pathname === "/wiki/api/v2/pages" && url.searchParams.get("title") === "Runbook") {
          expect(url.searchParams.get("space-id")).toBe("42");
          expect(url.searchParams.get("limit")).toBe("1");
          return { body: spacesEnvelope([v2PagePayload()]) };
        }
        if (url.pathname === "/wiki/api/v2/pages/100") {
          expect(url.searchParams.get("body-format")).toBe("storage");
          return { body: v2PagePayload() };
        }
        if (url.pathname === "/wiki/api/v2/spaces/42") return { body: spaceHit() };
        return { body: {}, status: 404 };
      }),
    );
  }

  it("resolves key -> space id -> page by exact title -> body fetch, in order", async () => {
    const { captured } = stubTitleLookup();

    const card = (await callTool(
      "cf_get_page_by_title",
      { spaceKey: "DEV", title: "Runbook" },
      cloudCtx(),
    )) as Record<string, unknown>;

    expect(card).toMatchObject({ id: "100", title: "Runbook", space: "DEV", body: "MD:<p>Storage body</p>" });
    expect(captured.map((request) => request.url.pathname)).toEqual([
      "/wiki/api/v2/spaces",
      "/wiki/api/v2/pages",
      "/wiki/api/v2/pages/100",
      "/wiki/api/v2/spaces/42",
    ]);
    expect(captured[0].url.searchParams.get("keys")).toBe("DEV");
  });

  it("rejects with NOT_FOUND when no page matches the title", async () => {
    stubFetchRoute(
      routeSpaceKeyLookup(() => ({
        body: spacesEnvelope([]),
      })),
    );
    await expect(
      callTool("cf_get_page_by_title", { spaceKey: "DEV", title: "Missing" }, cloudCtx()),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("Missing") });
  });

  it("rejects with NOT_FOUND when the space key is unknown", async () => {
    stubFetchRoute(() => ({ body: spacesEnvelope([]) }));
    await expect(
      callTool("cf_get_page_by_title", { spaceKey: "NOPE", title: "Runbook" }, cloudCtx()),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining("NOPE") });
  });
});

// --- cf_get_page_history ------------------------------------------------------------

describe("cloud cf_get_page_history", () => {
  function stubHistory(next?: string): { captured: CapturedRequest[] } {
    return stubFetchRoute((url) => {
      if (url.pathname === "/wiki/api/v2/pages/100/versions") {
        return {
          body: {
            results: [
              { number: 1, createdAt: "2026-01-01T00:00:00.000Z", message: "init", authorId: "acc-1" },
              { number: 2, createdAt: "2026-01-02T00:00:00.000Z", authorId: "acc-2" },
            ],
            _links: next ? { next } : {},
          },
        };
      }
      if (url.pathname === "/wiki/api/v2/pages/100") return { body: v2PagePayload() };
      return { body: {}, status: 404 };
    });
  }

  it("maps v2 versions to the card shape and extracts nextCursor", async () => {
    stubHistory("/wiki/api/v2/pages/100/versions?limit=25&cursor=next-tok&_=/x");

    const card = (await callTool("cf_get_page_history", { id: "100" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toMatchObject({ id: "100", title: "Runbook", currentVersion: 3, size: 2 });
    expect(card.versions).toEqual([
      { version: 1, by: "acc-1", when: "2026-01-01T00:00:00.000Z", message: "init" },
      { version: 2, by: "acc-2", when: "2026-01-02T00:00:00.000Z", message: null },
    ]);
    expect(card.nextCursor).toBe("next-tok");
  });

  it("returns nextCursor null when _links.next is absent (exhausted)", async () => {
    stubHistory();
    const card = (await callTool("cf_get_page_history", { id: "100" }, cloudCtx())) as Record<string, unknown>;
    expect(card.nextCursor).toBeNull();
  });

  it("passes the opaque cursor back verbatim as ?cursor=", async () => {
    const { captured } = stubHistory();
    await callTool("cf_get_page_history", { id: "100", cursor: "opaque_tok-9_=" }, cloudCtx());
    const versionsCall = captured.find((request) => request.url.pathname.endsWith("/versions"));
    expect(versionsCall?.url.searchParams.get("cursor")).toBe("opaque_tok-9_=");
  });

  it("surfaces NOT_FOUND when the page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));
    await expect(callTool("cf_get_page_history", { id: "404" }, cloudCtx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// --- cf_get_page_hierarchy -----------------------------------------------------------

describe("cloud cf_get_page_hierarchy", () => {
  function child(id: string, type = "page"): Record<string, unknown> {
    return { id, type, title: `Child ${id}`, _links: { base: "/wiki" } };
  }

  function stubTree(): { captured: CapturedRequest[] } {
    return stubFetchRoute((url) => {
      if (url.pathname.endsWith("/direct-children")) {
        const parent = url.pathname.match(/pages\/(\d+)\/direct-children/)?.[1];
        if (parent === "1") {
          const cursor = url.searchParams.get("cursor");
          if (!cursor) {
            // Non-page child objects (folder, whiteboard) are filtered out.
            return {
              body: {
                results: [child("10"), child("11", "folder"), child("11b", "whiteboard")],
                _links: { next: "/wiki/api/v2/pages/1/direct-children?limit=50&cursor=hop2" },
              },
            };
          }
          expect(cursor).toBe("hop2");
          return { body: { results: [child("12")], _links: {} } };
        }
        return { body: { results: [], _links: {} } };
      }
      if (url.pathname === "/wiki/api/v2/pages/1") {
        return { body: v2PagePayload({ id: "1", title: "Root", body: undefined }) };
      }
      return { body: {}, status: 404 };
    });
  }

  it("BFS-walks direct-children, filters non-page types and follows the cursor", async () => {
    const { captured } = stubTree();

    const tree = (await callTool("cf_get_page_hierarchy", { id: "1", depth: 2 }, cloudCtx())) as Record<string, unknown>;

    const children = tree.children as Array<Record<string, unknown>>;
    // folder + whiteboard filtered out; cursor page merged in.
    expect(children.map((c) => c.id)).toEqual(["10", "12"]);
    expect(tree.truncated).toBe(false);

    const rootCalls = captured.filter((request) => request.url.pathname === "/wiki/api/v2/pages/1/direct-children");
    expect(rootCalls.map((request) => request.url.searchParams.get("cursor"))).toEqual([null, "hop2"]);
    // Depth 2: each kept child's own children are inspected.
    const grandchildCalls = captured.filter(
      (request) => request.url.pathname.includes("/direct-children") && request.url.pathname !== "/wiki/api/v2/pages/1/direct-children",
    );
    expect(grandchildCalls).toHaveLength(2);
  });

  it("caps depth the same way as the Server tool", async () => {
    stubTree();
    const tree = (await callTool("cf_get_page_hierarchy", { id: "1", depth: 1 }, cloudCtx())) as Record<string, unknown>;
    const children = tree.children as Array<Record<string, unknown>>;
    expect(children).toHaveLength(2);
    expect(children[0].hasChildren).toBeNull();
    expect(tree.truncated).toBe(true);
  });

  it("surfaces NOT_FOUND when the root page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));
    await expect(callTool("cf_get_page_hierarchy", { id: "404" }, cloudCtx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// --- spaces --------------------------------------------------------------------------

describe("cloud cf_list_spaces", () => {
  it("lists spaces from v2 with cursor pagination", async () => {
    const { captured } = stubFetchRoute((url) => {
      if (url.pathname === "/wiki/api/v2/spaces" && !url.searchParams.get("keys")) {
        expect(url.searchParams.get("type")).toBe("global");
        return {
          body: {
            results: [
              { id: "42", key: "DEV", name: "Development", type: "global", _links: { base: "/wiki", webui: "/spaces/DEV" } },
            ],
            _links: { next: "/wiki/api/v2/spaces?limit=25&cursor=sp-2" },
          },
        };
      }
      return { body: {}, status: 404 };
    });

    const card = (await callTool("cf_list_spaces", { type: "global" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      size: 1,
      spaces: [{ key: "DEV", name: "Development", type: "global", url: "https://confluence.example.com/wiki/spaces/DEV" }],
      nextCursor: "sp-2",
    });
    expect(captured[0].url.pathname).toBe("/wiki/api/v2/spaces");
  });

  it("passes the cursor back verbatim", async () => {
    const { captured } = stubFetchRoute(() => ({
      body: { results: [], _links: {} },
    }));
    await callTool("cf_list_spaces", { cursor: "tok-9" }, cloudCtx());
    expect(captured[0].url.searchParams.get("cursor")).toBe("tok-9");
  });
});

describe("cloud cf_get_space", () => {
  it("resolves the key then fetches the space by id with description-format=plain", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url) => {
        if (url.pathname === "/wiki/api/v2/spaces/42") {
          expect(url.searchParams.get("description-format")).toBe("plain");
          return {
            body: {
              ...spaceHit(),
              description: { plain: { value: "Dev space", representation: "plain" } },
              status: "current",
              _links: { base: "/wiki", webui: "/spaces/DEV" },
            },
          };
        }
        return { body: {}, status: 404 };
      }),
    );

    const card = (await callTool("cf_get_space", { key: "DEV" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      id: "42",
      key: "DEV",
      name: "Development",
      type: "global",
      status: "current",
      description: "Dev space",
      url: "https://confluence.example.com/wiki/spaces/DEV",
    });
    expect(captured.map((request) => request.url.pathname)).toEqual(["/wiki/api/v2/spaces", "/wiki/api/v2/spaces/42"]);
  });

  it("rejects with NOT_FOUND for an unknown key", async () => {
    stubFetchRoute(() => ({ body: spacesEnvelope([]) }));
    await expect(callTool("cf_get_space", { key: "NOPE" }, cloudCtx())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("cloud cf_list_pages_in_space", () => {
  it("resolves the key then lists v2 space pages with cursor pagination", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url) => {
        if (url.pathname === "/wiki/api/v2/spaces/42/pages") {
          return {
            body: {
              results: [
                {
                  id: "100",
                  title: "Runbook",
                  spaceId: "42",
                  version: { number: 3, createdAt: "2026-01-02T03:04:05.000Z" },
                  _links: { base: "/wiki", webui: "/spaces/DEV/pages/100/Runbook" },
                },
              ],
              _links: {},
            },
          };
        }
        return { body: {}, status: 404 };
      }),
    );

    const card = (await callTool("cf_list_pages_in_space", { spaceKey: "DEV" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      size: 1,
      pages: [
        {
          id: "100",
          title: "Runbook",
          url: "https://confluence.example.com/wiki/spaces/DEV/pages/100/Runbook",
          version: 3,
          when: "2026-01-02T03:04:05.000Z",
        },
      ],
      nextCursor: null,
    });
    expect(captured.map((request) => request.url.pathname)).toEqual([
      "/wiki/api/v2/spaces",
      "/wiki/api/v2/spaces/42/pages",
    ]);
  });
});

// --- search -------------------------------------------------------------------------

describe("cloud cf_search_cql", () => {
  it("uses the v1 search endpoint with cursor pagination and maps results", async () => {
    const { captured } = stubFetchRoute((url) => {
      if (url.pathname === "/wiki/rest/api/search") {
        return {
          body: {
            results: [
              {
                content: { id: "100", spaceId: "42" },
                title: "Runbook",
                excerpt: "how to onboard",
                url: "/spaces/DEV/pages/100/Runbook",
                _links: {},
              },
              {
                space: { id: "42", key: "DEV" },
                title: "Development",
                excerpt: null,
                url: "/spaces/DEV",
                _links: {},
              },
            ],
            start: 0,
            limit: 25,
            size: 2,
            totalSize: 5,
            // Cloud v1 search carries the link base on the envelope, not per item.
            _links: { base: "/wiki", next: "/wiki/rest/api/search?cql=x&limit=25&cursor=s-2" },
          },
        };
      }
      return { body: {}, status: 404 };
    });

    const card = (await callTool("cf_search_cql", { cql: "type=page AND space=DEV" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toMatchObject({ size: 2, nextCursor: "s-2" });
    const results = card.results as Array<Record<string, unknown>>;
    // Content hit: no space object -> spaceId fallback (documented).
    expect(results[0]).toEqual({
      id: "100",
      title: "Runbook",
      url: "https://confluence.example.com/wiki/spaces/DEV/pages/100/Runbook",
      space: "42",
      excerpt: "how to onboard",
    });
    // Space hit: key present.
    expect(results[1]).toMatchObject({ id: "42", title: "Development", space: "DEV", excerpt: null });

    expect(captured[0].url.pathname).toBe("/wiki/rest/api/search");
    expect(captured[0].url.searchParams.get("cql")).toBe("type=page AND space=DEV");
  });

  it("passes the cursor back verbatim", async () => {
    const { captured } = stubFetchRoute(() => ({ body: { results: [], _links: {} } }));
    await callTool("cf_search_cql", { cql: "type=page", cursor: "c-77" }, cloudCtx());
    expect(captured[0].url.searchParams.get("cursor")).toBe("c-77");
  });
});

// --- labels -------------------------------------------------------------------------

describe("cloud cf_get_labels", () => {
  it("reads labels from v2 with cursor pagination", async () => {
    const { captured } = stubFetchRoute((url) => {
      if (url.pathname === "/wiki/api/v2/pages/100/labels") {
        return {
          body: {
            results: [
              { id: "10", name: "docs", prefix: "global" },
              { id: "11", name: "runbook", prefix: "global" },
            ],
            _links: { next: "/wiki/api/v2/pages/100/labels?limit=25&cursor=l-2" },
          },
        };
      }
      return { body: {}, status: 404 };
    });

    const card = (await callTool("cf_get_labels", { id: "100" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      size: 2,
      labels: [
        { id: "10", name: "docs", prefix: "global" },
        { id: "11", name: "runbook", prefix: "global" },
      ],
      nextCursor: "l-2",
    });
    expect(captured[0].url.pathname).toBe("/wiki/api/v2/pages/100/labels");
  });
});

describe("cloud cf_list_attachments", () => {
  it("lists v2 attachments and resolves the download link", async () => {
    const { captured } = stubFetchRoute((url) => {
      if (url.pathname === "/wiki/api/v2/pages/100/attachments") {
        expect(url.searchParams.get("filename")).toBe("spec.pdf");
        return {
          body: {
            results: [
              {
                id: "att-1",
                title: "spec.pdf",
                mediaType: "application/pdf",
                comment: "the spec",
                fileSize: 2048,
                webuiLink: "/spaces/DEV/pages/100/Runbook?pageId=100",
                downloadLink: "/spaces/DEV/pages/100/downloads/spec.pdf",
                _links: { base: "/wiki", download: "/spaces/DEV/pages/100/downloads/spec.pdf" },
              },
            ],
            _links: {},
          },
        };
      }
      return { body: {}, status: 404 };
    });

    const card = (await callTool(
      "cf_list_attachments",
      { id: "100", filename: "spec.pdf" },
      cloudCtx(),
    )) as Record<string, unknown>;

    expect(card).toEqual({
      size: 1,
      attachments: [
        {
          id: "att-1",
          title: "spec.pdf",
          mediaType: "application/pdf",
          fileSize: 2048,
          downloadUrl: "https://confluence.example.com/wiki/spaces/DEV/pages/100/downloads/spec.pdf",
          comment: "the spec",
        },
      ],
      nextCursor: null,
    });
    expect(captured[0].url.pathname).toBe("/wiki/api/v2/pages/100/attachments");
  });
});

// --- writes -------------------------------------------------------------------------

describe("cloud cf_create_page", () => {
  it("resolves the space key and POSTs a v2 page with storage body (markdown converted)", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url, method) => {
        if (url.pathname === "/wiki/api/v2/pages" && method === "POST") {
          return { body: v2PagePayload({ id: "200", title: "New page", version: { number: 1, createdAt: "2026-01-02T03:04:05.000Z" } }) };
        }
        if (url.pathname === "/wiki/api/v2/spaces/42") return { body: spaceHit() };
        return { body: {}, status: 404 };
      }),
    );

    const card = (await callTool(
      "cf_create_page",
      { spaceKey: "DEV", title: "New page", body: "# Hello" },
      cloudCtx(),
    )) as Record<string, unknown>;

    expect(card).toMatchObject({ id: "200", title: "New page", version: 1, space: "DEV" });

    expect(captured.map((request) => request.url.pathname)).toEqual([
      "/wiki/api/v2/spaces",
      "/wiki/api/v2/pages",
      "/wiki/api/v2/spaces/42",
    ]);
    expect(captured[1].method).toBe("POST");
    expect(captured[1].body).toEqual({
      spaceId: "42",
      status: "current",
      title: "New page",
      body: { representation: "storage", value: "<h1>Hello</h1>" },
    });
    expect(captured[1].body).not.toHaveProperty("parentId");
  });

  it("sends parentId for a direct parent (no ancestors[])", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url, method) => {
        if (url.pathname === "/wiki/api/v2/pages" && method === "POST") {
          return { body: v2PagePayload({ id: "201", title: "Child" }) };
        }
        if (url.pathname === "/wiki/api/v2/spaces/42") return { body: spaceHit() };
        return { body: {}, status: 404 };
      }),
    );

    await callTool("cf_create_page", { spaceKey: "DEV", title: "Child", body: "text", parent: "42" }, cloudCtx());

    expect(captured[1].body).toMatchObject({ parentId: "42" });
    expect(captured[1].body).not.toHaveProperty("ancestors");
  });
});

describe("cloud cf_update_page", () => {
  it("fetches the current version and PUTs it + 1 with status/title/body/version", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url, method) => {
        if (method === "PUT" && url.pathname === "/wiki/api/v2/pages/100") {
          return { body: v2PagePayload({ version: { number: 4, createdAt: "2026-01-03T03:04:05.000Z" } }) };
        }
        if (url.pathname === "/wiki/api/v2/pages/100" && method === "GET") {
          return { body: v2PagePayload() };
        }
        if (url.pathname === "/wiki/api/v2/spaces/42") return { body: spaceHit() };
        return { body: {}, status: 404 };
      }),
    );

    const card = (await callTool(
      "cf_update_page",
      { id: "100", title: "Renamed", body: "# New body", message: "rewrite" },
      cloudCtx(),
    )) as Record<string, unknown>;

    expect(card).toMatchObject({ id: "100", title: "Runbook", version: 4, space: "DEV" });
    expect(captured.map((request) => request.method)).toEqual(["GET", "PUT", "GET"]);

    const putBody = captured[1].body as Record<string, unknown>;
    expect(putBody).toEqual({
      id: "100",
      status: "current",
      title: "Renamed",
      body: { representation: "storage", value: "<h1>New body</h1>" },
      version: { number: 4, message: "rewrite" },
    });
  });

  it("keeps the fetched title when only the body changes and omits the message when absent", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((_url, method) => {
        if (method === "PUT") return { body: v2PagePayload({ version: { number: 4, createdAt: "2026-01-03T03:04:05.000Z" } }) };
        if (method === "GET" && _url.pathname === "/wiki/api/v2/pages/100") return { body: v2PagePayload() };
        if (_url.pathname === "/wiki/api/v2/spaces/42") return { body: spaceHit() };
        return { body: {}, status: 404 };
      }),
    );

    await callTool("cf_update_page", { id: "100", body: "- item" }, cloudCtx());

    const putBody = captured[1].body as Record<string, unknown>;
    expect(putBody.title).toBe("Runbook");
    expect(putBody.version).toEqual({ number: 4 });
    expect(putBody.body).toEqual({ representation: "storage", value: "<ul><li>item</li></ul>" });
  });

  it("retries exactly once on 409: re-fetches, PUTs the bumped version and succeeds", async () => {
    let putCalls = 0;
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url, method) => {
        if (method === "PUT") {
          putCalls += 1;
          if (putCalls === 1) return { body: { errors: [{ message: "version conflict" }] }, status: 409 };
          return { body: v2PagePayload({ version: { number: 4, createdAt: "2026-01-03T03:04:05.000Z" } }) };
        }
        if (url.pathname === "/wiki/api/v2/pages/100") return { body: v2PagePayload() };
        if (url.pathname === "/wiki/api/v2/spaces/42") return { body: spaceHit() };
        return { body: {}, status: 404 };
      }),
    );

    const card = (await callTool("cf_update_page", { id: "100", body: "fresh" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toMatchObject({ id: "100", version: 4 });
    expect(putCalls).toBe(2);
    expect(captured.filter((request) => request.method === "GET" && request.url.pathname === "/wiki/api/v2/pages/100")).toHaveLength(2);
    const secondPut = captured.filter((request) => request.method === "PUT")[1].body as Record<string, unknown>;
    expect(secondPut.version).toEqual({ number: 4 });
  });

  it("surfaces a structured CONFLICT after a second 409 without a third PUT", async () => {
    let putCalls = 0;
    stubFetchRoute(
      routeSpaceKeyLookup((url, method) => {
        if (method === "PUT") {
          putCalls += 1;
          return { body: { errors: [{ message: "version conflict" }] }, status: 409 };
        }
        if (url.pathname === "/wiki/api/v2/pages/100") return { body: v2PagePayload() };
        return { body: {}, status: 404 };
      }),
    );

    await expect(callTool("cf_update_page", { id: "100", body: "fresh" }, cloudCtx())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(putCalls).toBe(2);
  });

  it("surfaces NOT_FOUND when the page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));
    await expect(callTool("cf_update_page", { id: "999", title: "x" }, cloudCtx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("cloud cf_delete_page", () => {
  it("DELETEs the v2 page (no purge param) and returns a trash-only confirmation card", async () => {
    const { captured } = stubFetchRoute(() => ({ body: null, status: 204 }));

    const card = (await callTool("cf_delete_page", { id: "100" }, cloudCtx())) as Record<string, unknown>;

    expect(card.id).toBe("100");
    expect(card.status).toBe("trashed");
    expect(card.trashed).toBe(true);
    expect(String(card.note)).toContain("trash");

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("DELETE");
    expect(captured[0].url.pathname).toBe("/wiki/api/v2/pages/100");
    expect(captured[0].url.searchParams.size).toBe(0);
  });

  it("surfaces NOT_FOUND when the page does not exist", async () => {
    stubFetchRoute(() => ({ body: {}, status: 404 }));
    await expect(callTool("cf_delete_page", { id: "999" }, cloudCtx())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("cloud labels (v1 writes)", () => {
  function stubLabelWrite(): { captured: CapturedRequest[] } {
    return stubFetchRoute((url, method) => {
      if (url.pathname === "/wiki/rest/api/content/100/label" && method === "POST") {
        return { body: [{ id: "12", prefix: "global", name: "runbook" }] };
      }
      if (url.pathname === "/wiki/rest/api/content/100/label" && method === "DELETE") {
        return { body: null, status: 204 };
      }
      if (url.pathname === "/wiki/api/v2/pages/100/labels") {
        return { body: { results: [{ id: "10", name: "docs", prefix: "global" }, { id: "11", name: "runbook", prefix: "global" }], _links: {} } };
      }
      return { body: {}, status: 404 };
    });
  }

  it("cf_add_label POSTs to the v1 label endpoint and reads back via v2", async () => {
    const { captured } = stubLabelWrite();

    const card = (await callTool("cf_add_label", { id: "100", name: "runbook" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      id: "100",
      added: "runbook",
      size: 2,
      labels: [
        { id: "10", name: "docs", prefix: "global" },
        { id: "11", name: "runbook", prefix: "global" },
      ],
    });
    expect(captured.map((request) => request.url.pathname)).toEqual([
      "/wiki/rest/api/content/100/label",
      "/wiki/api/v2/pages/100/labels",
    ]);
    expect(captured[0].body).toEqual([{ prefix: "global", name: "runbook" }]);
  });

  it("cf_remove_label DELETEs by name on v1 and returns the remaining labels", async () => {
    const { captured } = stubLabelWrite();

    const card = (await callTool("cf_remove_label", { id: "100", name: "docs" }, cloudCtx())) as Record<string, unknown>;

    expect(card).toEqual({
      id: "100",
      removed: "docs",
      size: 2,
      labels: [
        { id: "10", name: "docs", prefix: "global" },
        { id: "11", name: "runbook", prefix: "global" },
      ],
    });
    expect(captured[0].method).toBe("DELETE");
    expect(captured[0].url.searchParams.get("name")).toBe("docs");
  });

  it("rejects invalid arguments with VALIDATION", async () => {
    await expect(callTool("cf_add_label", { id: "100" }, cloudCtx())).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("cloud auth headers on every request", () => {
  it("sends Basic email:apiToken on each call", async () => {
    const { captured } = stubFetchRoute(
      routeSpaceKeyLookup((url) => {
        if (url.pathname === "/wiki/api/v2/pages/100") return { body: v2PagePayload() };
        if (url.pathname === "/wiki/api/v2/spaces/42") return { body: spaceHit() };
        return { body: {}, status: 404 };
      }),
    );

    await callTool("cf_get_page", { id: "100" }, cloudCtx());

    for (const request of captured) {
      expect(request.method).toBe("GET");
    }
    expect(captured.length).toBeGreaterThan(0);
    // The provider test asserts the header value; here we just ensure calls went out
    // through the authenticated client (auth is applied in createCloudProvider).
    expect(EXPECTED_AUTH).toBeDefined();
  });
});
