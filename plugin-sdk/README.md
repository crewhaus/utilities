# `@crewhaus/plugin-sdk`

Typed surface for third-party Studio plugins. A plugin is a single TS module exporting `definePlugin({...})`; [studio-server](../studio-server/) lazy-loads them from `~/.crewhaus/plugins/<name>/index.ts` at boot.

## Install

```bash
bun add @crewhaus/plugin-sdk
```

## Author a plugin

Create `~/.crewhaus/plugins/my-plugin/index.ts`:

```typescript
import { definePlugin } from "@crewhaus/plugin-sdk";

export default definePlugin({
  name: "my-plugin",
  version: "0.1.0",
  description: "Adds a custom side-pane to the studio.",

  hooks: {
    onSpecLoad(spec) {
      // spec: { name, target, raw }
    },
    onTraceEvent(event) {
      // event: { kind, ... } — fires for every SSE event
    },
    onEvalSampleRendered(sample) {
      // sample: { id, passed, ... }
    },
  },

  panes: [
    {
      id: "my-pane",
      title: "My Pane",
      html: "<div>Hello from my plugin</div>",
    },
  ],

  permissions: {
    fs: ["read:~/.crewhaus/plugins/my-plugin/data/**"],
    net: ["fetch:https://api.example.com/**"],
  },
});
```

`definePlugin` validates the definition (`name`/`version` required, pane `id`s unique, permission entries prefixed with `read:` or `fetch:`) and freezes it. studio-server discovers the file when its `/api/plugins` endpoint scans `pluginRoot`.

## Permissions

A plugin declares exactly which filesystem paths and network origins it needs:

```typescript
permissions: {
  fs: ["read:./data/**", "read:~/.crewhaus/plugins/my-plugin/cache/**"],
  net: ["fetch:https://api.example.com/**", "fetch:https://*.example.com/**"],
}
```

Patterns are minimatch-style globs (`**` recursive, `*` single-segment). Empty or absent permissions = **fail-closed** (deny all). The runtime gates each I/O attempt with `isFsAllowed(perms, path)` and `isNetAllowed(perms, url)`.

> v0 enforces the filesystem allowlist at plugin-load via [`assertPluginPathsStaySandboxed`](./src/index.ts) (rejects `file://` URLs in pane HTML that escape the sandbox root). Full script isolation (worker / QuickJS) lands in a follow-up.

## API surface

| Export | Kind | Summary |
|---|---|---|
| `definePlugin(def)` | function | validates + freezes a plugin definition |
| `assertPluginPathsStaySandboxed(plugin, root)` | function | throws if any pane HTML embeds a `file://` URL outside `root` |
| `isFsAllowed(perms, path)` | function | true iff `path` matches an `fs: ["read:<glob>"]` entry |
| `isNetAllowed(perms, url)` | function | true iff `url` matches a `net: ["fetch:<glob>"]` entry |
| `validatePermissions(perms)` | function | structural check; throws `PluginSdkError` on bad prefixes |
| `PluginSdkError` | class | thrown for any plugin-author mistake |
| `StudioPluginDefinition` | type | what `definePlugin` accepts/returns |
| `StudioPluginHooks` | type | `onSpecLoad`, `onTraceEvent`, `onEvalSampleRendered` |
| `StudioPluginPane` | type | `{ id, title, html }` |
| `PluginPermissions` | type | `{ fs?: string[], net?: string[] }` |

## Pairs with

- [studio-server](../studio-server/) — discovers plugins from `pluginRoot`, calls `assertPluginPathsStaySandboxed`, exposes `/api/plugins`
- [studio-ui](../studio-ui/) — renders each plugin's `panes[]` in the Plugins tab

## Related

- Source: [src/index.ts](./src/index.ts)
