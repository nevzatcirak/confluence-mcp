import { describe, expect, it } from "vitest";
import { cursorFromNextUrl, extractPageItems, pageMeta, pageQuery } from "./pagination.js";
import { CLOUD_PAGINATION, SERVER_PAGINATION } from "./provider.js";

describe("pageQuery (number mode)", () => {
  it("emits zero-based start/limit for Server/DC", () => {
    expect(pageQuery({ start: 50, limit: 10 }, SERVER_PAGINATION)).toEqual({ limit: 10, start: 50 });
  });

  it("applies defaults and clamps", () => {
    expect(pageQuery({}, SERVER_PAGINATION)).toEqual({ limit: 25, start: 0 });
    expect(pageQuery({ limit: 0 }, SERVER_PAGINATION)).toEqual({ limit: 1, start: 0 });
    expect(pageQuery({ limit: 5000 }, SERVER_PAGINATION)).toEqual({ limit: 1000, start: 0 });
    expect(pageQuery({ start: -10 }, SERVER_PAGINATION)).toEqual({ limit: 25, start: 0 });
  });

  it("ignores a cursor in number mode", () => {
    expect(pageQuery({ cursor: "abc", start: 10 }, SERVER_PAGINATION)).toEqual({ limit: 25, start: 10 });
  });
});

describe("pageQuery (cursor mode)", () => {
  it("emits only the limit until a cursor is available", () => {
    expect(pageQuery({ limit: 25 }, CLOUD_PAGINATION)).toEqual({ limit: 25 });
    expect(pageQuery({}, CLOUD_PAGINATION)).toEqual({ limit: 25 });
  });

  it("passes the opaque cursor through the cursor param", () => {
    expect(pageQuery({ limit: 10, cursor: "tok-2" }, CLOUD_PAGINATION)).toEqual({ limit: 10, cursor: "tok-2" });
  });

  it("still clamps the limit", () => {
    expect(pageQuery({ limit: 5000 }, CLOUD_PAGINATION)).toEqual({ limit: 1000 });
  });
});

describe("pageMeta (number mode)", () => {
  it("normalizes a Server/DC envelope", () => {
    const payload = {
      results: [{ id: "1" }],
      size: 25,
      limit: 25,
      start: 0,
      _links: { next: "/rest/api/content?start=25&limit=25" },
    };
    expect(pageMeta(payload, 0, 25, 25, SERVER_PAGINATION)).toEqual({
      size: 25,
      limit: 25,
      start: 0,
      isLastPage: false,
      nextPageStart: 25,
      nextCursor: null,
    });
  });

  it("treats a missing _links.next as the last page", () => {
    const payload = { results: [{}], size: 5, limit: 25, start: 0, _links: { base: "https://confluence.example.com" } };
    expect(pageMeta(payload, 0, 25, 5, SERVER_PAGINATION)).toMatchObject({
      isLastPage: true,
      nextPageStart: null,
      nextCursor: null,
    });
  });

  it("falls back to request defaults when the envelope omits fields", () => {
    expect(pageMeta(null, 10, 25, 3, SERVER_PAGINATION)).toEqual({
      size: 3,
      limit: 25,
      start: 10,
      isLastPage: true,
      nextPageStart: null,
      nextCursor: null,
    });
  });

  it("derives nextPageStart from start + size when _links.next is present", () => {
    const payload = { results: [1, 2, 3], size: 3, limit: 3, start: 6, _links: { next: "/rest/api/content?start=9" } };
    expect(pageMeta(payload, 6, 3, 3, SERVER_PAGINATION)).toMatchObject({
      isLastPage: false,
      nextPageStart: 9,
    });
  });

  it("respects an explicit isLastPage even when _links.next exists", () => {
    const payload = { size: 10, start: 0, isLastPage: true, _links: { next: "/x" } };
    expect(pageMeta(payload, 0, 10, 10, SERVER_PAGINATION)).toMatchObject({
      isLastPage: true,
      nextPageStart: null,
    });
  });
});

describe("pageMeta (cursor mode)", () => {
  it("extracts the cursor from the Cloud-style _links.next URL and leaves nextPageStart null", () => {
    const payload = {
      results: [{}],
      size: 25,
      limit: 25,
      _links: { base: "https://confluence.example.com/wiki", next: "/wiki/api/v2/pages?limit=25&cursor=tok-2&_=/x" },
    };
    expect(pageMeta(payload, 0, 25, 25, CLOUD_PAGINATION)).toEqual({
      size: 25,
      limit: 25,
      start: 0,
      isLastPage: false,
      nextPageStart: null,
      nextCursor: "tok-2",
    });
  });

  it("reports the last page when no _links.next is present", () => {
    const payload = { results: [], size: 0, limit: 25, _links: { base: "https://confluence.example.com/wiki" } };
    expect(pageMeta(payload, 0, 25, 0, CLOUD_PAGINATION)).toMatchObject({
      isLastPage: true,
      nextCursor: null,
      nextPageStart: null,
    });
  });
});

describe("cursorFromNextUrl", () => {
  it("prefers the cursor query parameter, absolute or relative", () => {
    expect(cursorFromNextUrl("https://confluence.example.com/wiki/api/v2/pages?cursor=abc&limit=25")).toBe("abc");
    expect(cursorFromNextUrl("/wiki/api/v2/pages?limit=25&cursor=tok-2")).toBe("tok-2");
  });

  it("falls back to the last path segment for relative values and keeps opaque URLs", () => {
    expect(cursorFromNextUrl("/wiki/api/v2/next/tok42")).toBe("tok42");
    expect(cursorFromNextUrl("https://confluence.example.com/wiki/api/v2/pages?limit=25")).toBe(
      "https://confluence.example.com/wiki/api/v2/pages?limit=25",
    );
  });

  it("returns null for missing or invalid values", () => {
    expect(cursorFromNextUrl(undefined)).toBeNull();
    expect(cursorFromNextUrl(42)).toBeNull();
  });
});

describe("extractPageItems", () => {
  it("reads the results array", () => {
    expect(extractPageItems({ results: [1, 2] })).toEqual([1, 2]);
  });

  it("supports alternative envelope keys", () => {
    expect(extractPageItems({ values: [1] }, ["results", "values"])).toEqual([1]);
  });

  it("returns an empty array for missing or malformed envelopes", () => {
    expect(extractPageItems({})).toEqual([]);
    expect(extractPageItems(null)).toEqual([]);
    expect(extractPageItems({ results: "nope" })).toEqual([]);
  });
});
