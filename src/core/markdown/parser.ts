/**
 * Dependency-free, well-formed-XML tokenizer + AST for Confluence storage
 * format XHTML (expand=body.storage). Handles namespaced elements (ac:, ri:,
 * at:), non-namespaced HTML, attributes, text, CDATA, comments and the common
 * named/numeric entities. Tolerates the storage-format quirk where a CDATA
 * terminator is occasionally written as `]] >` (space injected).
 *
 * Pure functions only: parse(src) -> Node[].
 */

export interface Element {
  readonly kind: "element";
  /** Tag name, namespaced exactly as written (e.g. "ac:structured-macro"). */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: Node[];
}

export interface TextNode {
  readonly kind: "text";
  /** Decoded text (entities resolved, &nbsp; -> U+00A0). */
  readonly text: string;
}

export interface Cdata {
  readonly kind: "cdata";
  /** Verbatim CDATA content — never entity-decoded, never re-escaped. */
  readonly text: string;
}

export interface Comment {
  readonly kind: "comment";
  readonly text: string;
}

export type Node = Element | TextNode | Cdata | Comment;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9._:-]*/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the entity set Confluence storage actually uses; unknown entities pass through. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** CDATA content may be terminated by `]]>` or the storage quirk `]] >` (any whitespace). */
function readCdata(src: string, start: number): { readonly content: string; readonly next: number } {
  const plain = src.indexOf("]]>", start);
  if (plain !== -1) {
    return { content: src.slice(start, plain), next: plain + 3 };
  }
  const quirk = /]]\s*>/.exec(src.slice(start));
  if (quirk) {
    const at = start + quirk.index;
    return { content: src.slice(start, at), next: at + quirk[0].length };
  }
  return { content: src.slice(start), next: src.length };
}

/** Index of the closing `>` of a tag, honouring quoted attribute values. */
function findTagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") return i;
  }
  return -1;
}

function parseAttrs(interior: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*)))?/g;
  for (const m of interior.matchAll(re)) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[m[1]] = decodeEntities(value);
  }
  return attrs;
}

/**
 * Parse storage-format XHTML into a flat-rooted AST. Lenient by design:
 * unmatched close tags are ignored, unclosed elements are auto-closed at EOF,
 * and a stray `<` that does not start a tag is kept as literal text.
 */
export function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: Element[] = [];
  let i = 0;

  const push = (node: Node): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else root.push(node);
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      const stop = end === -1 ? src.length : end;
      push({ kind: "comment", text: src.slice(lt + 4, stop) });
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const { content, next } = readCdata(src, lt + 9);
      push({ kind: "cdata", text: content });
      i = next;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      if (end === -1) break;
      closeElement(src.slice(lt + 2, end).trim());
      i = end + 1;
      continue;
    }

    const nameMatch = NAME_RE.exec(src.slice(lt + 1));
    if (!nameMatch) {
      pushText("<");
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0];
    const gt = findTagEnd(src, lt + 1 + name.length);
    if (gt === -1) {
      pushText(src.slice(lt));
      break;
    }
    const interior = src.slice(lt + 1 + name.length, gt);
    const trimmed = interior.trimEnd();
    const selfClosing = trimmed.endsWith("/");
    const element: Element = {
      kind: "element",
      name,
      attrs: parseAttrs(selfClosing ? trimmed.slice(0, -1) : interior),
      children: [],
    };
    push(element);
    if (!selfClosing) stack.push(element);
    i = gt + 1;
  }

  return root;

  function pushText(text: string): void {
    if (text.length > 0) push({ kind: "text", text: decodeEntities(text) });
  }

  /** Close `name`, auto-closing any unclosed descendants inside it. Unknown close tags are ignored. */
  function closeElement(name: string): void {
    for (let d = stack.length - 1; d >= 0; d--) {
      if (stack[d].name === name) {
        stack.length = d;
        return;
      }
    }
  }
}

export function isElement(node: Node): node is Element {
  return node.kind === "element";
}

/** First child element with the given (exact, namespaced) name. */
export function findChild(element: Element, name: string): Element | undefined {
  return element.children.find((c): c is Element => c.kind === "element" && c.name === name);
}

/** All descendant text and CDATA content, concatenated in document order. */
export function textContent(node: Node): string {
  if (node.kind === "text" || node.kind === "cdata") return node.text;
  if (node.kind === "comment") return "";
  return node.children.map(textContent).join("");
}
