import { afterEach, describe, expect, mock, test } from "bun:test";

import { JetbrainsPluginError, buildPlugin } from "./build";

/**
 * Coverage for the private `defaultRunner` (build.ts:167-185) — the real
 * `node:child_process.spawn` path that drives `./gradlew buildPlugin` when no
 * test `runner` is injected. `buildPlugin` reaches it via `opts.runner ??
 * defaultRunner`, so these tests set `jbrBin` but omit `runner`, then stub
 * `node:child_process` with `mock.module` so NOTHING real spawns. A synthetic
 * child captures the registered listeners and the test drives them
 * deterministically — no real process, no real clock, no I/O.
 */

type Listener = (...args: unknown[]) => void;

/** Minimal stand-in for the ChildProcess surface defaultRunner touches. */
class FakeChild {
  readonly stdoutListeners: Listener[] = [];
  readonly stderrListeners: Listener[] = [];
  readonly closeListeners: Listener[] = [];
  readonly errorListeners: Listener[] = [];

  readonly stdout = {
    on: (event: string, cb: Listener) => {
      if (event === "data") this.stdoutListeners.push(cb);
      return this.stdout;
    },
  };
  readonly stderr = {
    on: (event: string, cb: Listener) => {
      if (event === "data") this.stderrListeners.push(cb);
      return this.stderr;
    },
  };

  on(event: string, cb: Listener): this {
    if (event === "close") this.closeListeners.push(cb);
    else if (event === "error") this.errorListeners.push(cb);
    return this;
  }

  emitStdout(chunk: Buffer): void {
    for (const cb of this.stdoutListeners) cb(chunk);
  }
  emitStderr(chunk: Buffer): void {
    for (const cb of this.stderrListeners) cb(chunk);
  }
  emitClose(code: number | null): void {
    for (const cb of this.closeListeners) cb(code);
  }
  emitError(err: Error): void {
    for (const cb of this.errorListeners) cb(err);
  }
}

/** Records the args the runner passed to spawn for assertion. */
type SpawnCall = { head: string; args: readonly string[]; cwd: string | undefined };

/**
 * Install a `mock.module` stub for `node:child_process` whose `spawn` returns a
 * fresh `FakeChild` and invokes `drive(child)` on the next microtask so the
 * listeners defaultRunner registers synchronously are already attached. Returns
 * the recorded spawn call (populated once spawn fires).
 */
function stubSpawn(drive: (child: FakeChild) => void): { call: SpawnCall | undefined } {
  const box: { call: SpawnCall | undefined } = { call: undefined };
  mock.module("node:child_process", () => ({
    spawn: (head: string, args: readonly string[], opts: { cwd?: string }) => {
      const child = new FakeChild();
      box.call = { head, args, cwd: opts?.cwd };
      // defaultRunner attaches its listeners synchronously right after spawn
      // returns; defer driving them so all four are registered first.
      queueMicrotask(() => drive(child));
      return child;
    },
  }));
  return box;
}

afterEach(() => {
  // Restore the real module so other suites are unaffected.
  mock.module("node:child_process", () => require("node:child_process"));
  mock.restore();
});

describe("defaultRunner real spawn path (T2 — exercises build.ts:167-185)", () => {
  test("success: code 0 resolves to {skipped:false} with stdout/stderr drained", async () => {
    const box = stubSpawn((child) => {
      child.emitStdout(Buffer.from("BUILD "));
      child.emitStdout(Buffer.from("SUCCESSFUL"));
      child.emitStderr(Buffer.from("warn: noop"));
      child.emitClose(0);
    });

    const r = await buildPlugin({ jbrBin: "/opt/jbr" });

    expect(r.skipped).toBe(false);
    if (!r.skipped) {
      expect(r.outPath).toContain("build/distributions");
      expect(r.buildArgv).toEqual(["./gradlew", "buildPlugin"]);
    }
    // spawn invoked with head "./gradlew", tail ["buildPlugin"], cwd = package root.
    expect(box.call?.head).toBe("./gradlew");
    expect(box.call?.args).toEqual(["buildPlugin"]);
    expect(box.call?.cwd).toMatch(/jetbrains-plugin$/);
  });

  test("non-zero exit code surfaces as JetbrainsPluginError with stderr slice", async () => {
    stubSpawn((child) => {
      child.emitStderr(Buffer.from("compile failed: missing symbol"));
      child.emitClose(2);
    });

    let caught: unknown;
    try {
      await buildPlugin({ jbrBin: "/opt/jbr" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JetbrainsPluginError);
    expect((caught as Error).message).toContain("exited with 2");
    expect((caught as Error).message).toContain("compile failed: missing symbol");
  });

  test("null close code coalesces to exit 1 (build.ts:181 `code ?? 1`) → error", async () => {
    stubSpawn((child) => {
      // No stderr emitted: exercises empty Buffer.concat([]) too.
      child.emitClose(null);
    });

    let caught: unknown;
    try {
      await buildPlugin({ jbrBin: "/opt/jbr" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JetbrainsPluginError);
    expect((caught as Error).message).toContain("exited with 1");
  });

  test("spawn 'error' event resolves exitCode 1 with the error message (build.ts:176-178)", async () => {
    stubSpawn((child) => {
      child.emitError(new Error("ENOENT: gradlew not found"));
    });

    let caught: unknown;
    try {
      await buildPlugin({ jbrBin: "/opt/jbr" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JetbrainsPluginError);
    // exitCode 1 from the error branch, and stderr carries the message text.
    expect((caught as Error).message).toContain("exited with 1");
    expect((caught as Error).message).toContain("ENOENT: gradlew not found");
  });
});
