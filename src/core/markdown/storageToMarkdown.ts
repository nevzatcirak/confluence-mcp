/**
 * Confluence storage-format XHTML -> Markdown converter. Implemented from
 * scratch (no DOM, no dependencies) because turndown's HTML parser cannot
 * losslessly handle namespaced XML + CDATA, escapes too aggressively, and its
 * rule model is the wrong shape for macros.
 *
 * Source is storage format (expand=body.storage), never export_view.
 * Everything here is pure: string/Node[] -> string, with side effects injected
 * via Ctx (link resolver callback, default null -> plain-text labels).
 *
 * Unknown macros are NEVER silently dropped: they are preserved as lossless
 * comment placeholders with all parameters serialized. Cell content is
 * inline-flattened and colspan padding is lossy by design (documented below).
 */

import { findChild, isElement, parse, textContent, type Element, type Node } from "./parser.js";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Reference carried out of an ac:link / ac:image so a host app can resolve real URLs. */
export interface LinkRef {
  readonly kind: "page" | "attachment" | "user" | "url";
  /** Anchor-style fallback target: `#content-title`, attachment filename, `@username`, or raw URL. */
  readonly defaultTarget: string;
  readonly contentTitle?: string;
  readonly spaceKey?: string;
  readonly filename?: string;
  readonly username?: string;
  readonly url?: string;
}

export type LinkResolver = (ref: LinkRef) => string | null;

export interface ConvertCtx {
  /**
   * Optional callback resolving a link reference to a URL. Returning null (or
   * leaving the resolver unset) yields a plain-text label with no link — the
   * converter never fabricates URLs it cannot know.
   */
  readonly resolveLink?: LinkResolver | null;
}

const DEFAULT_CTX: ConvertCtx = {};

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

function childrenElements(nodes: readonly Node[]): Element[] {
  return nodes.filter(isElement);
}

function firstOfAny(nodes: readonly Node[], names: readonly string[]): Element | undefined {
  return nodes.find((n): n is Element => n.kind === "element" && names.includes(n.name));
}

function childElementsNamed(nodes: readonly Node[], name: string): Element[] {
  return nodes.filter((n): n is Element => n.kind === "element" && n.name === name);
}

/** Collapse all whitespace (incl. nbsp) to single spaces. */
function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ");
}

function toSingleLine(text: string): string {
  return collapseWs(text).trim();
}

// ---------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------

type MacroHandler = (macro: Element, ctx: ConvertCtx) => string;

/** Collect ac:parameter (and nameless ac:default-parameter) values as strings. */
function macroParams(macro: Element): Record<string, string> {
  const params: Record<string, string> = {};
  for (const child of childrenElements(macro.children)) {
    if (child.name === "ac:parameter") {
      params[child.attrs["ac:name"] ?? ""] = toSingleLine(textContent(child));
    } else if (child.name === "ac:default-parameter") {
      params[""] = toSingleLine(textContent(child));
    }
  }
  return params;
}

/** Body of a plain-text body element: CDATA verbatim, decoded text otherwise. */
function plainTextBody(bodyEl: Element | undefined): string {
  if (!bodyEl) return "";
  const cdata = bodyEl.children.find((c) => c.kind === "cdata");
  if (cdata) return cdata.text;
  return textContent(bodyEl);
}

function richTextBody(macro: Element): Node[] {
  return findChild(macro, "ac:rich-text-body")?.children ?? [];
}

/** Smallest fence that does not collide with backtick runs inside the body. */
function fenceFor(body: string): string {
  let max = 0;
  for (const m of body.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(3, max + 1));
}

function codeMacro(macro: Element): string {
  const params = macroParams(macro);
  const lang = params["language"] ?? "";
  const body = plainTextBody(findChild(macro, "ac:plain-text-body"));
  const fence = fenceFor(body);
  const title = params["title"];
  const head = title ? `**${title}**\n` : "";
  const bodyText = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  return `${head}${fence}${lang}\n${bodyText}${fence}`;
}

