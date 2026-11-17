import { describe, expect, it } from "vitest";
import { convertNodes, storageToMarkdown, type ConvertCtx, type LinkRef } from "./storageToMarkdown.js";
import { parse } from "./parser.js";

/**
 * Fixtures below mimic real Confluence storage format output (body.storage):
 * ac:schema-version attributes, ri: namespaces, CDATA bodies and
 * auto-cursor-target artifacts.
 */

const SCHEMA = `ac:schema-version="1" ac:macro-id="0a1b2c3d-1111-2222-3333-444455556666"`;

describe("code macro", () => {
  it("emits a language-fenced block with the CDATA body verbatim (XML-looking text untouched)", () => {
    const xhtml = `
<ac:structured-macro ${SCHEMA} ac:name="code">
  <ac:parameter ac:name="language">xml</ac:parameter>
  <ac:plain-text-body><![CDATA[<config env="prod">
  <item value="&amp;" />
</config>]]></ac:plain-text-body>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe(
      "```xml\n<config env=\"prod\">\n  <item value=\"&amp;\" />\n</config>\n```",
    );
  });

  it("falls back to a bare fence when no language is set and adds an optional title", () => {
    const xhtml = `
<ac:structured-macro ${SCHEMA} ac:name="code">
  <ac:parameter ac:name="title">Deployment snippet</ac:parameter>
  <ac:plain-text-body><![CDATA[deploy --force]]></ac:plain-text-body>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe("**Deployment snippet**\n```\ndeploy --force\n```");
  });

  it("upgrades the fence when the body itself contains triple backticks", () => {
    const body = "```\nnested\n```";
    const xhtml =
      `<ac:structured-macro ac:name="code">` +
      `<ac:parameter ac:name="language">md</ac:parameter>` +
      `<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body>` +
      `</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe("````md\n```\nnested\n```\n````");
  });
});

describe.each([
  ["info", "[!NOTE]"],
  ["note", "[!NOTE]"],
  ["tip", "[!TIP]"],
  ["warning", "[!CAUTION]"],
])("%s macro", (name, marker) => {
  it(`renders a GFM alert (${marker}) with bold title and converted rich-text-body`, () => {
    const xhtml = `
<ac:structured-macro ${SCHEMA} ac:name="${name}">
  <ac:parameter ac:name="title">Heads up</ac:parameter>
  <ac:rich-text-body>
    <p>Watch the <strong>quota</strong> on <code>acme-prod</code>.</p>
  </ac:rich-text-body>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe(
      `> ${marker}\n> **Heads up**\n> Watch the **quota** on \`acme-prod\`.`,
    );
  });
});

describe("expand macro", () => {
  it("renders <details>/<summary> with converted body", () => {
    const xhtml = `
<ac:structured-macro ${SCHEMA} ac:name="expand">
  <ac:parameter ac:name="title">Rollback steps</ac:parameter>
  <ac:rich-text-body>
    <ol><li>Stop the service</li><li>Restore the dump</li></ol>
  </ac:rich-text-body>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe(
      "<details>\n<summary>Rollback steps</summary>\n\n1. Stop the service\n2. Restore the dump\n\n</details>",
    );
  });

  it("defaults the summary to Click to expand", () => {
    const xhtml = `
<ac:structured-macro ac:name="expand"><ac:rich-text-body><p>hidden</p></ac:rich-text-body></ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe("<details>\n<summary>Click to expand</summary>\n\nhidden\n\n</details>");
  });
});

describe("toc macro", () => {
  it("preserves parameters as a comment marker without fabricating a heading list", () => {
    const xhtml = `
<ac:structured-macro ${SCHEMA} ac:name="toc">
  <ac:parameter ac:name="maxLevel">3</ac:parameter>
  <ac:parameter ac:name="style">square</ac:parameter>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe(`<!-- toc: {maxLevel:3, style:square} -->`);
  });
});

describe("panel macro", () => {
  it("renders a blockquote with bolded title; colour params dropped", () => {
    const xhtml = `
<ac:structured-macro ${SCHEMA} ac:name="panel">
  <ac:parameter ac:name="title">Maintenace window</ac:parameter>
  <ac:parameter ac:name="borderColor">#cccccc</ac:parameter>
  <ac:rich-text-body><p>Every Sunday 02:00–04:00 UTC.</p></ac:rich-text-body>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe("> **Maintenace window**\n> Every Sunday 02:00–04:00 UTC.");
  });
});

