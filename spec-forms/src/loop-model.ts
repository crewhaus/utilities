// Loop projection for the /builder page (B1, read-only): render a PARSED
// `crewhaus.yaml` model as its AGENT LOOP.
//
// `projectLoop(model)` is the pure client-side v0 of the factory's planned
// `projectLoop(ir)` endpoint (AGENT-LOOPS-PLAN.md E3/G42: compiler-worker
// `GET|POST /loop`). The `LoopProjection` shape below is designed as that
// endpoint's wire shape — plain JSON-serializable data, no functions, no
// classes — so when the server-side projection lands, /builder swaps the
// producer and keeps the renderer. Until then this module projects the
// spec OBJECT (as parsed from the editor's YAML); it never sees YAML text.
//
// Two projection kinds:
//   - "ring"   — single-agent shapes (cli / channel / managed): the report's
//     seven-component loop as ring segments (perceive / reason / act /
//     evaluate / update) plus the Stop and Safety boundary panels. A segment
//     is `active` iff the spec keys that configure it are present; `keys`
//     lists them; `summary` is one operator-facing line either way.
//   - "canvas" — step/node/role shapes (workflow / graph / crew / pipeline /
//     research / batch): steps/nodes/roles as canvas nodes, edges/handoffs
//     as arrows, HITL gates as badge markers, `kind: judge` steps/nodes (loop
//     contract 0.4) as a distinct "judge" node kind whose conditional "gates"
//     edge points back at the step/node it scores, and each node carrying its
//     own mini seven-segment summary.
//
// Anything else (voice / browser / eval / onchain… or an unknown target)
// falls back to the generic ring with an honest warning — same policy as the
// target indicator in index.astro ("say so rather than shrink").
//
// The Evaluate segment (ring) and the judge nodes' evaluate mini describe the
// in-loop evaluation the way the factory IR projection (@crewhaus/ir loop.ts)
// does — grader type + threshold + on_fail for `evaluation:`, threshold +
// on_fail for a `judge:` gate — so a ring/canvas reads the same whether it was
// produced by `projectLoop` here or fetched from the compiler-worker's /loop.
//
// Discipline (mirrors templates.ts / fleet.ts / share.ts): this file imports
// NOTHING from ./compiler or ./cloudflare (the `__COMPILER_URL__` vite define
// is undefined under `bun test`) and touches NO DOM — /builder owns all
// rendering. `projectLoop` and its helpers are pure functions of the parsed
// model. The one exception is `loadLoopProjection`, which POSTs to the
// compiler-worker's `/loop` endpoint through an INJECTABLE fetch seam (the URL
// arrives as an argument, never from a compiler import) and falls back to the
// local `projectLoop` on any failure — the same SpecFetch pattern spec-schema
// uses, so the unit tests still run fully offline. It imports `parseSpecModel`
// from ./spec-model (a sibling pure lib, `yaml`-only) for the fallback parse.

import { parseSpecModel } from "./spec-model";

// --- projection wire shape ---------------------------------------------------

/** The seven loop components, in canonical render order. */
export type LoopSegmentId =
  | "perceive"
  | "reason"
  | "act"
  | "evaluate"
  | "update"
  | "stop"
  | "safety";

/** Canonical segment order — every ring and every node mini uses exactly this. */
export const SEGMENT_ORDER: readonly LoopSegmentId[] = [
  "perceive",
  "reason",
  "act",
  "evaluate",
  "update",
  "stop",
  "safety",
];

/**
 * One loop component. `active` iff the spec keys configuring it are present
 * (defaults alone never light a segment); `keys` are the dotted spec paths
 * that lit it (e.g. "agent.model_pool", "tools[webFetch]", "channels.slack");
 * `summary` is a one-line, operator-facing description of what is (or isn't)
 * configured — never a stack trace, never raw YAML.
 */
export type LoopSegment = {
  readonly id: LoopSegmentId;
  readonly active: boolean;
  readonly keys: readonly string[];
  readonly summary: string;
};

/** The single-agent loop ring: always all seven segments, in SEGMENT_ORDER. */
export type LoopRing = {
  readonly segments: readonly LoopSegment[];
};

/**
 * What a canvas node represents on its shape. A SUPERSET of the factory IR's
 * `LoopNodeKind` (`@crewhaus/ir` loop.ts): the studio renderer is the wire
 * consumer, so the compiler-worker only ever emits step/node/role/doc, while
 * the studio's LOCAL projection ALSO emits "judge" for `kind: judge` steps and
 * nodes (the factory folds those into step/node with an active evaluate mini).
 * Both remain valid `LoopNode`s the /builder canvas renders.
 */
export type LoopNodeKind = "step" | "node" | "role" | "doc" | "judge";

/**
 * One canvas node (a workflow step, graph node, crew role, judge gate, or a
 * doc/queue/report artifact). `hitl` marks a human-approval badge; `mini` is
 * the node's own seven-segment summary (same shape as the ring's segments).
 */
export type LoopNode = {
  readonly id: string;
  readonly label: string;
  readonly kind: LoopNodeKind;
  readonly hitl?: boolean;
  readonly mini: readonly LoopSegment[];
};

