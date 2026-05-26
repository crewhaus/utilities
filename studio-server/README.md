# `@crewhaus/studio-server`

Bun.serve daemon for the CrewHaus Studio — spec CRUD, wizard endpoints, live run inspection over SSE, plugin discovery, and graph layout. The studio-ui (and any third-party UI) talks to this HTTP surface.

## Install

Inside the `demos/` workspace it resolves as `workspace:*`; nothing to install. Standalone:

```bash
bun add @crewhaus/studio-server
```

## Quick start

```typescript
import { startStudioServer } from "@crewhaus/studio-server";

const handle = await startStudioServer({
  port: 4242,                           // 0 = pick a random free port
  workspaceDir: "./specs",              // default: CWD/specs
  pluginRoot: "~/.crewhaus/plugins",    // default: $HOME/.crewhaus/plugins
  devMode: true,                        // default: true (no auth wired yet)
});

console.log(`studio listening on http://localhost:${handle.port}`);
// ... later:
await handle.stop();
```

The server creates `workspaceDir` if missing. v0 has no built-in auth — `devMode` is reserved for the follow-up that wraps the daemon in the §20 gateway-server JWT scheme.

## Wiring a real runtime

By default the server emits canned run events (`run_start` → `trace` → `run_done` stubs) so the smoke harness has something to assert on. Production callers pass a `runDispatcher` that owns the actual agent loop:

```typescript
await startStudioServer({
  runDispatcher: async ({ runId, specName, prompt, publish, finish, signal }) => {
    publish({ kind: "trace", subkind: "model_request", model: "claude-sonnet-4-6" });
    // ... run the agent, calling publish() per event
    finish("done");
  },
  replaySource: async (runId) => [/* TraceEvent[] from §10 event-log */],
  costSummarySource: async ({ tenantId, fromMs, toMs }) => ({
    totalUsdMicros: 0,
    byProvider: {},
  }),
});
```

`signal` aborts when `/api/runs/:runId/cancel` is called.

## HTTP API

| Method | Path | Body / params | Returns |
|---|---|---|---|
| `GET` | `/healthz` | — | `ok` |
| `GET` | `/` | — | HTML stub for smoke probes |
| `GET` | `/api/templates` | — | `{ templates: Template[] }` from scaffold-templates |
| `GET` | `/api/templates/:id` | — | full `Template` or 404 |
| `GET` | `/api/specs` | — | `{ specs: { name, target }[] }` |
| `POST` | `/api/specs` | `{ name, yaml }` | `201 { name }` |
| `GET` | `/api/specs/:name` | — | `{ name, yaml, parsed }` or 404/422 |
| `PUT` | `/api/specs/:name` | `{ yaml }` | `{ name }` |
| `DELETE` | `/api/specs/:name` | — | `{ deleted: name }` |
| `POST` | `/api/wizard/start` | — | `{ state, nextQuestion }` |
| `POST` | `/api/wizard/step` | `{ state, answer }` | `{ state, nextQuestion }` |
| `POST` | `/api/wizard/compile` | `{ state }` | `{ yaml, envExample, target, name }` |
| `POST` | `/api/runs` | `{ specName, prompt }` | `201 { runId }` |
| `GET` | `/api/runs/:runId/events` | — | SSE stream of `data: <json>` events, terminated by `event: done` |
| `POST` | `/api/runs/:runId/cancel` | — | aborts the dispatcher's signal |
| `GET` | `/api/runs/:runId/replay` | — | SSE re-emit from `replaySource` |
| `POST` | `/api/runs/:runId/hitl` | `?nodeId=&decision=` | pushes a `hitl_decision` event into the run |
| `GET` | `/api/graph-layout/:specName` | `Accept: image/svg` for SVG | layout JSON or SVG (graph specs only) |
| `GET` | `/api/cost-summary` | `?tenant=&from=&to=` | `{ totalUsdMicros, byProvider }` |
| `GET` | `/api/plugins` | — | `{ pluginRoot, plugins: [...] }` |

Spec names must match `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i` (single alnum, or alnum-…-alnum, no leading/trailing hyphen).

## API surface

| Export | Kind | Summary |
|---|---|---|
| `startStudioServer(opts)` | function | starts the daemon; returns `{ port, stop() }` |
| `StudioServerError` | class | thrown for config errors and unsafe spec names |
| `StudioServerOptions` | type | `port`, `workspaceDir`, `pluginRoot`, `devMode`, `runDispatcher`, `replaySource`, `costSummarySource`, `verifyJwt` |
| `StudioServerHandle` | type | `{ port, stop() }` |
| `RunDispatcher` | type | injected per-run handler — `{ runId, specName, prompt, publish, finish, signal }` |
| `ReplaySource` | type | `(runId) => Promise<RunEvent[] \| undefined>` |
| `CostSummarySource` | type | `(query) => Promise<{ totalUsdMicros, byProvider }>` |

## Pairs with

- Consumes [wizard](../wizard/), [scaffold-templates](../scaffold-templates/), [plugin-sdk](../plugin-sdk/), [graph-visualizer](../graph-visualizer/) directly
- Returns trace events shaped for [trace-viewer](../trace-viewer/) to render
- The default UI is [studio-ui](../studio-ui/) — serve `renderStudioHtml({})` from `/` to replace the HTML stub

## Related

- Source: [src/index.ts](./src/index.ts)
