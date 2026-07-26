/**
 * E53 — per-sample eval drill-down + annotation round-trip.
 *
 * A tmpdir stands in for a harness: `<root>/.crewhaus/evals/<runId>/…` is laid
 * out exactly as `crewhaus eval` writes it, so the endpoints are exercised
 * against the REAL artifact contract rather than a convenient fixture shape.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvalAnnotationError,
  annotateSample,
  clipAnnotationText,
  harnessRootForEvals,
  isSafeArtifactId,
  readEvalRun,
  readSampleDetail,
  resolveEvalRoot,
  reviewEntryIdFor,
} from "./eval-drilldown.js";
import { startStudioServer } from "./index.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const SESSION_ID = "sess_0123456789abcdef";

/**
 * A harness root with one persisted eval run. `workspaceDir` is
 * `<root>/specs`, so the eval root resolves through the workspace's PARENT —
 * the same probe order `/api/evals` uses.
 */
function scaffoldRun(runId = "run_abc123"): { root: string; workspaceDir: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), "studio-eval-drill-"));
  roots.push(root);
  const workspaceDir = join(root, "specs");
  mkdirSync(workspaceDir, { recursive: true });
  const runDir = join(root, ".crewhaus", "evals", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "results.json"),
    JSON.stringify({
      runId,
      aggregates: { total: 2, passed: 1, passRate: 0.5, meanScore: 0.55 },
      samples: [
        { sampleId: "s0", passed: true, grades: { overall: { passed: true, score: 1 } } },
        { sampleId: "s1", passed: false, grades: { overall: { passed: false, score: 0.1 } } },
      ],
    }),
  );
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, concurrency: 4 }));
  for (const [sampleId, score] of [
    ["s0", 1],
    ["s1", 0.1],
  ] as const) {
    const sampleDir = join(runDir, sampleId);
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(
      join(sampleDir, "grades.json"),
      JSON.stringify({
        overall: { passed: score === 1, score },
        perGrader: [
          {
            name: "gold",
            passed: score === 1,
            score,
            rationale: score === 1 ? "matched" : "no source cited",
          },
        ],
      }),
    );
    writeFileSync(
      join(sampleDir, "meta.json"),
      JSON.stringify({
        sampleId,
        sessionId: SESSION_ID,
        latencyMs: 1200,
        turns: 1,
        model: "claude-sonnet-4-6",
      }),
    );
    writeFileSync(
      join(sampleDir, "transcript.jsonl"),
      `${JSON.stringify({ kind: "user_message", payload: { content: "q" } })}\n${JSON.stringify({ kind: "assistant_message", payload: { content: [{ type: "text", text: "a" }] } })}\n`,
    );
    writeFileSync(
      join(sampleDir, "events.jsonl"),
      `${JSON.stringify({ kind: "turn_start" })}\n(torn line\n`,
    );
  }
  return { root, workspaceDir, runId };
}

describe("path safety", () => {
  test("rejects traversal and separators in run/sample ids", () => {
    expect(isSafeArtifactId("run_abc123")).toBe(true);
    expect(isSafeArtifactId("sample.1-b_c")).toBe(true);
    expect(isSafeArtifactId("..")).toBe(false);
    expect(isSafeArtifactId("../etc")).toBe(false);
    expect(isSafeArtifactId("a/b")).toBe(false);
    expect(isSafeArtifactId("a\\b")).toBe(false);
    expect(isSafeArtifactId("")).toBe(false);
  });

  test("a traversing id reads as absent, never as a file outside the run dir", () => {
    const { root, workspaceDir } = scaffoldRun();
    writeFileSync(join(root, ".crewhaus", "secret.json"), '{"nope":true}');
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    expect(readEvalRun(evalRoot, "../..")).toBeUndefined();
    expect(readSampleDetail(evalRoot, "run_abc123", "../../secret")).toBeUndefined();
  });
});

