import { describe, expect, test } from "bun:test";
import type { TraceEvent, TraceEventEnvelope } from "@crewhaus/trace-event-bus";
import type { SpanKind } from "./index.js";
import { buildTimeline, drilldownSpan, replay, spanLabel } from "./index.js";

function envelope(
  spanId: string,
  parentSpanId?: string,
  ts = "2026-05-08T00:00:00.000Z",
): TraceEventEnvelope {
  return {
    runId: "run_test",
    sessionId: "sess_0000000000000000",
    turnNumber: 0,
    traceId: "0".repeat(32),
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    timestamp: ts,
  };
}

describe("buildTimeline (T1 snapshot)", () => {
  test("empty events → empty timeline", () => {
    const tl = buildTimeline([]);
    expect(tl).toEqual({ t0: 0, t1: 0, spans: [] });
  });

  test("pairs model_request + model_response into one span", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("span_1", "root", "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "claude-sonnet-4-6",
        messageCount: 3,
        toolCount: 2,
        streaming: false,
      },
      {
        ...envelope("span_1", "root", "2026-05-08T00:00:01.500Z"),
        kind: "model_response",
        model: "claude-sonnet-4-6",
        stopReason: "end_turn",
        usage: { input: 100, output: 50 },
        durationMs: 1500,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("model");
    expect(s.label).toBe("model: claude-sonnet-4-6");
    expect(s.t1 - s.t0).toBe(1500);
  });

  test("tool_call_start + tool_call_end pair → tool span with tool name in label", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("span_t", "model_span", "2026-05-08T00:00:00.000Z"),
        kind: "tool_call_start",
        toolUseId: "tu_1",
        toolName: "WebFetch",
        inputBytes: 32,
      },
      {
        ...envelope("span_t", "model_span", "2026-05-08T00:00:00.250Z"),
        kind: "tool_call_end",
        toolUseId: "tu_1",
        toolName: "WebFetch",
        isError: false,
        outputBytes: 1024,
        durationMs: 250,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    expect(tl.spans[0]?.label).toBe("tool: WebFetch");
  });

  test("point events (hook_fired, permission_decision, error_recovered, handoff, a2a_message, crew_done) become point spans (t0 === t1)", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("h1", "root", "2026-05-08T00:00:00.100Z"),
        kind: "hook_fired",
        event: "pre-tool",
        allowed: true,
        durationMs: 5,
      },
      {
        ...envelope("p1", "root", "2026-05-08T00:00:00.200Z"),
        kind: "permission_decision",
        toolName: "Bash",
        decision: "allow",
        mode: "default",
      },
      {
        ...envelope("ho1", "root", "2026-05-08T00:00:00.300Z"),
        kind: "handoff",
        from: "researcher",
        to: "writer",
        reason: "done",
        depth: 1,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(3);
    for (const s of tl.spans) {
      expect(s.t0).toBe(s.t1);
    }
    expect(tl.spans.find((s) => s.kind === "handoff")?.label).toBe("handoff: researcher→writer");
  });

  test("depth is computed via parentSpanId chain", () => {
    const events: TraceEvent[] = [
      // Root model span (no parent in the corpus)
      {
        ...envelope("model_root", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("model_root", undefined, "2026-05-08T00:00:01.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 5 },
        durationMs: 1000,
      },
      // Tool span nested under it
      {
        ...envelope("tool_inner", "model_root", "2026-05-08T00:00:00.500Z"),
        kind: "tool_call_start",
        toolUseId: "tu",
        toolName: "T",
        inputBytes: 0,
      },
      {
        ...envelope("tool_inner", "model_root", "2026-05-08T00:00:00.700Z"),
        kind: "tool_call_end",
        toolUseId: "tu",
        toolName: "T",
        isError: false,
        outputBytes: 0,
        durationMs: 200,
      },
    ];
    const tl = buildTimeline(events);
    const root = tl.spans.find((s) => s.spanId === "model_root");
    const inner = tl.spans.find((s) => s.spanId === "tool_inner");
    expect(root?.depth).toBe(0);
    expect(inner?.depth).toBe(1);
  });

  test("corpus t0/t1 = min/max of all span boundaries", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T00:00:02.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 0, output: 0 },
        durationMs: 2000,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.t0).toBe(Date.parse("2026-05-08T00:00:00.000Z"));
    expect(tl.t1).toBe(Date.parse("2026-05-08T00:00:02.000Z"));
  });
});

