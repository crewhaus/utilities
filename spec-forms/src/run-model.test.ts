import { describe, expect, test } from "bun:test";
import {
  createRunReducer,
  foldRunEvent,
  INITIAL_RUN_STATE,
  type RunState,
} from "./run-model";
import type { TraceStreamEvent } from "./trace-stream";

// Fully offline + deterministic: every test folds a hand-built array of merged
// TraceStreamEvents (exactly what ./trace-stream.ts yields) with the pure
// reducer and asserts the resulting RunState. No fetch, no DOM, no timers.

const trace = (event: Record<string, unknown>): TraceStreamEvent => ({ kind: "trace", event });
const text = (t: string): TraceStreamEvent => ({ kind: "text", text: t });
const done = (t: string, stopReason = "end_turn"): TraceStreamEvent => ({
  kind: "done",
  text: t,
  stopReason,
});
const errorEv = (message: string): TraceStreamEvent => ({ kind: "error", message });

/** Fold a whole sequence from the zero state (the canonical drive path). */
function foldAll(events: readonly TraceStreamEvent[]): RunState {
  const { initial, fold } = createRunReducer();
  return events.reduce(fold, initial);
}

// The realistic cf-worker cost_accrual for an unpriced call (its live shape:
// costUsdMicros 0 + unpriced true, carrying the real token counts).
const unpricedCost = (model: string, input: number, output: number) =>
  trace({
    kind: "cost_accrual",
    provider: "anthropic",
    modelId: model,
    inputTokens: input,
    outputTokens: output,
    cachedReadTokens: 0,
    costUsdMicros: 0,
    unpriced: true,
  });

const modelResponse = (model: string, input: number, output: number, extra: Record<string, unknown> = {}) =>
  trace({
    kind: "model_response",
    model,
    usage: { input, output, cacheRead: 0, cacheCreate: 0 },
    stopReason: "end_turn",
    durationMs: 1000,
    ...extra,
  });

describe("run-model — zero state", () => {
  test("INITIAL_RUN_STATE and createRunReducer().initial are the documented zero", () => {
    const zero: RunState = {
      activeSegment: null,
      activeNode: null,
      nodes: [],
      costMicros: 0,
      unpriced: false,
      tokensIn: 0,
      tokensOut: 0,
      cacheTokens: 0,
      approvals: [],
      transcript: "",
      turns: 0,
      toolCalls: 0,
      errors: 0,
      done: false,
      stopReason: null,
      failure: null,
    };
    expect(INITIAL_RUN_STATE).toEqual(zero);
    expect(createRunReducer().initial).toEqual(zero);
  });
});

describe("run-model — cli run (ring shape)", () => {
  // The base cf-worker-cli /chat sequence: streamed text deltas, then a
  // model_response + cost_accrual trace pair, then done.
  const events: TraceStreamEvent[] = [
    trace({ kind: "turn_start", turn: 1, messageCount: 2 }),
    text("Hel"),
    text("lo"),
    modelResponse("claude-sonnet-4-6", 120, 40),
    unpricedCost("claude-sonnet-4-6", 120, 40),
    done("Hello"),
  ];

  test("accumulates transcript, reason highlight, tokens, cost, and terminal state", () => {
    const s = foldAll(events);
    expect(s.transcript).toBe("Hello");
    expect(s.activeSegment).toBe("reason"); // model_response was the last attributing frame
    expect(s.activeNode).toBeNull(); // ring shape — no canvas
    expect(s.nodes).toEqual([]);
    expect(s.tokensIn).toBe(120);
    expect(s.tokensOut).toBe(40);
    expect(s.cacheTokens).toBe(0);
    expect(s.turns).toBe(1);
    expect(s.done).toBe(true);
    expect(s.stopReason).toBe("end_turn");
    // Unpriced accrual: cost is a floor (0 here) and the flag latches.
    expect(s.costMicros).toBe(0);
    expect(s.unpriced).toBe(true);
  });

  test("a priced accrual sums microdollars and leaves unpriced false", () => {
    const s = foldAll([
      modelResponse("claude-sonnet-4-6", 100, 50),
      trace({ kind: "cost_accrual", modelId: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 50, costUsdMicros: 4200 }),
      trace({ kind: "cost_accrual", modelId: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 5, costUsdMicros: 800 }),
    ]);
    expect(s.costMicros).toBe(5000);
    expect(s.unpriced).toBe(false);
  });

  test("cache read/write tokens fold into cacheTokens", () => {
    const s = foldAll([
      modelResponse("m", 10, 5, { usage: { input: 10, output: 5, cacheRead: 300, cacheCreate: 200 } }),
    ]);
    expect(s.cacheTokens).toBe(500);
    expect(s.tokensIn).toBe(10);
    expect(s.tokensOut).toBe(5);
  });
});

