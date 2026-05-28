# `utilities/` — Studio + IDE tooling

Studio + IDE tooling for the CrewHaus meta-harness compiler — extracted from `factory/` and shipped as a bun workspace tree. Lives at [crewhaus/utilities](https://github.com/crewhaus/utilities). Ten packages: a spec authoring + run-inspection HTTP daemon, a vanilla-TS UI for it, a 5-question wizard, scaffold templates, a plugin SDK, a Gantt trace timeline, a graph layout engine, two IDE integrations, and a browser REPL.

## Layout

Every package has a runnable `bun run start` (or near equivalent) that demonstrates it from a clean checkout. Run from inside `<package>/`:

| Package | What it is | Run it with |
|---|---|---|
| [studio-server](./studio-server/)         | HTTP daemon — spec CRUD, run SSE, plugin discovery | `bun run start` → `:4242` |
| [studio-ui](./studio-ui/)                 | vanilla-TS UI bundled with studio-server           | `bun run start` → `:4243` (server + UI) |
| [wizard](./wizard/)                       | 5-question state machine for guided spec creation  | `bun run start` (interactive CLI) |
| [scaffold-templates](./scaffold-templates/) | built-in spec YAML per target shape              | `bun run start [id]` (catalog / show one) |
| [plugin-sdk](./plugin-sdk/)               | typed surface for third-party studio plugins       | `bun run start` (define + validate demo) |
| [trace-viewer](./trace-viewer/)           | Gantt-shaped timeline from `TraceEvent[]`          | `bun run start` (ASCII Gantt of a fixture) |
| [graph-visualizer](./graph-visualizer/)   | layered DAG layout for `IrGraphV0`                 | `bun run start` (writes `graph.svg`) |
| [vscode-extension](./vscode-extension/)   | spec authoring + Run Spec for VS Code              | open in VS Code, press F5 (or `bun run build:vsce`) |
| [jetbrains-plugin](./jetbrains-plugin/)   | IntelliJ / WebStorm / PyCharm parity               | `bun run build:plugin` (gated on `JBR_BIN`) |
| [crewhaus-playground](./crewhaus-playground/) | browser REPL with Monaco + live trace          | `bun run start` → `:3001` |

Each package has its own `README.md`, `package.json`, `src/`, and `tsconfig.json`.

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

Boot the full studio (daemon + UI) with the bundled dev script:

```bash
bun install
bun run studio
# → studio + UI on http://localhost:4243
#   (backend on http://localhost:4242)
```

Open http://localhost:4243/ for the Specs / Wizard / Plugins UI talking to a live API. In a second shell, confirm the backend is live:

```bash
curl -fsS http://localhost:4242/healthz   # → ok
```

Want just the lean daemon (no UI), the playground, or the IDE extension? Each package has its own `bun run start` (see the table above). For example:

```bash
cd crewhaus-playground && bun run start          # browser REPL on :3001
cd vscode-extension    && bun run build:vsce     # produces a .vsix to install
```

## Verify

```bash
bun test                              # every workspace package (145 tests)
cd studio-server && bun test          # just one package
```

## Workspace setup

`utilities/` is a bun workspaces tree — each top-level directory resolves as a `workspace:*` dependency. The `paths` block in [tsconfig.base.json](./tsconfig.base.json) maps the four factory-only imports (`@crewhaus/errors`, `@crewhaus/ir`, `@crewhaus/spec`, `@crewhaus/trace-event-bus`) to the sibling `../factory/packages/<name>/` checkout; every other `@crewhaus/*` import resolves to a workspace sibling here.

Inter-package edges:

- `studio-server` → `wizard`, `scaffold-templates`, `plugin-sdk`, `trace-viewer`, `graph-visualizer`
- `studio-ui` → `studio-server` (the `bun run start` script bundles both)
- `wizard` → `scaffold-templates`
- `crewhaus-playground` → `scaffold-templates`
- `jetbrains-plugin` → `vscode-extension` (shares the spec-schema generator)
- `trace-viewer`, `graph-visualizer`, `scaffold-templates`, `plugin-sdk` — leaf packages, no sibling deps

## Related docs

- Catalog: [docs/MODULE-CATALOG.md:145](../docs/MODULE-CATALOG.md) lists these as the Section 26 (Studio) and Section 35 (IDE) entry points
- Compiler: [crewhaus/factory](https://github.com/crewhaus/factory) — the meta-harness compiler that produces specs these tools author and inspect
