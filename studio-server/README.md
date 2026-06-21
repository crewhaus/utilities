# `@crewhaus/studio-server`

Bun.serve daemon for the CrewHaus Studio — spec CRUD, wizard + grader-builder + dataset-builder endpoints, workspace dataset storage, live run inspection over SSE, plugin discovery, and graph layout. The studio-ui (and any third-party UI) talks to this HTTP surface.

## Try it

```bash
cd studio-server
bun install
bun run start
# → studio on http://localhost:4242
#   Ctrl-C to stop

# in another shell:
curl -fsS http://localhost:4242/healthz   # → ok
curl -fsS http://localhost:4242/api/templates | head -c 200
```

`PORT` and `STUDIO_WORKSPACE` override the listener port and the spec directory.

## Programmatic use

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
| `POST` | `/api/grader-wizard/start` | — | `{ state, nextQuestion }` |
| `POST` | `/api/grader-wizard/step` | `{ state, answer }` | `{ state, nextQuestion }`; `400 { error }` on invalid answers (shown inline by the UI) |
| `POST` | `/api/grader-wizard/compile` | `{ state }` | `{ grader, yamlEntry, yamlBlock }` |
| `POST` | `/api/specs/:name/graders` | `{ state }` | appends the compiled grader to the eval spec's `graders:`; `{ name, graderName, yaml }` or 404 / 400 (non-eval, incomplete) / 409 (identical grader — same `name` + `opts` — already present) / 422 |
| `POST` | `/api/dataset-wizard/start` | — | `{ state, nextQuestion }` |
| `POST` | `/api/dataset-wizard/step` | `{ state, answer }` | `{ state, nextQuestion }`; `400 { error }` on invalid answers (shown inline by the UI) |
| `POST` | `/api/dataset-wizard/compile` | `{ state }` | `{ dataset, cases, yamlBlock, jsonl, path }` |
| `GET` | `/api/datasets` | — | `{ datasets: { name, version, split, cases }[] }` — `cases` is the count, or `null` for an invalid file |
| `GET` | `/api/datasets/:name/:version/:split` | — | `{ dataset, cases, path }` or 404 / 422 (file no longer validates) |
| `POST` | `/api/datasets` | `{ state }` | writes `datasets/<name>/<version>/<split>.jsonl`; `201 { dataset, path, caseCount }`, `200 + unchanged: true` when identical content already stored, or 409 (different cases at the coordinate — bump the version) |
| `POST` | `/api/specs/:name/dataset` | `{ state, create? }` | sets the eval spec's `dataset:` block **and** writes the JSONL sidecar; `{ name, dataset, yaml, datasetPath, caseCount }` or 404 (spec missing, no `create`) / 400 / 409 / 422. With `create: { model, instructions }` a missing spec is created as a starter eval spec around the dataset → `201 + created: true` |
| `POST` | `/api/runs` | `{ specName, prompt }` | `201 { runId }` |
| `GET` | `/api/runs/:runId/events` | — | SSE stream of `data: <json>` events, terminated by `event: done` |
| `POST` | `/api/runs/:runId/cancel` | — | aborts the dispatcher's signal |
| `GET` | `/api/runs/:runId/replay` | — | SSE re-emit from `replaySource` |
| `POST` | `/api/runs/:runId/hitl` | `?nodeId=&decision=` | pushes a `hitl_decision` event into the run |
| `GET` | `/api/graph-layout/:specName` | `Accept: image/svg` for SVG | layout JSON or SVG (graph specs only) |
| `GET` | `/api/cost-summary` | `?tenant=&from=&to=` | `{ totalUsdMicros, byProvider }` |
| `GET` | `/api/plugins` | — | `{ pluginRoot, plugins: [...] }` |

Spec names must match `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i` (single alnum, or alnum-…-alnum, no leading/trailing hyphen).

The graders append pre-checks the spec with a *loose* YAML parse, so the first grader can be appended to a draft eval spec (`graders: []` or no `graders:` key yet — not yet valid under `@crewhaus/spec`, which requires at least one grader). Persistence is gated by the real `@crewhaus/spec` parse of the resulting spec: on failure the server returns 422 and writes nothing. `POST /api/specs/:name/dataset` follows the same discipline (loose pre-parse, strict persistence gate) and replaces the `dataset:` block in place — `dataset:` is a single mapping, not a growable list.

Dataset coordinates are immutable once written: storing different cases at an existing `{name, version, split}` is a 409 (bump the version instead), identical content is idempotent. Wizard/builder `state` payloads are never trusted — every endpoint replays the answers through the validating state machine, so a hand-crafted state (wrong types, traversal-shaped names) is a 400, not a persisted file.

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

- Consumes [wizard](../wizard/), [grader-builder](../grader-builder/), [dataset-builder](../dataset-builder/), [scaffold-templates](../scaffold-templates/), [studio-plugin-sdk](../studio-plugin-sdk/), [graph-visualizer](../graph-visualizer/) directly
- Returns trace events shaped for [trace-viewer](../trace-viewer/) to render
- The default UI is [studio-ui](../studio-ui/) — `/` ships a minimal smoke-probe page; the full SPA is rendered by wiring `renderStudioHtml` into your own `Bun.serve` handler (see [studio-ui/README.md](../studio-ui/))

## Related

- Source: [src/index.ts](./src/index.ts), [src/scripts/start.ts](./src/scripts/start.ts)

> Inside this workspace, resolves as `workspace:*`. Published to npm as `@crewhaus/studio-server@0.1.5`.
