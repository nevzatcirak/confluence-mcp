/**
 * Markdown -> Confluence storage format XHTML converter (the reverse of
 * storageToMarkdown). Pure, dependency-free: a small hand-written tokenizer
 * over a deliberately limited, writer-friendly Markdown subset. This is
 * intentionally NOT a full Markdown parser — cf_create_page / cf_update_page
 * accept authoring input, and anything the subset cannot represent exactly is
 * REJECTED with a structured VALIDATION error instead of being silently
 * converted, approximated or dropped.
 *
 * SUPPORTED SUBSET
 * - Headings            `#` .. `######` at the start of a line  -> <h1>..<h6>
 * - Paragraphs          blank-line separated                    -> <p>; every
 *   newline inside a paragraph becomes a hard break (<br/>)
 * - Unordered lists     `-` or `*` bullets                      -> <ul>/<li>
 * - Ordered lists       `1.` markers                            -> <ol>/<li>
 *   Exactly ONE nesting level is supported (indented items under a parent
 *   item); anything deeper is rejected.
 * - Fenced code blocks  ```lang ... ``` -> <ac:structured-macro ac:name="code">
 *   with a language parameter and an <ac:plain-text-body> CDATA. The body is
 *   kept verbatim; the only rewrite is splitting a literal `]]>` as CDATA
 *   rules require.
 * - Inline: **bold** -> <strong>, *italic* -> <em>, `code` -> <code>,
 *   [text](url) -> <a href="url">text</a> with url restricted to http, https
 *   and relative targets (/, ./, ../, #).
 *
 * UNSUPPORTED (each rejected with VALIDATION): tables, images, blockquotes,
 * task lists, HTML passthrough, list nesting deeper than one level,
 * horizontal rules, strikethrough, footnotes, reference-style links,
 * autolinks, setext headings, unterminated code fences, mixed ordered and
 * unordered markers inside one list, and indented continuation lines below a
 * list item.
 *
 * Authors who need richer bodies (tables, panels, status macros, ...) should
 * pass bodyFormat "storage" and write Confluence storage XHTML directly.
 */

import { ERROR_CODES, ToolError } from "../errors.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Reject the input with a structured VALIDATION error naming the construct. */
function fail(construct: string, line: number, snippet: string): never {
  const shown = snippet.length > 60 ? `${snippet.slice(0, 59)}…` : snippet;
  throw new ToolError(
    ERROR_CODES.VALIDATION,
    `Unsupported Markdown construct: ${construct} (line ${line}: "${shown}"). ` +
      "Only the supported subset is converted: headings (#..######), paragraphs, one-level " +
      "unordered (- /*) and ordered (1.) lists, fenced code blocks (```lang), **bold**, *italic*, " +
      "`inline code` and [text](http/https/relative link). " +
      'For richer bodies pass bodyFormat "storage" with raw Confluence storage XHTML.',
    { construct, line },
  );
}

// ---------------------------------------------------------------------------
// Line patterns
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const QUOTE_RE = /^ {0,3}>/;
const TABLE_ROW_RE = /^ {0,3}\|/;
const TABLE_SEPARATOR_RE = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const LIST_ITEM_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const TASK_ITEM_RE = /^\[(?: |x|X)\]/;
const FOOTNOTE_RE = /^\[\^[^\]]+\]/;
const LINK_RE = /^\[([^\]]*)\]\(([^()\s]+)\)/;
const EM_RE = /^\*([^\s*][^*]*[^\s*]|\S)\*/;
const HTML_START_RE = /^<[A-Za-z/!]/;

/** True when the line starts a construct that terminates an open paragraph. */
function isBlockStart(line: string): boolean {
  return (
    HEADING_RE.test(line) ||
    line.startsWith("```") ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    TABLE_ROW_RE.test(line) ||
    TABLE_SEPARATOR_RE.test(line) ||
    LIST_ITEM_RE.test(line)
  );
}

// ---------------------------------------------------------------------------
// Inline conversion (headings, paragraphs, list items)
// ---------------------------------------------------------------------------

function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (ch) => (ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : "&gt;"));
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

/** http/https/relative only — anything else is a VALIDATION error, never a passthrough. */
function validateLinkTarget(url: string, line: number, source: string): void {
  if (/^https?:\/\//i.test(url)) return;
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || url.startsWith("#")) return;
  fail(`link target "${url}" (only http, https and relative URLs are supported)`, line, source);
}

/**
 * Convert one line's inline content to storage XHTML. Supported inline
 * constructs: **bold**, *italic*, `code`, [text](url). Anything else that
 * looks like richer Markdown (image, strikethrough, HTML, footnote,
 * reference-style link) is rejected; everything else is escaped literal text.
 */
