import { afterEach, describe, expect, test } from "bun:test";

import { internals, isCrewhausSpec } from "./extension";
// Re-import the module namespace so we can reach activate/deactivate, which
// are exported as a name-list (`export { activate, deactivate }`).
import * as extension from "./extension";

// ─── fake vscode API ────────────────────────────────────────────────────────
//
// A hand-rolled stand-in for the slice of the VS Code API the extension
// touches. Every method records its inputs so tests can assert the exact
// argv/terminal shape without a real extension host, child_process, fs, or
// network. Nothing here performs a side effect.

type RecordedTerminal = {
  opts: { name?: string; cwd?: string };
  shown: boolean;
  sent: string[];
};

function makeFakeVscode(opts?: {
  activeFsPath?: string | null;
  cliPath?: string | null;
}) {
  const errors: string[] = [];
  const terminals: RecordedTerminal[] = [];
  const registered: Record<string, () => void | Promise<void>> = {};

  const activeTextEditor =
    opts?.activeFsPath === null || opts?.activeFsPath === undefined
      ? undefined
      : { document: { uri: { fsPath: opts.activeFsPath } } };

  const v = {
    commands: {
      registerCommand(name: string, handler: () => void | Promise<void>) {
        registered[name] = handler;
        return { dispose() {} };
      },
    },
    window: {
      activeTextEditor,
      showErrorMessage(msg: string) {
        errors.push(msg);
      },
      createTerminal(o: { name?: string; cwd?: string }) {
        const t: RecordedTerminal = { opts: o, shown: false, sent: [] };
        terminals.push(t);
        return {
          show() {
            t.shown = true;
          },
          sendText(s: string) {
            t.sent.push(s);
          },
        };
      },
    },
    workspace: {
      getConfiguration(_section: string) {
        return {
          get<T>(_key: string): T | undefined {
            return (opts?.cliPath ?? undefined) as T | undefined;
          },
        };
      },
    },
  };

  return { v, errors, terminals, registered };
}

function makeContext() {
  const pushed: Array<{ dispose(): void }> = [];
  return {
    ctx: { subscriptions: { push: (d: { dispose(): void }) => pushed.push(d) } },
    pushed,
  };
}

afterEach(() => {
  // Defensive: ensure no test leaks a global vscode injection into the next.
  delete (globalThis as { vscode?: unknown }).vscode;
});

// ─── activate: early-return guards ──────────────────────────────────────────

describe("activate — guard clauses", () => {
  test("no-ops when context lacks a subscriptions.push function", () => {
    // Should not throw and should register nothing, regardless of vscode.
    const { v, registered } = makeFakeVscode({ activeFsPath: "/x/crewhaus.yaml" });
    expect(() => extension.activate(undefined, v)).not.toThrow();
    expect(() => extension.activate({}, v)).not.toThrow();
    expect(() => extension.activate({ subscriptions: {} }, v)).not.toThrow();
    expect(Object.keys(registered)).toHaveLength(0);
  });

  test("no-ops when no vscode is injected and globalThis.vscode is unset", () => {
    delete (globalThis as { vscode?: unknown }).vscode;
    const { ctx, pushed } = makeContext();
    expect(() => extension.activate(ctx)).not.toThrow();
    expect(pushed).toHaveLength(0);
  });

  test("falls back to globalThis.vscode when no injection arg is given", () => {
    const { v, registered } = makeFakeVscode({ activeFsPath: "/x/crewhaus.yaml" });
    (globalThis as { vscode?: unknown }).vscode = v;
    try {
      const { ctx, pushed } = makeContext();
      extension.activate(ctx);
      expect(Object.keys(registered).sort()).toEqual([
        "crewhaus.continueSpec",
        "crewhaus.runSpec",
      ]);
      expect(pushed).toHaveLength(2);
    } finally {
      delete (globalThis as { vscode?: unknown }).vscode;
    }
  });
});

// ─── activate: command registration ─────────────────────────────────────────

describe("activate — registers runSpec + continueSpec", () => {
  test("registers exactly the two M5.1 commands and pushes both disposables", () => {
    const { v, registered } = makeFakeVscode({ activeFsPath: "/x/crewhaus.yaml" });
    const { ctx, pushed } = makeContext();
    extension.activate(ctx, v);
    expect(Object.keys(registered).sort()).toEqual([
      "crewhaus.continueSpec",
      "crewhaus.runSpec",
    ]);
    expect(pushed).toHaveLength(2);
  });
});

// ─── runSpec handler ────────────────────────────────────────────────────────

describe("crewhaus.runSpec handler", () => {
  test("errors when there is no active editor", async () => {
    const { v, errors, terminals, registered } = makeFakeVscode({ activeFsPath: null });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.runSpec"]?.();
    expect(errors).toEqual(["crewhaus.runSpec: no active editor"]);
    expect(terminals).toHaveLength(0);
  });

  test("errors when the active file is not a crewhaus spec", async () => {
    const { v, errors, terminals, registered } = makeFakeVscode({
      activeFsPath: "/repo/notes.txt",
    });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.runSpec"]?.();
    expect(errors[0]).toContain("active file is not a crewhaus.yaml");
    expect(terminals).toHaveLength(0);
  });

  test("happy path: opens a terminal in the spec dir and runs the default CLI", async () => {
    const { v, errors, terminals, registered } = makeFakeVscode({
      activeFsPath: "/repo/examples/hello/crewhaus.yaml",
      cliPath: null, // unset -> defaults to "crewhaus"
    });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.runSpec"]?.();

    expect(errors).toHaveLength(0);
    expect(terminals).toHaveLength(1);
    const t = terminals[0]!;
    expect(t.opts.name).toBe("crewhaus: crewhaus.yaml");
    expect(t.opts.cwd).toBe("/repo/examples/hello");
    expect(t.shown).toBe(true);
    expect(t.sent).toEqual(["crewhaus run /repo/examples/hello/crewhaus.yaml"]);
  });

  test("honours a configured crewhaus.cliPath override", async () => {
    const { v, terminals, registered } = makeFakeVscode({
      activeFsPath: "/repo/crewhaus.yaml",
      cliPath: "/opt/crewhaus/bin/crewhaus",
    });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.runSpec"]?.();

    expect(terminals).toHaveLength(1);
    // Bare "crewhaus.yaml" lives at filesystem root in this fsPath, so cwd
    // resolves to the leading "/repo" segment and basename to "crewhaus.yaml".
    expect(terminals[0]!.opts.cwd).toBe("/repo");
    expect(terminals[0]!.sent).toEqual([
      "/opt/crewhaus/bin/crewhaus run /repo/crewhaus.yaml",
    ]);
  });
});