function alertMacro(marker: string): MacroHandler {
  return (macro, ctx) => {
    const params = macroParams(macro);
    const body = convertNodes(richTextBody(macro), ctx);
    const lines: string[] = [`> [!${marker}]`];
    if (params["title"]) lines.push(`> **${params["title"]}**`);
    for (const line of body.split("\n")) lines.push(line === "" ? ">" : `> ${line}`);
    return lines.length > 1 ? lines.join("\n") : "";
  };
}

function expandMacro(macro: Element, ctx: ConvertCtx): string {
  const params = macroParams(macro);
  const title = params["title"] || "Click to expand";
  const body = convertNodes(richTextBody(macro), ctx);
  return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
}

function tocMacro(macro: Element): string {
  const inner = Object.entries(macroParams(macro))
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
  return `<!-- toc: {${inner}} -->`;
}

function panelMacro(macro: Element, ctx: ConvertCtx): string {
  const params = macroParams(macro);
  const body = convertNodes(richTextBody(macro), ctx);
  const lines: string[] = [];
  if (params["title"]) lines.push(`> **${params["title"]}**`);
  for (const line of body.split("\n")) lines.push(line === "" ? ">" : `> ${line}`);
  return lines.length > 0 ? lines.join("\n") : "";
}

const STATUS_EMOJI: Readonly<Record<string, string>> = {
  green: "🟢",
  red: "🔴",
  grey: "⚪",
  gray: "⚪",
  purple: "🟣",
  blue: "🔵",
};

function statusMacro(macro: Element): string {
  const params = macroParams(macro);
  const title = params["title"];
  const colour = (params["colour"] ?? params["color"] ?? "").toLowerCase();
  const emoji = STATUS_EMOJI[colour];
  if (!title && !emoji) return "";
  const head = emoji ? `${emoji} ` : "";
  return `${head}${title ? `**${title}**` : ""}`.trim();
}

const MACRO_HANDLERS: Readonly<Record<string, MacroHandler>> = {
  code: codeMacro,
  info: alertMacro("NOTE"),
  note: alertMacro("NOTE"),
  tip: alertMacro("TIP"),
  warning: alertMacro("CAUTION"),
  expand: expandMacro,
  toc: (macro) => tocMacro(macro),
  panel: panelMacro,
  status: (macro) => statusMacro(macro),
};

/** Any macro without a handler: lossless placeholder, params fully serialized. Never guess semantics. */
function unknownMacroPlaceholder(macro: Element): string {
  const name = macro.attrs["ac:name"] ?? "";
  return `<!-- ac:macro name="${name}" params: ${JSON.stringify(macroParams(macro))} -->`;
}

function dispatchMacro(macro: Element, ctx: ConvertCtx): string {
  const name = macro.attrs["ac:name"] ?? "";
  const handler = MACRO_HANDLERS[name];
  return handler ? handler(macro, ctx) : unknownMacroPlaceholder(macro);
}

function isMacroElement(el: Element): boolean {
  return el.name === "ac:structured-macro" || el.name === "ac:macro";
}

// ---------------------------------------------------------------------------
// Links, emoticons, tasks, images
// ---------------------------------------------------------------------------

function convertEmoticon(el: Element): string {
  const fallback = el.attrs["ac:emoji-fallback"];
  if (fallback !== undefined) return fallback;
  const name = el.attrs["ac:name"] ?? "";
  return EMOTICON_EMOJI[name] ?? `:${name}:`;
}

const EMOTICON_EMOJI: Readonly<Record<string, string>> = {
  smile: "🙂",
  sad: "🙁",
  tick: "✅",
  cross: "❌",
  "thumbs-up": "👍",
  information: "ℹ️",
  warning: "⚠️",
  plus: "➕",
  minus: "➖",
};

