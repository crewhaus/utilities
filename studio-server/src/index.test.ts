import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioServerError, startStudioServer } from "./index.js";

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "studio-server-"));
}

describe("studio-server (T3 — endpoint contract)", () => {
  test("GET /healthz returns ok", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const r = await fetch(`http://localhost:${server.port}/healthz`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("ok");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET /api/templates returns the scaffold-templates list", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/templates`);
      const body = (await r.json()) as { templates: Array<{ id: string; target: string }> };
      expect(body.templates.length).toBe(10);
      expect(body.templates.some((t) => t.target === "cli")).toBe(true);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/specs validates YAML and writes to workspace", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const yaml =
        "name: t1\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: be brief\n";
      const create = await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "t1", yaml }),
      });
      expect(create.status).toBe(201);
      const list = await fetch(`http://localhost:${server.port}/api/specs`).then(
        (r) => r.json() as Promise<{ specs: Array<{ name: string; target: string }> }>,
      );
      expect(list.specs).toEqual([{ name: "t1", target: "cli" }]);
      const get = await fetch(`http://localhost:${server.port}/api/specs/t1`).then(
        (r) => r.json() as Promise<{ name: string; yaml: string }>,
      );
      expect(get.name).toBe("t1");
      expect(get.yaml).toContain("target: cli");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/specs rejects invalid YAML with 400", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "bad", yaml: "this is not valid yaml: {[" }),
      });
      expect(r.status).toBe(400);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/runs + GET /api/runs/:id/events streams SSE events including run_start, trace, and a `done` event", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      // Create a spec.
      const yaml =
        "name: r1\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: hi\n";
      await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "r1", yaml }),
      });
      const runResp = await fetch(`http://localhost:${server.port}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specName: "r1", prompt: "test" }),
      });
      const { runId } = (await runResp.json()) as { runId: string };
      expect(runId).toMatch(/^run_/);

      const sse = await fetch(`http://localhost:${server.port}/api/runs/${runId}/events`);
      expect(sse.headers.get("content-type")).toBe("text/event-stream");
      const text = await sse.text();
      expect(text).toContain("run_start");
      expect(text).toContain("event: done");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET /api/graph-layout/:name returns nodes + edges for a graph spec", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const yaml =
        "name: g\ntarget: graph\nmodel: claude-sonnet-4-6\nentry: a\nnodes:\n  a:\n    instructions: a\n  b:\n    instructions: b\nedges:\n  - { from: a, to: b }\n";
      const create = await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "g", yaml }),
      });
      expect(create.status).toBe(201);
      const lay = await fetch(`http://localhost:${server.port}/api/graph-layout/g`).then(
        (r) => r.json() as Promise<{ nodes: Array<{ id: string }>; edges: unknown[] }>,
      );
      expect(lay.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
      expect(lay.edges).toHaveLength(1);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/wizard/start → step → compile produces a valid YAML spec", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const start = await fetch(`http://localhost:${server.port}/api/wizard/start`, {
        method: "POST",
      }).then((r) => r.json() as Promise<{ state: unknown }>);
      let state = start.state;
      const answer = async (a: unknown) => {
        const r = await fetch(`http://localhost:${server.port}/api/wizard/step`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state, answer: a }),
        }).then((r) => r.json() as Promise<{ state: unknown }>);
        state = r.state;
      };
      await answer({ question: "target", value: "cli" });
      await answer({ question: "name", value: "wiz-out" });
      await answer({ question: "model", value: "claude-sonnet-4-6" });
      await answer({ question: "tools", value: ["read", "bash"] });
      await answer({ question: "permissionMode", value: "default" });
      const compiled = await fetch(`http://localhost:${server.port}/api/wizard/compile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      }).then((r) => r.json() as Promise<{ yaml: string; envExample: string }>);
      expect(compiled.yaml).toContain("name: wiz-out");
      expect(compiled.yaml).toContain("- read");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET /api/plugins lists discovered plugins (T3 + T8 sandbox)", async () => {
    const root = newRoot();
    const pluginRoot = join(root, "plugins");
    const fixtureDir = join(pluginRoot, "fixture");
    await import("node:fs").then((fs) => {
      fs.mkdirSync(fixtureDir, { recursive: true });
      // Fixture plugin without external imports — discoverPlugins
      // takes the default export verbatim. Real plugins use
      // `definePlugin` from @crewhaus/studio-plugin-sdk; tests skip that
      // import so the workspace-resolution doesn't reach a tmpdir.
      fs.writeFileSync(
        join(fixtureDir, "index.ts"),
        `export default {
  name: "fixture",
  version: "0.0.1",
  description: "Hello from plugin",
  panes: [{ id: "main", title: "Hello", html: "<div>Hello from plugin</div>" }],
};`,
      );
    });
    const server = await startStudioServer({ workspaceDir: root, pluginRoot });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/plugins`).then(
        (r) => r.json() as Promise<{ plugins: Array<{ name: string; panes: unknown[] }> }>,
      );
      expect(r.plugins.length).toBe(1);
      expect(r.plugins[0]?.name).toBe("fixture");
      expect(r.plugins[0]?.panes).toHaveLength(1);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GET /api/specs returns specs sorted by name (exercises the listSpecs comparator)", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const mk = (name: string) =>
        fetch(`http://localhost:${server.port}/api/specs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            yaml: `name: ${name}\ntarget: cli\nagent:\n  model: m\n  instructions: i\n`,
          }),
        });
      // Create out of alphabetical order so the comparator has to reorder.
      expect((await mk("zeta")).status).toBe(201);
      expect((await mk("alpha")).status).toBe(201);
      expect((await mk("mid")).status).toBe(201);
      const list = await fetch(`http://localhost:${server.port}/api/specs`).then(
        (r) => r.json() as Promise<{ specs: Array<{ name: string; target: string }> }>,
      );
      expect(list.specs.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("DELETE /api/specs/:name removes the spec", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const yaml = "name: del-me\ntarget: cli\nagent:\n  model: m\n  instructions: i\n";
      await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "del-me", yaml }),
      });
      const del = await fetch(`http://localhost:${server.port}/api/specs/del-me`, {
        method: "DELETE",
      });
      expect(del.status).toBe(200);
      const list = await fetch(`http://localhost:${server.port}/api/specs`).then(
        (r) => r.json() as Promise<{ specs: unknown[] }>,
      );
      expect(list.specs).toEqual([]);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("studio-server v1 — Section 31 endpoints", () => {
  test("runDispatcher injection routes through caller's runtime", async () => {
    const root = newRoot();
    const dispatched: Array<{ specName: string; prompt: string }> = [];
    const server = await startStudioServer({
      port: 0,
      workspaceDir: join(root, "specs"),
      runDispatcher: async ({ specName, prompt, publish, finish }) => {
        dispatched.push({ specName, prompt });
        publish({ kind: "custom_event", who: "test" });
        finish("dispatched-final-text");
      },
    });
    try {
      const yaml = "name: test\ntarget: cli\nagent:\n  model: m\n  instructions: i\n";
      await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test", yaml }),
      });
      const runRes = await fetch(`http://localhost:${server.port}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specName: "test", prompt: "hi" }),
      });
      const { runId } = (await runRes.json()) as { runId: string };
      await new Promise((r) => setTimeout(r, 50));
      expect(dispatched.length).toBe(1);
      expect(dispatched[0]?.prompt).toBe("hi");
      const events = await fetch(`http://localhost:${server.port}/api/runs/${runId}/events`);
      const text = await events.text();
      expect(text).toContain("custom_event");
      expect(text).toContain("dispatched-final-text");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("/api/runs/:runId/cancel signals the dispatcher's abort", async () => {
    const root = newRoot();
    let signalSeen: AbortSignal | undefined;
    const server = await startStudioServer({
      port: 0,
      workspaceDir: join(root, "specs"),
      runDispatcher: async ({ signal, finish }) => {
        signalSeen = signal;
        await new Promise((r) => setTimeout(r, 100));
        finish("done");
      },
    });
    try {
      const yaml = "name: test\ntarget: cli\nagent:\n  model: m\n  instructions: i\n";
      await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test", yaml }),
      });
      const runRes = await fetch(`http://localhost:${server.port}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specName: "test", prompt: "hi" }),
      });
      const { runId } = (await runRes.json()) as { runId: string };
      await new Promise((r) => setTimeout(r, 10));
      const cancelRes = await fetch(`http://localhost:${server.port}/api/runs/${runId}/cancel`, {
        method: "POST",
      });
      expect(cancelRes.status).toBe(200);
      expect(signalSeen?.aborted).toBe(true);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("/api/cost-summary returns the source's payload", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      port: 0,
      workspaceDir: join(root, "specs"),
      costSummarySource: async () => ({
        totalUsdMicros: 12_345,
        byProvider: { anthropic: 12_345 },
      }),
    });
    try {
      const res = await fetch(
        `http://localhost:${server.port}/api/cost-summary?tenant=t1&from=0&to=999`,
      );
      const body = (await res.json()) as { totalUsdMicros: number };
      expect(body.totalUsdMicros).toBe(12_345);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("/api/cost-summary without source returns zeros + note", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      port: 0,
      workspaceDir: join(root, "specs"),
    });
    try {
      const res = await fetch(`http://localhost:${server.port}/api/cost-summary`);
      const body = (await res.json()) as {
        totalUsdMicros: number;
        note?: string;
      };
      expect(body.totalUsdMicros).toBe(0);
      expect(body.note).toContain("no costSummarySource");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("/api/runs/:runId/replay uses replaySource when provided", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      port: 0,
      workspaceDir: join(root, "specs"),
      replaySource: async (runId) => {
        if (runId === "run_abc1234567") {
          return [
            { kind: "run_start", specName: "x", prompt: "y" },
            { kind: "trace", subkind: "model_request" },
          ];
        }
        return undefined;
      },
    });
    try {
      const res = await fetch(`http://localhost:${server.port}/api/runs/run_abc1234567/replay`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("run_start");
      expect(text).toContain("event: done");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("/api/runs/:runId/hitl pushes a hitl_decision event", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      port: 0,
      workspaceDir: join(root, "specs"),
    });
    try {
      const yaml = "name: test\ntarget: cli\nagent:\n  model: m\n  instructions: i\n";
      await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test", yaml }),
      });
      const runRes = await fetch(`http://localhost:${server.port}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specName: "test", prompt: "hi" }),
      });
      const { runId } = (await runRes.json()) as { runId: string };
      await new Promise((r) => setTimeout(r, 50));
      const hitlRes = await fetch(
        `http://localhost:${server.port}/api/runs/${runId}/hitl?nodeId=n1&decision=approve`,
        { method: "POST" },
      );
      expect(hitlRes.status).toBe(200);
      const events = await fetch(`http://localhost:${server.port}/api/runs/${runId}/events`);
      const text = await events.text();
      expect(text).toContain("hitl_decision");
      expect(text).toContain("approve");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("studio-server — grader builder endpoints", () => {
  const EVAL_YAML =
    "name: e1\ntarget: eval\nagent:\n  model: claude-sonnet-4-6\n  instructions: answer briefly\ndataset:\n  path: ./data.jsonl\ngraders: []\n";

  // Drive the full state machine over HTTP and return the final state.
  async function buildState(port: number, answers: ReadonlyArray<unknown>): Promise<unknown> {
    const start = await fetch(`http://localhost:${port}/api/grader-wizard/start`, {
      method: "POST",
    }).then((r) => r.json() as Promise<{ state: unknown }>);
    let state = start.state;
    for (const answer of answers) {
      const r = await fetch(`http://localhost:${port}/api/grader-wizard/step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, answer }),
      });
      expect(r.status).toBe(200);
      state = ((await r.json()) as { state: unknown }).state;
    }
    return state;
  }

  const LLM_JUDGE_ANSWERS: ReadonlyArray<unknown> = [
    { question: "kind", value: "llm-judge" },
    { question: "id", value: "helpfulness" },
    { question: "rubric", value: "Be polite and cite a source." },
    { question: "judgeModel", value: "claude-sonnet-4-6" },
    { question: "threshold", value: 0.7 },
    { question: "weight", value: undefined },
  ];

  test("POST /api/grader-wizard/start → step → compile produces grader YAML", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const state = await buildState(server.port, LLM_JUDGE_ANSWERS);
      const compiled = await fetch(`http://localhost:${server.port}/api/grader-wizard/compile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      }).then((r) => r.json() as Promise<{ grader: { id: string }; yamlBlock: string }>);
      expect(compiled.grader.id).toBe("helpfulness");
      expect(compiled.yamlBlock).toContain("graders:");
      expect(compiled.yamlBlock).toContain("kind: llm-judge");
      expect(compiled.yamlBlock).toContain("threshold: 0.7");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/grader-wizard/step rejects invalid answers with 400 + message", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const start = await fetch(`http://localhost:${server.port}/api/grader-wizard/start`, {
        method: "POST",
      }).then((r) => r.json() as Promise<{ state: unknown }>);
      const r = await fetch(`http://localhost:${server.port}/api/grader-wizard/step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: start.state,
          answer: { question: "kind", value: "vibes" },
        }),
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string };
      expect(body.error).toContain("unknown grader kind");
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/specs/:name/graders appends to an eval spec", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const create = await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "e1", yaml: EVAL_YAML }),
      });
      expect(create.status).toBe(201);
      const state = await buildState(server.port, LLM_JUDGE_ANSWERS);
      const append = await fetch(`http://localhost:${server.port}/api/specs/e1/graders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      });
      expect(append.status).toBe(200);
      const body = (await append.json()) as { graderId: string; yaml: string };
      expect(body.graderId).toBe("helpfulness");
      expect(body.yaml).toContain("kind: llm-judge");
      // Round-trip: the stored spec now contains the grader and still parses.
      const get = await fetch(`http://localhost:${server.port}/api/specs/e1`).then(
        (r) => r.json() as Promise<{ yaml: string; parsed: { graders: Array<{ id: string }> } }>,
      );
      expect(get.yaml).toContain("- id: helpfulness");
      expect(get.parsed.graders.map((g) => g.id)).toEqual(["helpfulness"]);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("POST /api/specs/:name/graders → 404 unknown spec, 400 non-eval, 409 duplicate id, 400 incomplete state", async () => {
    const root = newRoot();
    const server = await startStudioServer({
      workspaceDir: root,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const state = await buildState(server.port, LLM_JUDGE_ANSWERS);
      const post = (name: string, body: unknown) =>
        fetch(`http://localhost:${server.port}/api/specs/${name}/graders`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      expect((await post("missing", { state })).status).toBe(404);

      await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "cli-spec",
          yaml: "name: cli-spec\ntarget: cli\nagent:\n  model: m\n  instructions: i\n",
        }),
      });
      const nonEval = await post("cli-spec", { state });
      expect(nonEval.status).toBe(400);
      expect(((await nonEval.json()) as { error: string }).error).toContain("not an eval target");

      await fetch(`http://localhost:${server.port}/api/specs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "e2", yaml: EVAL_YAML.replace("name: e1", "name: e2") }),
      });
      expect((await post("e2", { state })).status).toBe(200);
      expect((await post("e2", { state })).status).toBe(409);

      const incompleteState = await buildState(server.port, [
        { question: "kind", value: "exact-match" },
      ]);
      expect((await post("e2", { state: incompleteState })).status).toBe(400);
      expect((await post("e2", {})).status).toBe(400);
    } finally {
      await server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("StudioServerError", () => {
  test("constructs with the config code, message, and no cause", () => {
    const err = new StudioServerError("unsafe spec name: ../etc");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(StudioServerError);
    expect(err.name).toBe("StudioServerError");
    expect(err.message).toBe("unsafe spec name: ../etc");
    expect(err.code).toBe("config");
    expect(err.cause).toBeUndefined();
  });

  test("threads a cause through to the CrewhausError chain", () => {
    const cause = new Error("root cause");
    const err = new StudioServerError("write failed", cause);
    expect(err.cause).toBe(cause);
    expect(err.code).toBe("config");
    // toJSON (inherited from CrewhausError) serializes the cause chain.
    expect(err.toJSON()).toEqual({
      name: "StudioServerError",
      code: "config",
      message: "write failed",
      cause: { name: "Error", message: "root cause" },
    });
  });
});