describe("run-model — workflow run (canvas shape)", () => {
  // Two steps, exactly as target-cf-worker-workflow emits them.
  const events: TraceStreamEvent[] = [
    trace({ kind: "step_start", name: "draft", step: 1, total: 2 }),
    modelResponse("claude-sonnet-4-6", 100, 30),
    unpricedCost("claude-sonnet-4-6", 100, 30),
    trace({ kind: "step_end", name: "draft", step: 1, durationMs: 1500 }),
    trace({ kind: "step_start", name: "review", step: 2, total: 2 }),
    modelResponse("claude-haiku-4-5", 60, 20),
    unpricedCost("claude-haiku-4-5", 60, 20),
    trace({ kind: "step_end", name: "review", step: 2, durationMs: 900 }),
    done("reviewed"),
  ];

  test("tracks each step's node status, position, total, and duration", () => {
    const s = foldAll(events);
    expect(s.nodes).toEqual([
      { id: "draft", status: "done", position: 1, total: 2, durationMs: 1500 },
      { id: "review", status: "done", position: 2, total: 2, durationMs: 900 },
    ]);
    expect(s.activeNode).toBeNull(); // both ended
    expect(s.tokensIn).toBe(160);
    expect(s.tokensOut).toBe(50);
    expect(s.done).toBe(true);
  });

  test("mid-run: the running step is active and is the current node", () => {
    // Fold only up to draft's step_start + its model_response.
    const s = foldAll(events.slice(0, 2));
    expect(s.activeNode).toBe("draft");
    expect(s.nodes).toEqual([{ id: "draft", status: "active", position: 1, total: 2 }]);
    expect(s.activeSegment).toBe("reason");
  });

  test("a step_start with no position/total records a bare active node", () => {
    const s = foldAll([trace({ kind: "step_start", name: "solo" })]);
    expect(s.nodes).toEqual([{ id: "solo", status: "active" }]);
    expect(s.activeNode).toBe("solo");
  });

  test("a re-started step resets to active and drops the prior duration (retry)", () => {
    const s = foldAll([
      trace({ kind: "step_start", name: "draft", step: 1, total: 1 }),
      trace({ kind: "step_end", name: "draft", step: 1, durationMs: 500 }),
      trace({ kind: "step_start", name: "draft", step: 1, total: 1 }), // retry
    ]);
    expect(s.nodes).toEqual([{ id: "draft", status: "active", position: 1, total: 1 }]);
    expect(s.activeNode).toBe("draft");
  });
});

describe("run-model — graph run (canvas shape)", () => {
  // target-cf-worker-graph uses `node` (not `step`) for the position index.
  const events: TraceStreamEvent[] = [
    trace({ kind: "node_start", name: "classify", node: 1, total: 3 }),
    modelResponse("m", 40, 10),
    trace({ kind: "node_end", name: "classify", node: 1, durationMs: 400 }),
    trace({ kind: "node_start", name: "route", node: 2, total: 3 }),
    trace({ kind: "tool_call_start", toolUseId: "t1", toolName: "webFetch", inputBytes: 12 }),
    trace({ kind: "tool_call_end", toolUseId: "t1", toolName: "webFetch", isError: false, outputBytes: 900, durationMs: 700 }),
  ];

  test("reads the graph `node` position field and tracks node lifecycle", () => {
    const s = foldAll(events);
    expect(s.nodes).toEqual([
      { id: "classify", status: "done", position: 1, total: 3, durationMs: 400 },
      { id: "route", status: "active", position: 2, total: 3 },
    ]);
    expect(s.activeNode).toBe("route");
    // A tool call was the last attributing frame -> act highlight.
    expect(s.activeSegment).toBe("act");
    expect(s.toolCalls).toBe(1);
  });

  test("a node_end for the current node clears activeNode; a stale end does not", () => {
    const s1 = foldAll([trace({ kind: "node_start", name: "a", node: 1 })]);
    expect(s1.activeNode).toBe("a");
    const s2 = foldRunEvent(s1, trace({ kind: "node_end", name: "a", node: 1, durationMs: 5 }));
    expect(s2.activeNode).toBeNull();
    // A different node starting, then an end for a NODE THAT NEVER STARTED,
    // leaves the current node untouched but still records the phantom as done.
    const s3 = foldRunEvent(s2, trace({ kind: "node_start", name: "b", node: 2 }));
    const s4 = foldRunEvent(s3, trace({ kind: "node_end", name: "ghost", node: 9, durationMs: 1 }));
    expect(s4.activeNode).toBe("b");
    expect(s4.nodes.find((n) => n.id === "ghost")).toEqual({ id: "ghost", status: "done", durationMs: 1 });
  });
});