function convertLink(linkEl: Element, ctx: ConvertCtx): string {
  const ri = firstOfAny(linkEl.children, ["ri:page", "ri:attachment", "ri:user", "ri:url"]);

  // Label: plain-text-link-body CDATA, else converted ac:link-body, else target fallbacks.
  let label = "";
  const plainBody = findChild(linkEl, "ac:plain-text-link-body");
  if (plainBody) {
    label = toSingleLine(textContent(plainBody));
  } else {
    const linkBody = findChild(linkEl, "ac:link-body");
    if (linkBody) label = convertInline(linkBody.children, ctx).trim();
  }

  let ref: LinkRef | undefined;
  if (ri?.name === "ri:page") {
    const contentTitle = ri.attrs["ri:content-title"] ?? "";
    ref = {
      kind: "page",
      defaultTarget: `#${contentTitle}`,
      contentTitle,
      spaceKey: ri.attrs["ri:space-key"],
    };
  } else if (ri?.name === "ri:attachment") {
    const filename = ri.attrs["ri:filename"] ?? "";
    ref = { kind: "attachment", defaultTarget: filename, filename };
  } else if (ri?.name === "ri:user") {
    const username = ri.attrs["ri:username"] ?? ri.attrs["ri:userkey"] ?? "";
    ref = { kind: "user", defaultTarget: `@${username}`, username };
  } else if (ri?.name === "ri:url") {
    const url = ri.attrs["ri:value"] ?? "";
    ref = { kind: "url", defaultTarget: url, url };
  }

  if (!label) {
    label =
      ref?.contentTitle ?? ref?.filename ?? (ref?.kind === "user" ? `@${ref.username ?? ""}` : ref?.username) ?? "";
  }
  if (!ref || !label) return label;

  if (ctx.resolveLink) {
    const resolved = ctx.resolveLink(ref);
    if (resolved !== null) return `[${label}](${resolved})`;
    return label;
  }
  // No resolver: never fabricate a URL. Emit the plain-text label.
  return label;
}

function convertImage(imageEl: Element, ctx: ConvertCtx): string {
  const urlEl = findChild(imageEl, "ri:url");
  const attEl = findChild(imageEl, "ri:attachment");

  let url = "";
  let filename = "";
  if (urlEl) {
    url = urlEl.attrs["ri:value"] ?? "";
  } else if (attEl) {
    filename = attEl.attrs["ri:filename"] ?? "";
    url = filename;
    if (ctx.resolveLink) {
      const resolved = ctx.resolveLink({ kind: "attachment", defaultTarget: filename, filename });
      if (resolved !== null) url = resolved;
    }
  }

  const altEl = findChild(imageEl, "ac:alt");
  const alt =
    (altEl ? toSingleLine(textContent(altEl)) : "") || imageEl.attrs["ac:alt"] || filename || url;

  const captionEl = findChild(imageEl, "ac:caption");
  const caption = captionEl ? convertInline(captionEl.children, ctx).trim() : "";

  let out = `![${alt}](${url})`;
  if (caption) out += `\n*${caption}*`;
  return out;
}

function convertTaskList(listEl: Element, ctx: ConvertCtx, indent = ""): string {
  const lines: string[] = [];
  for (const task of childElementsNamed(listEl.children, "ac:task")) {
    const statusEl = findChild(task, "ac:task-status");
    const done = statusEl !== undefined && toSingleLine(textContent(statusEl)).toLowerCase() === "complete";
    const bodyEl = findChild(task, "ac:task-body");
    const body = bodyEl ? convertInline(bodyEl.children, ctx).trim() : "";
    lines.push(`${indent}- [${done ? "x" : " "}] ${body}`.trimEnd());
    for (const nested of childElementsNamed(task.children, "ac:task-list")) {
      lines.push(convertTaskList(nested, ctx, `${indent}  `));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function collectRows(node: Node, out: Element[]): void {
  if (!isElement(node)) return;
  if (node.name === "tr") {
    out.push(node);
    return;
  }
  for (const child of childrenElements(node.children)) collectRows(child, out);
}

function spanOf(cell: Element): number {
  const raw = Number.parseInt(cell.attrs["colspan"] ?? "1", 10);
  return Number.isFinite(raw) && raw > 1 ? Math.min(raw, 1000) : 1;
}

const CELL_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "section",
  "article",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
]);

/** Inline-flatten cell content to one line: block children joined by space, lists joined by "; ". */
function flattenCell(nodes: readonly Node[], ctx: ConvertCtx): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.kind === "comment") continue;
    if (node.kind === "text" || node.kind === "cdata") {
      parts.push(node.text);
      continue;
    }
    if (isMacroElement(node)) {
      parts.push(toSingleLine(dispatchMacro(node, ctx)));
      continue;
    }
    if (node.name === "ul" || node.name === "ol") {
      const items = childElementsNamed(node.children, "li").map((li) => flattenCell(li.children, ctx));
      parts.push(items.filter(Boolean).join("; "));
      continue;
    }
    if (node.name === "br") {
      parts.push(" ");
      continue;
    }
    if (CELL_BLOCK_TAGS.has(node.name)) {
      parts.push(flattenCell(node.children, ctx));
      continue;
    }
    // Inline element: keep its markdown formatting, flattened to one line.
    parts.push(toSingleLine(convertInline([node], ctx, true)));
  }
  return collapseWs(parts.join(" ")).trim();
}