describe("status macro (inline)", () => {
  it.each([
    ["Green", "🟢"],
    ["Red", "🔴"],
    ["Grey", "⚪"],
    ["Purple", "🟣"],
    ["Blue", "🔵"],
  ])("maps colour %s to its emoji", (colour, emoji) => {
    const xhtml = `<p>Release: <ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="colour">${colour}</ac:parameter><ac:parameter ac:name="title">Ready</ac:parameter></ac:structured-macro></p>`;
    expect(storageToMarkdown(xhtml)).toBe(`Release: ${emoji} **Ready**`);
  });

  it("uses no emoji for unknown colours and ignores the subtle param", () => {
    const xhtml = `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Magenta</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter><ac:parameter ac:name="title">Draft</ac:parameter></ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe("**Draft**");
  });
});

describe("ac:link", () => {
  const pageLink = (body: string) => `
<ac:link><ri:page ri:content-title="Release Notes" ri:space-key="ENG"/>${body}</ac:link>`;

  it("resolves via ctx resolver to [label](url)", () => {
    const ctx: ConvertCtx = {
      resolveLink: (ref: LinkRef) =>
        ref.kind === "page" ? `https://conf.example.com/display/${ref.spaceKey}/${ref.contentTitle}` : null,
    };
    expect(
      storageToMarkdown(pageLink(`<ac:plain-text-link-body><![CDATA[changelog]]></ac:plain-text-link-body>`), ctx),
    ).toBe("[changelog](https://conf.example.com/display/ENG/Release Notes)");
  });

  it("emits a plain-text label when no resolver is configured (never fabricates URLs)", () => {
    expect(storageToMarkdown(pageLink(`<ac:plain-text-link-body><![CDATA[changelog]]></ac:plain-text-link-body>`))).toBe(
      "changelog",
    );
  });

  it("emits a plain label when the resolver returns null", () => {
    const ctx: ConvertCtx = { resolveLink: () => null };
    expect(storageToMarkdown(pageLink(`<ac:plain-text-link-body><![CDATA[changelog]]></ac:plain-text-link-body>`), ctx)).toBe(
      "changelog",
    );
  });

  it("falls back to content-title / filename / username for bodyless links", () => {
    const xhtml = `
<p><ac:link><ri:page ri:content-title="Runbook"/></ac:link>
<ac:link><ri:attachment ri:filename="spec.pdf"/></ac:link>
<ac:link><ri:user ri:username="jdoe"/></ac:link></p>`;
    expect(storageToMarkdown(xhtml)).toBe("Runbook spec.pdf @jdoe");
  });

  it("uses ac:link-body rich content as label", () => {
    const xhtml = `<ac:link><ri:page ri:content-title="Arch"/><ac:link-body><em>architecture</em> doc</ac:link-body></ac:link>`;
    expect(storageToMarkdown(xhtml)).toBe("*architecture* doc");
  });

  it("passes attachment and user refs to the resolver", () => {
    const seen: LinkRef[] = [];
    const ctx: ConvertCtx = {
      resolveLink: (ref) => {
        seen.push(ref);
        return ref.kind === "attachment" ? `/files/${ref.filename}` : `@${ref.username}`;
      },
    };
    const out = storageToMarkdown(
      `<p><ac:link><ri:attachment ri:filename="diagram.png"/><ac:plain-text-link-body><![CDATA[diagram]]></ac:plain-text-link-body></ac:link> <ac:link><ri:user ri:username="asmith"/><ac:plain-text-link-body><![CDATA[Ann]]></ac:plain-text-link-body></ac:link></p>`,
      ctx,
    );
    expect(out).toBe("[diagram](/files/diagram.png) [Ann](@asmith)");
    expect(seen.map((r) => r.defaultTarget)).toEqual(["diagram.png", "@asmith"]);
  });
});

describe("ac:emoticon", () => {
  it("prefers ac:emoji-fallback, then the name map, then :name:", () => {
    const xhtml = `<p><ac:emoticon ac:name="smile" ac:emoji-fallback="🙂"/> <ac:emoticon ac:name="tick"/> <ac:emoticon ac:name="thumbs-up"/> <ac:emoticon ac:name="crocodile"/></p>`;
    expect(storageToMarkdown(xhtml)).toBe("🙂 ✅ 👍 :crocodile:");
  });
});

describe("task lists", () => {
  it("renders ac:task-list items from ac:task-status", () => {
    const xhtml = `
<ac:task-list>
  <ac:task>
    <ac:task-status>complete</ac:task-status>
    <ac:task-body><span>Tag the release</span></ac:task-body>
  </ac:task>
  <ac:task>
    <ac:task-status>incomplete</ac:task-status>
    <ac:task-body>Announce on <strong>#ops</strong></ac:task-body>
  </ac:task>
</ac:task-list>`;
    expect(storageToMarkdown(xhtml)).toBe("- [x] Tag the release\n- [ ] Announce on **#ops**");
  });

  it("supports nested task lists", () => {
    const xhtml = `
<ac:task-list>
  <ac:task>
    <ac:task-status>incomplete</ac:task-status>
    <ac:task-body>Parent</ac:task-body>
    <ac:task-list>
      <ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task>
    </ac:task-list>
  </ac:task>
</ac:task-list>`;
    expect(storageToMarkdown(xhtml)).toBe("- [ ] Parent\n  - [x] Child");
  });
});

