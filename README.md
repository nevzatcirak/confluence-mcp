# confluence-mcp

Deployment-agnostic [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) for
Atlassian Confluence.

- **Confluence Server / Data Center** — fully working provider (REST base `/rest/api`, zero-based
  `start`/`limit` pagination, numbered page envelopes with `size`).
- **Confluence Cloud** — adapter seam only. Every call returns a structured
  `PROVIDER_UNAVAILABLE` error until the Cloud v2 adapter lands in Phase 4.

Core features carried over from the shared MCP core design:

- **Compact cards** — raw REST payloads are never forwarded to the LLM; list/detail projections
  emit small, token-cheap JSON cards.
- **Pagination-aware listings** — page envelopes are normalized into a single `PageMeta`
  convention (`isLastPage`, `nextPageStart`, `nextCursor`) regardless of whether the provider
  pages by numbered offsets or opaque cursors.
- **Optimistic-lock-safe writes** — Confluence pages carry a `version`; on HTTP 409 the current
  page is re-fetched and the write is retried exactly once.

## Configuration (environment)

| Variable | Meaning |
| --- | --- |
| `CONFLUENCE_URL` | Instance base URL, e.g. `https://confluence.example.com` (required). |
| `CONFLUENCE_PROVIDER` | `server` (default) or `cloud`. |
| `CONFLUENCE_TOKEN` | Personal access token → `Authorization: Bearer`. |
| `CONFLUENCE_USERNAME` / `CONFLUENCE_PASSWORD` | Credential pair → `Authorization: Basic`. |
| `CONFLUENCE_READ_ONLY` | `true` hides all write tools. |
| `CONFLUENCE_CUSTOM_HEADERS` | Comma-separated `Name: Value` pairs appended to every request. |

Either `CONFLUENCE_TOKEN` or the `CONFLUENCE_USERNAME` + `CONFLUENCE_PASSWORD` pair is required.

## Tools (Phase 1 — Server/DC read)

All tools are read-only (`readOnly: true`) and served by the `server` provider. List tools use
numbered pagination (`start`/`limit`) and return `PageMeta` (`isLastPage`, `nextPageStart`) on
every card.

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `cf_get_page` | Page by id | `id`, `format`: `storage` \| `view` \| `markdown` (default `markdown`) |
| `cf_get_page_by_title` | Resolve spaceKey + title → page | `spaceKey`, `title`, `format` |
| `cf_get_page_history` | Version history | `id` |
| `cf_get_page_hierarchy` | Recursive child tree | `id`, `depth` (default 2, max 5) |
| `cf_list_spaces` | List spaces | `limit`, `start`, `type` (`global` \| `personal`) |
| `cf_get_space` | Space details incl. description | `key` |
| `cf_list_pages_in_space` | Flat page list of a space | `spaceKey`, `limit`, `start` |
| `cf_search_cql` | Search via CQL | `cql`, `limit`, `start` |
| `cf_get_labels` | Labels of a page | `id`, `limit`, `start` |
| `cf_list_attachments` | Attachment metadata + download links | `id`, `limit`, `start`, `filename` |

### CQL examples (`cf_search_cql`)

The agent authors the CQL string. Common patterns:

```text
type=page AND space=DEV
type=page AND space=DEV AND lastmodified > now("-30d")
type=page AND title ~ "onboarding"
type=blogpost AND created > now("-7d")
type=attachment AND space=DEV
type=page AND label = "runbook"
type=page AND contributor.currentUser = true AND lastmodified > now("-90d")
```

### Markdown conversion (`format: "markdown"`)

`cf_get_page` / `cf_get_page_by_title` fetch the page body as Confluence **storage format** (XHTML)
and convert it to Markdown with a dependency-free, pure converter (`src/core/markdown/`).

Handled macros:

| Macro | Markdown output |
| --- | --- |
| `code` | fenced block with language; CDATA body emitted verbatim (never escaped/decoded) |
| `info` / `note` / `tip` / `warning` | GFM alert blockquotes (`> [!NOTE]` / `[!TIP]` / `[!CAUTION]`) |
| `expand` | `<details><summary>title</summary>…</details>` |
| `toc` | lossless `<!-- toc: {maxLevel:3, …} -->` marker |
| `panel` | blockquote with bolded title (colours dropped) |
| `status` | colour emoji + bold title (`🟢 **Done**`) |
| `ac:link` | page/attachment/user links (label from link body or target title) |
| `ac:emoticon` | emoji via fallback attr or name map, unknown → `:name:` |
| `ac:task-list` | GFM task list (`- [x]` / `- [ ]`) |
| `ac:image` | `![alt](url)` + italic caption |
| tables | GFM pipe tables (header row, `\|` escaping; colspan padded, rowspan lossy) |

**Unknown macros are never silently dropped** — they become lossless placeholders that keep the
macro name and all parameters, e.g. `<!-- ac:macro name="view-file" params: {"filename":"spec.pdf"} -->`.

