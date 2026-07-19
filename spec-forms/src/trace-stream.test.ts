import { describe, expect, test } from "bun:test";
import {
  type TraceFetch,
  type TraceStreamEvent,
  streamChatTrace,
  streamTraceEvents,
} from "./trace-stream";

// Fully offline: every test feeds the generator a mocked fetch returning a
// hand-built SSE ReadableStream. Modeled on fleet.test.ts's mockFetch.

type Observed = { url: string; init: RequestInit };

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: TraceFetch;
  calls: Observed[];
} {
  const calls: Observed[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const observed: Observed = { url: String(url), init: init ?? {} };
    calls.push(observed);
    return respond(observed.url, observed.init);
  }) as unknown as TraceFetch;
  return { fetchImpl, calls };
}

/** A Response whose body is an SSE byte stream, delivered in the given chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(gen: AsyncGenerator<TraceStreamEvent>): Promise<TraceStreamEvent[]> {
  const out: TraceStreamEvent[] = [];
  for (const ev of await Array.fromAsync(gen)) out.push(ev);
  return out;
}

const URL_ = "https://hello-cli.example.workers.dev/chat";

describe("streamTraceEvents — today's contract (no trace events)", () => {
  test("degrades to exactly the text/done stream chat.ts sees", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      sseResponse([
        'event: text\ndata: {"text":"Hel"}\n\n',
        'event: text\ndata: {"text":"lo"}\n\n',
        'event: done\ndata: {"text":"Hello","stopReason":"end_turn"}\n\n',
      ]),
    );
    const events = await collect(
      streamTraceEvents(URL_, { messages: [{ role: "user", content: "hi" }] }, fetchImpl),
    );
    expect(events).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
      { kind: "done", text: "Hello", stopReason: "end_turn" },
    ]);
    // Request shape mirrors chat.ts: one POST with a JSON body.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messages: [{ role: "user", content: "hi" }],
    });
  });

  test("applies chat.ts's done defaults (text '', stopReason 'end_turn')", async () => {
    const { fetchImpl } = mockFetch(() => sseResponse(["event: done\ndata: {}\n\n"]));
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "done", text: "", stopReason: "end_turn" }]);
  });

  test("yields error events with the server's message (or a default)", async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse(['event: error\ndata: {"message":"boom"}\n\n', "event: error\ndata: {}\n\n"]),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([
      { kind: "error", message: "boom" },
      { kind: "error", message: "unknown error" },
    ]);
  });
});

describe("streamTraceEvents — trace events (future structured contract)", () => {
  test("yields each trace payload verbatim, interleaved with text in order", async () => {
    const trace1 = { type: "turn_start", turn: 1 };
    const trace2 = { type: "tool_call", name: "search", args: { q: "x" } };
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        `event: trace\ndata: ${JSON.stringify(trace1)}\n\n`,
        'event: text\ndata: {"text":"thinking"}\n\n',
        `event: trace\ndata: ${JSON.stringify(trace2)}\n\n`,
        'event: done\ndata: {"text":"done"}\n\n',
      ]),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([
      { kind: "trace", event: trace1 },
      { kind: "text", text: "thinking" },
      { kind: "trace", event: trace2 },
      { kind: "done", text: "done", stopReason: "end_turn" },
    ]);
  });

  test("skips non-object trace payloads (number / string / array / null)", async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        "event: trace\ndata: 42\n\n",
        'event: trace\ndata: "oops"\n\n',
        "event: trace\ndata: [1,2]\n\n",
        "event: trace\ndata: null\n\n",
        'event: trace\ndata: {"type":"ok"}\n\n',
      ]),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "trace", event: { type: "ok" } }]);
  });
});

describe("streamTraceEvents — defensive parsing", () => {
  test("skips malformed JSON frames and keeps consuming later frames", async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        "event: trace\ndata: {not json\n\n",
        'event: text\ndata: {"text":"still here"}\n\n',
      ]),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "text", text: "still here" }]);
  });

  test("ignores unknown event names and data-less frames", async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        'event: heartbeat\ndata: {"n":1}\n\n',
        "event: text\n\n", // no data line at all
        'event: text\ndata: {"text":"ok"}\n\n',
      ]),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "text", text: "ok" }]);
  });

  test("reassembles frames split across arbitrary chunk boundaries", async () => {
    // One trace + one text frame, delivered in chunks that split mid-line,
    // mid-JSON, and mid-"\n\n" separator — the buffer must reassemble all.
    const wire = 'event: trace\ndata: {"type":"turn_end","turns":2}\n\nevent: text\ndata: {"text":"hi"}\n\n';
    const chunks = [wire.slice(0, 9), wire.slice(9, 30), wire.slice(30, 47), wire.slice(47)];
    const { fetchImpl } = mockFetch(() => sseResponse(chunks));
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([
      { kind: "trace", event: { type: "turn_end", turns: 2 } },
      { kind: "text", text: "hi" },
    ]);
  });

  test("concatenates multi-`data:` line frames (same as chat.ts)", async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse(['event: trace\ndata: {"type":"tool_call",\ndata: "name":"grep"}\n\n']),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "trace", event: { type: "tool_call", name: "grep" } }]);
  });

  test("a stream that ends without a done frame just ends (no throw, no phantom events)", async () => {
    const { fetchImpl } = mockFetch(() => sseResponse(['event: text\ndata: {"text":"cut o"}\n\n']));
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "text", text: "cut o" }]);
  });
});

describe("streamTraceEvents — HTTP/network failures", () => {
  test("non-ok response with a JSON error body yields its message", async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "spec rejected" } }), { status: 400 }),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "error", message: "spec rejected" }]);
  });

  test("non-ok response without JSON falls back to the HTTP status", async () => {
    const { fetchImpl } = mockFetch(() => new Response("nope", { status: 503 }));
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "error", message: "HTTP 503" }]);
  });

  test("a rejected fetch yields a single error event instead of throwing", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Load failed");
    }) as unknown as TraceFetch;
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([{ kind: "error", message: "Load failed" }]);
  });
});

describe("streamTraceEvents — Batch C wire contract (TraceEvent-vocabulary frames)", () => {
  // The cf-worker targets send each per-turn / per-step TraceEvent as an
  // `event: trace` frame (emit("trace", event)). This module is a pass-through
  // for those: EVERY JSON-object trace payload — every kind — surfaces verbatim
  // as { kind: "trace", event }, so a new kind needs no change here.

  test("a workflow turn: step_start / model_response / cost_accrual / step_end all pass through verbatim", async () => {
    // Exactly the frames packages/target-cf-worker-workflow emits for one step.
    const stepStart = { kind: "step_start", name: "draft", step: 1, total: 2 };
    const modelResponse = {
      kind: "model_response",
      model: "claude-sonnet-4-6",
      usage: { input: 120, output: 40, cacheRead: 0, cacheCreate: 0 },
      stopReason: "end_turn",
      durationMs: 1500,
    };
    const costAccrual = {
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      inputTokens: 120,
      outputTokens: 40,
      cachedReadTokens: 0,
      costUsdMicros: 0,
      unpriced: true,
    };
    const stepEnd = { kind: "step_end", name: "draft", step: 1, durationMs: 1500 };
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        `event: trace\ndata: ${JSON.stringify(stepStart)}\n\n`,
        `event: trace\ndata: ${JSON.stringify(modelResponse)}\n\n`,
        `event: trace\ndata: ${JSON.stringify(costAccrual)}\n\n`,
        `event: trace\ndata: ${JSON.stringify(stepEnd)}\n\n`,
        'event: done\ndata: {"text":"drafted","stopReason":"end_turn"}\n\n',
      ]),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([
      { kind: "trace", event: stepStart },
      { kind: "trace", event: modelResponse },
      { kind: "trace", event: costAccrual },
      { kind: "trace", event: stepEnd },
      { kind: "done", text: "drafted", stopReason: "end_turn" },
    ]);
  });

  test("graph node_start / node_end and an approval_requested pass through verbatim", async () => {
    const nodeStart = { kind: "node_start", name: "classify", node: 1, total: 3 };
    const approval = {
      kind: "approval_requested",
      approvalId: "apr_7",
      toolName: "bash",
      surface: "single-turn",
    };
    const nodeEnd = { kind: "node_end", name: "classify", node: 1, durationMs: 900 };
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        `event: trace\ndata: ${JSON.stringify(nodeStart)}\n\n`,
        `event: trace\ndata: ${JSON.stringify(approval)}\n\n`,
        `event: trace\ndata: ${JSON.stringify(nodeEnd)}\n\n`,
      ]),
    );
    const events = await collect(streamTraceEvents(URL_, {}, fetchImpl));
    expect(events).toEqual([
      { kind: "trace", event: nodeStart },
      { kind: "trace", event: approval },
      { kind: "trace", event: nodeEnd },
    ]);
  });
});

describe("streamChatTrace — /chat convenience wrapper (merged stream)", () => {
  const WORKER = "https://hello-cli.example.workers.dev";
  const messages = [{ role: "user" as const, content: "hi" }];

  test("POSTs <workerUrl>/chat with a { messages } body, mirroring streamChat", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      sseResponse(['event: done\ndata: {"text":"hey","stopReason":"end_turn"}\n\n']),
    );
    await collect(streamChatTrace(WORKER, messages, fetchImpl));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${WORKER}/chat`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ messages });
  });

  test("yields the MERGED stream: text deltas AND trace frames interleaved with done", async () => {
    const modelResponse = {
      kind: "model_response",
      model: "claude-sonnet-4-6",
      usage: { input: 10, output: 5 },
      stopReason: "end_turn",
      durationMs: 800,
    };
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        'event: text\ndata: {"text":"he"}\n\n',
        `event: trace\ndata: ${JSON.stringify(modelResponse)}\n\n`,
        'event: text\ndata: {"text":"y"}\n\n',
        'event: done\ndata: {"text":"hey","stopReason":"end_turn"}\n\n',
      ]),
    );
    const events = await collect(streamChatTrace(WORKER, messages, fetchImpl));
    expect(events).toEqual([
      { kind: "text", text: "he" },
      { kind: "trace", event: modelResponse },
      { kind: "text", text: "y" },
      { kind: "done", text: "hey", stopReason: "end_turn" },
    ]);
  });

  test("trims trailing slashes on the worker URL before appending /chat", async () => {
    const { fetchImpl, calls } = mockFetch(() => sseResponse(["event: done\ndata: {}\n\n"]));
    await collect(streamChatTrace(`${WORKER}///`, messages, fetchImpl));
    expect(calls[0]?.url).toBe(`${WORKER}/chat`);
  });

  test("inherits streamTraceEvents's never-throw posture on a rejected fetch", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Load failed");
    }) as unknown as TraceFetch;
    const events = await collect(streamChatTrace(WORKER, messages, fetchImpl));
    expect(events).toEqual([{ kind: "error", message: "Load failed" }]);
  });
});
