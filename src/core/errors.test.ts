import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_CODES as CODES, ToolError, mcpError, mcpText, toMcpError } from "./errors.js";
import { RestError } from "./restClient.js";

describe("mcpText", () => {
  it("wraps a result as pretty-printed JSON text content", () => {
    const result = mcpText({ ok: true });
    expect(result).toMatchObject({ content: [{ type: "text" }] });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });
});

describe("mcpError", () => {
  it("emits a structured error envelope with isError", () => {
    const result = mcpError(CODES.NOT_FOUND, "missing", { id: "1" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: { code: "NOT_FOUND", message: "missing", details: { id: "1" } },
    });
  });
});

describe("toMcpError", () => {
  it("maps RestError to its code and details", () => {
    const result = toMcpError(new RestError(409, "CONFLICT", "clash", { a: 1 }));
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      error: { code: "CONFLICT", message: "clash", details: { a: 1 } },
    });
  });

  it("maps ToolError to its code and details", () => {
    const result = toMcpError(new ToolError(ERROR_CODES.PROVIDER_UNAVAILABLE, "not yet"));
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      error: { code: "PROVIDER_UNAVAILABLE", message: "not yet" },
    });
  });

  it("maps plain Errors and non-Error values to INTERNAL_ERROR", () => {
    expect(JSON.parse((toMcpError(new Error("boom")).content[0] as { text: string }).text)).toMatchObject({
      error: { code: "INTERNAL_ERROR", message: "boom" },
    });
    expect(JSON.parse((toMcpError(42).content[0] as { text: string }).text)).toMatchObject({
      error: { code: "INTERNAL_ERROR", message: "42" },
    });
  });
});
