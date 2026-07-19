// Run-state reducer for the /builder page: fold a live harness `/chat` stream
// (the merged TraceStreamEvent stream ./trace-stream.ts produces) into a plain
// {@link RunState} the page renders — a loop overlay the user watches while
// their agent runs.
//
// The projection ./loop-model.ts draws is STATIC: the shape of the loop as the
// spec configures it. This module is its DYNAMIC counterpart: as the run
// streams, it lights the segment/node currently executing, tallies cost and
// tokens, tracks pending approvals, and accumulates the reply transcript — so
// the same ring/canvas the builder already shows can pulse with the live run.
//
// It reduces the MERGED stream (not raw TraceEvents): ./trace-stream.ts yields
// `{ kind: "text" }` deltas and `{ kind: "done"/"error" }` terminals ALONGSIDE
// `{ kind: "trace", event }` frames, and the transcript needs the text deltas
// while the stats need the trace frames — so `fold` takes the whole
// TraceStreamEvent union and dispatches on the trace payload's own `.kind` (the
// TraceEvent discriminant: model_response, cost_accrual, step_start, …).
//
// Highlight vocabulary is SHARED with the ring: `activeSegment` is a
// loop-model {@link LoopSegmentId}, so the page lights the very segment the
// ring already draws. `activeNode` / `nodes` key on the node NAME the cf-worker
// stamps on step_start/node_start/role_start — the same id loop-model's canvas
// builders use — so the page overlays run status onto a projected node by id.
//
// Deterministic + PURE: `fold(state, event)` returns a NEW RunState and never
// mutates its input, so a synthetic event array folds to one predictable
// result (`events.reduce(fold, initial)`), which is exactly how it is tested.
// Every field read off a trace payload is guarded (payloads are `unknown`), so
// a malformed frame degrades to "no change", never a throw.
//
// Discipline (mirrors ./loop-model.ts / ./trace-stream.ts): imports NOTHING
// from ./compiler or ./cloudflare (the `__COMPILER_URL__` vite define is
// undefined under `bun test`), performs no fetch, and touches NO DOM — the two
// imports are TYPES only (LoopSegmentId from ./loop-model, TraceStreamEvent
// from ./trace-stream), erased at compile time, so the unit tests run fully
// offline.

import type { LoopSegmentId } from "./loop-model";
import type { TraceStreamEvent } from "./trace-stream";

// --- run-state shape ---------------------------------------------------------

/**
 * Live status of one canvas node the run has touched. Nodes appear only once
 * their start frame arrives (so a node absent from {@link RunState.nodes} is
 * implicitly "pending" — the projected canvas already knows every node; this
 * list overlays run status onto it). `position` is the 1-based step/node index
 * (the cf-worker's `step`/`node` field; crew's 0-based `activation`), `total`
 * the run's node count, `durationMs` the measured wall time once it ends.
 */
export type RunNode = {
  readonly id: string;
  readonly status: "active" | "done";
  readonly position?: number;
  readonly total?: number;
  readonly durationMs?: number;
};

/**
 * One approval the run is parked on, awaiting a grant/deny. Added by an
 * `approval_requested` trace frame, removed by the matching `approval_resolved`
 * (keyed on `approvalId`). `toolName` is the parked tool call; `surface` the
 * non-interactive surface the ask arose on (e.g. "single-turn", "daemon").
 */
export type PendingApproval = {
  readonly approvalId: string;
  readonly toolName: string;
  readonly surface: string;
};

/**
 * The accumulated view of a run. Every field is derived deterministically from
 * the folded stream; the page renders straight from it.
 *
 * Highlight — for a ring shape, `activeSegment` is the loop component currently
 * executing (model_* -> reason, tool/mcp/sub-agent -> act, …); for a canvas
 * shape, `activeNode` is the running node's id and `nodes` carries per-node
 * status. The two are tracked independently (a run is one or the other); the
 * page shows whichever matches its projection kind.
 */