describe("ac:image", () => {
  it("renders ri:url images with alt and italic caption", () => {
    const xhtml = `
<ac:image ac:align="center">
  <ri:url ri:value="https://example.com/topology.png"/>
  <ac:alt>Service topology</ac:alt>
  <ac:caption>Figure 1: prod topology</ac:caption>
</ac:image>`;
    expect(storageToMarkdown(xhtml)).toBe("![Service topology](https://example.com/topology.png)\n*Figure 1: prod topology*");
  });

  it("falls back to the attachment filename for url and alt", () => {
    const xhtml = `<ac:image><ri:attachment ri:filename="diag.png"/></ac:image>`;
    expect(storageToMarkdown(xhtml)).toBe("![diag.png](diag.png)");
  });
});

describe("tables", () => {
  it("renders a GFM table from th headers, escaping pipes in cells", () => {
    const xhtml = `
<table>
  <tbody>
    <tr><th>Env</th><th>URL</th></tr>
    <tr><td>prod</td><td>a | b</td></tr>
    <tr><td>stage</td><td>https://stage.example.com</td></tr>
  </tbody>
</table>`;
    expect(storageToMarkdown(xhtml)).toBe(
      "| Env | URL |\n| --- | --- |\n| prod | a \\| b |\n| stage | https://stage.example.com |",
    );
  });

  it("synthesizes an empty header row when no th row exists", () => {
    const xhtml = `
<table><tbody>
  <tr><td>a</td><td>b</td></tr>
</tbody></table>`;
    expect(storageToMarkdown(xhtml)).toBe("|  |  |\n| --- | --- |\n| a | b |");
  });

  it("pads colspan cells with empty cells (documented as lossy)", () => {
    const xhtml = `
<table><tbody>
  <tr><th>A</th><th>B</th><th>C</th></tr>
  <tr><td colspan="2">wide</td><td>right</td></tr>
</tbody></table>`;
    expect(storageToMarkdown(xhtml)).toBe("| A | B | C |\n| --- | --- | --- |\n| wide |  | right |");
  });

  it("inline-flattens cell content: nested lists join with '; ', block children join with space", () => {
    const xhtml = `
<table><tbody>
  <tr><th>Steps</th><th>Owner</th></tr>
  <tr>
    <td><ul><li>build</li><li>test</li></ul></td>
    <td><p>team <strong>alpha</strong></p><p>backup team</p></td>
  </tr>
</tbody></table>`;
    expect(storageToMarkdown(xhtml)).toBe("| Steps | Owner |\n| --- | --- |\n| build; test | team **alpha** backup team |");
  });
});

describe("unknown macros", () => {
  it("preserves ALL parameters in a lossless placeholder; never guesses semantics", () => {
    const xhtml = `
<ac:structured-macro ${SCHEMA} ac:name="view-file">
  <ac:parameter ac:name="filename">spec.pdf</ac:parameter>
  <ac:parameter ac:name="height">250px</ac:parameter>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe(
      `<!-- ac:macro name="view-file" params: {"filename":"spec.pdf","height":"250px"} -->`,
    );
  });

  it("serializes element-valued parameters as their text and supports the nameless default parameter", () => {
    const xhtml = `
<ac:structured-macro ac:name="widget">
  <ac:default-parameter>fallback-value</ac:default-parameter>
  <ac:parameter ac:name="label"><strong>rich</strong> label</ac:parameter>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe(
      `<!-- ac:macro name="widget" params: {"":"fallback-value","label":"rich label"} -->`,
    );
  });

  it("treats legacy ac:macro like ac:structured-macro (placeholder with params)", () => {
    const xhtml = `
<ac:macro ac:name="view-file">
  <ac:parameter ac:name="filename">spec.pdf</ac:parameter>
</ac:macro>`;
    expect(storageToMarkdown(xhtml)).toBe(`<!-- ac:macro name="view-file" params: {"filename":"spec.pdf"} -->`);
  });
});