describe("run-model — crew run (role frames share the canvas path)", () => {
  test("role_start/role_end map role -> node id and activation -> position", () => {
    const s = foldAll([
      trace({ kind: "role_start", role: "writer", activation: 0 }),
      trace({ kind: "role_end", role: "writer", activation: 0, finalMessageBytes: 200, durationMs: 300 }),
      trace({ kind: "role_start", role: "editor", activation: 1 }),
    ]);
    expect(s.nodes).toEqual([
      { id: "writer", status: "done", position: 0, durationMs: 300 },
      { id: "editor", status: "active", position: 1 },
    ]);
    expect(s.activeNode).toBe("editor");
  });
});

describe("run-model — approvals", () => {
  test("approval_requested parks a pending approval and lights the safety segment", () => {
    const s = foldAll([
      trace({ kind: "approval_requested", approvalId: "apr_1", toolName: "bash", surface: "single-turn" }),
    ]);
    expect(s.approvals).toEqual([{ approvalId: "apr_1", toolName: "bash", surface: "single-turn" }]);
    expect(s.activeSegment).toBe("safety");
  });

  test("approval_resolved removes the matching pending approval", () => {
    const s = foldAll([
      trace({ kind: "approval_requested", approvalId: "apr_1", toolName: "bash", surface: "daemon" }),
      trace({ kind: "approval_requested", approvalId: "apr_2", toolName: "webFetch", surface: "daemon" }),
      trace({ kind: "approval_resolved", approvalId: "apr_1", decision: "grant", by: "cli" }),
    ]);
    expect(s.approvals).toEqual([{ approvalId: "apr_2", toolName: "webFetch", surface: "daemon" }]);
  });

  test("a duplicate approval_requested is idempotent (keyed on approvalId)", () => {
    const s = foldAll([
      trace({ kind: "approval_requested", approvalId: "apr_1", toolName: "bash", surface: "daemon" }),
      trace({ kind: "approval_requested", approvalId: "apr_1", toolName: "bash", surface: "daemon" }),
    ]);
    expect(s.approvals).toHaveLength(1);
  });

  test("approval_resolved for an unknown id is a no-op (returns the same state ref)", () => {
    const before = foldAll([
      trace({ kind: "approval_requested", approvalId: "apr_1", toolName: "bash", surface: "daemon" }),
    ]);
    const after = foldRunEvent(before, trace({ kind: "approval_resolved", approvalId: "nope", decision: "deny", by: "x" }));
    expect(after).toBe(before);
  });
});

describe("run-model — highlight mapping", () => {
  test("model_request -> reason, tool_call_start -> act (the contract's named pair)", () => {
    const reason = foldAll([trace({ kind: "model_request", model: "m", messageCount: 1, toolCount: 0, streaming: true })]);
    expect(reason.activeSegment).toBe("reason");
    const act = foldAll([trace({ kind: "tool_call_start", toolUseId: "t", toolName: "read", inputBytes: 4 })]);
    expect(act.activeSegment).toBe("act");
  });

  test("evaluate / update / safety kinds each light their segment", () => {
    expect(foldAll([trace({ kind: "test_verdict", testId: "t", verdict: "pass", durationMs: 1 })]).activeSegment).toBe("evaluate");
    expect(foldAll([trace({ kind: "compaction_fired", subKind: "auto", before: 9, after: 3, phase: "x" })]).activeSegment).toBe("update");
    expect(foldAll([trace({ kind: "permission_decision", toolName: "bash", decision: "ask", mode: "default" })]).activeSegment).toBe("safety");
  });

  test("an unmapped/feed-only kind leaves the highlight unchanged", () => {
    const s = foldAll([
      trace({ kind: "tool_call_start", toolUseId: "t", toolName: "read", inputBytes: 4 }), // -> act
      trace({ kind: "turn_end", turn: 1, stopReason: "end_turn", durationMs: 5 }), // unmapped
    ]);
    expect(s.activeSegment).toBe("act");
  });
});