/** One canvas arrow. `conditional` marks a guarded edge (a graph `when`, a
 *  routing rule, or a judge gate's "gates" back-edge). */
export type LoopEdge = {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly conditional?: boolean;
};

export type LoopCanvas = {
  readonly nodes: readonly LoopNode[];
  readonly edges: readonly LoopEdge[];
};

/**
 * The full projection. Exactly one of `ring` / `canvas` is set, matching
 * `kind`. `target` is the spec's declared target ("cli" when absent, matching
 * detectTarget's documented default; "unknown" when the model isn't a mapping
 * or the target isn't a string). `warnings` carry defaults-only boundaries
 * (see NO_BUDGET_WARNING), family hints for fallback targets, and structural
 * notes (crew routing, dangling graph edges).
 */
export type LoopProjection = {
  readonly kind: "ring" | "canvas";
  readonly target: string;
  readonly ring?: LoopRing;
  readonly canvas?: LoopCanvas;
  readonly warnings: readonly string[];
};

// --- target families ----------------------------------------------------------

/** Single-agent shapes rendered as the seven-component ring. */
export const RING_TARGETS: readonly string[] = ["cli", "channel", "managed"];

/** Step/node/role shapes rendered as a node canvas. */
export const CANVAS_TARGETS: readonly string[] = [
  "workflow",
  "graph",
  "crew",
  "pipeline",
  "research",
  "batch",
];

// The remaining canonical shapes; they fall back to the generic ring with a
// family hint rather than pretending to a projection they don't have yet.
const OTHER_KNOWN_TARGETS = new Set(["voice", "browser", "eval", "onchain", "onchain-game"]);

/**
 * The exact defaults-only Stop warning (guardrails-first affordance): with no
 * `budget:`/`limits:` the loop's only boundary is the runtime's hardcoded
 * tool-iteration cap. Exported so /builder and the tests share one string.
 */
export const NO_BUDGET_WARNING = "no budget: — stops only at the 500-iteration default";

/**
 * Tool names that count as PERCEPTION (bringing outside state into the loop)
 * rather than plain action: browsing / fetching / web-search style tools, in
 * the tool-catalog's camelCase or any casing (webFetch, webSearch, browse,
 * navigate, retrieve, crawl…). Everything in `tools:` still counts toward the
 * Act segment; matching names ALSO light Perceive.
 */
export const PERCEIVE_TOOL_RE = /(browse|fetch|web|search|crawl|navigate|retrieve)/i;

// --- tiny guarded readers -----------------------------------------------------
// The model is `unknown` (whatever the YAML parse produced) — every read is
// guarded so a malformed spec degrades to inactive segments, never a throw.

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Rec | undefined {
  return isRecord(v) ? v : undefined;
}