export type RunState = {
  /** Ring segment currently executing, or null before any attributable frame. */
  readonly activeSegment: LoopSegmentId | null;
  /** Canvas node currently running (its id), or null between/after nodes. */
  readonly activeNode: string | null;
  /** Per-node run status, in first-started order. */
  readonly nodes: readonly RunNode[];
  /** Running cost in microdollars (1e-6 USD) — sum of per-call cost_accrual. */
  readonly costMicros: number;
  /** True once any accrual was UNPRICED — cost is then a floor, not exact. */
  readonly unpriced: boolean;
  /** Prompt (input) tokens summed from model_response.usage. */
  readonly tokensIn: number;
  /** Completion (output) tokens summed from model_response.usage. */
  readonly tokensOut: number;
  /** Cache read + write tokens summed from model_response.usage. */
  readonly cacheTokens: number;
  /** Approvals awaiting resolution, in request order. */
  readonly approvals: readonly PendingApproval[];
  /** The assistant reply so far — text deltas, or done's final text if unstreamed. */
  readonly transcript: string;
  /** Turns started (turn_start count). */
  readonly turns: number;
  /** Tool calls started (tool_call_start count). */
  readonly toolCalls: number;
  /** Errors seen (tool_call_end isError, run_failed, and stream `error` frames). */
  readonly errors: number;
  /** True once a terminal frame (done, error, or run_failed) was folded. */
  readonly done: boolean;
  /** stopReason from the terminal done / run failure, when known. */
  readonly stopReason: string | null;
  /** Human-readable failure message from a run_failed / stream error, when any. */
  readonly failure: string | null;
};