function cellLine(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function convertTable(table: Element, ctx: ConvertCtx): string {
  const rows: Element[] = [];
  for (const child of table.children) collectRows(child, rows);
  if (rows.length === 0) return "";

  const grid = rows.map((tr) => {
    const cells: string[] = [];
    for (const cell of childrenElements(tr.children)) {
      if (cell.name !== "td" && cell.name !== "th") continue;
      const text = flattenCell(cell.children, ctx).replace(/\|/g, "\\|");
      cells.push(text);
      for (let pad = 1; pad < spanOf(cell); pad++) cells.push("");
      // rowspan is emitted once in its own row (lossy: later rows lose a column).
    }
    return cells;
  });

  const columnCount = Math.max(...grid.map((cells) => cells.length), 1);
  const firstRowIsHeader = childrenElements(rows[0].children).every((c) => c.name === "th");

  const lines: string[] = [];
  const header = firstRowIsHeader ? grid[0] : Array.from({ length: columnCount }, () => "");
  lines.push(cellLine(header));
  lines.push(cellLine(Array.from({ length: columnCount }, () => "---")));
  for (let r = firstRowIsHeader ? 1 : 0; r < grid.length; r++) {
    lines.push(cellLine(grid[r]));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inline conversion
// ---------------------------------------------------------------------------

function inlineCodeSpan(content: string): string {
  if (content.includes("`")) return `\`\` ${content} \`\``;
  return `\`${content}\``;
}

function convertInlineElement(el: Element, ctx: ConvertCtx, cellMode: boolean): string {
  switch (el.name) {
    case "strong":
    case "b": {
      const content = convertInline(el.children, ctx, cellMode).trim();
      return content ? `**${content}**` : "";
    }
    case "em":
    case "i": {
      const content = convertInline(el.children, ctx, cellMode).trim();
      return content ? `*${content}*` : "";
    }
    case "del":
    case "s": {
      const content = convertInline(el.children, ctx, cellMode).trim();
      return content ? `~~${content}~~` : "";
    }
    case "code": {
      const content = toSingleLine(textContent(el));
      return content ? inlineCodeSpan(content) : "";
    }
    case "a": {
      const href = el.attrs["href"] ?? "";
      const label = convertInline(el.children, ctx, cellMode).trim() || href;
      return href ? `[${label}](${href})` : label;
    }
    case "br":
      return cellMode ? " " : "  \n";
    case "ac:emoticon":
      return convertEmoticon(el);
    case "ac:link":
      return convertLink(el, ctx);
    case "ac:image":
      return convertImage(el, ctx);
    case "ac:structured-macro":
    case "ac:macro": {
      const out = dispatchMacro(el, ctx);
      // A block-shaped macro (e.g. code) inside a paragraph gets its own lines.
      return out.includes("\n") ? `\n${out}\n` : out;
    }
    case "u":
    case "sub":
    case "sup":
    case "small":
    case "span":
    case "font":
    case "p":
    case "div":
    default:
      return convertInline(el.children, ctx, cellMode);
  }
}

function convertInline(nodes: readonly Node[], ctx: ConvertCtx, cellMode = false): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "comment") continue;
    if (node.kind === "text" || node.kind === "cdata") {
      out += collapseWs(node.text);
      continue;
    }
    out += convertInlineElement(node, ctx, cellMode);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block conversion
// ---------------------------------------------------------------------------

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "table",
  "hr",
  "div",
  "section",
  "article",
  "ac:structured-macro",
  "ac:macro",
  "ac:task-list",
]);

