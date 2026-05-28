# `@crewhaus/jetbrains-plugin`

IntelliJ / WebStorm / PyCharm parity for the [vscode-extension](../vscode-extension/). Schema-driven autocomplete on `crewhaus.yaml`, three run-configuration types, and a spec-registry tool window. Plugin ID `io.crewhaus.jetbrains-plugin`.

## Try it

```bash
cd jetbrains-plugin
bun install
bun run build:plugin
# → "JBR_BIN not set; gradle build skipped" (expected on a fresh checkout)
```

The build delegates to `./gradlew buildPlugin`. To actually produce a `.zip`, point `JBR_BIN` at a [JetBrains Runtime](https://github.com/JetBrains/JetBrainsRuntime) install:

```bash
JBR_BIN=/path/to/jbr bun run build:plugin
# → emits build/distributions/<name>-<version>.zip
```

The skip-on-missing-JBR is deliberate: local dev tests the bun-side manifest validation (`bun test`) without requiring Gradle. Marketplace publishing runs in CI with the JBR-bundled `verifyPlugin` task. Install the resulting `.zip` via **Settings → Plugins → (gear icon) → Install Plugin from Disk…**.

## What it provides

- **JSON schema provider** — `io.crewhaus.plugin.schema.CrewhausSpecSchemaProviderFactory` registers `crewhaus.yaml` with the YAML plugin's JSON Schema integration; autocomplete + lint fires automatically.
- **Run configurations** — three types:
  - `io.crewhaus.plugin.run.RunSpecConfigurationType` (Run Spec)
  - `io.crewhaus.plugin.run.RunEvalConfigurationType` (Run Eval)
  - `io.crewhaus.plugin.run.RunCanaryConfigurationType` (Run Canary)
- **Tool window** — id `CrewHaus Spec Registry`, anchored bottom, factory `io.crewhaus.plugin.toolwindow.SpecRegistryToolWindowFactory`. Database tools integration for the §28 Postgres adapter.
- **Editor actions** (right-click menu): `crewhaus.runSpec` and `crewhaus.openTrace`.

## Requires

- IntelliJ Platform — depends on `com.intellij.modules.platform` and the bundled `org.jetbrains.plugins.yaml` plugin
- the `crewhaus` CLI binary (the actions shell out)
- a running [studio-server](../studio-server/) for Open Trace Viewer

## Layout

```
src/
  main/
    kotlin/io/crewhaus/plugin/      action, run-config, tool-window, schema-provider classes
    resources/META-INF/plugin.xml   IntelliJ manifest
  scripts/
    build.ts                        bun-side validate + gradle invoke
```

`build.ts` also exports pure helpers (`fingerprintPluginXml`, `readPluginXml`, `kotlinSourceFiles`) used by `bun test` to catch local drift in the manifest before marketplace publishing.

## Related

- Sibling: [vscode-extension](../vscode-extension/) — shares the spec-schema generator
- Source: [src/main/resources/META-INF/plugin.xml](./src/main/resources/META-INF/plugin.xml), [src/scripts/build.ts](./src/scripts/build.ts)

> Inside this workspace, resolves as `workspace:*`. Not yet on the marketplace.
