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

## Status: Phase 1

- ✅ **Phase 0** — core (config, pagination, compact cards, optimistic lock, errors), server
  provider, cloud seam, manifest registry, check-org guard, CI.
- ✅ **Phase 1** — 10 read tools (content, spaces, CQL search, labels, attachments) +
  storage→Markdown conversion layer (pure functions, fixture-tested per macro).
- 🚧 **Phase 2+** — write tools (create/update page with optimistic locking), attachments.
- 🚧 **Phase 4** — Confluence Cloud v2 adapter (replaces the `PROVIDER_UNAVAILABLE` seam).
