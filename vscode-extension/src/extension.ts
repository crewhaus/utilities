import { buildRunSpecArgv, resolveSubAgentDefinition } from "./run-spec";
/**
 * @crewhaus/vscode-extension — Section 35 + M5.1
 *
 * Extension activation entry point. The actual VS Code APIs (acquireVsCodeApi,
 * vscode.window, etc.) only exist when the extension is loaded by VS Code,
 * so this file declares them via type imports and exports the activation
 * surface for the test layer + the marketplace bundle.
 *
 * Tests don't load `vscode` at runtime (that would require the full VS Code
 * Extension Test Runner). They import this module's pure helpers only.
 *
 * M5.1 additions: registers crewhaus.runSpec + crewhaus.continueSpec
 * commands that spawn an integrated terminal running the configured
 * CLI against the active editor's spec.
 */
import { TARGET_SHAPES, getSpecJsonSchema, schemaCoversAllTargetShapes } from "./spec-schema";

export { activate, deactivate };

/**
 * Activation hook. VS Code calls this when the user opens a `crewhaus.yaml`
 * or runs the `crewhaus.runSpec` command.
 *
 * Type-loose `unknown` for the context to avoid pulling vscode.d.ts as a
 * runtime dep — the marketplace bundle injects vscode at load time.
 */
function activate(context: unknown, vscode?: VsCodeApi): void {
  const ctx = context as ExtensionContext;
  if (typeof ctx?.subscriptions?.push !== "function") return;

  // The marketplace bundle assigns globalThis.vscode at load time; pull
  // it out here so command handlers can dispatch. The optional injection
  // parameter is for tests.
  const v = vscode ?? (globalThis as { vscode?: VsCodeApi }).vscode;
  if (!v) {
    // We're loaded outside of VS Code (e.g. test runner). Skip command
    // registration — pure helpers (resolveSubAgentDefinition,
    // buildRunSpecArgv, getSpecJsonSchema) remain usable via the
    // `internals` export.
    return;
  }

  // M5.1 — Run Spec. Spawns a fresh integrated terminal in the spec's
  // directory and runs `crewhaus run <path>`. Output streams into the
  // terminal panel just like a local shell invocation.
  const runDisposable = v.commands.registerCommand("crewhaus.runSpec", async () => {
    const editor = v.window.activeTextEditor;
    if (!editor) {
      v.window.showErrorMessage("crewhaus.runSpec: no active editor");
      return;
    }
    const specPath = editor.document.uri.fsPath;
    if (!isCrewhausSpec(specPath)) {
      v.window.showErrorMessage(
        "crewhaus.runSpec: active file is not a crewhaus.yaml (or *.crewhaus.yaml)",
      );
      return;
    }
    const cliPath = v.workspace.getConfiguration("crewhaus").get<string>("cliPath") ?? "crewhaus";
    const argv = buildRunSpecArgv({ cliPath, specPath });
    const cwd = pathDirname(specPath);
    const terminal = v.window.createTerminal({ name: `crewhaus: ${pathBasename(specPath)}`, cwd });
    terminal.show();
    terminal.sendText(argv.join(" "));
  });
  ctx.subscriptions.push(runDisposable);

  // M5.1 + M1.4 — Continue Spec. Same as runSpec but appends --continue
  // so the most-recent session resumes.
  const continueDisposable = v.commands.registerCommand("crewhaus.continueSpec", async () => {
    const editor = v.window.activeTextEditor;
    if (!editor) {
      v.window.showErrorMessage("crewhaus.continueSpec: no active editor");
      return;
    }
    const specPath = editor.document.uri.fsPath;
    if (!isCrewhausSpec(specPath)) {
      v.window.showErrorMessage(
        "crewhaus.continueSpec: active file is not a crewhaus.yaml",
      );
      return;
    }
    const cliPath = v.workspace.getConfiguration("crewhaus").get<string>("cliPath") ?? "crewhaus";
    const argv = [...buildRunSpecArgv({ cliPath, specPath }), "--continue"];
    const cwd = pathDirname(specPath);
    const terminal = v.window.createTerminal({ name: `crewhaus[continue]: ${pathBasename(specPath)}`, cwd });
    terminal.show();
    terminal.sendText(argv.join(" "));
  });
  ctx.subscriptions.push(continueDisposable);
}

function deactivate(): void {
  // VS Code disposes of registered commands automatically when the
  // extension deactivates, via the subscriptions array.
}

export function isCrewhausSpec(path: string): boolean {
  return /(?:^|[/\\])crewhaus\.yaml$/.test(path) || /\.crewhaus\.yaml$/.test(path);
}

function pathDirname(p: string): string {
  const i = p.lastIndexOf("/");
  const j = p.lastIndexOf("\\");
  const k = Math.max(i, j);
  return k === -1 ? "." : p.slice(0, k);
}

function pathBasename(p: string): string {
  const i = p.lastIndexOf("/");
  const j = p.lastIndexOf("\\");
  const k = Math.max(i, j);
  return k === -1 ? p : p.slice(k + 1);
}

/** Public surface used by the extension test runner + the marketplace pkg. */
export const internals = {
  getSpecJsonSchema,
  schemaCoversAllTargetShapes,
  resolveSubAgentDefinition,
  buildRunSpecArgv,
  isCrewhausSpec,
  TARGET_SHAPES,
};

// Minimal subset of vscode.ExtensionContext used at activation time.
// Avoids a `@types/vscode` dep at workspace tsc time.
type Disposable = { dispose(): void };
type ExtensionContext = {
  subscriptions: { push(d: Disposable): void };
};

// Minimal subset of the vscode API surface this extension uses. Kept
// loose so we don't drag in @types/vscode for the workspace tsc.
type VsCodeApi = {
  commands: {
    registerCommand(name: string, handler: () => void | Promise<void>): Disposable;
  };
  window: {
    activeTextEditor?: { document: { uri: { fsPath: string } } };
    showErrorMessage(msg: string): void;
    createTerminal(opts: { name?: string; cwd?: string }): { show(): void; sendText(s: string): void };
  };
  workspace: {
    getConfiguration(section: string): { get<T>(key: string): T | undefined };
  };
};
