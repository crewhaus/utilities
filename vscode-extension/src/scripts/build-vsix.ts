/**
 * `bun run build:vsce` entry point.
 *
 * VS Code Marketplace requires unscoped extension names, but the
 * workspace name (`@crewhaus/vscode-extension`) is scoped so bun's
 * workspace resolution can find it. This script swaps `name` to the
 * unscoped marketplace identifier (`crewhaus-vscode-extension`) for
 * the duration of `vsce package`, then restores the original
 * manifest.
 *
 * Produces `crewhaus-vscode-extension-<version>.vsix` in the package
 * root. Install locally via:
 *   code --install-extension crewhaus-vscode-extension-*.vsix
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const manifestPath = "package.json";
const original = readFileSync(manifestPath, "utf-8");
const manifest = JSON.parse(original) as { name: string };
const publishingName = "crewhaus-vscode-extension";

writeFileSync(manifestPath, JSON.stringify({ ...manifest, name: publishingName }, null, 2));

let exitCode = 0;
try {
  const result = spawnSync(
    "bunx",
    [
      "vsce",
      "package",
      "--no-dependencies",
      "--skip-license",
      "--allow-missing-repository",
      "--allow-star-activation",
    ],
    { stdio: "inherit" },
  );
  exitCode = result.status ?? 1;
} finally {
  writeFileSync(manifestPath, original);
}

process.exit(exitCode);
