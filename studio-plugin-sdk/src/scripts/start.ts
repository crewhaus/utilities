/**
 * `bun run start` entry point for `@crewhaus/studio-plugin-sdk`.
 *
 * Defines a sample studio plugin via `definePlugin`, validates its
 * permissions, and exercises the `isFsAllowed` / `isNetAllowed`
 * decision functions against a few representative paths/URLs.
 */
import {
  definePlugin,
  isFsAllowed,
  isNetAllowed,
  validatePermissions,
} from "../index";

const demo = definePlugin({
  name: "demo-plugin",
  version: "0.1.0",
  description: "Sample plugin exercising the SDK surface.",
  hooks: {
    onSpecLoad(spec) {
      void spec; // observer
    },
    onTraceEvent(event) {
      void event; // observer
    },
  },
  panes: [
    {
      id: "demo-pane",
      title: "Demo Pane",
      html: "<div>Hello from demo-plugin</div>",
    },
  ],
  permissions: {
    fs: ["read:./data/**", "read:~/.crewhaus/plugins/demo-plugin/cache/**"],
    net: ["fetch:https://api.example.com/**", "fetch:https://*.example.com/**"],
  },
});

validatePermissions(demo.permissions);

process.stdout.write(`✓ definePlugin() returned a frozen manifest for "${demo.name}"\n`);
process.stdout.write(`  version:     ${demo.version}\n`);
process.stdout.write(`  description: ${demo.description}\n`);
process.stdout.write(`  hooks:       ${Object.keys(demo.hooks ?? {}).join(", ") || "(none)"}\n`);
process.stdout.write(`  panes:       ${demo.panes?.map((p) => p.id).join(", ") ?? "(none)"}\n`);
process.stdout.write(`  permissions: fs=${demo.permissions?.fs?.length ?? 0}, net=${demo.permissions?.net?.length ?? 0}\n`);

process.stdout.write(`\nPermission probes:\n`);
const checks: ReadonlyArray<readonly [string, () => boolean]> = [
  ["fs read:./data/foo.json", () => isFsAllowed(demo.permissions, "./data/foo.json")],
  ["fs read:./secrets/key", () => isFsAllowed(demo.permissions, "./secrets/key")],
  ["net fetch:https://api.example.com/v1/users", () => isNetAllowed(demo.permissions, "https://api.example.com/v1/users")],
  ["net fetch:https://malicious.com/", () => isNetAllowed(demo.permissions, "https://malicious.com/")],
];
for (const [label, fn] of checks) {
  process.stdout.write(`  ${fn() ? "ALLOW" : "DENY "}  ${label}\n`);
}
