# `@crewhaus/vscode-extension`

Spec authoring + run-from-editor for `crewhaus.yaml` files in VS Code. YAML schema validation, three commands, and a Run Spec terminal that shells to the configured CLI.

## Try it

The fastest path is the F5 dev-host flow — no packaging needed:

```bash
cd vscode-extension
bun install
code .          # open this folder in VS Code
# then press F5
```

VS Code launches an **Extension Development Host** window with the extension already loaded. Open any `crewhaus.yaml` file there; right-click → **CrewHaus: Run Spec**, or run the commands from the palette (`Cmd-Shift-P`).

Prefer a packaged install? Build a real `.vsix`:

```bash
cd vscode-extension
bun install
bun run build:vsce
# → crewhaus-vscode-extension-0.0.0.vsix
code --install-extension crewhaus-vscode-extension-*.vsix
```

Requires VS Code `^1.80.0`. Activates on any `yaml` or `crewhaus-spec` file, or on the three commands below.

## Commands

| Command ID | Title | What it does |
|---|---|---|
| `crewhaus.runSpec` | CrewHaus: Run Spec | Opens an integrated terminal in the spec's directory and runs `<cliPath> run <specPath>` |
| `crewhaus.continueSpec` | CrewHaus: Continue Spec | Same as Run Spec but appends `--continue` to resume the most-recent session |
| `crewhaus.openTrace` | CrewHaus: Open Trace Viewer | Opens the Studio v1 trace viewer at `studioUrl/#/run?spec=<rel>` |

Editor-title and explorer-context menus surface Run Spec / Continue Spec when the active file matches `crewhaus.yaml` or `*.crewhaus.yaml`.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `crewhaus.cliPath` | `"crewhaus"` | path (or PATH lookup) to the CLI binary |
| `crewhaus.studioUrl` | `"http://localhost:4242"` | URL of the Section-31 [studio-server](../studio-server/) for the webview SSE |

## YAML validation

Declared in the manifest under `contributes.yamlValidation` — file pattern `crewhaus.yaml` / `*.crewhaus.yaml` maps to `./schemas/spec.json`. The schema-generation helpers (`getSpecJsonSchema`, `schemaCoversAllTargetShapes`) are reused by [jetbrains-plugin](../jetbrains-plugin/) so both IDEs share one source of truth.

## Requires

- the `crewhaus` CLI binary on PATH (or pointed at via `crewhaus.cliPath`)
- a running [studio-server](../studio-server/) at `crewhaus.studioUrl` if you use Open Trace Viewer

## Related

- Source: [src/extension.ts](./src/extension.ts), [src/run-spec.ts](./src/run-spec.ts), [src/spec-schema.ts](./src/spec-schema.ts), [src/scripts/build-vsix.ts](./src/scripts/build-vsix.ts)
- Dev launch: [.vscode/launch.json](./.vscode/launch.json) wires the F5 → Extension Development Host flow.
- Sibling: [jetbrains-plugin](../jetbrains-plugin/) — IntelliJ / WebStorm / PyCharm parity

> Inside this workspace, resolves as `workspace:*`. Not yet on the marketplace.
