import { describe, expect, it } from "vitest";
import { defineCardFields, projectCard, projectCards } from "./compactCard.js";

const PAGE = {
  id: "123456",
  type: "page",
  title: "Add pagination helper",
  status: "current",
  version: { number: 7, by: { displayName: "dev-one" } },
  body: { view: { value: "x".repeat(80) } },
  _links: { webui: "https://confluence.example.com/pages/123456" },
};

const FIELDS = defineCardFields([
  ["id", "id"],
  ["title", "title", 40],
  ["status", "status"],
  ["version", "version.number"],
  ["updatedBy", "version.by.displayName"],
  ["body", "body.view.value", 20],
]);

describe("projectCard", () => {
  it("projects a flat, token-cheap card from a raw payload", () => {
    expect(projectCard(PAGE, FIELDS)).toEqual({
      id: "123456",
      title: "Add pagination helper",
      status: "current",
      version: 7,
      updatedBy: "dev-one",
      body: `${"x".repeat(19)}…`,
    });
  });

  it("maps missing paths to null instead of undefined", () => {
    expect(projectCard({ id: "1" }, FIELDS)).toMatchObject({ status: null, updatedBy: null });
  });

  it("does not forward link/body payloads", () => {
    const card = projectCard(PAGE, FIELDS);
    expect(JSON.stringify(card)).not.toContain("_links");
    expect(JSON.stringify(card)).not.toContain("webui");
  });
});

describe("projectCards", () => {
  it("projects every record", () => {
    const cards = projectCards([PAGE, { id: "2" }], FIELDS);
    expect(cards).toHaveLength(2);
    expect(cards[1]).toMatchObject({ id: "2", status: null });
  });
});