function readString(rec: Rec | undefined, key: string): string | undefined {
  const v = rec?.[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(rec: Rec | undefined, key: string): number | undefined {
  const v = rec?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The string entries of an array value (non-arrays / non-strings drop out). */
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * Whether a spec value counts as CONFIGURED. Absent / null / `false` /
 * `{ enabled: false }` / empty arrays / empty records do not — `continuity:
 * false` is an explicit opt-out, `permissions: {}` configures nothing.
 * Everything else (true, strings, numbers, non-empty objects/arrays) does.
 */
function isConfigured(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isRecord(v)) {
    if (v["enabled"] === false) return false;
    return Object.keys(v).length > 0;
  }
  return true;
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** "3 tools (read, write, bash)" — list up to `max` names, then "+n more". */
function countList(n: number, noun: string, names: readonly string[], max = 6): string {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  const list = shown.length > 0 ? ` (${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""})` : "";
  return `${n} ${noun}${n === 1 ? "" : "s"}${list}`;
}

function segment(
  id: LoopSegmentId,
  keys: readonly string[],
  activeSummary: string,
  inactiveSummary: string,
): LoopSegment {
  const active = keys.length > 0;
  return { id, active, keys, summary: active ? activeSummary : inactiveSummary };
}

// --- shared segment builders ----------------------------------------------------

/** Tools declared at the spec top level and/or under `agent:` (channel nests
 *  them there), with the dotted key path each came from. */
function collectSpecTools(spec: Rec): { names: string[]; path: (name: string) => string } {
  const top = stringArray(spec["tools"]);
  const agent = asRecord(spec["agent"]);
  const nested = stringArray(agent?.["tools"]);
  const fromTop = new Set(top);
  return {
    names: [...top, ...nested.filter((n) => !fromTop.has(n))],
    path: (name) => (fromTop.has(name) ? `tools[${name}]` : `agent.tools[${name}]`),
  };
}

/** The reason keys/summary parts shared by ring + node minis: thinking /
 *  model_tiers / model_pool read off one record, key paths prefixed. */
function reasonParts(rec: Rec | undefined, prefix: string): { keys: string[]; parts: string[] } {
  const keys: string[] = [];
  const parts: string[] = [];
  if (rec && isConfigured(rec["thinking"])) {
    keys.push(`${prefix}thinking`);
    parts.push("extended thinking");
  }
  if (rec && isConfigured(rec["model_tiers"])) {
    keys.push(`${prefix}model_tiers`);
    parts.push("two-tier turn routing");
  }
  if (rec && isConfigured(rec["model_pool"])) {
    keys.push(`${prefix}model_pool`);
    const pool = asRecord(rec["model_pool"]);
    const rawCandidates = pool?.["candidates"];
    const candidates = Array.isArray(rawCandidates) ? rawCandidates.length : undefined;
    const policy = readString(pool, "policy") ?? "heuristic";
    parts.push(
      `adaptive model pool (${candidates !== undefined ? `${candidates} candidates, ` : ""}policy: ${policy})`,
    );
  }
  return { keys, parts };
}

/**
 * One-line summary of a top-level `evaluation:` block: grader type, threshold
 * (llm_judge only), on_fail (default `retry`), and the retry cap when > 1.
 * Mirrors the factory IR projection's `describeEvaluation` (@crewhaus/ir
 * loop.ts) — same tokens, same order — so the Evaluate summary reads the same
 * whether the ring was produced locally or fetched from /loop. Defaults are
 * applied for display only (the factory reads them off the RESOLVED IR); a
 * malformed block with no grader simply drops the grader token.
 */
function describeEvaluationBlock(ev: Rec | undefined): string {
  const parts: string[] = [];
  const graderType = readString(asRecord(ev?.["grader"]), "type");
  if (graderType) parts.push(graderType);
  const threshold = readNumber(ev, "threshold");
  if (threshold !== undefined) parts.push(`threshold ${threshold}`);
  parts.push(`on fail: ${readString(ev, "on_fail") ?? "retry"}`);
  const maxRetries = readNumber(ev, "max_retries") ?? 1;
  if (maxRetries > 1) parts.push(`≤ ${maxRetries} retries`);
  return `in-loop evaluation (${parts.join(", ")})`;
}

/**
 * One-line summary of a `judge:` gate block (a `kind: judge` step/node):
 * threshold (default 0.7) and on_fail (default `retry_previous`). Mirrors the
 * factory IR projection's `describeJudge`. A judge gate's grader is always an
 * llm_judge scoring `criteria`, so — unlike an `evaluation` block — no grader
 * type is shown.
 */
function describeJudgeBlock(judge: Rec | undefined): string {
  const threshold = readNumber(judge, "threshold") ?? 0.7;
  const onFail = readString(judge, "on_fail") ?? "retry_previous";
  return `judge gate (threshold ${threshold}, on fail: ${onFail})`;
}

// --- the seven ring segments -----------------------------------------------------

/**
 * Compute the seven segments for a single-agent spec (the ring shapes, and the
 * generic fallback). PURE; exported for reuse by tests and the /builder page's
 * inspector (the ring itself comes via projectLoop).
 */
export function ringSegments(spec: Rec): LoopSegment[] {
  const agent = asRecord(spec["agent"]);
  const model = readString(agent, "model") ?? readString(spec, "model");

  // perceive ← browse/fetch/web tools + channel ingress (+ heartbeat timer).
  const tools = collectSpecTools(spec);
  const perceiveTools = tools.names.filter((n) => PERCEIVE_TOOL_RE.test(n));
  const perceiveKeys: string[] = perceiveTools.map((n) => tools.path(n));
  const perceiveParts: string[] = [];
  if (perceiveTools.length > 0) perceiveParts.push(`web tools: ${perceiveTools.join(", ")}`);
  const channels = asRecord(spec["channels"]);
  const channelNames = channels ? Object.keys(channels).filter((k) => isConfigured(channels[k])) : [];
  if (channelNames.length > 0) {
    perceiveKeys.push(...channelNames.map((c) => `channels.${c}`));
    perceiveParts.push(`channel ingress: ${channelNames.join(", ")}`);
  }
  if (isConfigured(spec["heartbeat"])) {
    perceiveKeys.push("heartbeat");
    perceiveParts.push("heartbeat timer");
  }
  const perceive = segment(
    "perceive",
    perceiveKeys,
    perceiveParts.join(" · "),
    "input arrives only from the incoming message — no browse/fetch/web tools or channel ingress",
  );

  // reason ← agent.thinking / agent.model_tiers / agent.model_pool.
  const { keys: reasonKeys, parts: rParts } = reasonParts(agent, "agent.");
  const reason = segment(
    "reason",
    reasonKeys,
    `${rParts.join(" · ")}${model ? ` on ${model}` : ""}`,
    model
      ? `single fixed model (${model}) — no thinking, tiers, or pool`
      : "no model declared — nothing to reason with",
  );

  // act ← tools / mcp_servers / sub_agents.
  const actKeys: string[] = [];
  const actParts: string[] = [];
  if (tools.names.length > 0) {
    actKeys.push(stringArray(spec["tools"]).length > 0 ? "tools" : "agent.tools");
    actParts.push(countList(tools.names.length, "tool", tools.names));
  }
  const mcp = asRecord(spec["mcp_servers"]);
  const mcpNames = mcp ? Object.keys(mcp) : [];
  if (mcpNames.length > 0) {
    actKeys.push("mcp_servers");
    actParts.push(countList(mcpNames.length, "MCP server", mcpNames));
  }
  const subAgents = asRecord(agent?.["sub_agents"]) ?? asRecord(spec["sub_agents"]);
  const subAgentNames = subAgents ? Object.keys(subAgents) : [];
  if (subAgentNames.length > 0) {
    actKeys.push(agent?.["sub_agents"] !== undefined ? "agent.sub_agents" : "sub_agents");
    actParts.push(countList(subAgentNames.length, "sub-agent", subAgentNames));
  }
  const act = segment(
    "act",
    actKeys,
    actParts.join(" · "),
    "no tools, MCP servers, or sub-agents — replies in text only",
  );

  // evaluate ← evaluation (future) / learning.exam / security.justification.
  const evalKeys: string[] = [];
  const evalParts: string[] = [];
  if (isConfigured(spec["evaluation"])) {
    evalKeys.push("evaluation");
    evalParts.push(describeEvaluationBlock(asRecord(spec["evaluation"])));
  }
  const learning = asRecord(spec["learning"]);
  if (learning && isConfigured(learning["exam"])) {
    evalKeys.push("learning.exam");
    const dataset = readString(asRecord(learning["exam"]), "dataset");
    evalParts.push(`competency exam${dataset ? ` (${dataset})` : ""}`);
  }
  const security = asRecord(spec["security"]);
  if (security && isConfigured(security["justification"])) {
    evalKeys.push("security.justification");
    const judge = readString(asRecord(security["justification"]), "judge") ?? "rule-based";
    evalParts.push(`justification intent gate (judge: ${judge})`);
  }
  const evaluate = segment(
    "evaluate",
    evalKeys,
    evalParts.join(" · "),
    "no in-loop evaluation — output is never checked before it ships",
  );

  // update ← memory / continuity / thredz / compaction.
  const updKeys: string[] = [];
  const updParts: string[] = [];
  const memory = asRecord(spec["memory"]);
  if (isConfigured(spec["memory"])) {
    updKeys.push("memory");
    const quals: string[] = [];
    const backend = readString(memory, "backend");
    if (backend) quals.push(`${backend} backend`);
    if (memory && isConfigured(memory["wiki"])) quals.push("wiki");
    if (memory && isConfigured(memory["dream"])) quals.push("dream");
    updParts.push(`memory${quals.length > 0 ? ` (${quals.join(", ")})` : ""}`);
  }
  if (isConfigured(spec["continuity"])) {
    updKeys.push("continuity");
    const proof = readString(asRecord(spec["continuity"]), "proof");
    updParts.push(`continuity${proof ? ` (proof: ${proof})` : ""}`);
  }
  if (isConfigured(spec["thredz"])) {
    updKeys.push("thredz");
    updParts.push("thredz wiki");
  }
  if (isConfigured(spec["compaction"])) {
    updKeys.push("compaction");
    const curated = asRecord(spec["compaction"])?.["curate"] === true;
    updParts.push(`compaction${curated ? " (curated)" : ""}`);
  }
  const continuityOff =
    spec["continuity"] === false || asRecord(spec["continuity"])?.["enabled"] === false;
  const update = segment(
    "update",
    updKeys,
    updParts.join(" · "),
    continuityOff
      ? "continuity explicitly disabled — nothing durable persists between sessions"
      : "no memory/continuity/thredz configured — facts are not persisted between sessions",
  );

  // stop ← budget / limits (hardcoded runtime defaults when absent).
  const stopKeys: string[] = [];
  const stopParts: string[] = [];
  if (isConfigured(spec["budget"])) {
    stopKeys.push("budget");
    const budget = asRecord(spec["budget"]);
    const usd = readNumber(budget, "usd");
    const onExceed = asRecord(budget?.["on_exceed"]);
    const action = readString(onExceed, "action");
    const degradeTo = readString(onExceed, "model");
    stopParts.push(
      `budget${usd !== undefined ? ` $${usd}` : ""}${
        action ? ` (on exceed: ${action}${degradeTo ? ` → ${degradeTo}` : ""})` : ""
      }`,
    );
  }
  if (isConfigured(spec["limits"])) {
    stopKeys.push("limits");
    const limits = asRecord(spec["limits"]);
    const names = limits ? Object.keys(limits) : [];
    stopParts.push(`limits${names.length > 0 ? ` (${names.join(", ")})` : ""}`);
  }
  const stop = segment(
    "stop",
    stopKeys,
    stopParts.join(" · "),
    "defaults only — stops at the 500-iteration cap",
  );

  // safety ← permissions / security / hooks / transaction_policy.
  const safeKeys: string[] = [];
  const safeParts: string[] = [];
  if (isConfigured(spec["permissions"])) {
    safeKeys.push("permissions");
    const perms = asRecord(spec["permissions"]);
    const mode = readString(perms, "mode");
    const rawRules = perms?.["rules"];
    const rules = Array.isArray(rawRules) ? rawRules.length : 0;
    const quals = [mode ? `mode: ${mode}` : "", rules > 0 ? `${rules} rule${rules === 1 ? "" : "s"}` : ""]
      .filter((q) => q.length > 0)
      .join(", ");
    safeParts.push(`permissions${quals ? ` (${quals})` : ""}`);
  }
  if (isConfigured(spec["security"])) {
    safeKeys.push("security");
    const egress = readString(security, "egressMatcher");
    safeParts.push(`security fabric${egress ? ` (egress: ${egress})` : ""}`);
  }
  if (isConfigured(spec["hooks"])) {
    safeKeys.push("hooks");
    safeParts.push("hooks");
  }
  if (isConfigured(spec["transaction_policy"])) {
    safeKeys.push("transaction_policy");
    safeParts.push("transaction policy");
  }
  const safety = segment(
    "safety",
    safeKeys,
    safeParts.join(" · "),
    "no permissions, security, or transaction policy — runtime defaults only",
  );

  return [perceive, reason, act, evaluate, update, stop, safety];
}

// --- node mini segments -----------------------------------------------------------

/**
 * The seven-segment mini summary for one canvas node (a workflow step, graph
 * node, crew role, or a shape's agent block). Node-scoped: `model` counts as
 * reasoning config (on nodes it is a real per-node choice, unlike the ring's
 * always-present agent.model), `hitl` counts as a safety gate, and the
 * spec-level blocks (memory/budget/permissions…) do NOT leak in — a node
 * summarizes only its own keys. `extraTools` merges in top-level `tools:` for
 * shapes that declare the agent's tools beside the agent block (research /
 * batch). PURE; exported for the /builder inspector.
 */
export function nodeSegments(node: Rec | undefined, extraTools: readonly string[] = []): LoopSegment[] {
  const rec = node ?? {};
  const ownTools = stringArray(rec["tools"]);
  const seen = new Set(ownTools);
  const tools = [...ownTools, ...extraTools.filter((t) => !seen.has(t))];

  const perceiveTools = tools.filter((n) => PERCEIVE_TOOL_RE.test(n));
  const perceive = segment(
    "perceive",
    perceiveTools.map((n) => `tools[${n}]`),
    `web tools: ${perceiveTools.join(", ")}`,
    "sees only upstream state and its instructions",
  );

  const model = readString(rec, "model");
  const { keys: reasonKeys, parts: rParts } = reasonParts(rec, "");
  if (model) {
    reasonKeys.unshift("model");
    rParts.unshift(`model: ${model}`);
  }
  const reason = segment(
    "reason",
    reasonKeys,
    rParts.join(" · "),
    "inherits the spec-level model",
  );

  const actKeys: string[] = [];
  const actParts: string[] = [];
  if (tools.length > 0) {
    actKeys.push("tools");
    actParts.push(countList(tools.length, "tool", tools));
  }
  const subAgents = asRecord(rec["sub_agents"]);
  const subAgentNames = subAgents ? Object.keys(subAgents) : [];
  if (subAgentNames.length > 0) {
    actKeys.push("sub_agents");
    actParts.push(countList(subAgentNames.length, "sub-agent", subAgentNames));
  }
  const act = segment("act", actKeys, actParts.join(" · "), "no tools — replies in text only");

  // evaluate ← a `kind: judge` gate block (judge steps/nodes score the
  // previous/upstream output). Regular steps/nodes carry no in-loop evaluation.
  const judgeBlock = asRecord(rec["judge"]);
  const evaluate = segment(
    "evaluate",
    judgeBlock !== undefined ? ["judge"] : [],
    judgeBlock !== undefined ? describeJudgeBlock(judgeBlock) : "",
    "no in-loop evaluation",
  );

  const updKeys: string[] = [];
  if (isConfigured(rec["memory"])) updKeys.push("memory");
  if (isConfigured(rec["compaction"])) updKeys.push("compaction");
  const update = segment(
    "update",
    updKeys,
    updKeys.join(" · "),
    "no node-level memory — shares the spec's stores",
  );

  const stopKeys: string[] = [];
  if (isConfigured(rec["budget"])) stopKeys.push("budget");
  if (isConfigured(rec["limits"])) stopKeys.push("limits");
  const stop = segment(
    "stop",
    stopKeys,
    stopKeys.join(" · "),
    "bounded by the surrounding orchestration",
  );

  const hitl = asRecord(rec["hitl"]);
  const safeKeys = isConfigured(rec["hitl"]) ? ["hitl"] : [];
  const prompt = readString(hitl, "prompt");
  const safety = segment(
    "safety",
    safeKeys,
    `human approval gate${prompt ? `: "${truncate(prompt, 60)}"` : ""}`,
    "no approval gate on this node",
  );

  return [perceive, reason, act, evaluate, update, stop, safety];
}

// --- canvas builders ---------------------------------------------------------------

/** Allocate a unique node id, suffixing duplicates ("draft", "draft-2", …). */
function claimId(used: Set<string>, wanted: string): string {
  let id = wanted;
  let n = 2;
  while (used.has(id)) {
    id = `${wanted}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function workflowCanvas(spec: Rec, warnings: string[]): LoopCanvas {
  const steps = Array.isArray(spec["steps"]) ? spec["steps"] : [];
  if (steps.length === 0) warnings.push("workflow has no steps — nothing to run");
  const used = new Set<string>();
  const nodes: LoopNode[] = steps.map((raw, i) => {
    const step = asRecord(raw);
    const name = readString(step, "name") ?? `step-${i + 1}`;
    const isJudge = readString(step, "kind") === "judge";
    return {
      id: claimId(used, name),
      label: `${i + 1}. ${name}`,
      kind: isJudge ? ("judge" as const) : ("step" as const),
      mini: nodeSegments(step),
    };
  });
  const edges: LoopEdge[] = [];
  for (let i = 0; i + 1 < nodes.length; i += 1) {
    const from = nodes[i];
    const to = nodes[i + 1];
    if (from && to) edges.push({ from: from.id, to: to.id });
  }
  // A judge step gates the PREVIOUS step's output: a conditional "gates" edge
  // from the judge back to the step it scores (the diamond points at what it
  // gates). A judge step in the first position has no previous step — the
  // compiler rejects that, so surface it as a warning here.
  steps.forEach((raw, i) => {
    if (readString(asRecord(raw), "kind") !== "judge") return;
    const judgeNode = nodes[i];
    const prevNode = nodes[i - 1];
    if (judgeNode === undefined) return;
    if (prevNode === undefined) {
      warnings.push(`judge step "${judgeNode.label.replace(/^\d+\.\s*/, "")}" is first — no previous step to gate`);
      return;
    }
    edges.push({ from: judgeNode.id, to: prevNode.id, label: "gates", conditional: true });
  });
  return { nodes, edges };
}

function graphCanvas(spec: Rec, warnings: string[]): LoopCanvas {
  const nodeRecs = asRecord(spec["nodes"]) ?? {};
  const entry = readString(spec, "entry");
  const ids = Object.keys(nodeRecs);
  if (ids.length === 0) warnings.push("graph has no nodes — nothing to run");
  if (entry && ids.length > 0 && !ids.includes(entry)) {
    warnings.push(`entry "${entry}" is not a declared node`);
  }
  const isJudgeNode = (id: string): boolean => readString(asRecord(nodeRecs[id]), "kind") === "judge";
  if (entry && ids.includes(entry) && isJudgeNode(entry)) {
    warnings.push(`entry "${entry}" is a judge node — a judge gates upstream output, so it cannot be the entry`);
  }
  const nodes: LoopNode[] = ids.map((id) => {
    const rec = asRecord(nodeRecs[id]);
    const judge = isJudgeNode(id);
    // Judge nodes carry only their gate config — never a hitl badge.
    const hitl = !judge && rec !== undefined && isConfigured(rec["hitl"]);
    return {
      id,
      label: id === entry ? `${id} (entry)` : id,
      kind: judge ? ("judge" as const) : ("node" as const),
      ...(hitl ? { hitl: true } : {}),
      mini: nodeSegments(rec),
    };
  });
  const edges: LoopEdge[] = [];
  const known = new Set(ids);
  const rawEdges = Array.isArray(spec["edges"]) ? spec["edges"] : [];
  // Upstream sources feeding each judge node (edge.from where edge.to is a
  // judge), collected while walking the declared edges.
  const judgeUpstreams = new Map<string, Set<string>>();
  for (const raw of rawEdges) {
    const edge = asRecord(raw);
    const from = readString(edge, "from");
    const to = readString(edge, "to");
    if (!from || !to) continue;
    for (const end of [from, to]) {
      if (!known.has(end)) warnings.push(`edge ${from} → ${to} references unknown node "${end}"`);
    }
    if (known.has(to) && known.has(from) && isJudgeNode(to)) {
      const set = judgeUpstreams.get(to) ?? new Set<string>();
      set.add(from);
      judgeUpstreams.set(to, set);
    }
    const when = readString(edge, "when");
    edges.push({ from, to, ...(when ? { label: when, conditional: true } : {}) });
  }
  // A judge node gates its UPSTREAM: a conditional "gates" edge from the judge
  // back to each node feeding it (the diamond points at what it scores).
  for (const id of ids) {
    if (!isJudgeNode(id)) continue;
    const sources = judgeUpstreams.get(id);
    if (sources === undefined || sources.size === 0) {
      warnings.push(`judge node "${id}" has no upstream edge to gate`);
      continue;
    }
    for (const src of sources) {
      edges.push({ from: id, to: src, label: "gates", conditional: true });
    }
  }
  return { nodes, edges };
}

function crewCanvas(spec: Rec, warnings: string[]): LoopCanvas {
  const roleRecs = asRecord(spec["roles"]) ?? {};
  const entry = readString(spec, "entry");
  const ids = Object.keys(roleRecs);
  if (ids.length === 0) warnings.push("crew has no roles — nothing to run");
  const nodes: LoopNode[] = ids.map((id) => ({
    id,
    label: id === entry ? `${id} (entry)` : id,
    kind: "role" as const,
    mini: nodeSegments(asRecord(roleRecs[id])),
  }));
  const edges: LoopEdge[] = [];
  const routing = asRecord(spec["routing"]);
  const kind = readString(routing, "kind");
  if (!routing || !kind) {
    warnings.push(
      `no routing: — the entry role${entry ? ` ("${entry}")` : ""} handles every message`,
    );
  } else if (kind === "llm") {
    warnings.push("routing.kind: llm — an LLM router picks the next role at runtime");
    if (entry) {
      for (const id of ids) {
        if (id !== entry) edges.push({ from: entry, to: id, label: "llm router", conditional: true });
      }
    }
  } else if (kind === "match") {
    const match = asRecord(routing["match"]) ?? {};
    for (const from of Object.keys(match)) {
      const rawRules = match[from];
      for (const raw of Array.isArray(rawRules) ? rawRules : []) {
        const rule = asRecord(raw);
        const to = readString(rule, "to");
        const contains = readString(rule, "contains");
        if (!to) continue;
        edges.push({
          from,
          to,
          ...(contains ? { label: `contains "${truncate(contains, 24)}"` } : {}),
          conditional: true,
        });
      }
    }
  }
  return { nodes, edges };
}

function pipelineCanvas(spec: Rec, warnings: string[]): LoopCanvas {
  const used = new Set<string>();
  const indexing = asRecord(spec["indexing"]);
  const retrieve = asRecord(spec["retrieve"]);
  const docs = Array.isArray(indexing?.["documents"]) ? indexing["documents"] : [];
  if (docs.length === 0) warnings.push("pipeline declares no indexing.documents — nothing to index");
  const nodes: LoopNode[] = [];
  const edges: LoopEdge[] = [];
  for (let i = 0; i < docs.length; i += 1) {
    const doc = asRecord(docs[i]);
    const docId = readString(doc, "id") ?? `doc-${i + 1}`;
    const id = claimId(used, `doc:${docId}`);
    nodes.push({ id, label: docId, kind: "doc", mini: nodeSegments(undefined) });
    edges.push({ from: id, to: "index" });
  }
  const strategy = readString(indexing, "chunkStrategy") ?? "fixed";
  nodes.push({
    id: claimId(used, "index"),
    label: `index (${strategy})`,
    kind: "node",
    mini: nodeSegments(undefined),
  });
  const agent = asRecord(spec["agent"]);
  nodes.push({
    id: claimId(used, "agent"),
    label: "chat agent",
    kind: "node",
    mini: nodeSegments(agent),
  });
  const k = readNumber(retrieve, "defaultK") ?? 5;
  const backend = readString(retrieve, "vectorBackend") ?? "in-memory";
  edges.push({ from: "index", to: "agent", label: `retrieve (k=${k}, ${backend})` });
  return { nodes, edges };
}

function researchCanvas(spec: Rec): LoopCanvas {
  const agent = asRecord(spec["agent"]);
  const tools = stringArray(spec["tools"]);
  const goal = readString(spec, "goal");
  const raw = readNumber(spec, "branchingFactor") ?? 3;
  // Clamp to the schema's 1..8 range so a malformed value can't flood the canvas.
  const branches = Math.min(8, Math.max(1, Math.floor(raw)));
  const nodes: LoopNode[] = [
    {
      id: "goal",
      label: goal ? `goal: ${truncate(goal, 40)}` : "goal",
      kind: "node",
      mini: nodeSegments(agent, tools),
    },
  ];
  const edges: LoopEdge[] = [];
  for (let i = 1; i <= branches; i += 1) {
    nodes.push({ id: `branch-${i}`, label: `branch ${i}`, kind: "node", mini: nodeSegments(agent, tools) });
    edges.push({ from: "goal", to: `branch-${i}` });
    edges.push({ from: `branch-${i}`, to: "report" });
  }
  nodes.push({ id: "report", label: "report", kind: "doc", mini: nodeSegments(undefined) });
  return { nodes, edges };
}

function batchCanvas(spec: Rec): LoopCanvas {
  const agent = asRecord(spec["agent"]);
  const tools = stringArray(spec["tools"]);
  const queue = asRecord(spec["queue"]);
  const adapter = readString(queue, "adapter");
  const concurrency = readNumber(spec, "concurrency") ?? 4;
  const maxRetries = readNumber(queue, "maxRetries") ?? 3;
  const nodes: LoopNode[] = [
    {
      id: "queue",
      label: `queue${adapter ? ` (${adapter})` : ""}`,
      kind: "node",
      mini: nodeSegments(undefined),
    },
    {
      id: "agent",
      label: `worker × ${concurrency}`,
      kind: "node",
      mini: nodeSegments(agent, tools),
    },
  ];
  const edges: LoopEdge[] = [
    { from: "queue", to: "agent", label: "jobs" },
    { from: "agent", to: "queue", label: `retries (≤ ${maxRetries})`, conditional: true },
  ];
  return { nodes, edges };
}

// --- projectLoop -------------------------------------------------------------------

/**
 * Project a parsed `crewhaus.yaml` model into its loop view.
 *
 * Never throws: a model that isn't a mapping projects to an all-inactive ring
 * with target "unknown" and an explanatory warning; a mapping without a
 * `target:` projects as "cli" (detectTarget's documented default). Ring
 * shapes without `budget:`/`limits:` get the exact NO_BUDGET_WARNING; targets
 * outside the ring/canvas families get a family-hint warning and the generic
 * ring.
 */
export function projectLoop(model: unknown): LoopProjection {
  if (!isRecord(model)) {
    return {
      kind: "ring",
      target: "unknown",
      ring: { segments: ringSegments({}) },
      warnings: ["spec did not parse to a mapping — nothing to project"],
    };
  }

  const spec = model;
  const declared = spec["target"];
  const target =
    typeof declared === "string" ? declared : declared === undefined ? "cli" : "unknown";
  const warnings: string[] = [];
  if (declared !== undefined && typeof declared !== "string") {
    warnings.push("target: is not a string — projecting as a generic single-agent ring");
  }

  if (CANVAS_TARGETS.includes(target)) {
    let canvas: LoopCanvas;
    if (target === "workflow") canvas = workflowCanvas(spec, warnings);
    else if (target === "graph") canvas = graphCanvas(spec, warnings);
    else if (target === "crew") canvas = crewCanvas(spec, warnings);
    else if (target === "pipeline") canvas = pipelineCanvas(spec, warnings);
    else if (target === "research") canvas = researchCanvas(spec);
    else canvas = batchCanvas(spec);
    return { kind: "canvas", target, canvas, warnings };
  }

  const isRingFamily = RING_TARGETS.includes(target);
  if (!isRingFamily && typeof declared === "string") {
    warnings.push(
      OTHER_KNOWN_TARGETS.has(target)
        ? `target "${target}" has no dedicated loop projection yet — showing the generic single-agent ring`
        : `unknown target "${target}" — projecting as a generic single-agent ring`,
    );
  }

  const segments = ringSegments(spec);
  // Guardrails-first: the defaults-only Stop warning applies to the true ring
  // families (their loop really does run to the iteration cap). Fallback
  // targets have their own boundaries (call length, page budget, dataset
  // size), so the 500-iteration claim would be dishonest there.
  if (isRingFamily) {
    const stop = segments.find((s) => s.id === "stop");
    if (stop && !stop.active) warnings.push(NO_BUDGET_WARNING);
  }
  return { kind: "ring", target, ring: { segments }, warnings };
}

// --- loadLoopProjection ------------------------------------------------------------

/**
 * Structural guard for a value claimed to be a {@link LoopProjection} — the
 * `loop` of a POST /loop response body. Checks only the load-bearing shape the
 * canvas/ring renderer needs (kind ∈ {ring, canvas}, a string target, an array
 * of warnings, and the matching ring.segments / canvas.{nodes,edges} arrays),
 * so a version-skewed or truncated body degrades to the local projection
 * rather than crashing the page. Field VALUES are trusted — the factory
 * golden-tests keep its LoopProjection field-compatible with this module.
 */
export function isLoopProjection(value: unknown): value is LoopProjection {
  if (!isRecord(value)) return false;
  if (value["kind"] !== "ring" && value["kind"] !== "canvas") return false;
  if (typeof value["target"] !== "string") return false;
  if (!Array.isArray(value["warnings"])) return false;
  if (value["kind"] === "ring") {
    const ring = asRecord(value["ring"]);
    return ring !== undefined && Array.isArray(ring["segments"]);
  }
  const canvas = asRecord(value["canvas"]);
  return canvas !== undefined && Array.isArray(canvas["nodes"]) && Array.isArray(canvas["edges"]);
}

/**
 * Produce the loop projection for `yaml`, compiler-first with a local fallback.
 *
 * When a compiler-worker `url` and a usable `fetch` are both available, POSTs
 * `{ yaml }` to `<url>/loop` and returns the server's `loop` — the factory's
 * `projectLoop(lower(parseSpec(yaml)))`, whose {@link LoopProjection} is
 * field-compatible with this module's (its golden tests pin that). On ANY
 * failure — no url/fetch, a network throw, a non-2xx response, a non-JSON
 * body, `{ ok: false }` (a parse/lower error), or a body that fails
 * {@link isLoopProjection} — it falls back to the LOCAL `projectLoop` of the
 * parsed model (which itself never throws: an unparseable spec projects to an
 * inactive ring). NEVER throws; always resolves to a LoopProjection.
 *
 * The page owns the "offline gate": passing no `url` (or a fetch that will fail
 * offline) simply yields the local projection, no network attempt trusted.
 */
export async function loadLoopProjection(args: {
  yaml: string;
  url?: string;
  fetchImpl?: typeof fetch;
}): Promise<LoopProjection> {
  const { yaml, url } = args;
  // Under `bun test` the global fetch exists; the typeof guard keeps this
  // call-safe in a fetch-less runtime, and the tests inject `fetchImpl`.
  const fetchImpl = args.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);

  if (fetchImpl && url) {
    try {
      const res = await fetchImpl(`${url.replace(/\/+$/, "")}/loop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ yaml }),
      });
      if (res.ok) {
        const body = (await res.json()) as unknown;
        if (isRecord(body) && body["ok"] === true && isLoopProjection(body["loop"])) {
          return body["loop"];
        }
      }
    } catch {
      // Network / JSON / shape failure — fall through to the local projection.
    }
  }

  return projectLoop(parseSpecModel(yaml).model);
}
