import { describe, expect, it } from "vitest";
import { decodeEntities, findChild, isElement, parse, textContent } from "./parser.js";

describe("parse", () => {
  it("parses namespaced elements with attributes and children", () => {
    const [root] = parse(
      `<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">xml</ac:parameter></ac:structured-macro>`,
    );
    expect(root).toMatchObject({ kind: "element", name: "ac:structured-macro" });
    if (!isElement(root)) throw new Error("expected element");
    expect(root.attrs).toEqual({ "ac:name": "code", "ac:schema-version": "1" });
    expect(root.children).toHaveLength(1);
    expect(findChild(root, "ac:parameter")?.attrs["ac:name"]).toBe("language");
  });

  it("parses self-closing and non-namespaced HTML tags", () => {
    const nodes = parse(`<p>a<br/>b</p><hr/>`);
    expect(nodes).toHaveLength(2);
    const [p, hr] = nodes;
    expect(isElement(p) && p.children.map((c) => (c.kind === "element" ? c.name : c.kind))).toEqual([
      "text",
      "br",
      "text",
    ]);
    expect(isElement(hr) && hr.name).toBe("hr");
  });

  it("keeps CDATA verbatim — entities inside are NOT decoded", () => {
    const [root] = parse(`<ac:plain-text-body><![CDATA[<xml attr="&amp;">]]&gt;]]></ac:plain-text-body>`);
    if (!isElement(root)) throw new Error("expected element");
    const body = root.children[0];
    expect(body).toMatchObject({ kind: "cdata", text: `<xml attr="&amp;">]]&gt;` });
  });

  it("tolerates the storage CDATA terminator quirk `]] >` (space injected)", () => {
    // Fixture contains no plain `]]>` anywhere before the spaced terminator,
    // so the tokenizer must fall back to `]] >`.
    const [root] = parse(`<ac:plain-text-body><![CDATA[<a href="x">y</a> ]] >`);
    if (!isElement(root)) throw new Error("expected element");
    expect(root.children[0]).toMatchObject({ kind: "cdata", text: `<a href="x">y</a> ` });
  });

  it("unterminated CDATA runs to EOF instead of looping", () => {
    const nodes = parse(`<x><![CDATA[never ends`);
    expect(nodes).toHaveLength(1);
  });

  it("parses comments", () => {
    const [c] = parse(`<!-- a comment with <tags> inside -->`);
    expect(c).toMatchObject({ kind: "comment", text: " a comment with <tags> inside " });
  });

  it("keeps a stray `<` that does not start a tag as literal text", () => {
    const nodes = parse(`1 < 2`);
    expect(nodes.map((n) => (n.kind === "text" ? n.text : "")).join("")).toBe("1 < 2");
  });

  it("auto-closes unclosed elements at EOF and ignores unmatched close tags", () => {
    const nodes = parse(`<div><p>text</div>`);
    const div = nodes[0];
    expect(isElement(div) && div.children).toHaveLength(1);
    expect(() => parse(`</nowhere><p>x`)).not.toThrow();
  });

  it("decodes named and numeric entities in text and attributes, passes unknown through", () => {
    const [el] = parse(`<a href="x?a=1&amp;b=2" title="&#39;q&#x27;">&lt;script&gt; &nbsp; &unknown;</a>`);
    if (!isElement(el)) throw new Error("expected element");
    expect(el.attrs.href).toBe("x?a=1&b=2");
    expect(el.attrs.title).toBe("'q'");
    const expectedText = "<script> \u00a0 &unknown;";
    expect(textContent(el)).toBe(expectedText);
  });

  it("handles single-quoted and bare attributes", () => {
    const [el] = parse(`<ri:page ri:content-title='My Page' data-x>`);
    if (!isElement(el)) throw new Error("expected element");
    expect(el.attrs["ri:content-title"]).toBe("My Page");
    expect(el.attrs["data-x"]).toBe("");
  });
});

describe("decodeEntities", () => {
  it("decodes &nbsp; to U+00A0 (converter normalizes it back to a space)", () => {
    expect(decodeEntities("a&nbsp;b")).toBe("a\u00a0b");
  });

  it("decodes hex and decimal character references", () => {
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
  });

  it("decodes the HTML4 named entities Confluence emits in storage bodies", () => {
    expect(decodeEntities("&mdash;&ndash;&rarr;&larr;&hellip;")).toBe("\u2014\u2013\u2192\u2190\u2026");
    expect(decodeEntities("&ldquo;q&rdquo;&rsquo;s&bull;&euro;")).toBe("\u201cq\u201d\u2019s\u2022\u20ac");
  });

  it("leaves unknown named entities as literal text", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});
