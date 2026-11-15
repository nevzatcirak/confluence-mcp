import { describe, expect, it } from "vitest";
import {
  asBoolean,
  asNumber,
  asRecord,
  asString,
  asStringArray,
  getPath,
  truncateString,
} from "./json.js";

describe("asRecord", () => {
  it("accepts plain objects and rejects arrays and primitives", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeNull();
    expect(asRecord("x")).toBeNull();
    expect(asRecord(null)).toBeNull();
  });
});

describe("asString / asNumber / asBoolean", () => {
  it("type-check primitives", () => {
    expect(asString("s")).toBe("s");
    expect(asString(1)).toBeNull();
    expect(asNumber(1.5)).toBe(1.5);
    expect(asNumber(Number.NaN)).toBeNull();
    expect(asNumber("1")).toBeNull();
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean("true")).toBeNull();
  });
});

describe("asStringArray", () => {
  it("filters non-strings and rejects non-arrays", () => {
    expect(asStringArray(["a", 1, "b"])).toEqual(["a", "b"]);
    expect(asStringArray("a")).toEqual([]);
  });
});

describe("getPath", () => {
  it("resolves dot paths through nested records", () => {
    expect(getPath({ version: { number: 3 } }, "version.number")).toBe(3);
    expect(getPath({ a: { b: { c: "x" } } }, "a.b.c")).toBe("x");
  });

  it("returns undefined for missing paths or non-record intermediates", () => {
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getPath({ a: "s" }, "a.b")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
  });
});

describe("truncateString", () => {
  it("keeps short strings intact", () => {
    expect(truncateString("short", 10)).toBe("short");
  });

  it("truncates with an ellipsis within the budget", () => {
    expect(truncateString("abcdefghij", 5)).toBe("abcd…");
    expect(truncateString("abc", 1)).toBe("…");
  });
});