// ─── continueSpec handler ───────────────────────────────────────────────────

describe("crewhaus.continueSpec handler", () => {
  test("errors when there is no active editor", async () => {
    const { v, errors, terminals, registered } = makeFakeVscode({ activeFsPath: null });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.continueSpec"]?.();
    expect(errors).toEqual(["crewhaus.continueSpec: no active editor"]);
    expect(terminals).toHaveLength(0);
  });

  test("errors when the active file is not a crewhaus spec", async () => {
    const { v, errors, terminals, registered } = makeFakeVscode({
      activeFsPath: "/repo/README.md",
    });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.continueSpec"]?.();
    expect(errors[0]).toContain("active file is not a crewhaus.yaml");
    expect(terminals).toHaveLength(0);
  });

  test("happy path: appends --continue and labels the terminal [continue]", async () => {
    const { v, errors, terminals, registered } = makeFakeVscode({
      activeFsPath: "/repo/svc/crewhaus.yaml",
      cliPath: null,
    });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.continueSpec"]?.();

    expect(errors).toHaveLength(0);
    expect(terminals).toHaveLength(1);
    const t = terminals[0]!;
    expect(t.opts.name).toBe("crewhaus[continue]: crewhaus.yaml");
    expect(t.opts.cwd).toBe("/repo/svc");
    expect(t.shown).toBe(true);
    expect(t.sent).toEqual(["crewhaus run /repo/svc/crewhaus.yaml --continue"]);
  });
});

// ─── path helpers via a separator-less fsPath ───────────────────────────────

describe("path helpers (dirname/basename) — no-separator branch", () => {
  test("a bare crewhaus.yaml (no path separator) yields '.' cwd and itself as name", async () => {
    // The fsPath has no "/" or "\\", exercising the k === -1 branch in both
    // pathDirname (-> ".") and pathBasename (-> whole string).
    const { v, terminals, registered } = makeFakeVscode({
      activeFsPath: "crewhaus.yaml",
      cliPath: null,
    });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.runSpec"]?.();

    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.opts.name).toBe("crewhaus: crewhaus.yaml");
    expect(terminals[0]!.opts.cwd).toBe(".");
    expect(terminals[0]!.sent).toEqual(["crewhaus run crewhaus.yaml"]);
  });

  test("backslash-separated (Windows-style) fsPath splits on the backslash", async () => {
    const { v, terminals, registered } = makeFakeVscode({
      activeFsPath: "C:\\proj\\crewhaus.yaml",
      cliPath: null,
    });
    const { ctx } = makeContext();
    extension.activate(ctx, v);
    await registered["crewhaus.runSpec"]?.();

    expect(terminals[0]!.opts.cwd).toBe("C:\\proj");
    expect(terminals[0]!.opts.name).toBe("crewhaus: crewhaus.yaml");
  });
});

// ─── deactivate ─────────────────────────────────────────────────────────────

describe("deactivate", () => {
  test("is a no-op and returns undefined", () => {
    expect(extension.deactivate()).toBeUndefined();
  });
});

// ─── isCrewhausSpec + internals surface ─────────────────────────────────────

describe("isCrewhausSpec", () => {
  test("matches crewhaus.yaml and *.crewhaus.yaml in posix + windows paths", () => {
    expect(isCrewhausSpec("/a/b/crewhaus.yaml")).toBe(true);
    expect(isCrewhausSpec("crewhaus.yaml")).toBe(true);
    expect(isCrewhausSpec("C:\\a\\crewhaus.yaml")).toBe(true);
    expect(isCrewhausSpec("/a/b/prod.crewhaus.yaml")).toBe(true);
  });

  test("rejects non-spec paths", () => {
    expect(isCrewhausSpec("/a/b/other.yaml")).toBe(false);
    expect(isCrewhausSpec("/a/b/crewhaus.yml")).toBe(false);
    expect(isCrewhausSpec("/a/b/crewhaus.yaml.bak")).toBe(false);
    expect(isCrewhausSpec("notcrewhaus.yaml")).toBe(false);
  });

  test("internals re-exports the pure helper surface", () => {
    expect(typeof internals.getSpecJsonSchema).toBe("function");
    expect(typeof internals.schemaCoversAllTargetShapes).toBe("function");
    expect(typeof internals.resolveSubAgentDefinition).toBe("function");
    expect(typeof internals.buildRunSpecArgv).toBe("function");
    expect(internals.isCrewhausSpec).toBe(isCrewhausSpec);
    expect(Array.isArray(internals.TARGET_SHAPES)).toBe(true);
  });
});