/** The zero state — fold the first event against this. */
export const INITIAL_RUN_STATE: RunState = {
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

// --- trace-event vocabulary maps ---------------------------------------------

/**
 * Which loop segment a trace kind attributes to — the ring highlight. The
 * load-bearing entries are the ones the contract names (model_request /
 * model_response -> reason; tool_call_* -> act); the rest extend the same
 * "what phase is running" idea to the neighbouring kinds so the highlight stays
 * meaningful across a whole turn. A kind absent from this map leaves
 * `activeSegment` unchanged (e.g. turn_start, cost_accrual, the step/node
 * frames — those advance the canvas, not the ring).
 */
const SEGMENT_FOR_KIND: Readonly<Record<string, LoopSegmentId>> = {
  // reason — the model is thinking / responding / being routed.
  model_request: "reason",
  model_response: "reason",
  model_stream_token: "reason",
  model_route: "reason",
  model_tier_route: "reason",
  model_failover: "reason",
  // act — a tool, MCP server, or sub-agent is doing work.
  tool_call_start: "act",
  tool_call_end: "act",
  tool_stream_chunk: "act",
  mcp_call_start: "act",
  mcp_call_end: "act",
  sub_agent_start: "act",
  sub_agent_end: "act",
  // evaluate — an in-loop verdict is being scored.
  test_verdict: "evaluate",
  eval_graded: "evaluate",
  judge_verdict: "evaluate",
  coverage_report: "evaluate",
  // update — the working context is being compacted / rotated.
  compaction_fired: "update",
  cache_rotation: "update",
  // safety — a permission / hook / approval gate is deciding.
  permission_decision: "safety",
  hook_fired: "safety",
  approval_requested: "safety",
  sanitizer_report: "safety",
  circuit_state_changed: "safety",
};

/**
 * Trace kinds that ADVANCE the canvas position: a workflow step, a graph node,
 * or a crew role has begun. All three carry a node identity (`name` for
 * step/node, `role` for crew) and are folded through one code path.
 */
const NODE_START_KINDS = new Set(["step_start", "node_start", "role_start"]);
/** Trace kinds that MARK a canvas node done (the `*_end` counterparts). */
const NODE_END_KINDS = new Set(["step_end", "node_end", "role_end"]);

// --- guarded readers ---------------------------------------------------------
// A trace payload is `Record<string, unknown>` — every read is typed-checked so
// a malformed frame degrades to "no change", never a throw.

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readString(rec: Rec, key: string): string | undefined {
  const v = rec[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(rec: Rec, key: string): number | undefined {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A canvas node's id: the cf-worker's `name` (step/node) or `role` (crew). */
function nodeId(event: Rec): string | undefined {
  return readString(event, "name") ?? readString(event, "role");
}

/** A canvas node's 1-based position: `step` (workflow) / `node` (graph) / `activation` (crew). */
function nodePosition(event: Rec): number | undefined {
  return readNumber(event, "step") ?? readNumber(event, "node") ?? readNumber(event, "activation");
}

// --- per-kind trace folds ----------------------------------------------------

/** step_start / node_start / role_start — mark the node active, make it current. */
function applyNodeStart(state: RunState, event: Rec): RunState {
  const id = nodeId(event);
  if (id === undefined) return state; // malformed frame: no node identity
  const position = nodePosition(event);
  const total = readNumber(event, "total");
  const entry: RunNode = {
    id,
    status: "active",
    ...(position !== undefined ? { position } : {}),
    ...(total !== undefined ? { total } : {}),
  };
  const idx = state.nodes.findIndex((n) => n.id === id);
  // A restart (retry) fully resets the node to active, dropping the prior
  // duration; a first start appends it in run order.
  const nodes = idx >= 0 ? state.nodes.map((n, i) => (i === idx ? entry : n)) : [...state.nodes, entry];
  return { ...state, activeNode: id, nodes };
}

/** step_end / node_end / role_end — mark the node done, clear the highlight if it was current. */
function applyNodeEnd(state: RunState, event: Rec): RunState {
  const id = nodeId(event);
  if (id === undefined) return state;
  const durationMs = readNumber(event, "durationMs");
  const done = (n: RunNode): RunNode => ({
    ...n,
    status: "done",
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  const idx = state.nodes.findIndex((n) => n.id === id);
  const nodes =
    idx >= 0
      ? state.nodes.map((n, i) => (i === idx ? done(n) : n))
      : // An end without a prior start (unusual): record it done anyway.
        [...state.nodes, done({ id, status: "done" })];
  return { ...state, activeNode: state.activeNode === id ? null : state.activeNode, nodes };
}

/** model_response — sum token usage (pricing-independent; survives an unpriced model). */
function applyModelResponse(state: RunState, event: Rec): RunState {
  const usage = event["usage"];
  if (!isRecord(usage)) return state;
  const input = readNumber(usage, "input") ?? 0;
  const output = readNumber(usage, "output") ?? 0;
  const cacheRead = readNumber(usage, "cacheRead") ?? 0;
  const cacheCreate = readNumber(usage, "cacheCreate") ?? 0;
  return {
    ...state,
    tokensIn: state.tokensIn + input,
    tokensOut: state.tokensOut + output,
    cacheTokens: state.cacheTokens + cacheRead + cacheCreate,
  };
}

/**
 * cost_accrual — sum per-call microdollars. Mirrors events.js CH.events.accrue:
 * the aggregate `summary` variant is SKIPPED (a run-total published on top of
 * the per-call accruals would double-count), and `unpriced` latches on the
 * explicit flag or the robust fallback (zero cost but real tokens) so the page
 * can show "unpriced" rather than a misleading $0.00.
 */
function applyCostAccrual(state: RunState, event: Rec): RunState {
  if (event["summary"] === true) return state;
  const micros = readNumber(event, "costUsdMicros") ?? 0;
  const inTok = readNumber(event, "inputTokens") ?? 0;
  const outTok = readNumber(event, "outputTokens") ?? 0;
  const unpriced = event["unpriced"] === true || (!(micros > 0) && (inTok > 0 || outTok > 0));
  return { ...state, costMicros: state.costMicros + micros, unpriced: state.unpriced || unpriced };
}

/** approval_requested — park a pending approval (idempotent on approvalId). */
function applyApprovalRequested(state: RunState, event: Rec): RunState {
  const approvalId = readString(event, "approvalId");
  if (approvalId === undefined) return state;
  if (state.approvals.some((a) => a.approvalId === approvalId)) return state;
  const approval: PendingApproval = {
    approvalId,
    toolName: readString(event, "toolName") ?? "",
    surface: readString(event, "surface") ?? "",
  };
  return { ...state, approvals: [...state.approvals, approval] };
}

/** approval_resolved — drop the matching pending approval (grant or deny). */
function applyApprovalResolved(state: RunState, event: Rec): RunState {
  const approvalId = readString(event, "approvalId");
  if (approvalId === undefined) return state;
  const approvals = state.approvals.filter((a) => a.approvalId !== approvalId);
  return approvals.length === state.approvals.length ? state : { ...state, approvals };
}

/** Fold one `{ kind: "trace", event }` payload (dispatch on the TraceEvent's own kind). */
function foldTrace(state: RunState, event: Rec): RunState {
  const kind = readString(event, "kind");
  if (kind === undefined) return state; // malformed trace: no discriminant

  // 1) Ring highlight — attribute the kind to a loop segment when we can.
  const seg = SEGMENT_FOR_KIND[kind];
  const withSeg = seg !== undefined ? { ...state, activeSegment: seg } : state;

  // 2) Canvas position — start/end frames advance the node overlay.
  if (NODE_START_KINDS.has(kind)) return applyNodeStart(withSeg, event);
  if (NODE_END_KINDS.has(kind)) return applyNodeEnd(withSeg, event);

  // 3) Counters + accumulators.
  switch (kind) {
    case "turn_start":
      return { ...withSeg, turns: withSeg.turns + 1 };
    case "tool_call_start":
      return { ...withSeg, toolCalls: withSeg.toolCalls + 1 };
    case "tool_call_end":
      return event["isError"] === true ? { ...withSeg, errors: withSeg.errors + 1 } : withSeg;
    case "run_failed":
      return {
        ...withSeg,
        errors: withSeg.errors + 1,
        done: true,
        failure: readString(event, "message") ?? withSeg.failure,
      };
    case "model_response":
      return applyModelResponse(withSeg, event);
    case "cost_accrual":
      return applyCostAccrual(withSeg, event);
    case "approval_requested":
      return applyApprovalRequested(withSeg, event);
    case "approval_resolved":
      return applyApprovalResolved(withSeg, event);
    default:
      return withSeg; // unknown / feed-only kind: highlight only, no accrual
  }
}

// --- the reducer -------------------------------------------------------------

/**
 * Fold one merged-stream event into the run state. Pure: returns a NEW
 * {@link RunState}, never mutates `state`. Text deltas grow the transcript; the
 * `done` terminal records the stop reason (and back-fills the transcript from
 * done.text when the reply never streamed); a stream `error` records the
 * failure; a `trace` frame dispatches on its payload's `.kind`.
 */
export function foldRunEvent(state: RunState, event: TraceStreamEvent): RunState {
  switch (event.kind) {
    case "text":
      return { ...state, transcript: state.transcript + event.text };
    case "done":
      return {
        ...state,
        done: true,
        stopReason: event.stopReason,
        transcript: state.transcript.length === 0 ? event.text : state.transcript,
      };
    case "error":
      return { ...state, done: true, errors: state.errors + 1, failure: event.message };
    case "trace":
      return foldTrace(state, event.event);
  }
}

/**
 * Build the run reducer: its `initial` zero state and the pure `fold`. Bundled
 * so a caller drives a run with one handle —
 *
 *   const { initial, fold } = createRunReducer();
 *   let run = initial;
 *   for await (const ev of streamChatTrace(url, messages)) run = fold(run, ev);
 *
 * — and a test folds a synthetic array deterministically:
 * `events.reduce(fold, initial)`. `fold` is the module-level
 * {@link foldRunEvent}; there is no hidden per-instance state, so two reducers
 * never interfere.
 */
export function createRunReducer(): {
  readonly initial: RunState;
  readonly fold: (state: RunState, event: TraceStreamEvent) => RunState;
} {
  return { initial: INITIAL_RUN_STATE, fold: foldRunEvent };
}
