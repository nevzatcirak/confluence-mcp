import { afterEach, describe, expect, it, vi } from "vitest";
import { RestError, RestClient } from "./restClient.js";

interface CapturedRequest {
  url: URL;
  init: RequestInit;
}

function stubFetch(body: unknown = "", status = 200): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      captured.push({ url: new URL(String(input)), init: init ?? {} });
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return new Response(text, { status });
    }),
  );
  return { captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RestClient", () => {
  it("sends auth + custom headers and parses JSON responses", async () => {
    const { captured } = stubFetch({ id: 1 });
    const client = new RestClient("https://confluence.example.com", {
      authHeaders: { Authorization: "Bearer tok" },
      defaultHeaders: { "X-Custom-Trace": "abc" },
    });

    await expect(
      client.get("/rest/api/content", { query: { limit: 25, start: 0, flag: undefined } }),
    ).resolves.toEqual({ id: 1 });

    const { url, init } = captured[0];
    expect(url.toString()).toBe("https://confluence.example.com/rest/api/content?limit=25&start=0");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-Custom-Trace"]).toBe("abc");
    expect(headers.Accept).toBe("application/json");
    expect(url.searchParams.has("flag")).toBe(false);
  });

  it("serializes a JSON body with the right content type", async () => {
    const { captured } = stubFetch({ ok: true });
    const client = new RestClient("https://confluence.example.com");

    await client.post("/rest/api/content", { body: { type: "page", title: "p1" } });

    expect(captured[0].init.method).toBe("POST");
    expect(captured[0].init.body).toBe(JSON.stringify({ type: "page", title: "p1" }));
    expect((captured[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("normalizes HTTP errors into RestError with mapped codes", async () => {
    stubFetch({ message: "version conflict", statusCode: 409 }, 409);
    const client = new RestClient("https://confluence.example.com");

    const err = await client.put("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestError);
    expect(err).toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: expect.stringContaining("version conflict"),
    });
  });

  it("maps auth, not-found, validation and upstream statuses", async () => {
    stubFetch({}, 401);
    await expect(new RestClient("https://c.example").get("/x")).rejects.toMatchObject({ code: "AUTH_FAILED" });

    stubFetch({}, 404);
    await expect(new RestClient("https://c.example").get("/x")).rejects.toMatchObject({ code: "NOT_FOUND" });

    stubFetch({}, 400);
    await expect(new RestClient("https://c.example").get("/x")).rejects.toMatchObject({ code: "VALIDATION" });

    stubFetch({}, 500);
    await expect(new RestClient("https://c.example").get("/x")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("reads errors-array envelopes too", async () => {
    stubFetch({ errors: [{ message: "bad limit" }] }, 400);
    const client = new RestClient("https://c.example");
    await expect(client.get("/x")).rejects.toMatchObject({
      message: expect.stringContaining("bad limit"),
      code: "VALIDATION",
    });
  });

  it("wraps network failures as NETWORK_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("socket hang up");
    }));
    const client = new RestClient("https://c.example");
    await expect(client.get("/x")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});
