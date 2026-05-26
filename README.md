# `utilities/` — Studio + IDE tooling

Studio + IDE tooling for the CrewHaus meta-harness compiler — extracted from `factory/` and shipped as a bun workspace tree. Lives at [crewhaus/utilities](https://github.com/crewhaus/utilities). Ten packages: a spec authoring + run-inspection HTTP daemon, a vanilla-TS UI for it, a 5-question wizard, scaffold templates, a plugin SDK, a Gantt trace timeline, a graph layout engine, two IDE integrations, and a browser REPL.

## Layout

```
utilities/
  studio-server/            HTTP daemon — spec CRUD, run SSE, plugin discovery
  studio-ui/                vanilla-TS UI served by studio-server
  wizard/                   5-question state machine for guided spec creation
  scaffold-templates/       built-in spec YAML per target shape
  plugin-sdk/               typed surface for third-party studio plugins
  trace-viewer/             Gantt-shaped timeline from TraceEvent[]
  graph-visualizer/         layered DAG layout for IrGraphV0
  vscode-extension/         spec authoring + Run Spec for VS Code
  jetbrains-plugin/         IntelliJ / WebStorm / PyCharm parity
  crewhaus-playground/      browser REPL with Monaco + live trace
```

Each package lives at [`./<name>/`](./) with its own `README.md`, `package.json`, `src/`, and `tsconfig.json`.

## Package roles

### Studio runtime

- **[studio-server](./studio-server/)** — Bun.serve daemon exposing `/api/specs`, `/api/wizard/*`, `/api/runs/*` (SSE), `/api/graph-layout/*`, `/api/plugins`. v0 ships in dev mode (no auth) and a canned run-event stream — inject `runDispatcher` to wire a real runtime.
- **[studio-ui](./studio-ui/)** — `renderStudioHtml({ title })` returns a self-contained SPA (vanilla TS, no build step) that calls the studio-server API. Also exports `renderMcpConnectorsPanel()` and `renderMultiSpecDashboard()` as HTML fragments.
- **[wizard](./wizard/)** — 5-question state machine: target → name → model → tools → permission mode. Headless; the studio-ui and `crewhaus init --wizard` both drive it. Returns `{ yaml, envExample, target, name }`.
- **[scaffold-templates](./scaffold-templates/)** — pure data module. Ten `TemplateId` values, one per target shape. The wizard and studio-server both read this list as the seed for new specs.
- **[plugin-sdk](./plugin-sdk/)** — typed surface for third-party plugins. Plugins `export default definePlugin({ name, hooks, panes, permissions })`; the studio-server lazy-loads them from `~/.crewhaus/plugins/<name>/index.ts`.

### Visualization

- **[trace-viewer](./trace-viewer/)** — pure-logic Gantt layout. `buildTimeline(events)` pairs start/end events on `spanId` and returns a flat `TimelineSpan[]` with absolute t0/t1 + parent links. `replay()` yields events at 1×/2×/4×/raw.
- **[graph-visualizer](./graph-visualizer/)** — deterministic layered DAG layout for `IrGraphV0`. `layoutGraph(ir)` returns positions; `renderSvg()` + `renderLiveSvg()` emit SVG with `data-state` attributes for CSS coloring during live runs.

### IDE / browser surfaces

- **[vscode-extension](./vscode-extension/)** — VS Code ≥1.80. Registers `crewhaus.runSpec`, `crewhaus.continueSpec`, `crewhaus.openTrace`. YAML schema validation for `crewhaus.yaml` and `*.crewhaus.yaml`.
- **[jetbrains-plugin](./jetbrains-plugin/)** — plugin ID `io.crewhaus.jetbrains-plugin`. Schema-driven autocomplete on `crewhaus.yaml`, Run Spec / Run Eval / Run Canary configurations, and a spec-registry tool window. Built via `bun src/scripts/build.ts` (gates on `JBR_BIN`).
- **[crewhaus-playground](./crewhaus-playground/)** — browser REPL. `bun run play:server` stands up the SPA on `:3001` with a stubbed gateway; production mounts behind §20 gateway-server.

## Quickstart

Start the studio-server (random port, dev mode) and open the embedded UI:

```bash
bun --filter '@crewhaus/studio-server' test          # smoke
bun -e 'import {startStudioServer} from "@crewhaus/studio-server"; \
        import {renderStudioHtml} from "@crewhaus/studio-ui"; \
        const h = await startStudioServer({port: 4242}); \
        console.log("studio on http://localhost:" + h.port);'
```

Browse to `http://localhost:4242/` for the built-in HTML stub. To serve the full vanilla-TS UI, point studio-server's `/` handler at `renderStudioHtml({})`.

Run the browser playground:

```bash
cd utilities/crewhaus-playground
PORT=3001 CREWHAUS_STUDIO_URL=http://localhost:4242 bun run play:server
```

Install the VS Code extension locally:

```bash
cd utilities/vscode-extension
bun run build:vsce
code --install-extension *.vsix
```

## Workspace setup

`utilities/` is a bun workspaces tree — each top-level directory resolves as a `workspace:*` dependency. `@crewhaus/*` imports inside this tree map to the sibling `../factory/packages/*` checkout via the `paths` block in [tsconfig.base.json](./tsconfig.base.json); set `FACTORY_PATH` to override.

Inter-package edges:

- `studio-server` → `wizard`, `scaffold-templates`, `plugin-sdk`, `trace-viewer`, `graph-visualizer`
- `wizard` → `scaffold-templates`
- `crewhaus-playground` → `scaffold-templates`
- `jetbrains-plugin` → `vscode-extension` (shares the spec-schema generator)
- `studio-ui`, `trace-viewer`, `graph-visualizer`, `scaffold-templates`, `plugin-sdk` — leaf packages, no sibling deps

## Related docs

- Catalog: [docs/MODULE-CATALOG.md:145](../docs/MODULE-CATALOG.md) lists these as the Section 26 (Studio) and Section 35 (IDE) entry points
- Compiler: [crewhaus/factory](https://github.com/crewhaus/factory) — the meta-harness compiler that produces specs these tools author and inspect
