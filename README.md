# confluence-mcp

Deployment-agnostic [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) for
Atlassian Confluence.

- **Confluence Server / Data Center** — fully working provider (REST base `/rest/api`, zero-based
  `start`/`limit` pagination, numbered page envelopes with `size`).
- **Confluence Cloud** — fully working provider (REST base `{URL}/wiki`: v2 under `/wiki/api/v2`,
  v1 under `/wiki/rest/api`; cursor pagination everywhere).

Core features carried over from the shared MCP core design:

- **Compact cards** — raw REST payloads are never forwarded to the LLM; list/detail projections
  emit small, token-cheap JSON cards.
- **Pagination-aware listings** — page envelopes are normalized into a single `PageMeta`
  convention (`isLastPage`, `nextPageStart`, `nextCursor`) regardless of whether the provider
  pages by numbered offsets (Server/DC) or opaque cursors (Cloud).
- **Optimistic-lock-safe writes** — Confluence pages carry a `version`; on HTTP 409 the current
  page is re-fetched and the write is retried exactly once.

## Atlassian MCP Suite

| Package | Scope |
|---|---|
| [@nevzatcirak/jira-mcp](https://www.npmjs.com/package/@nevzatcirak/jira-mcp) | Jira issues, boards, sprints, worklogs |
| [@nevzatcirak/bitbucket-mcp](https://www.npmjs.com/package/@nevzatcirak/bitbucket-mcp) | Bitbucket Server/DC + Cloud: PRs, reviews, branches, code search |
| [@nevzatcirak/confluence-mcp](https://www.npmjs.com/package/@nevzatcirak/confluence-mcp) | Confluence Server/DC + Cloud: pages, CQL search, labels, markdown round-trip |

Install the other two depending on the client you use: `npx @nevzatcirak/jira-mcp` · `npx @nevzatcirak/bitbucket-mcp`

## Configuration (environment)

| Variable | Meaning |
| --- | --- |
| `CONFLUENCE_URL` | Instance base URL, e.g. `https://confluence.example.com` (required; on Cloud the adapter appends `/wiki`). |
| `CONFLUENCE_PROVIDER` | `server` (default) or `cloud`. |
| `CONFLUENCE_TOKEN` | Server/DC: personal access token → Bearer. Cloud: OAuth access token → Bearer. |
| `CONFLUENCE_USERNAME` / `CONFLUENCE_PASSWORD` | Server/DC credential pair → `Authorization: Basic`. **Server-only** — rejected in cloud mode. |
| `CONFLUENCE_CLOUD_EMAIL` | Atlassian account email; with `CONFLUENCE_CLOUD_API_TOKEN` → `Authorization: Basic base64(email:token)`. **Cloud only, both required together.** |
| `CONFLUENCE_CLOUD_API_TOKEN` | Confluence Cloud API token (see above). |
| `CONFLUENCE_READ_ONLY` | `true` hides all write tools. |
| `CONFLUENCE_CUSTOM_HEADERS` | Comma-separated `Name: Value` pairs appended to every request. |

**Auth matrix:**

| Provider | PAT (Bearer) | Basic | OAuth |
| --- | --- | --- | --- |
| Server / DC | ✅ `CONFLUENCE_TOKEN` → Bearer | ✅ `CONFLUENCE_USERNAME` + `CONFLUENCE_PASSWORD` | ❌ |
| Cloud | — | ✅ `CONFLUENCE_CLOUD_EMAIL` + `CONFLUENCE_CLOUD_API_TOKEN` → Basic | ✅ `CONFLUENCE_TOKEN` → Bearer (OAuth access token) |

Cloud mode requires **exactly one** credential set: the email + API-token pair, or
`CONFLUENCE_TOKEN` (Bearer). Setting both, or setting either half of the pair alone, or setting
`CONFLUENCE_USERNAME`/`CONFLUENCE_PASSWORD` in cloud mode, is reported as a structured
configuration problem (the server still starts and tools answer with `CONFIG_MISSING`).

## Read tools (10)

All read tools are read-only (`readOnly: true`) and served by both providers. List tools return a
`PageMeta` follow-up pointer on every card: `nextStart` on Server/DC (numbered `start`/`limit`
pagination) and `nextCursor` on Cloud (opaque cursor — pass it back via the `cursor` argument,
which Cloud tools forward verbatim as `?cursor=`; the Server/DC implementations ignore it).

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `cf_get_page` | Page by id | `id`, `format`: `storage` \| `view` \| `markdown` (default `markdown`) |
| `cf_get_page_by_title` | Resolve spaceKey + title → page | `spaceKey`, `title`, `format` |
| `cf_get_page_history` | Version history | `id` |
| `cf_get_page_hierarchy` | Recursive child tree | `id`, `depth` (default 2, max 5) |
| `cf_list_spaces` | List spaces | `limit`, `start`, `type` (`global` \| `personal`) |
| `cf_get_space` | Space details incl. description | `key` |
| `cf_list_pages_in_space` | Flat page list of a space | `spaceKey`, `limit`, `start` |
| `cf_search_cql` | Search via CQL | `cql`, `limit`, `start` (Server/DC) / `cursor` (Cloud) |
| `cf_get_labels` | Labels of a page | `id`, `limit`, `start` (Server/DC) / `cursor` (Cloud) |
| `cf_list_attachments` | Attachment metadata + download links | `id`, `limit`, `start` (Server/DC) / `cursor` (Cloud), `filename` |

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

## Write tools (5)

The five write tools declare `readOnly: false` and are served by both providers. Under
`CONFLUENCE_READ_ONLY=true` they are not advertised at all — `tools/list` returns only the ten
read tools.

| Tool | Purpose | Key arguments |
| --- | --- | --- |
| `cf_create_page` | Create a page in a space | `spaceKey`, `title`, `body`, `bodyFormat` (`markdown` \| `storage`, default `markdown`), `parent` (optional direct parent page id) |
| `cf_update_page` | Update title and/or body with mandatory optimistic locking | `id`, `title`?, `body`?, `bodyFormat`, `message`? — at least one of `title`/`body` |
| `cf_delete_page` | Move a page to the trash | `id` |
| `cf_add_label` | Add one global label | `id`, `name` |
| `cf_remove_label` | Remove one label by name | `id`, `name` |

**Deletion is trash-only.** `cf_delete_page` calls `DELETE /rest/api/content/{id}` (Server/DC) or
v2 `DELETE /pages/{id}` (Cloud, never passing `purge`), which moves the page to the Confluence
trash. Permanent purge is a separate server-side administration operation and is deliberately not
exposed by this tool.

**Optimistic locking.** `cf_update_page` always fetches the page's current `version.number`,
writes `version.number + 1` and, on HTTP 409 (concurrent edit), re-fetches and retries exactly
once. A second conflict surfaces a structured `CONFLICT` error — there is no second automatic
retry. Cloud v2 requires the current version number in the PUT payload; the same wrapper and
retry semantics apply on both providers.

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

## Confluence Cloud

The Cloud adapter talks to the same site your browser uses: the REST base is
`{CONFLUENCE_URL}/wiki`, with the v2 API under `/wiki/api/v2` and the legacy v1 API under
`/wiki/rest/api`. Both accept Basic (email + API token) and Bearer (OAuth) auth.

### Per-tool endpoint mix (v2 / v1)

| Tool | Cloud endpoint(s) |
| --- | --- |
| `cf_get_page` | v2 `GET /pages/{id}?body-format={storage\|view}` (one call per requested format) |
| `cf_get_page_by_title` | v2 `GET /spaces?keys=<KEY>` → `GET /pages?space-id=<id>&title=<title>&limit=1` → `GET /pages/{id}?body-format=…` (no CQL) |
| `cf_get_page_history` | v2 `GET /pages/{id}` + `GET /pages/{id}/versions` (cursor) |
| `cf_get_page_hierarchy` | v2 `GET /pages/{id}/direct-children` (BFS, non-page children filtered out) |
| `cf_list_spaces` | v2 `GET /spaces?type=&cursor=&limit=` |
| `cf_get_space` | v2 `GET /spaces?keys=<KEY>` → `GET /spaces/{id}?description-format=plain` |
| `cf_list_pages_in_space` | v2 `GET /spaces/{id}/pages?cursor=&limit=` (key resolved to id first) |
| `cf_search_cql` | **v1** `GET /rest/api/search?cql=&cursor=&limit=` (v2 has no search) |
| `cf_get_labels` | v2 `GET /pages/{id}/labels` (read) |
| `cf_add_label` / `cf_remove_label` | **v1** `POST/DELETE /rest/api/content/{id}/label` (the v2 label group is read-only) |
| `cf_list_attachments` | v2 `GET /pages/{id}/attachments?filename=&cursor=&limit=` |
| `cf_create_page` | v2 `POST /pages` (`spaceId` resolved from the space key; `parentId` for a direct parent) |
| `cf_update_page` | v2 `PUT /pages/{id}` (requires the current `version.number` in the payload) |
| `cf_delete_page` | v2 `DELETE /pages/{id}` (trash only, never `purge`) |

### Cursor pagination

Everything on Cloud pages by cursor — v2 endpoints and Cloud v1 search alike. Each envelope's
`_links.next` carries an opaque `cursor` query parameter; the tools extract it verbatim into
`nextCursor` and the matching `cursor` argument passes it back as `?cursor=`. An absent
`_links.next` means the listing is exhausted (`nextCursor: null`). The `start` argument only
applies to Server/DC and is ignored by Cloud implementations.

### Cloud card differences

Compact cards keep the same shape as Server/DC, with documented Cloud-specifics:

- `version.by` carries the author's **accountId** (display names would require extra user
  lookups, which are deliberately not made).
- `space` is resolved back from the numeric `spaceId` via a shared space key↔id resolver.
- `ancestors` on page cards is always `null` (the v2 single-page payload has no breadcrumb).
- `cf_search_cql` falls back to the content's `spaceId` in the `space` field when the hit is not
  a space (v1 search does not expand it).

### Attachment downloads

`cf_list_attachments` resolves `downloadUrl` to an absolute URL, but on Cloud that URL is **not a
public signed link** — downloading it requires the same authenticated session (Basic or Bearer
headers) that the MCP server itself uses.

## Provider matrix

| Tool | Server / DC | Cloud |
| --- | --- | --- |
| `cf_get_page` | ✅ | ✅ |
| `cf_get_page_by_title` | ✅ | ✅ |
| `cf_get_page_history` | ✅ | ✅ |
| `cf_get_page_hierarchy` | ✅ | ✅ |
| `cf_list_spaces` | ✅ | ✅ |
| `cf_get_space` | ✅ | ✅ |
| `cf_list_pages_in_space` | ✅ | ✅ |
| `cf_search_cql` | ✅ | ✅ |
| `cf_get_labels` | ✅ | ✅ |
| `cf_list_attachments` | ✅ | ✅ |
| `cf_create_page` | ✅ | ✅ |
| `cf_update_page` | ✅ | ✅ |
| `cf_delete_page` | ✅ | ✅ |
| `cf_add_label` | ✅ | ✅ |
| `cf_remove_label` | ✅ | ✅ |

## Usage

```sh
npm run build
# Server / Data Center
CONFLUENCE_URL=https://confluence.example.com CONFLUENCE_TOKEN=<pat> node dist/index.js
# Cloud (API-token Basic auth)
CONFLUENCE_PROVIDER=cloud CONFLUENCE_URL=https://confluence.example.com \
  CONFLUENCE_CLOUD_EMAIL=<email> CONFLUENCE_CLOUD_API_TOKEN=<token> node dist/index.js
```

CLI flags: `--version`, `--help`.

## Development

```sh
npm run build      # tsc -> dist/
npm run lint       # eslint
npm test           # pretest builds, then vitest (unit + stdio smoke test)
npm run check:org  # guard: forbidden references, public-registry lockfile, .npmrc pin
```

## Status

- ✅ **Phase 0** — core (config, pagination, compact cards, optimistic lock, errors), server
  provider, manifest registry, check-org guard, CI.
- ✅ **Phase 1** — 10 read tools (content, spaces, CQL search, labels, attachments) +
  storage→Markdown conversion layer (pure functions, fixture-tested per macro).
- ✅ **Phase 2** — 5 write tools (create/update page with mandatory optimistic locking, trash-only
  delete, label add/remove) + Markdown→storage conversion layer (strict supported subset,
  VALIDATION on anything else).
- ✅ **Phase 4 (0.4.0)** — Confluence Cloud provider: v2/v1 endpoint mix per tool, cursor
  pagination everywhere, email+API-token Basic / OAuth Bearer auth, provider-selected dispatch
  behind the same 15 manifests.
- 🚧 **Phase 5+** — attachments download tool, blog posts, and further write coverage.
