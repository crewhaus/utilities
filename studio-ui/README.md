# `@crewhaus/studio-ui`

Vanilla-TS UI for [studio-server](../studio-server/) — no build step, no framework. Exports HTML + inlined JS as strings. Three tabs: Specs (list + edit), Wizard (5-question flow), Plugins (discovery).

## Install

```bash
bun add @crewhaus/studio-ui
```

## Serve it

```typescript
import { startStudioServer } from "@crewhaus/studio-server";
import { renderStudioHtml } from "@crewhaus/studio-ui";

// Quickest path: hand-roll a tiny wrapper that serves the UI at "/"
// and lets studio-server handle everything under /api.
const html = renderStudioHtml({ title: "My Studio" });
// → returns a complete <!doctype html> string with the JS bundle inlined
```

`getStudioJs()` returns the JS bundle separately if you want to serve it from `/studio.js` instead of inlining.

## What it provides

- **`renderStudioHtml({ title? })`** — the full page (HTML + inlined `<script type="module">`). Calls `/api/specs`, `/api/wizard/*`, `/api/plugins` via `fetch`.
- **`getStudioJs()`** — just the JS bundle (string). Useful when embedding the UI inside another page.
- **`renderMcpConnectorsPanel({ currentSpecName?, catalog? })`** — HTML fragment listing curated MCP servers (`github`, `filesystem`, `postgres`, `fetch`, `memory`, `slack`) with `+ Add` buttons. Click handling is delegated to the embedding page via `data-connector` attributes.
- **`renderMultiSpecDashboard(rows)`** — HTML table of per-spec metrics (runs, cost, pass-rate, p50, p95).
- **`CURATED_MCP_SERVERS`** — the default catalog passed to `renderMcpConnectorsPanel`.

## Configuration

`renderStudioHtml` takes one option: `{ title?: string }` (default `"CrewHaus Studio"`). Everything else lives in the JS bundle and is hardwired to the studio-server `/api/*` routes.

## Requires

- [studio-server](../studio-server/) running on the same origin (or behind a reverse proxy) — the inlined JS uses relative `/api/*` paths.

## Related

- Source: [src/index.ts](./src/index.ts)