describe("run-model — counters and failures", () => {
  test("turn_start / tool_call_start increment their counters", () => {
    const s = foldAll([
      trace({ kind: "turn_start", turn: 1, messageCount: 1 }),
      trace({ kind: "tool_call_start", toolUseId: "a", toolName: "read", inputBytes: 1 }),
      trace({ kind: "tool_call_start", toolUseId: "b", toolName: "bash", inputBytes: 1 }),
    ]);
    expect(s.turns).toBe(1);
    expect(s.toolCalls).toBe(2);
  });

  test("a failed tool_call_end increments errors; a clean one does not", () => {
    const s = foldAll([
      trace({ kind: "tool_call_end", toolUseId: "a", toolName: "bash", isError: true, outputBytes: 10, durationMs: 3 }),
      trace({ kind: "tool_call_end", toolUseId: "b", toolName: "read", isError: false, outputBytes: 10, durationMs: 3 }),
    ]);
    expect(s.errors).toBe(1);
  });

  test("run_failed marks the run done with an error and the failure message", () => {
    const s = foldAll([trace({ kind: "run_failed", class: "billing", message: "insufficient funds" })]);
    expect(s.errors).toBe(1);
    expect(s.done).toBe(true);
    expect(s.failure).toBe("insufficient funds");
  });

  test("a stream error frame marks the run done + errored with its message", () => {
    const s = foldAll([text("partial"), errorEv("connection reset")]);
    expect(s.done).toBe(true);
    expect(s.errors).toBe(1);
    expect(s.failure).toBe("connection reset");
    expect(s.transcript).toBe("partial");
  });
});

describe("run-model — transcript semantics", () => {
  test("text deltas concatenate; done keeps the streamed transcript (no double)", () => {
    const s = foldAll([text("a"), text("b"), text("c"), done("abc")]);
    expect(s.transcript).toBe("abc");
  });

  test("with no streamed deltas, done back-fills the transcript from done.text", () => {
    const s = foldAll([modelResponse("m", 5, 5), done("full reply")]);
    expect(s.transcript).toBe("full reply");
  });
});

describe("run-model — defensive parsing", () => {
  test("a trace frame with no kind is a no-op", () => {
    const before = foldAll([text("x")]);
    const after = foldRunEvent(before, trace({ foo: "bar" }));
    expect(after).toEqual(before);
  });

  test("a step_start with no node identity is a no-op", () => {
    const s = foldAll([trace({ kind: "step_start", step: 1, total: 2 })]);
    expect(s.nodes).toEqual([]);
    expect(s.activeNode).toBeNull();
  });

  test("model_response without a usage object leaves the token tallies at zero", () => {
    const s = foldAll([trace({ kind: "model_response", model: "m", stopReason: "end_turn", durationMs: 5 })]);
    expect(s.tokensIn).toBe(0);
    expect(s.tokensOut).toBe(0);
  });

  test("an aggregate summary cost_accrual is NOT summed (avoids double count)", () => {
    const s = foldAll([
      trace({ kind: "cost_accrual", modelId: "m", inputTokens: 10, outputTokens: 5, costUsdMicros: 1000 }),
      trace({ kind: "cost_accrual", summary: true, inputTokens: 10, outputTokens: 5, costUsdMicros: 1000 }),
    ]);
    expect(s.costMicros).toBe(1000);
  });

  test("unpriced latches via the fallback when the flag is absent (zero cost, real tokens)", () => {
    const s = foldAll([
      trace({ kind: "cost_accrual", modelId: "mystery", inputTokens: 100, outputTokens: 40, costUsdMicros: 0 }),
    ]);
    expect(s.unpriced).toBe(true);
    expect(s.costMicros).toBe(0);
  });
});

describe("run-model — purity + determinism", () => {
  test("fold never mutates its input state and returns a fresh object", () => {
    const { initial, fold } = createRunReducer();
    const next = fold(initial, text("hi"));
    expect(next).not.toBe(initial);
    expect(initial.transcript).toBe(""); // input untouched
    expect(next.transcript).toBe("hi");
  });

  test("the shared INITIAL_RUN_STATE survives a full fold unmutated", () => {
    foldAll([
      trace({ kind: "step_start", name: "s", step: 1, total: 1 }),
      modelResponse("m", 9, 9),
      unpricedCost("m", 9, 9),
      trace({ kind: "approval_requested", approvalId: "a", toolName: "bash", surface: "daemon" }),
      trace({ kind: "step_end", name: "s", step: 1, durationMs: 1 }),
      done("x"),
    ]);
    expect(INITIAL_RUN_STATE.nodes).toEqual([]);
    expect(INITIAL_RUN_STATE.approvals).toEqual([]);
    expect(INITIAL_RUN_STATE.transcript).toBe("");
    expect(INITIAL_RUN_STATE.costMicros).toBe(0);
  });

  test("the same sequence folds to a deep-equal result every time", () => {
    const seq: TraceStreamEvent[] = [
      trace({ kind: "step_start", name: "a", step: 1, total: 2 }),
      modelResponse("m", 10, 4),
      trace({ kind: "step_end", name: "a", step: 1, durationMs: 12 }),
      done("done"),
    ];
    expect(foldAll(seq)).toEqual(foldAll(seq));
  });
});