describe("trace-viewer v1 — Section 31 replay + drilldown", () => {
  test("replay yields events in order with deterministic timing", async () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T00:00:01.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
        durationMs: 1000,
      },
    ];
    const setTimeoutCalls: number[] = [];
    const stubSetTimeout = (cb: () => void, ms: number): void => {
      setTimeoutCalls.push(ms);
      cb();
    };
    const out: TraceEvent[] = [];
    for await (const ev of replay(events, { speed: 1, setTimeoutImpl: stubSetTimeout })) {
      out.push(ev);
    }
    expect(out.length).toBe(2);
    // Second event scheduled with 1000ms gap.
    expect(setTimeoutCalls).toContain(1000);
  });

  test("replay raw mode yields immediately (no setTimeout calls)", async () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T01:00:00.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
        durationMs: 1000,
      },
    ];
    let calls = 0;
    const stubSetTimeout = (cb: () => void): void => {
      calls++;
      cb();
    };
    const out: TraceEvent[] = [];
    for await (const ev of replay(events, { speed: "raw", setTimeoutImpl: stubSetTimeout })) {
      out.push(ev);
    }
    expect(calls).toBe(0);
    expect(out.length).toBe(2);
  });

  test("replay 4× quarters the wait", async () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.400Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
        durationMs: 400,
      },
    ];
    const calls: number[] = [];
    const stubSetTimeout = (cb: () => void, ms: number): void => {
      calls.push(ms);
      cb();
    };
    const out: TraceEvent[] = [];
    for await (const ev of replay(events, { speed: 4, setTimeoutImpl: stubSetTimeout }))
      out.push(ev);
    // 400ms gap / 4 = 100ms wait
    expect(calls).toContain(100);
  });

  test("drilldownSpan returns the span + related events", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "model_request",
        model: "m",
        messageCount: 1,
        toolCount: 0,
        streaming: false,
      },
      {
        ...envelope("a", undefined, "2026-05-08T00:00:01.000Z"),
        kind: "model_response",
        model: "m",
        stopReason: "end_turn",
        usage: { input: 10, output: 10 },
        durationMs: 1000,
      },
    ];
    const tl = buildTimeline(events);
    const drilldown = drilldownSpan(tl, events, "a");
    expect(drilldown).toBeDefined();
    expect(drilldown?.events.length).toBe(2);
  });

  test("drilldownSpan returns undefined for unknown spanId", () => {
    const events: TraceEvent[] = [];
    const tl = buildTimeline(events);
    expect(drilldownSpan(tl, events, "missing")).toBeUndefined();
  });
});

describe("buildTimeline — remaining start-kind variants (startKind + rich labels)", () => {
  test("turn_start + turn_end → turn span labelled with the turn number", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("turn_span", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "turn_start",
        turn: 7,
        messageCount: 2,
      },
      {
        ...envelope("turn_span", undefined, "2026-05-08T00:00:03.000Z"),
        kind: "turn_end",
        turn: 7,
        stopReason: "end_turn",
        durationMs: 3000,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("turn");
    expect(s.label).toBe("turn 7");
    expect(s.t0).toBe(Date.parse("2026-05-08T00:00:00.000Z"));
    expect(s.t1).toBe(Date.parse("2026-05-08T00:00:03.000Z"));
    expect(s.meta).toEqual({ startEvent: "turn_start", endEvent: "turn_end" });
  });

  test("mcp_call_start + mcp_call_end → mcp span with tool name in label", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("mcp_span", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "mcp_call_start",
        server: "filesystem",
        toolName: "read_file",
      },
      {
        ...envelope("mcp_span", undefined, "2026-05-08T00:00:00.500Z"),
        kind: "mcp_call_end",
        server: "filesystem",
        toolName: "read_file",
        isError: false,
        durationMs: 500,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("mcp");
    expect(s.label).toBe("mcp: read_file");
    expect(s.t1 - s.t0).toBe(500);
  });

  test("sub_agent_start + sub_agent_end → sub_agent span labelled with the agent name", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("sa_span", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "sub_agent_start",
        name: "researcher",
        childRunId: "run_child",
        childSessionId: "sess_child000000000",
        toolCount: 3,
        promptBytes: 128,
      },
      {
        ...envelope("sa_span", undefined, "2026-05-08T00:00:02.000Z"),
        kind: "sub_agent_end",
        name: "researcher",
        childRunId: "run_child",
        childSessionId: "sess_child000000000",
        isError: false,
        toolCallCount: 5,
        finalMessageBytes: 512,
        durationMs: 2000,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("sub_agent");
    expect(s.label).toBe("sub_agent: researcher");
    expect(s.t1 - s.t0).toBe(2000);
  });

  test("role_start + role_end → role span labelled with the role name", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("role_span", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "role_start",
        role: "writer",
        activation: 1,
      },
      {
        ...envelope("role_span", undefined, "2026-05-08T00:00:01.250Z"),
        kind: "role_end",
        role: "writer",
        activation: 1,
        finalMessageBytes: 256,
        durationMs: 1250,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("role");
    expect(s.label).toBe("role: writer");
    expect(s.t1 - s.t0).toBe(1250);
  });

  test("start event without a matching end → t1 === t0 (no endEvent in meta)", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("lonely", undefined, "2026-05-08T00:00:00.000Z"),
        kind: "tool_call_start",
        toolUseId: "tu_lonely",
        toolName: "Grep",
        inputBytes: 16,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.t0).toBe(s.t1);
    expect(s.meta).toEqual({ startEvent: "tool_call_start" });
  });
});