describe("readEvalRun / readSampleDetail", () => {
  test("resolves the eval root through the workspace's parent", () => {
    const { root, workspaceDir } = scaffoldRun();
    expect(resolveEvalRoot(workspaceDir)).toBe(join(root, ".crewhaus", "evals"));
    expect(harnessRootForEvals(join(root, ".crewhaus", "evals"))).toBe(root);
  });

  test("a workspace with no eval runs resolves to undefined (empty state, not an error)", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-eval-empty-"));
    roots.push(root);
    expect(resolveEvalRoot(join(root, "specs"))).toBeUndefined();
  });

  test("run detail carries aggregates, run.json, and the per-sample index", () => {
    const { workspaceDir, runId } = scaffoldRun();
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    const detail = readEvalRun(evalRoot, runId);
    expect(detail?.samples.map((s) => s.sampleId)).toEqual(["s0", "s1"]);
    expect(detail?.samples[1]?.passed).toBe(false);
    expect(detail?.samples[1]?.score).toBe(0.1);
    expect(detail?.samples.every((s) => s.hasArtifacts)).toBe(true);
    expect((detail?.run as { concurrency?: number }).concurrency).toBe(4);
  });

  test("a sample dir results.json never mentioned still appears (crashed/resumed run)", () => {
    const { root, workspaceDir, runId } = scaffoldRun();
    mkdirSync(join(root, ".crewhaus", "evals", runId, "s2"), { recursive: true });
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    const detail = readEvalRun(evalRoot, runId);
    expect(detail?.samples.map((s) => s.sampleId)).toEqual(["s0", "s1", "s2"]);
    expect(detail?.samples[2]?.hasArtifacts).toBe(true);
  });

  test("sample detail serves grader rationale, meta and the transcript; a torn JSONL line is skipped", () => {
    const { workspaceDir, runId } = scaffoldRun();
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    const detail = readSampleDetail(evalRoot, runId, "s1");
    const grades = detail?.grades as { perGrader?: Array<{ rationale?: string }> };
    expect(grades.perGrader?.[0]?.rationale).toBe("no source cited");
    expect((detail?.meta as { model?: string }).model).toBe("claude-sonnet-4-6");
    expect(detail?.transcript).toHaveLength(2);
    // The torn events line is dropped, the good one survives.
    expect(detail?.events).toHaveLength(1);
  });

  test("an unknown run or sample reads as absent", () => {
    const { workspaceDir, runId } = scaffoldRun();
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    expect(readEvalRun(evalRoot, "run_nope")).toBeUndefined();
    expect(readSampleDetail(evalRoot, runId, "s9")).toBeUndefined();
  });
});

describe("annotateSample", () => {
  // NOTE: this pins the record SHAPE against the FeedbackRecord contract, not
  // a distill round-trip — see eval-drilldown.ts's module docs: an eval
  // sample's session log lives under the run dir, so `crewhaus distill`'s
  // (sessionId, turnNumber) join finds no turn for these records today.
  test("writes a contract-shaped FeedbackRecord and enqueues a needs_review item", () => {
    const { root, workspaceDir, runId } = scaffoldRun();
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    const result = annotateSample(
      evalRoot,
      {
        runId,
        sampleId: "s1",
        verdict: "fail",
        comment: "the answer cites nothing",
        correction: "Paris is the capital of France [source].",
        rater: "max",
        adjudicate: true,
      },
      () => new Date("2026-07-26T10:00:00.000Z"),
    );

    // 1 — the append-only feedback sink (the verdict's durable carrier).
    expect(result.feedbackPath).toBe(join(root, ".crewhaus", "feedback", "studio.jsonl"));
    const fb = JSON.parse(readFileSync(result.feedbackPath, "utf8").trim()) as Record<
      string,
      unknown
    >;
    expect(fb["schemaVersion"]).toBe(1);
    expect(fb["sessionId"]).toBe(SESSION_ID);
    expect(fb["runId"]).toBe(runId);
    expect(fb["turnNumber"]).toBe(1);
    expect(fb["modality"]).toBe("binary");
    expect(fb["rating"]).toEqual({ thumbs: "down" });
    expect(fb["correction"]).toBe("Paris is the capital of France [source].");
    expect(fb["source"]).toBe("ui");
    expect(fb["rater"]).toBe("max");
    expect(fb["adjudication"]).toBe(true);
    expect(fb["ts"]).toBe("2026-07-26T10:00:00.000Z");

    // 2 — the Wave-3 review queue, with the deterministic id.
    expect(result.reviewPath).toBe(join(root, ".crewhaus", "review", "queue.jsonl"));
    const rev = JSON.parse(readFileSync(result.reviewPath, "utf8").trim()) as Record<
      string,
      unknown
    >;
    expect(rev["id"]).toBe(reviewEntryIdFor(runId, "s1"));
    expect(rev["id"]).toBe("rev_needs_review_run_abc123_s1");
    expect(rev["kind"]).toBe("needs_review");
    expect(rev["status"]).toBe("open");
    expect(rev["sourceRef"]).toEqual({ runId, sampleId: "s1" });
    expect(result.reviewAdded).toBe(true);
  });

  test("a second vote appends another feedback line but does NOT duplicate the queue item", () => {
    const { workspaceDir, runId } = scaffoldRun();
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    const first = annotateSample(evalRoot, { runId, sampleId: "s1", verdict: "fail" });
    const second = annotateSample(evalRoot, { runId, sampleId: "s1", verdict: "pass" });
    expect(second.reviewAdded).toBe(false);
    const feedbackLines = readFileSync(first.feedbackPath, "utf8").trim().split("\n");
    expect(feedbackLines).toHaveLength(2);
    const reviewLines = readFileSync(first.reviewPath, "utf8").trim().split("\n");
    expect(reviewLines).toHaveLength(1);
  });

  test("refuses a sample with no usable sessionId rather than minting a synthetic one", () => {
    const { root, workspaceDir, runId } = scaffoldRun();
    writeFileSync(
      join(root, ".crewhaus", "evals", runId, "s0", "meta.json"),
      JSON.stringify({ sampleId: "s0" }),
    );
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    expect(() => annotateSample(evalRoot, { runId, sampleId: "s0", verdict: "pass" })).toThrow(
      EvalAnnotationError,
    );
    expect(existsSync(join(root, ".crewhaus", "feedback", "studio.jsonl"))).toBe(false);
  });

  test("refuses to write the sinks outside the caller's allowed harness roots", () => {
    const { root, workspaceDir, runId } = scaffoldRun();
    const evalRoot = resolveEvalRoot(workspaceDir) as string;
    // The harness root here is `root` (the workspace's PARENT — the probe order
    // finds the repo-root .crewhaus first). A caller that only allows the
    // workspace itself must be refused, and nothing may be written.
    expect(() =>
      annotateSample(evalRoot, { runId, sampleId: "s1", verdict: "pass" }, undefined, {
        allowedRoots: [workspaceDir],
      }),
    ).toThrow(EvalAnnotationError);
    expect(existsSync(join(root, ".crewhaus", "feedback", "studio.jsonl"))).toBe(false);
    expect(existsSync(join(root, ".crewhaus", "review", "queue.jsonl"))).toBe(false);

    // The allow-list the server actually passes (both probe roots) admits it.
    const ok = annotateSample(evalRoot, { runId, sampleId: "s1", verdict: "pass" }, undefined, {
      allowedRoots: [root, workspaceDir],
    });
    expect(ok.feedbackPath).toBe(join(root, ".crewhaus", "feedback", "studio.jsonl"));
  });

  test("free text is control-char stripped and bounded", () => {
    const raw = `a${String.fromCodePoint(0)}b\n${"x".repeat(10_000)}`;
    const clipped = clipAnnotationText(raw);
    expect(clipped.startsWith("ab\n")).toBe(true);
    expect(clipped.length).toBeLessThanOrEqual(8192);
  });
});