function headingLevel(name: string): number {
  return Number.parseInt(name.slice(1), 10);
}

function renderList(listEl: Element, ctx: ConvertCtx, indent: string): string {
  const ordered = listEl.name === "ol";
  let index = Number.parseInt(listEl.attrs["start"] ?? "1", 10);
  if (!Number.isFinite(index) || index < 1) index = 1;

  const lines: string[] = [];
  for (const li of childElementsNamed(listEl.children, "li")) {
    const marker = ordered ? `${index++}. ` : "- ";
    const nested: Element[] = [];
    const inlineNodes: Node[] = [];
    for (const child of li.children) {
      if (child.kind === "element" && (child.name === "ul" || child.name === "ol")) nested.push(child);
      else inlineNodes.push(child);
    }
    const content = convertInline(inlineNodes, ctx).trim();
    lines.push(`${indent}${marker}${content}`.trimEnd());
    const nestedIndent = indent + " ".repeat(marker.length);
    for (const subList of nested) lines.push(renderList(subList, ctx, nestedIndent));
  }
  return lines.join("\n");
}

function convertPre(pre: Element): string {
  const body = textContent(pre);
  const fence = fenceFor(body);
  const bodyText = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  return `${fence}\n${bodyText}${fence}`;
}

function convertBlockElement(el: Element, ctx: ConvertCtx): string {
  switch (el.name) {
    case "p":
      return convertInline(el.children, ctx).trim();
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `${"#".repeat(headingLevel(el.name))} ${convertInline(el.children, ctx).trim()}`.trimEnd();
    case "ul":
    case "ol":
      return renderList(el, ctx, "");
    case "blockquote": {
      const body = convertNodes(el.children, ctx);
      return body
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    }
    case "pre":
      return convertPre(el);
    case "hr":
      return "---";
    case "table":
      return convertTable(el, ctx);
    case "ac:task-list":
      return convertTaskList(el, ctx);
    case "ac:image":
      return convertImage(el, ctx);
    case "ac:structured-macro":
    case "ac:macro":
      return dispatchMacro(el, ctx);
    default:
      // Unknown / container elements (div, section, rich-text wrappers…): transparent recursion.
      return convertNodes(el.children, ctx);
  }
}

function convertBlocks(nodes: readonly Node[], ctx: ConvertCtx): string[] {
  const blocks: string[] = [];
  let inlineRun: Node[] = [];

  const flush = (): void => {
    if (inlineRun.length === 0) return;
    const text = convertInline(inlineRun, ctx).trim();
    if (text) blocks.push(text);
    inlineRun = [];
  };

  for (const node of nodes) {
    if (node.kind === "comment") continue;
    if (node.kind === "element" && BLOCK_TAGS.has(node.name)) {
      flush();
      const block = convertBlockElement(node, ctx);
      if (block.trim()) blocks.push(block.trim());
    } else {
      inlineRun.push(node);
    }
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Convert a parsed storage-format AST to Markdown. Blocks are separated by blank lines. */
export function convertNodes(nodes: readonly Node[], ctx: ConvertCtx = DEFAULT_CTX): string {
  return convertBlocks(nodes, ctx)
    .filter((block) => block.trim().length > 0)
    .join("\n\n");
}

/** Confluence storage-format XHTML -> Markdown. Pure, dependency-free. */
export function storageToMarkdown(xhtml: string, ctx: ConvertCtx = DEFAULT_CTX): string {
  return convertNodes(parse(xhtml), ctx);
}
