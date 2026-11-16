import { describe, expect, it } from "vitest";
import { ToolError } from "../errors.js";
import { storageToMarkdown } from "./storageToMarkdown.js";
import { markdownToStorage } from "./markdownToStorage.js";

describe("markdownToStorage (supported constructs)", () => {
  it.each([
    ["# H1", "<h1>H1</h1>"],
    ["## H2", "<h2>H2</h2>"],
    ["###### H6", "<h6>H6</h6>"],
  ])("converts headings: %j", (markdown, expected) => {
    expect(markdownToStorage(markdown)).toBe(expected);
  });

  it("converts a single-line paragraph", () => {
    expect(markdownToStorage("Just a paragraph.")).toBe("<p>Just a paragraph.</p>");
  });

  it("joins paragraph lines with <br/> (hard breaks)", () => {
    expect(markdownToStorage("line one\nline two")).toBe("<p>line one<br/>line two</p>");
  });

  it("separates blocks by blank lines", () => {
    expect(markdownToStorage("first\n\nsecond")).toBe("<p>first</p>\n<p>second</p>");
  });

  it("converts unordered lists with - and * bullets", () => {
    expect(markdownToStorage("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(markdownToStorage("* a\n* b")).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("converts ordered lists", () => {
    expect(markdownToStorage("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
  });

  it("converts exactly one nesting level", () => {
    expect(markdownToStorage("- a\n  - b\n- c")).toBe("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
  });

  it("converts fenced code blocks with a language parameter and verbatim CDATA body", () => {
    expect(markdownToStorage("```ts\nconst a = 1;\n```")).toBe(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[const a = 1;]]></ac:plain-text-body></ac:structured-macro>",
    );
  });

  it("emits no language parameter when the fence has none", () => {
    expect(markdownToStorage("```\nplain\n```")).toBe(
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[plain]]></ac:plain-text-body></ac:structured-macro>',
    );
  });

  it("splits a literal ]]> inside code bodies per CDATA rules, keeping the rest verbatim", () => {
    expect(markdownToStorage("```\nx ]] > y\n```")).toBe(
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x ]] > y]]></ac:plain-text-body></ac:structured-macro>',
    );
    expect(markdownToStorage("```\na ]]> b\n```")).toBe(
      "<ac:structured-macro ac:name=\"code\"><ac:plain-text-body><![CDATA[a ]]]]><![CDATA[> b]]></ac:plain-text-body></ac:structured-macro>",
    );
  });

  it.each([
    ["**bold**", "<p><strong>bold</strong></p>"],
    ["*italic*", "<p><em>italic</em></p>"],
    ["`code`", "<p><code>code</code></p>"],
    ["**bold** and *italic* and `code`", "<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>"],
  ])("converts inline formatting: %j", (markdown, expected) => {
    expect(markdownToStorage(markdown)).toBe(expected);
  });

  it.each([
    ["http", "[docs](http://example.com/docs)"],
    ["https", "[docs](https://example.com/docs)"],
    ["root-relative", "[home](/display/DEV/Home)"],
    ["anchor", "[section](#section)"],
  ])("converts %s links to <a>", (_kind, markdown) => {
    const match = /\[([^\]]*)\]\(([^()\s]+)\)/.exec(markdown)!;
    expect(markdownToStorage(markdown)).toBe(`<p><a href="${match[2]}">${match[1]}</a></p>`);
  });

  it("converts headings, list items and nested items with inline formatting", () => {
    expect(markdownToStorage("- **bold item** `code`")).toBe("<ul><li><strong>bold item</strong> <code>code</code></li></ul>");
  });

  it("escapes XML-significant characters in text", () => {
    expect(markdownToStorage("a < b and c > d & AT&T")).toBe("<p>a &lt; b and c &gt; d &amp; AT&amp;T</p>");
  });

  it("escapes double quotes inside link hrefs", () => {
    expect(markdownToStorage('[docs](https://example.com/a"b)')).toBe(
      '<p><a href="https://example.com/a&quot;b">docs</a></p>',
    );
  });

  it("leaves unknown punctuation and unpaired markers as literal text", () => {
    expect(markdownToStorage("a * b and a lone \\ backslash")).toBe("<p>a * b and a lone \\ backslash</p>");
  });
});

describe("markdownToStorage (unsupported constructs -> VALIDATION)", () => {
  const CASES: Array<[string, string]> = [
    ["table", "| a | b |\n| --- | --- |\n| 1 | 2 |"],
    ["image", "![alt text](https://example.com/picture.png)"],
    ["blockquote", "> quoted line"],
    ["nested list (two levels)", "- a\n  - b\n    - c"],
    ["horizontal rule", "---"],
    ["inline HTML", "Hello <div>world</div>"],
    ["strikethrough", "~~gone~~"],
    ["task list", "- [ ] unfinished"],
    ["footnote", "Text[^1]"],
    ["reference-style link", "[text][ref]"],
    ["javascript link", "[x](javascript:alert(1))"],
    ["mixed list markers", "- a\n1. b"],
    ["list continuation line", "- a\n  continued text"],
    ["unterminated code fence", "```ts\nconst a = 1;"],
  ];

  it.each(CASES)("rejects %s with a structured VALIDATION error", (_name, markdown) => {
    try {
      markdownToStorage(markdown);
      expect.unreachable("expected a VALIDATION ToolError");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("VALIDATION");
      // The message names the offending construct and points at the subset.
      expect((err as ToolError).message).toContain("Unsupported Markdown construct");
      expect((err as ToolError).message).toContain("supported subset");
    }
  });

  it("reports the offending line number and a snippet in the error details", () => {
    try {
      markdownToStorage("first\n\n> quoted");
      expect.unreachable();
    } catch (err) {
      expect((err as ToolError).details).toEqual({ construct: "blockquote (>)", line: 3 });
      expect((err as ToolError).message).toContain("line 3");
    }
  });
});

describe("markdown -> storage -> markdown round trip (supported subset)", () => {
  // Cases whose round trip is byte-exact.
  const EXACT_CASES = [
    "# Title",
    "## Section",
    "- a\n- b",
    "1. a\n2. b",
    "- a\n  - b\n- c",
    "**bold** and *italic* and `code`",
    "```ts\nconst a = 1;\n```",
    "[docs](https://example.com/docs)",
    "# Head with **bold**",
    "just a paragraph",
    "- item with [link](https://example.com/x) and `code`",
  ];

  it.each(EXACT_CASES)("round trips %j byte-exactly", (markdown) => {
    expect(storageToMarkdown(markdownToStorage(markdown))).toBe(markdown);
  });

  it("normalizes single newlines in paragraphs to hard breaks (documented loss)", () => {
    expect(storageToMarkdown(markdownToStorage("line one\nline two"))).toBe("line one  \nline two");
  });
});

describe("storageToMarkdown interop", () => {
  it("markdownToStorage output re-parses as well-formed storage XHTML", () => {
    // Round trip through the storage parser: the produced macro must decode
    // back to the same code body (CDATA verbatim, no entity rewriting).
    const storage = markdownToStorage("```xml\nif (a < b && b > c) { run(); }\n```");
    expect(storage).toContain('ac:name="code"');
    expect(storage).toContain('ac:name="language"');
    expect(storageToMarkdown(storage)).toBe("```xml\nif (a < b && b > c) { run(); }\n```");
  });

  it("escapes XML entities in text but decodes them again on the way back", () => {
    const storage = markdownToStorage("AT&T < specials >");
    expect(storage).toBe("<p>AT&amp;T &lt; specials &gt;</p>");
    expect(storageToMarkdown(storage)).toBe("AT&T < specials >");
  });
});