Storage format is the conversion source (not `export_view`): storage is the canonical, lossless
representation in the REST conversion graph (`storage → view/export_view`; `export_view` is
terminal), keeps macro semantics (code language, TOC identity, collapse state) stable across
Confluence versions, and converts deterministically server-side without theme or render-mode drift.

## Write tools (Phase 2 — Server/DC)

The five write tools declare `readOnly: false` and are served by the `server` provider. Under
`CONFLUENCE_READ_ONLY=true` they are not advertised at all — `tools/list` returns only the ten
read tools.

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `cf_create_page` | Create a page in a space | `spaceKey`, `title`, `body`, `bodyFormat` (`markdown` \| `storage`, default `markdown`), `parent` (optional parent page id) |
| `cf_update_page` | Update title and/or body with mandatory optimistic locking | `id`, `title`?, `body`?, `bodyFormat`, `message`? — at least one of `title`/`body` |
| `cf_delete_page` | Move a page to the trash | `id` |
| `cf_add_label` | Add one global label | `id`, `name` |
| `cf_remove_label` | Remove one label by name | `id`, `name` |

**Deletion is trash-only.** `cf_delete_page` calls `DELETE /rest/api/content/{id}`, which moves
the page to the Confluence trash. Permanent purge is a separate server-side administration
operation and is deliberately not exposed by this tool.

**Optimistic locking.** `cf_update_page` always fetches the page's current `version.number`,
writes `version.number + 1` and, on HTTP 409 (concurrent edit), re-fetches and retries exactly
once. A second conflict surfaces a structured `CONFLICT` error — there is no second automatic
retry.

### Markdown input subset (write tools)

`cf_create_page` / `cf_update_page` accept `bodyFormat: "markdown"` (default) and convert the
body with a dependency-free converter (`src/core/markdown/markdownToStorage.ts`). This is a
sharply scoped, writer-friendly subset — **not** a full Markdown parser.

Supported on input:

- Headings `#` .. `######`
- Paragraphs (blank-line separated); a newline inside a paragraph becomes a hard break (`<br/>`)
- Unordered lists (`-` / `*`) and ordered lists (`1.`) — exactly one nesting level
- Fenced code blocks (```` ```lang ````) → code macro with language parameter and a verbatim body
- Inline: `**bold**`, `*italic*`, `` `code` ``, `[text](url)` with http, https and relative URLs
  (`/…`, `./…`, `../…`, `#…`)

Anything else is rejected with a structured `VALIDATION` error naming the offending construct —
input is never silently converted, approximated or dropped. Explicitly unsupported on input:
tables, images, blockquotes, task lists, HTML passthrough, list nesting deeper than one level,
horizontal rules, strikethrough, footnotes, reference-style links, autolinks, mixed ordered and
unordered markers inside one list, and indented continuation lines below a list item. For richer
bodies (macros, tables, panels, …) pass `bodyFormat: "storage"` and author Confluence storage
XHTML directly.

### Round-trip fidelity (markdown → storage → markdown)

A page written via the markdown subset reads back through `cf_get_page` with the supported
subset intact (headings, one-level lists, bold/italic/inline code, code fence incl. language,
links). Known losses of the cycle:

- Paragraph line breaks normalize to hard breaks (`  \n`), and runs of internal whitespace
  collapse to single spaces.
- Nested lists beyond one level are rejected on input, so they are never produced either.
- Tables, images, task lists, blockquotes and strikethrough are not in the input subset; pages
  containing them read fine (`cf_get_page` handles them) but cannot be authored via markdown.
- Code fences keep their language, but other code-macro parameters (`collapse`, `linenumbers`,
  `title`, …) are not expressible from markdown input.
- Storage-only constructs (status/panel/expand/toc macros, `ac:link` page references, emoticons)
  cannot be produced from markdown input; reading them back renders their markdown approximations.

## Usage

```sh
npm run build
CONFLUENCE_URL=https://confluence.example.com CONFLUENCE_TOKEN=<pat> node dist/index.js
```

CLI flags: `--version`, `--help`.

## Development

```sh
npm run build      # tsc -> dist/
npm run lint       # eslint
npm test           # pretest builds, then vitest (unit + stdio smoke test)
npm run check:org  # guard: forbidden references, public-registry lockfile, .npmrc pin
```

## Status: Phase 2

- ✅ **Phase 0** — core (config, pagination, compact cards, optimistic lock, errors), server
  provider, cloud seam, manifest registry, check-org guard, CI.
- ✅ **Phase 1** — 10 read tools (content, spaces, CQL search, labels, attachments) +
  storage→Markdown conversion layer (pure functions, fixture-tested per macro).
- ✅ **Phase 2** — 5 write tools (create/update page with mandatory optimistic locking, trash-only
  delete, label add/remove) + Markdown→storage conversion layer (strict supported subset,
  VALIDATION on anything else).
- 🚧 **Phase 3+** — attachments and further write coverage.
- 🚧 **Phase 4** — Confluence Cloud v2 adapter (replaces the `PROVIDER_UNAVAILABLE` seam).