describe("standard HTML subset", () => {
  it("converts headings, inline styles, code spans, links, hr and lists", () => {
    const xhtml = `
<h1>Title</h1>
<p>Some <strong>bold</strong>, <em>italic</em>, <code>raw &lt;code&gt;</code> and an <a href="https://example.com">external link</a>.</p>
<hr/>
<ul><li>one<ol><li>nested</li></ol></li><li>two</li></ul>`;
    expect(storageToMarkdown(xhtml)).toBe(
      "# Title\n\nSome **bold**, *italic*, `raw <code>` and an [external link](https://example.com).\n\n---\n\n- one\n  1. nested\n- two",
    );
  });

  it("doubles backticks inside inline code spans", () => {
    expect(storageToMarkdown("<p><code>a `b` c</code></p>")).toBe("`` a `b` c ``");
  });

  it("renders <pre> without a code macro as a verbatim fenced block", () => {
    const xhtml = `<pre>if (a &lt; b) {\n  run();\n}</pre>`;
    expect(storageToMarkdown(xhtml)).toBe("```\nif (a < b) {\n  run();\n}\n```");
  });

  it("renders <blockquote> with > prefix", () => {
    expect(storageToMarkdown("<blockquote><p>quoted</p></blockquote>")).toBe("> quoted");
  });

  it("decodes the named entities Confluence normalizes non-ASCII characters into", () => {
    // Observed on a live Cloud tenant: create with literal U+2014/U+2192, the
    // returned storage body carries &mdash; / &rarr; instead.
    expect(storageToMarkdown("<p>Dash &mdash; arrow &rarr; end</p>")).toBe("Dash \u2014 arrow \u2192 end");
  });
});

describe("storage-format edge cases", () => {
  it("drops auto-cursor-target paragraph artifacts", () => {
    const xhtml = `<p class="auto-cursor-target"><br/></p><p>real content</p><p class="auto-cursor-target"><br/></p>`;
    expect(storageToMarkdown(xhtml)).toBe("real content");
  });

  it("normalizes &nbsp; filler in empty paragraphs and cells to empty content", () => {
    const xhtml = `<p>&nbsp;</p><table><tbody><tr><td>&nbsp;</td><td>kept</td></tr></tbody></table>`;
    expect(storageToMarkdown(xhtml)).toBe("|  |  |\n| --- | --- |\n|  | kept |");
  });

  it("emits entities as literal decoded characters, not re-escaped HTML", () => {
    const xhtml = `<p>Escaped: &lt;script&gt; &amp; &quot;quotes&quot;</p>`;
    expect(storageToMarkdown(xhtml)).toBe(`Escaped: <script> & "quotes"`);
  });

  it("converts nested macros inside rich-text-body", () => {
    const xhtml = `
<ac:structured-macro ac:name="info">
  <ac:rich-text-body>
    <p>See:</p>
    <ac:structured-macro ac:name="code">
      <ac:parameter ac:name="language">bash</ac:parameter>
      <ac:plain-text-body><![CDATA[kubectl get pods]]></ac:plain-text-body>
    </ac:structured-macro>
  </ac:rich-text-body>
</ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe(
      "> [!NOTE]\n> See:\n>\n> ```bash\n> kubectl get pods\n> ```",
    );
  });

  it("converts a block macro wrapped in <p> onto its own lines", () => {
    const xhtml = `<p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">sh</ac:parameter><ac:plain-text-body><![CDATA[echo hi]]></ac:plain-text-body></ac:structured-macro></p>`;
    expect(storageToMarkdown(xhtml)).toBe("```sh\necho hi\n```");
  });

  it("keeps the CDATA `]] >` quirk lossless inside code bodies", () => {
    const xhtml = `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[arr[0]] > done]]></ac:plain-text-body></ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe("```\narr[0]] > done\n```");
  });

  it("uses CDATA verbatim (never entity-decoded) in code bodies", () => {
    const xhtml = `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA["&amp;" & "<tag>"]]></ac:plain-text-body></ac:structured-macro>`;
    expect(storageToMarkdown(xhtml)).toBe('```\n"&amp;" & "<tag>"\n```');
  });
});

describe("convertNodes (lower-level API)", () => {
  it("converts an already-parsed AST", () => {
    const nodes = parse("<h2>From AST</h2>");
    expect(convertNodes(nodes)).toBe("## From AST");
  });
});

describe("idempotence (single-block plain HTML subset)", () => {
  // Multi-paragraph output re-parsed as plain text collapses blank lines, so
  // stable double-conversion is only claimed where it genuinely holds.
  it.each([
    "<p><strong>bold</strong> and <em>italic</em></p>",
    "<p><code>x = 1</code> stays <code>intact</code></p>",
    "<h2>Just a heading</h2>",
    "<p>plain text only</p>",
  ])("is stable when converting twice: %s", (html) => {
    const once = storageToMarkdown(html);
    const twice = storageToMarkdown(once);
    expect(twice).toBe(once);
  });
});