function convertInline(text: string, line: number): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code: content verbatim (entity-escaped), no nested processing.
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1 && end > i + 1) {
        out += `<code>${escapeText(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
      out += "`";
      i += 1;
      continue;
    }

    // Bold before italic so ** is never read as an empty * pair.
    if (rest.startsWith("**")) {
      const end = rest.indexOf("**", 2);
      const content = end !== -1 ? rest.slice(2, end) : "";
      if (end !== -1 && content.trim() !== "") {
        out += `<strong>${convertInline(content, line)}</strong>`;
        i += end + 2;
        continue;
      }
      out += escapeText(rest.slice(0, 2));
      i += 2;
      continue;
    }

    if (rest.startsWith("~~")) fail("strikethrough (~~text~~)", line, text);
    if (rest.startsWith("!["))
      fail("image (![alt](url)) — images are not part of the supported subset", line, text);

    if (text[i] === "[") {
      const link = LINK_RE.exec(rest);
      if (link) {
        validateLinkTarget(link[2], line, text);
        out += `<a href="${escapeAttr(link[2])}">${convertInline(link[1], line)}</a>`;
        i += link[0].length;
        continue;
      }
      // A link-shaped construct the strict URL charset rejected (spaces or
      // parentheses in the target, e.g. [x](javascript:alert(1))) is still a
      // link attempt — reject it instead of passing it through as text.
      if (/^\[[^\]]*\]\([^)]*\)/.test(rest))
        fail("link target (only http, https and relative URLs without spaces or parentheses are supported)", line, text);
      if (FOOTNOTE_RE.test(rest)) fail("footnote reference ([^label])", line, text);
      out += "[";
      i += 1;
      continue;
    }

    if (rest.startsWith("][")) fail("reference-style link ([text][ref])", line, text);

    if (text[i] === "*") {
      const em = EM_RE.exec(rest);
      if (em) {
        out += `<em>${convertInline(em[1], line)}</em>`;
        i += em[0].length;
        continue;
      }
      out += "*";
      i += 1;
      continue;
    }

    if (text[i] === "<" && HTML_START_RE.test(rest))
      fail("inline HTML (<tag>) — HTML passthrough is not part of the supported subset", line, text);

    const ch = text[i];
    out += ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lists (exactly one nesting level)
// ---------------------------------------------------------------------------

/** Parse a contiguous list block (single nesting level) into storage XHTML. */
function parseList(lines: readonly string[], start: number): { html: string; next: number } {
  interface ItemNode {
    readonly text: string;
    readonly line: number;
    readonly children: string[];
  }

  const tops: ItemNode[] = [];
  let ordered: boolean | null = null;
  let nestedIndent: number | null = null;
  let i = start;

  while (i < lines.length) {
    const match = LIST_ITEM_RE.exec(lines[i]);
    if (!match) {
      // A non-blank indented line below a list item would silently split into
      // a separate paragraph — reject it instead.
      if (lines[i].trim() !== "" && /^\s/.test(lines[i])) {
        fail("list item continuation line (indented text below a list item)", i + 1, lines[i]);
      }
      break;
    }

    const lineNo = i + 1;
    const indent = match[1].length;
    const itemOrdered = match[2] !== "-" && match[2] !== "*";
    const text = match[3];

    if (TASK_ITEM_RE.test(text)) fail("task list (- [ ] / - [x])", lineNo, lines[i]);

    if (indent === 0) {
      if (ordered === null) ordered = itemOrdered;
      else if (ordered !== itemOrdered) {
        fail("mixed ordered and unordered list markers in one list (separate them with a blank line)", lineNo, lines[i]);
      }
      tops.push({ text, line: lineNo, children: [] });
    } else {
      if (nestedIndent === null) {
        if (tops.length === 0) fail("indented list item without a parent item", lineNo, lines[i]);
        nestedIndent = indent;
      } else if (indent !== nestedIndent) {
        fail("list nesting deeper than one level", lineNo, lines[i]);
      }
      tops[tops.length - 1].children.push(text);
    }
    i += 1;
  }

  const tag = ordered ? "ol" : "ul";
  const items = tops.map((top) => {
    const nested =
      top.children.length > 0
        ? `<${tag}>${top.children.map((child) => `<li>${convertInline(child, top.line)}</li>`).join("")}</${tag}>`
        : "";
    return `<li>${convertInline(top.text, top.line)}${nested}</li>`;
  });
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: i };
}

// ---------------------------------------------------------------------------
// Fenced code blocks
// ---------------------------------------------------------------------------

/** Verbatim body, rewritten only as CDATA rules demand (split any `]]>`). */
function toCdata(body: string): string {
  return body.replace(/\]\]>/g, "]]]]><![CDATA[>");
}

function codeMacro(lang: string, body: string): string {
  const language = lang.trim();
  const langParam = language ? `<ac:parameter ac:name="language">${escapeText(language)}</ac:parameter>` : "";
  return (
    `<ac:structured-macro ac:name="code">${langParam}` +
    `<ac:plain-text-body><![CDATA[${toCdata(body)}]]></ac:plain-text-body>` +
    `</ac:structured-macro>`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Markdown (supported subset only) -> Confluence storage-format XHTML.
 * Pure and dependency-free. Throws a ToolError with code VALIDATION for any
 * construct outside the documented subset — input is never silently dropped.
 */
export function markdownToStorage(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3);
      i += 1;
      const body: string[] = [];
      let closed = false;
      while (i < lines.length) {
        if (lines[i].startsWith("```")) {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      if (!closed) fail("unterminated fenced code block (missing closing ```)", lineNo, line);
      blocks.push(codeMacro(lang, body.join("\n")));
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${convertInline(heading[2].trim(), lineNo)}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) fail("horizontal rule (---)", lineNo, line);
    if (QUOTE_RE.test(line)) fail("blockquote (>)", lineNo, line);
    if (TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line)) fail("table (pipe-delimited rows)", lineNo, line);

    if (LIST_ITEM_RE.test(line)) {
      const list = parseList(lines, i);
      blocks.push(list.html);
      i = list.next;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    // Every newline inside the paragraph becomes a hard break (<br/>).
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push(`<p>${paragraph.map((text, offset) => convertInline(text, lineNo + offset)).join("<br/>")}</p>`);
  }

  return blocks.join("\n");
}