describe("buildTimeline — remaining point-kind variants (pointKind + rich labels)", () => {
  test("compaction_fired → compaction point span labelled with subKind", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("c1", "root", "2026-05-08T00:00:00.000Z"),
        kind: "compaction_fired",
        subKind: "autocompact",
        before: 100,
        after: 40,
        phase: "pre-turn",
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("compaction");
    expect(s.label).toBe("compaction: autocompact");
    expect(s.t0).toBe(s.t1);
    expect(s.meta).toEqual({ eventKind: "compaction_fired" });
  });

  test("error_recovered → recovery point span labelled with the action", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("e1", "root", "2026-05-08T00:00:00.000Z"),
        kind: "error_recovered",
        action: "retry",
        errorName: "RateLimitError",
        depth: 0,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("recovery");
    expect(s.label).toBe("recover: retry");
    expect(s.t0).toBe(s.t1);
  });

  test("a2a_message → a2a_message point span labelled from→to", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("a2a1", "root", "2026-05-08T00:00:00.000Z"),
        kind: "a2a_message",
        from: "planner",
        to: "executor",
        messageKind: "question",
        payloadBytes: 64,
        traceparent: "00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-01",
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("a2a_message");
    expect(s.label).toBe("a2a: planner→executor");
    expect(s.t0).toBe(s.t1);
  });

  test("crew_done → crew point span with the 'crew' label", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("crew1", "root", "2026-05-08T00:00:00.000Z"),
        kind: "crew_done",
        finalRole: "writer",
        totalActivations: 4,
        durationMs: 9000,
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(1);
    const s = tl.spans[0];
    if (s === undefined) throw new Error("expected span");
    expect(s.kind).toBe("crew");
    expect(s.label).toBe("crew");
    expect(s.t0).toBe(s.t1);
  });

  test("unrecognised event kind produces no span (startKind & pointKind default)", () => {
    const events: TraceEvent[] = [
      {
        ...envelope("ct1", "root", "2026-05-08T00:00:00.000Z"),
        kind: "circuit_state_changed",
        adapter: "anthropic",
        fromState: "closed",
        toState: "open",
      },
    ];
    const tl = buildTimeline(events);
    expect(tl.spans).toHaveLength(0);
  });
});

describe("spanLabel — defensive fallbacks for mismatched kind/event", () => {
  // A bare envelope whose `kind` never matches any rich-label guard, so every
  // `spanLabel(<kind>, mismatched)` call falls through to the `return "<kind>"`
  // branch. Cast through the union so we exercise the total-function contract.
  function mismatched(kind: string): TraceEvent {
    return { ...envelope("mismatch"), kind } as unknown as TraceEvent;
  }

  const cases: ReadonlyArray<readonly [SpanKind, string]> = [
    ["model", "model"],
    ["tool", "tool"],
    ["mcp", "mcp"],
    ["hook", "hook"],
    ["compaction", "compaction"],
    ["permission", "permission"],
    ["recovery", "recovery"],
    ["sub_agent", "sub_agent"],
    ["role", "role"],
    ["handoff", "handoff"],
    ["a2a_message", "a2a"],
  ];

  for (const [kind, expected] of cases) {
    test(`${kind} with a non-matching event falls back to "${expected}"`, () => {
      expect(spanLabel(kind, mismatched("__none__"))).toBe(expected);
    });
  }

  test("turn fallback yields '?' when the turn number is absent", () => {
    expect(spanLabel("turn", mismatched("__none__"))).toBe("turn ?");
  });

  test("crew label is constant", () => {
    expect(spanLabel("crew", mismatched("__none__"))).toBe("crew");
  });

  test("tool_stream label is constant", () => {
    expect(spanLabel("tool_stream", mismatched("__none__"))).toBe("tool stream");
  });

  test("rich branches still fire when kind and event agree", () => {
    const hook = {
      ...envelope("h"),
      kind: "hook_fired",
      event: "pre-tool",
      allowed: true,
      durationMs: 5,
    } as unknown as TraceEvent;
    expect(spanLabel("hook", hook)).toBe("hook: pre-tool");

    const perm = {
      ...envelope("p"),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "deny",
      mode: "default",
    } as unknown as TraceEvent;
    expect(spanLabel("permission", perm)).toBe("permission: Bash=deny");

    const handoff = {
      ...envelope("ho"),
      kind: "handoff",
      from: "a",
      to: "b",
      reason: "x",
      depth: 1,
    } as unknown as TraceEvent;
    expect(spanLabel("handoff", handoff)).toBe("handoff: a→b");

    const model = {
      ...envelope("m"),
      kind: "model_request",
      model: "claude-opus-4-8",
      messageCount: 1,
      toolCount: 0,
      streaming: false,
    } as unknown as TraceEvent;
    expect(spanLabel("model", model)).toBe("model: claude-opus-4-8");

    const turn = {
      ...envelope("t"),
      kind: "turn_start",
      turn: 3,
      messageCount: 1,
    } as unknown as TraceEvent;
    expect(spanLabel("turn", turn)).toBe("turn 3");
  });
});
