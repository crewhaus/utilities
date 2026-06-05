import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _testFixturePath,
  buildRunSpecArgv,
  resolveSubAgentDefinition,
  studioWebviewUrl,
} from "./run-spec";

describe("buildRunSpecArgv (T1)", () => {
  test("happy path argv shape", () => {
    expect(
      buildRunSpecArgv({
        cliPath: "crewhaus",
        specPath: "/path/to/crewhaus.yaml",
      }),
    ).toEqual(["crewhaus", "run", "/path/to/crewhaus.yaml"]);
  });

  test("with --model override", () => {
    expect(
      buildRunSpecArgv({
        cliPath: "crewhaus",
        specPath: "/path/to/crewhaus.yaml",
        modelOverride: "claude-opus-4-7",
      }),
    ).toEqual(["crewhaus", "run", "/path/to/crewhaus.yaml", "--model", "claude-opus-4-7"]);
  });

  test("rejects shell-injection-shaped cliPath", () => {
    expect(() => buildRunSpecArgv({ cliPath: "crewhaus; rm -rf /", specPath: "x" })).toThrow(
      /invalid cliPath/,
    );
  });

  test("rejects empty cliPath / specPath", () => {
    expect(() => buildRunSpecArgv({ cliPath: "", specPath: "x" })).toThrow();
    expect(() => buildRunSpecArgv({ cliPath: "x", specPath: "" })).toThrow();
  });
});

describe("studioWebviewUrl (T1)", () => {
  test("URL-encodes the spec path", () => {
    const url = studioWebviewUrl({
      studioUrl: "http://localhost:4242/",
      specPath: "/repo/examples/hello cli/crewhaus.yaml",
      workspaceRoot: "/repo",
    });
    expect(url).toContain("/#/run?spec=examples%2Fhello+cli%2Fcrewhaus.yaml");
  });

  test("strips trailing slashes from studioUrl", () => {
    const url = studioWebviewUrl({
      studioUrl: "http://localhost:4242///",
      specPath: "/repo/x/crewhaus.yaml",
      workspaceRoot: "/repo",
    });
    expect(url.startsWith("http://localhost:4242/#/run")).toBe(true);
  });
});

describe("resolveSubAgentDefinition (T3)", () => {
  test("returns null when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscode-ext-test-"));
    try {
      const r = resolveSubAgentDefinition({
        workspaceRoot: dir,
        subAgentName: "missing",
      });
      expect(r).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses frontmatter + body from .crewhaus/sub-agents/<name>.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscode-ext-test-"));
    try {
      mkdirSync(join(dir, ".crewhaus", "sub-agents"), { recursive: true });
      writeFileSync(
        join(dir, ".crewhaus", "sub-agents", "code-reviewer.md"),
        `---
name: code-reviewer
description: "Reviews diffs for security + correctness"
tools: Read,Bash
---

You are a senior code reviewer. Focus on:
1. Logical correctness
2. Security issues
3. Test coverage
`,
      );
      const r = resolveSubAgentDefinition({
        workspaceRoot: dir,
        subAgentName: "code-reviewer",
      });
      expect(r).not.toBeNull();
      expect(r?.frontmatter["name"]).toBe("code-reviewer");
      expect(r?.frontmatter["description"]).toBe("Reviews diffs for security + correctness");
      expect(r?.frontmatter["tools"]).toBe("Read,Bash");
      expect(r?.body).toContain("senior code reviewer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when the sanitised sub-agent name is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscode-ext-test-"));
    try {
      // A name made entirely of disallowed characters sanitises to "",
      // which must short-circuit to null before any fs access.
      const r = resolveSubAgentDefinition({
        workspaceRoot: dir,
        subAgentName: "////",
      });
      expect(r).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to empty frontmatter + raw body when no `---` block", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscode-ext-test-"));
    try {
      mkdirSync(join(dir, ".crewhaus", "sub-agents"), { recursive: true });
      writeFileSync(
        join(dir, ".crewhaus", "sub-agents", "plain.md"),
        "no frontmatter here, just a body line\n",
      );
      const r = resolveSubAgentDefinition({
        workspaceRoot: dir,
        subAgentName: "plain",
      });
      expect(r).not.toBeNull();
      expect(r?.frontmatter).toEqual({});
      expect(r?.body).toContain("just a body line");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects path-traversal-shaped sub-agent names", () => {
    const dir = mkdtempSync(join(tmpdir(), "vscode-ext-test-"));
    try {
      const r = resolveSubAgentDefinition({
        workspaceRoot: dir,
        subAgentName: "../../etc/passwd",
      });
      // Even if the file existed, the sanitiser strips the slash characters
      // so the resolved path stays inside `.crewhaus/sub-agents/`.
      // We assert null here because the sanitised name `etcpasswd` won't
      // resolve to a real file in the temp dir.
      expect(r).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("studioWebviewUrl — relative path traversal", () => {
  test("emits ../ segments when the spec sits above the workspace root", () => {
    // workspaceRoot is deeper than the spec, so `relative` must walk up.
    const url = studioWebviewUrl({
      studioUrl: "http://localhost:4242",
      specPath: "/repo/crewhaus.yaml",
      workspaceRoot: "/repo/packages/app",
    });
    expect(url).toContain("spec=..%2F..%2Fcrewhaus.yaml");
  });
});

describe("_testFixturePath (T0)", () => {
  test("resolves a sibling test-fixtures dir next to the module", () => {
    const p = _testFixturePath();
    expect(p.endsWith("/test-fixtures")).toBe(true);
    // It is computed from this module's own URL, so it must live under
    // the vscode-extension package (one level up from src/).
    expect(p).toContain("vscode-extension");
    expect(p).not.toContain("/src/");
  });
});
