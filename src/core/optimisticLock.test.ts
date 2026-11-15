import { describe, expect, it, vi } from "vitest";
import { RestError } from "./restClient.js";
import { versionNumberOf, withOptimisticLock } from "./optimisticLock.js";

function conflict(): RestError {
  return new RestError(409, "CONFLICT", "Confluence request failed (HTTP 409)");
}

describe("withOptimisticLock", () => {
  it("applies the write against the initially fetched version", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue({ version: 3, title: "Page" });
    const apply = vi.fn().mockResolvedValue("ok");

    await expect(withOptimisticLock({ fetchCurrent, apply })).resolves.toBe("ok");
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ version: 3, title: "Page" });
  });

  it("re-fetches and retries once on a 409 conflict", async () => {
    const fetchCurrent = vi
      .fn()
      .mockResolvedValueOnce({ version: 1 })
      .mockResolvedValueOnce({ version: 2 });
    const apply = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();

    await expect(withOptimisticLock({ fetchCurrent, apply, onRetry })).resolves.toBe("ok");
    expect(fetchCurrent).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenNthCalledWith(1, { version: 1 });
    expect(apply).toHaveBeenNthCalledWith(2, { version: 2 });
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(RestError));
  });

  it("gives up after the single default retry on repeated conflicts", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue({ version: 1 });
    const apply = vi.fn().mockRejectedValue(conflict());

    await expect(withOptimisticLock({ fetchCurrent, apply })).rejects.toMatchObject({ status: 409 });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(fetchCurrent).toHaveBeenCalledTimes(2); // initial + one retry
  });

  it("honors maxRetries=0 (no retry)", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue({ version: 1 });
    const apply = vi.fn().mockRejectedValue(conflict());

    await expect(withOptimisticLock({ fetchCurrent, apply, maxRetries: 0 })).rejects.toMatchObject({
      status: 409,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
  });

  it("propagates non-conflict errors without re-fetching", async () => {
    const fetchCurrent = vi.fn().mockResolvedValue({ version: 1 });
    const apply = vi.fn().mockRejectedValue(new RestError(404, "NOT_FOUND", "missing"));

    await expect(withOptimisticLock({ fetchCurrent, apply })).rejects.toMatchObject({ status: 404 });
    expect(fetchCurrent).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("versionNumberOf", () => {
  it("reads the nested Confluence page version (version.number)", () => {
    expect(versionNumberOf({ id: "1", version: { number: 7, message: "edit" } })).toBe(7);
  });

  it("reads a flattened version field", () => {
    expect(versionNumberOf({ version: 4 })).toBe(4);
  });

  it("returns null when no version is present", () => {
    expect(versionNumberOf({ title: "Page" })).toBeNull();
    expect(versionNumberOf(null)).toBeNull();
    expect(versionNumberOf("nope")).toBeNull();
  });
});
