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

/**
 * HTML4 named entity set — the set Confluence storage actually uses
 * (Confluence normalizes characters like U+2014 EM DASH and U+2192 RIGHTWARDS
 * ARROW in the returned storage body to &mdash; / &rarr;). Unknown entities
 * pass through unchanged.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  // C0 / basic markup
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  // Latin-1 supplement
  nbsp: "\u00a0", iexcl: "\u00a1", cent: "\u00a2", pound: "\u00a3", curren: "\u00a4",
  yen: "\u00a5", brvbar: "\u00a6", sect: "\u00a7", uml: "\u00a8", copy: "\u00a9",
  ordf: "\u00aa", laquo: "\u00ab", not: "\u00ac", shy: "\u00ad", reg: "\u00ae",
  macr: "\u00af", deg: "\u00b0", plusmn: "\u00b1", sup2: "\u00b2", sup3: "\u00b3",
  acute: "\u00b4", micro: "\u00b5", para: "\u00b6", middot: "\u00b7", cedil: "\u00b8",
  sup1: "\u00b9", ordm: "\u00ba", raquo: "\u00bb", frac14: "\u00bc", frac12: "\u00bd",
  frac34: "\u00be", iquest: "\u00bf", Agrave: "\u00c0", Aacute: "\u00c1", Acirc: "\u00c2",
  Atilde: "\u00c3", Auml: "\u00c4", Aring: "\u00c5", AElig: "\u00c6", Ccedil: "\u00c7",
  Egrave: "\u00c8", Eacute: "\u00c9", Ecirc: "\u00ca", Euml: "\u00cb", Igrave: "\u00cc",
  Iacute: "\u00cd", Icirc: "\u00ce", Iuml: "\u00cf", ETH: "\u00d0", Ntilde: "\u00d1",
  Ograve: "\u00d2", Oacute: "\u00d3", Ocirc: "\u00d4", Otilde: "\u00d5", Ouml: "\u00d6",
  times: "\u00d7", Oslash: "\u00d8", Ugrave: "\u00d9", Uacute: "\u00da", Ucirc: "\u00db",
  Uuml: "\u00dc", Yacute: "\u00dd", THORN: "\u00de", szlig: "\u00df", agrave: "\u00e0",
  aacute: "\u00e1", acirc: "\u00e2", atilde: "\u00e3", auml: "\u00e4", aring: "\u00e5",
  aelig: "\u00e6", ccedil: "\u00e7", egrave: "\u00e8", eacute: "\u00e9", ecirc: "\u00ea",
  euml: "\u00eb", igrave: "\u00ec", iacute: "\u00ed", icirc: "\u00ee", iuml: "\u00ef",
  eth: "\u00f0", ntilde: "\u00f1", ograve: "\u00f2", oacute: "\u00f3", ocirc: "\u00f4",
  otilde: "\u00f5", ouml: "\u00f6", divide: "\u00f7", oslash: "\u00f8", ugrave: "\u00f9",
  uacute: "\u00fa", ucirc: "\u00fb", uuml: "\u00fc", yacute: "\u00fd", thorn: "\u00fe",
  yuml: "\u00ff",
  // Latin extended / spacing marks
  OElig: "\u0152", oelig: "\u0153", Scaron: "\u0160", scaron: "\u0161", Yuml: "\u0178",
  fnof: "\u0192", circ: "\u02c6", tilde: "\u02dc",
  // General punctuation
  ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwnj: "\u200c", zwj: "\u200d",
  lrm: "\u200e", rlm: "\u200f", ndash: "\u2013", mdash: "\u2014", lsquo: "\u2018",
  rsquo: "\u2019", sbquo: "\u201a", ldquo: "\u201c", rdquo: "\u201d", bdquo: "\u201e",
  dagger: "\u2020", Dagger: "\u2021", bull: "\u2022", hellip: "\u2026", permil: "\u2030",
  prime: "\u2032", Prime: "\u2033", lsaquo: "\u2039", rsaquo: "\u203a", oline: "\u203e",
  frasl: "\u2044", euro: "\u20ac",
  // Letterlike symbols
  image: "\u2111", weierp: "\u2118", real: "\u211c", trade: "\u2122", alefsym: "\u2135",
  // Arrows
  larr: "\u2190", uarr: "\u2191", rarr: "\u2192", darr: "\u2193", harr: "\u2194",
  crarr: "\u21b5", lArr: "\u21d0", uArr: "\u21d1", rArr: "\u21d2", dArr: "\u21d3",
  hArr: "\u21d4",
  // Mathematical operators
  forall: "\u2200", part: "\u2202", exist: "\u2203", empty: "\u2205", nabla: "\u2207",
  isin: "\u2208", notin: "\u2209", ni: "\u220b", prod: "\u220f", sum: "\u2211",
  minus: "\u2212", lowast: "\u2217", radic: "\u221a", prop: "\u221d", infin: "\u221e",
  ang: "\u2220", and: "\u2227", or: "\u2228", cap: "\u2229", cup: "\u222a",
  int: "\u222b", there4: "\u2234", sim: "\u223c", cong: "\u2245", asymp: "\u2248",
  ne: "\u2260", equiv: "\u2261", le: "\u2264", ge: "\u2265", sub: "\u2282",
  sup: "\u2283", nsub: "\u2284", sube: "\u2286", supe: "\u2287", oplus: "\u2295",
  otimes: "\u2297", perp: "\u22a5", sdot: "\u22c5",
  // Miscellaneous technical / geometric shapes
  lceil: "\u2308", rceil: "\u2309", lfloor: "\u230a", rfloor: "\u230b",
  lang: "\u2329", rang: "\u232a", loz: "\u25ca",
  // Greek letters
  Alpha: "\u0391", Beta: "\u0392", Gamma: "\u0393", Delta: "\u0394", Epsilon: "\u0395",
  Zeta: "\u0396", Eta: "\u0397", Theta: "\u0398", Iota: "\u0399", Kappa: "\u039a",
  Lambda: "\u039b", Mu: "\u039c", Nu: "\u039d", Xi: "\u039e", Omicron: "\u039f",
  Pi: "\u03a0", Rho: "\u03a1", Sigma: "\u03a3", Tau: "\u03a4", Upsilon: "\u03a5",
  Phi: "\u03a6", Chi: "\u03a7", Psi: "\u03a8", Omega: "\u03a9", alpha: "\u03b1",
  beta: "\u03b2", gamma: "\u03b3", delta: "\u03b4", epsilon: "\u03b5", zeta: "\u03b6",
  eta: "\u03b7", theta: "\u03b8", iota: "\u03b9", kappa: "\u03ba", lambda: "\u03bb",
  mu: "\u03bc", nu: "\u03bd", xi: "\u03be", omicron: "\u03bf", pi: "\u03c0",
  rho: "\u03c1", sigmaf: "\u03c2", sigma: "\u03c3", tau: "\u03c4", upsilon: "\u03c5",
  phi: "\u03c6", chi: "\u03c7", psi: "\u03c8", omega: "\u03c9", thetasym: "\u03d1",
  upsih: "\u03d2", piv: "\u03d6",
  // Card suits
  spades: "\u2660", clubs: "\u2663", hearts: "\u2665", diams: "\u2666",
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