describe("HTTP endpoints", () => {
  test("run detail, sample drill-down and the annotation round-trip", async () => {
    const { root, workspaceDir, runId } = scaffoldRun();
    const server = await startStudioServer({
      workspaceDir,
      pluginRoot: join(root, "plugins"),
    });
    try {
      const base = `http://localhost:${server.port}`;

      const runRes = await fetch(`${base}/api/evals/${runId}`);
      expect(runRes.status).toBe(200);
      const runBody = (await runRes.json()) as { samples: Array<{ sampleId: string }> };
      expect(runBody.samples.map((s) => s.sampleId)).toEqual(["s0", "s1"]);

      const sampleRes = await fetch(`${base}/api/evals/${runId}/s1`);
      expect(sampleRes.status).toBe(200);
      const sampleBody = (await sampleRes.json()) as {
        grades: { perGrader: Array<{ rationale: string }> };
        transcript: unknown[];
      };
      expect(sampleBody.grades.perGrader[0]?.rationale).toBe("no source cited");
      expect(sampleBody.transcript).toHaveLength(2);

      const missing = await fetch(`${base}/api/evals/run_nope`);
      expect(missing.status).toBe(404);

      const badVerdict = await fetch(`${base}/api/evals/${runId}/s1/annotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: "maybe" }),
      });
      expect(badVerdict.status).toBe(400);

      const annotated = await fetch(`${base}/api/evals/${runId}/s1/annotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: "fail", comment: "cites nothing", rater: "max" }),
      });
      expect(annotated.status).toBe(201);
      const body = (await annotated.json()) as { reviewAdded: boolean; feedbackPath: string };
      expect(body.reviewAdded).toBe(true);

      // The queue file the CLI's `crewhaus review list` reads.
      const queue = readFileSync(join(root, ".crewhaus", "review", "queue.jsonl"), "utf8");
      expect(queue).toContain("rev_needs_review_run_abc123_s1");
      // And the feedback sink `crewhaus distill` reads.
      const feedback = readFileSync(join(root, ".crewhaus", "feedback", "studio.jsonl"), "utf8");
      expect(feedback).toContain(SESSION_ID);
    } finally {
      await server.stop();
    }
  });

  test("a workspace with no eval runs 404s the detail endpoints instead of 500ing", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-eval-none-"));
    roots.push(root);
    const workspaceDir = join(root, "specs");
    mkdirSync(workspaceDir, { recursive: true });
    const server = await startStudioServer({ workspaceDir, pluginRoot: join(root, "plugins") });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/evals/run_x`);
      expect(r.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
