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

## Status: Phase 0

The tool registry ships an **empty manifest** — `tools/list` returns `[]`. Tool manifests land in
Phase 1+; the provider seam, pagination model, error model and optimistic-lock wrapper are
already in place and tested.
