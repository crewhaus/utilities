import { describe, expect, test } from "bun:test";
import {
  CANVAS_TARGETS,
  isLoopProjection,
  loadLoopProjection,
  type LoopProjection,
  type LoopSegment,
  type LoopSegmentId,
  NO_BUDGET_WARNING,
  nodeSegments,
  PERCEIVE_TOOL_RE,
  projectLoop,
  RING_TARGETS,
  ringSegments,
  SEGMENT_ORDER,
} from "./loop-model";

// --- helpers -----------------------------------------------------------------

function seg(projection: LoopProjection, id: LoopSegmentId): LoopSegment {
  const found = projection.ring?.segments.find((s) => s.id === id);
  if (!found) throw new Error(`no ring segment "${id}" in projection`);
  return found;
}

function miniOf(projection: LoopProjection, nodeId: string): readonly LoopSegment[] {
  const node = projection.canvas?.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`no canvas node "${nodeId}" in projection`);
  return node.mini;
}

function miniSeg(segments: readonly LoopSegment[], id: LoopSegmentId): LoopSegment {
  const found = segments.find((s) => s.id === id);
  if (!found) throw new Error(`no mini segment "${id}"`);
  return found;
}

// A fully-loaded cli spec exercising every ring mapping rule at once.
const LOADED_CLI = {
  name: "kitchen-sink",
  target: "cli",
  agent: {
    model: "claude-sonnet-4-6",
    instructions: "do everything",
    model_tiers: { hard: "claude-opus-4-7" },
    model_pool: {
      candidates: [{ model: "a" }, { model: "b" }, { model: "c" }],
      policy: "learned",
    },
    sub_agents: { reviewer: { instructions: "review" } },
  },
  tools: ["read", "write", "webFetch", "webSearch"],
  mcp_servers: { github: { transport: "stdio", command: "gh-mcp" } },
  memory: { backend: "thredz", wiki: { enabled: true }, dream: { every: "1d" } },
  continuity: { proof: "require" },
  thredz: { api_key: "$THREDZ_API_KEY" },
  compaction: { curate: true },
  learning: { domain: "espresso", exam: { dataset: "exam.jsonl", graders: "graders.yaml" } },
  security: { justification: { judge: "claude" }, egressMatcher: "semantic" },
  budget: { usd: 5, on_exceed: { action: "degrade", model: "claude-haiku-4-5" } },
  permissions: { mode: "auto", rules: [{ type: "alwaysDeny", pattern: "rm *" }] },
  transaction_policy: { allowed_contracts: ["c1"] },
};

// --- shape + family routing ----------------------------------------------------

describe("projectLoop shape routing", () => {
  test("single-agent shapes project as a ring, orchestration shapes as a canvas", () => {
    for (const target of RING_TARGETS) {
      const p = projectLoop({ target, agent: { model: "m", instructions: "i" } });
      expect(p.kind).toBe("ring");
      expect(p.target).toBe(target);
      expect(p.ring).toBeDefined();
      expect(p.canvas).toBeUndefined();
    }
    for (const target of CANVAS_TARGETS) {
      const p = projectLoop({ target });
      expect(p.kind).toBe("canvas");
      expect(p.target).toBe(target);
      expect(p.canvas).toBeDefined();
      expect(p.ring).toBeUndefined();
    }
  });

  test("a ring always carries all seven segments in canonical order", () => {
    const p = projectLoop({ target: "cli", agent: { model: "m", instructions: "i" } });
    expect(p.ring?.segments.map((s) => s.id)).toEqual([...SEGMENT_ORDER]);
    expect(SEGMENT_ORDER).toEqual([
      "perceive",
      "reason",
      "act",
      "evaluate",
      "update",
      "stop",
      "safety",
    ]);
  });

  test("a missing target defaults to cli (detectTarget's documented default)", () => {
    const p = projectLoop({ name: "x", agent: { model: "m", instructions: "i" } });
    expect(p.kind).toBe("ring");
    expect(p.target).toBe("cli");
  });

  test("a non-mapping model projects to an inactive ring with a warning, never throws", () => {
    for (const bad of [null, undefined, 42, "target: cli", ["a"]]) {
      const p = projectLoop(bad);
      expect(p.kind).toBe("ring");
      expect(p.target).toBe("unknown");
      expect(p.ring?.segments.every((s) => !s.active)).toBe(true);
      expect(p.warnings.some((w) => w.includes("not"))).toBe(true);
    }
  });

  test("a non-string target projects as a generic ring with a warning", () => {
    const p = projectLoop({ target: 7 });
    expect(p.kind).toBe("ring");
    expect(p.target).toBe("unknown");
    expect(p.warnings.some((w) => w.includes("target: is not a string"))).toBe(true);
  });

  test("known-but-unprojected targets fall back to the ring with a family hint", () => {
    const p = projectLoop({ target: "voice", agent: { model: "m", instructions: "i" } });
    expect(p.kind).toBe("ring");
    expect(p.warnings.some((w) => w.includes('"voice"') && w.includes("no dedicated loop"))).toBe(
      true,
    );
    // Fallback shapes do NOT get the 500-iteration claim — it's a ring-family fact.
    expect(p.warnings).not.toContain(NO_BUDGET_WARNING);
  });

  test("an unknown target string falls back to the ring and says so", () => {
    const p = projectLoop({ target: "chain-game" });
    expect(p.kind).toBe("ring");
    expect(p.warnings.some((w) => w.includes('unknown target "chain-game"'))).toBe(true);
  });
});

// --- ring segment mapping --------------------------------------------------------

describe("ring segments — minimal cli spec", () => {
  const p = projectLoop({
    name: "hello-cli",
    target: "cli",
    agent: { model: "claude-haiku-4-5-20251001", instructions: "be warm" },
  });

  test("every segment is present but inactive", () => {
    for (const id of SEGMENT_ORDER) {
      const s = seg(p, id);
      expect(s.active).toBe(false);
      expect(s.keys).toEqual([]);
      expect(s.summary.length).toBeGreaterThan(0);
    }
  });

  test("reason's inactive summary names the fixed model", () => {
    expect(seg(p, "reason").summary).toContain("claude-haiku-4-5-20251001");
  });

  test("defaults-only stop boundaries produce the exact warning", () => {
    expect(p.warnings).toContain(NO_BUDGET_WARNING);
    expect(seg(p, "stop").summary).toContain("500-iteration");
  });
});

describe("ring segments — fully-loaded cli spec", () => {
  const p = projectLoop(LOADED_CLI);

  test("every segment is active", () => {
    for (const id of SEGMENT_ORDER) {
      expect({ id, active: seg(p, id).active }).toEqual({ id, active: true });
    }
  });

  test("perceive lists only the browse/fetch/web tools", () => {
    const s = seg(p, "perceive");
    expect(s.keys).toEqual(["tools[webFetch]", "tools[webSearch]"]);
    expect(s.summary).toContain("webFetch");
    expect(s.summary).not.toContain("read");
  });

  test("reason lists tiers + pool with candidate count and policy", () => {
    const s = seg(p, "reason");
    expect(s.keys).toEqual(["agent.model_tiers", "agent.model_pool"]);
    expect(s.summary).toContain("3 candidates");
    expect(s.summary).toContain("policy: learned");
    expect(s.summary).toContain("claude-sonnet-4-6");
  });

  test("act lists tools, MCP servers, and sub-agents", () => {
    const s = seg(p, "act");
    expect(s.keys).toEqual(["tools", "mcp_servers", "agent.sub_agents"]);
    expect(s.summary).toContain("4 tools");
    expect(s.summary).toContain("1 MCP server");
    expect(s.summary).toContain("1 sub-agent");
    expect(s.summary).toContain("github");
    expect(s.summary).toContain("reviewer");
  });

  test("evaluate lists learning.exam and security.justification", () => {
    const s = seg(p, "evaluate");
    expect(s.keys).toEqual(["learning.exam", "security.justification"]);
    expect(s.summary).toContain("exam.jsonl");
    expect(s.summary).toContain("judge: claude");
  });

  test("update lists memory/continuity/thredz/compaction with qualifiers", () => {
    const s = seg(p, "update");
    expect(s.keys).toEqual(["memory", "continuity", "thredz", "compaction"]);
    expect(s.summary).toContain("thredz backend");
    expect(s.summary).toContain("wiki");
    expect(s.summary).toContain("dream");
    expect(s.summary).toContain("proof: require");
    expect(s.summary).toContain("curated");
  });

  test("stop lists the budget with its degradation ladder — and no default warning", () => {
    const s = seg(p, "stop");
    expect(s.keys).toEqual(["budget"]);
    expect(s.summary).toContain("$5");
    expect(s.summary).toContain("degrade → claude-haiku-4-5");
    expect(p.warnings).not.toContain(NO_BUDGET_WARNING);
  });

  test("safety lists permissions/security/transaction_policy", () => {
    const s = seg(p, "safety");
    expect(s.keys).toEqual(["permissions", "security", "transaction_policy"]);
    expect(s.summary).toContain("mode: auto");
    expect(s.summary).toContain("1 rule");
    expect(s.summary).toContain("egress: semantic");
    expect(s.summary).toContain("transaction policy");
  });
});

describe("ring segments — channel ingress and future keys", () => {
  test("channel shapes light perceive from channels + heartbeat and read agent.tools", () => {
    const p = projectLoop({
      target: "channel",
      agent: { model: "m", instructions: "i", tools: ["webSearch", "bash"] },
      channels: { slack: { botToken: "$T", signingSecret: "$S" } },
      routing: { sessionKey: "thread" },
      heartbeat: { every: "30m" },
    });
    const s = seg(p, "perceive");
    expect(s.active).toBe(true);
    expect(s.keys).toEqual(["agent.tools[webSearch]", "channels.slack", "heartbeat"]);
    expect(s.summary).toContain("channel ingress: slack");
    expect(s.summary).toContain("heartbeat timer");
    // agent.tools also count toward act, keyed under agent.
    expect(seg(p, "act").keys).toContain("agent.tools");
  });

  test("future keys light their segments: limits→stop, evaluation→evaluate, hooks→safety, agent.thinking→reason", () => {
    const p = projectLoop({
      target: "cli",
      agent: { model: "m", instructions: "i", thinking: { budget_tokens: 4096 } },
      limits: { iterations: 40, wall_clock: "10m" },
      evaluation: { judge: "llm" },
      hooks: { pre_tool: "check.sh" },
    });
    expect(seg(p, "stop").keys).toEqual(["limits"]);
    expect(seg(p, "stop").summary).toContain("iterations");
    expect(p.warnings).not.toContain(NO_BUDGET_WARNING);
    expect(seg(p, "evaluate").keys).toContain("evaluation");
    expect(seg(p, "safety").keys).toContain("hooks");
    expect(seg(p, "reason").keys).toContain("agent.thinking");
    expect(seg(p, "reason").summary).toContain("extended thinking");
  });

  test("managed projects as a ring", () => {
    const p = projectLoop({
      target: "managed",
      agent: { model: "m", instructions: "i" },
      tenants: [{ id: "t1", budget: { maxInputTokens: 1, maxOutputTokens: 1 } }],
    });
    expect(p.kind).toBe("ring");
  });
});

describe("disabled / empty blocks do not light segments", () => {
  test("continuity:false and memory:{enabled:false} leave update inactive", () => {
    const p = projectLoop({
      target: "cli",
      agent: { model: "m", instructions: "i" },
      continuity: false,
      memory: { enabled: false },
    });
    const s = seg(p, "update");
    expect(s.active).toBe(false);
    expect(s.summary).toContain("explicitly disabled");
  });

  test("thredz:false does not count; thredz string/true shorthands do", () => {
    const off = projectLoop({ target: "cli", agent: { model: "m", instructions: "i" }, thredz: false });
    expect(seg(off, "update").active).toBe(false);
    const str = projectLoop({
      target: "cli",
      agent: { model: "m", instructions: "i" },
      thredz: "$THREDZ_API_KEY",
    });
    expect(seg(str, "update").keys).toEqual(["thredz"]);
    const bool = projectLoop({ target: "cli", agent: { model: "m", instructions: "i" }, thredz: true });
    expect(seg(bool, "update").keys).toEqual(["thredz"]);
  });

  test("empty tools/mcp_servers/permissions configure nothing", () => {
    const p = projectLoop({
      target: "cli",
      agent: { model: "m", instructions: "i" },
      tools: [],
      mcp_servers: {},
      permissions: {},
    });
    expect(seg(p, "act").active).toBe(false);
    expect(seg(p, "safety").active).toBe(false);
  });
});

// --- canvas: workflow ---------------------------------------------------------------

describe("workflow canvas", () => {
  const p = projectLoop({
    name: "hello-workflow",
    target: "workflow",
    model: "claude-sonnet-4-6",
    steps: [
      { name: "brainstorm", instructions: "three angles" },
      { name: "summarize", instructions: "pick one", model: "claude-haiku-4-5", tools: ["bash"] },
    ],
  });

  test("steps become a linear chain of step nodes", () => {
    expect(p.kind).toBe("canvas");
    expect(p.canvas?.nodes.map((n) => ({ id: n.id, kind: n.kind }))).toEqual([
      { id: "brainstorm", kind: "step" },
      { id: "summarize", kind: "step" },
    ]);
    expect(p.canvas?.edges).toEqual([{ from: "brainstorm", to: "summarize" }]);
    expect(p.canvas?.nodes[0]?.label).toBe("1. brainstorm");
  });

  test("step minis carry the seven segments with node-scoped mappings", () => {
    const mini = miniOf(p, "summarize");
    expect(mini.map((s) => s.id)).toEqual([...SEGMENT_ORDER]);
    expect(miniSeg(mini, "reason").keys).toEqual(["model"]);
    expect(miniSeg(mini, "reason").summary).toContain("claude-haiku-4-5");
    expect(miniSeg(mini, "act").keys).toEqual(["tools"]);
    // The first step inherits the spec-level model: reason inactive.
    expect(miniSeg(miniOf(p, "brainstorm"), "reason").active).toBe(false);
  });

  test("duplicate step names get unique node ids", () => {
    const dup = projectLoop({
      target: "workflow",
      model: "m",
      steps: [
        { name: "draft", instructions: "a" },
        { name: "draft", instructions: "b" },
      ],
    });
    expect(dup.canvas?.nodes.map((n) => n.id)).toEqual(["draft", "draft-2"]);
    expect(dup.canvas?.edges).toEqual([{ from: "draft", to: "draft-2" }]);
  });

  test("an empty workflow warns", () => {
    const empty = projectLoop({ target: "workflow", model: "m", steps: [] });
    expect(empty.canvas?.nodes).toEqual([]);
    expect(empty.warnings.some((w) => w.includes("no steps"))).toBe(true);
  });
});

// --- canvas: graph ---------------------------------------------------------------

describe("graph canvas", () => {
  const p = projectLoop({
    name: "hello-graph",
    target: "graph",
    model: "claude-sonnet-4-6",
    entry: "plan",
    nodes: {
      plan: { instructions: "plan it" },
      execute: { instructions: "do it", hitl: { prompt: "Ship the plan?" } },
      summarise: { instructions: "sum it" },
    },
    edges: [
      { from: "plan", to: "execute" },
      { from: "execute", to: "summarise", when: "approved" },
    ],
  });

  test("nodes + edges project with entry marked and when→conditional", () => {
    expect(p.kind).toBe("canvas");
    expect(p.canvas?.nodes.map((n) => n.id)).toEqual(["plan", "execute", "summarise"]);
    expect(p.canvas?.nodes[0]?.label).toBe("plan (entry)");
    expect(p.canvas?.edges).toEqual([
      { from: "plan", to: "execute" },
      { from: "execute", to: "summarise", label: "approved", conditional: true },
    ]);
  });

  test("hitl nodes carry the badge and an active safety mini", () => {
    const execute = p.canvas?.nodes.find((n) => n.id === "execute");
    expect(execute?.hitl).toBe(true);
    const safety = miniSeg(miniOf(p, "execute"), "safety");
    expect(safety.active).toBe(true);
    expect(safety.keys).toEqual(["hitl"]);
    expect(safety.summary).toContain("Ship the plan?");
    // Non-hitl nodes carry no badge property at all (clean wire shape).
    const plan = p.canvas?.nodes.find((n) => n.id === "plan");
    expect(plan && "hitl" in plan).toBe(false);
  });

  test("edges to unknown nodes and a missing entry warn", () => {
    const broken = projectLoop({
      target: "graph",
      model: "m",
      entry: "ghost",
      nodes: { a: { instructions: "x" } },
      edges: [{ from: "a", to: "nowhere" }],
    });
    expect(broken.warnings.some((w) => w.includes('unknown node "nowhere"'))).toBe(true);
    expect(broken.warnings.some((w) => w.includes('entry "ghost"'))).toBe(true);
  });
});

// --- canvas: crew ---------------------------------------------------------------

describe("crew canvas", () => {
  test("roles project as role nodes; match routing becomes conditional edges", () => {
    const p = projectLoop({
      target: "crew",
      model: "m",
      entry: "researcher",
      roles: {
        researcher: { instructions: "dig", tools: ["webSearch"] },
        writer: { instructions: "write" },
      },
      routing: {
        kind: "match",
        match: { researcher: [{ contains: "draft", to: "writer" }] },
      },
    });
    expect(p.canvas?.nodes.map((n) => ({ id: n.id, kind: n.kind }))).toEqual([
      { id: "researcher", kind: "role" },
      { id: "writer", kind: "role" },
    ]);
    expect(p.canvas?.nodes[0]?.label).toBe("researcher (entry)");
    expect(p.canvas?.edges).toEqual([
      { from: "researcher", to: "writer", label: 'contains "draft"', conditional: true },
    ]);
    expect(miniSeg(miniOf(p, "researcher"), "perceive").keys).toEqual(["tools[webSearch]"]);
  });

  test("no routing block yields the routing note and zero edges", () => {
    const p = projectLoop({
      target: "crew",
      model: "m",
      entry: "solo",
      roles: { solo: { instructions: "x" } },
    });
    expect(p.canvas?.edges).toEqual([]);
    expect(p.warnings.some((w) => w.includes("no routing:") && w.includes('"solo"'))).toBe(true);
  });

  test("llm routing fans conditional edges out from the entry with a note", () => {
    const p = projectLoop({
      target: "crew",
      model: "m",
      entry: "router",
      roles: { router: { instructions: "r" }, a: { instructions: "a" }, b: { instructions: "b" } },
      routing: { kind: "llm" },
    });
    expect(p.canvas?.edges).toEqual([
      { from: "router", to: "a", label: "llm router", conditional: true },
      { from: "router", to: "b", label: "llm router", conditional: true },
    ]);
    expect(p.warnings.some((w) => w.includes("routing.kind: llm"))).toBe(true);
  });
});

// --- canvas: pipeline / research / batch ----------------------------------------------

describe("pipeline canvas", () => {
  const p = projectLoop({
    target: "pipeline",
    agent: { model: "m", instructions: "answer with citations" },
    retrieve: { embedderModel: "voyage-3", vectorBackend: "qdrant", defaultK: 8 },
    indexing: {
      chunkStrategy: "markdown",
      documents: [
        { id: "handbook", text: "…" },
        { id: "faq", text: "…" },
      ],
    },
  });

  test("documents become doc nodes feeding index → agent", () => {
    expect(p.canvas?.nodes.map((n) => ({ id: n.id, kind: n.kind }))).toEqual([
      { id: "doc:handbook", kind: "doc" },
      { id: "doc:faq", kind: "doc" },
      { id: "index", kind: "node" },
      { id: "agent", kind: "node" },
    ]);
    expect(p.canvas?.edges).toEqual([
      { from: "doc:handbook", to: "index" },
      { from: "doc:faq", to: "index" },
      { from: "index", to: "agent", label: "retrieve (k=8, qdrant)" },
    ]);
    expect(p.canvas?.nodes[2]?.label).toBe("index (markdown)");
  });

  test("no documents warns but the agent still renders", () => {
    const empty = projectLoop({ target: "pipeline", agent: { model: "m", instructions: "i" } });
    expect(empty.warnings.some((w) => w.includes("no indexing.documents"))).toBe(true);
    expect(empty.canvas?.nodes.map((n) => n.id)).toEqual(["index", "agent"]);
  });
});

describe("research canvas", () => {
  test("goal fans out to branchingFactor branches that converge on the report", () => {
    const p = projectLoop({
      target: "research",
      agent: { model: "m", instructions: "i" },
      goal: "map the espresso market",
      branchingFactor: 2,
      tools: ["webSearch"],
    });
    expect(p.canvas?.nodes.map((n) => ({ id: n.id, kind: n.kind }))).toEqual([
      { id: "goal", kind: "node" },
      { id: "branch-1", kind: "node" },
      { id: "branch-2", kind: "node" },
      { id: "report", kind: "doc" },
    ]);
    expect(p.canvas?.nodes[0]?.label).toContain("espresso");
    expect(p.canvas?.edges).toEqual([
      { from: "goal", to: "branch-1" },
      { from: "branch-1", to: "report" },
      { from: "goal", to: "branch-2" },
      { from: "branch-2", to: "report" },
    ]);
    // Top-level tools merge into the agent-node minis (research declares them there).
    expect(miniSeg(miniOf(p, "branch-1"), "perceive").keys).toEqual(["tools[webSearch]"]);
  });

  test("branchingFactor defaults to 3 and clamps into the schema's 1..8", () => {
    const dflt = projectLoop({ target: "research", agent: { model: "m", instructions: "i" }, goal: "g" });
    expect(dflt.canvas?.nodes.filter((n) => n.id.startsWith("branch-")).length).toBe(3);
    const wild = projectLoop({
      target: "research",
      agent: { model: "m", instructions: "i" },
      goal: "g",
      branchingFactor: 999,
    });
    expect(wild.canvas?.nodes.filter((n) => n.id.startsWith("branch-")).length).toBe(8);
  });
});

describe("batch canvas", () => {
  test("queue and worker nodes with a jobs edge and a conditional retry edge", () => {
    const p = projectLoop({
      target: "batch",
      agent: { model: "m", instructions: "i" },
      queue: { adapter: "sqs", maxRetries: 5 },
      concurrency: 8,
      tools: ["webFetch"],
    });
    expect(p.canvas?.nodes.map((n) => n.id)).toEqual(["queue", "agent"]);
    expect(p.canvas?.nodes[0]?.label).toBe("queue (sqs)");
    expect(p.canvas?.nodes[1]?.label).toBe("worker × 8");
    expect(p.canvas?.edges).toEqual([
      { from: "queue", to: "agent", label: "jobs" },
      { from: "agent", to: "queue", label: "retries (≤ 5)", conditional: true },
    ]);
    expect(miniSeg(miniOf(p, "agent"), "act").keys).toEqual(["tools"]);
  });

  test("defaults render when queue knobs are omitted", () => {
    const p = projectLoop({ target: "batch", agent: { model: "m", instructions: "i" }, queue: { adapter: "in-memory" } });
    expect(p.canvas?.nodes[1]?.label).toBe("worker × 4");
    expect(p.canvas?.edges[1]?.label).toBe("retries (≤ 3)");
  });
});

// --- exported helpers ---------------------------------------------------------------

describe("exported building blocks", () => {
  test("PERCEIVE_TOOL_RE matches ingestion tools, not fs/exec tools", () => {
    for (const hit of ["webFetch", "webSearch", "browse", "navigate", "retrieve", "crawl", "fetch"]) {
      expect({ hit, match: PERCEIVE_TOOL_RE.test(hit) }).toEqual({ hit, match: true });
    }
    for (const miss of ["read", "write", "edit", "bash", "glob", "grep", "todoWrite"]) {
      expect({ miss, match: PERCEIVE_TOOL_RE.test(miss) }).toEqual({ miss, match: false });
    }
  });

  test("ringSegments and nodeSegments always return the seven segments in order", () => {
    expect(ringSegments({}).map((s) => s.id)).toEqual([...SEGMENT_ORDER]);
    expect(nodeSegments(undefined).map((s) => s.id)).toEqual([...SEGMENT_ORDER]);
    expect(nodeSegments({}).every((s) => !s.active)).toBe(true);
  });

  test("the projection is plain JSON (the future /loop wire shape)", () => {
    const p = projectLoop(LOADED_CLI);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

// --- in-loop evaluation: evaluation block ------------------------------------------

describe("ring evaluate — evaluation block (loop contract 0.4)", () => {
  test("an llm_judge block describes grader type, threshold, on_fail, and retry cap", () => {
    const p = projectLoop({
      target: "cli",
      agent: { model: "m", instructions: "i" },
      evaluation: {
        grader: { type: "llm_judge", criteria: "accurate and complete" },
        threshold: 0.7,
        on_fail: "retry",
        max_retries: 2,
      },
    });
    const s = seg(p, "evaluate");
    expect(s.active).toBe(true);
    expect(s.keys).toContain("evaluation");
    expect(s.summary).toContain("llm_judge");
    expect(s.summary).toContain("threshold 0.7");
    expect(s.summary).toContain("on fail: retry");
    expect(s.summary).toContain("≤ 2 retries");
  });

  test("a deterministic grader shows its type, no threshold, and the default on_fail", () => {
    const p = projectLoop({
      target: "cli",
      agent: { model: "m", instructions: "i" },
      evaluation: { grader: { type: "contains", value: "DONE" } },
    });
    const s = seg(p, "evaluate");
    expect(s.summary).toContain("contains");
    expect(s.summary).not.toContain("threshold");
    expect(s.summary).toContain("on fail: retry"); // documented default, matching the IR projection
  });
});

// --- canvas: workflow judge steps ---------------------------------------------------

describe("workflow canvas — judge steps (kind: judge)", () => {
  const p = projectLoop({
    target: "workflow",
    model: "m",
    steps: [
      { name: "draft", instructions: "write it" },
      { name: "revise", instructions: "improve it" },
      {
        name: "gate",
        kind: "judge",
        judge: { criteria: "accurate", threshold: 0.8, on_fail: "retry_previous", max_retries: 2 },
      },
    ],
  });

  test("a kind: judge step renders as a distinct 'judge' node", () => {
    expect(p.canvas?.nodes.map((n) => ({ id: n.id, kind: n.kind }))).toEqual([
      { id: "draft", kind: "step" },
      { id: "revise", kind: "step" },
      { id: "gate", kind: "judge" },
    ]);
  });

  test("the judge's evaluate mini describes the gate; reason/act stay inactive", () => {
    const mini = miniOf(p, "gate");
    const ev = miniSeg(mini, "evaluate");
    expect(ev.active).toBe(true);
    expect(ev.keys).toEqual(["judge"]);
    expect(ev.summary).toContain("judge gate");
    expect(ev.summary).toContain("threshold 0.8");
    expect(ev.summary).toContain("on fail: retry_previous");
    expect(miniSeg(mini, "reason").active).toBe(false);
    expect(miniSeg(mini, "act").active).toBe(false);
  });

  test("a 'gates' edge points from the judge back to the step it scores", () => {
    expect(p.canvas?.edges).toEqual([
      { from: "draft", to: "revise" },
      { from: "revise", to: "gate" },
      { from: "gate", to: "revise", label: "gates", conditional: true },
    ]);
  });

  test("a judge step in the first position warns and emits no gates edge", () => {
    const bad = projectLoop({
      target: "workflow",
      model: "m",
      steps: [{ name: "gate", kind: "judge", judge: { criteria: "x" } }],
    });
    expect(bad.canvas?.nodes[0]?.kind).toBe("judge");
    expect(bad.warnings.some((w) => w.includes("gate") && w.includes("no previous step"))).toBe(true);
    expect(bad.canvas?.edges).toEqual([]);
  });
});

// --- canvas: graph judge nodes ------------------------------------------------------

describe("graph canvas — judge nodes (kind: judge)", () => {
  const p = projectLoop({
    target: "graph",
    model: "m",
    entry: "draft",
    nodes: {
      draft: { instructions: "write it" },
      gate: { kind: "judge", judge: { criteria: "accurate", on_fail: "halt" } },
      publish: { instructions: "ship it" },
    },
    edges: [
      { from: "draft", to: "gate" },
      { from: "gate", to: "publish" },
    ],
  });

  test("a kind: judge node renders as a distinct 'judge' node with no hitl badge", () => {
    const gate = p.canvas?.nodes.find((n) => n.id === "gate");
    expect(gate?.kind).toBe("judge");
    expect(gate && "hitl" in gate).toBe(false);
    const ev = miniSeg(miniOf(p, "gate"), "evaluate");
    expect(ev.keys).toEqual(["judge"]);
    expect(ev.summary).toContain("judge gate");
    expect(ev.summary).toContain("on fail: halt");
  });

  test("a 'gates' edge points from the judge back to its upstream, keeping the declared edges", () => {
    expect(p.canvas?.edges).toContainEqual({ from: "draft", to: "gate" });
    expect(p.canvas?.edges).toContainEqual({ from: "gate", to: "publish" });
    expect(p.canvas?.edges).toContainEqual({
      from: "gate",
      to: "draft",
      label: "gates",
      conditional: true,
    });
  });

  test("a judge node with no upstream edge warns", () => {
    const bad = projectLoop({
      target: "graph",
      model: "m",
      entry: "a",
      nodes: { a: { instructions: "x" }, gate: { kind: "judge", judge: { criteria: "c" } } },
      edges: [],
    });
    expect(bad.warnings.some((w) => w.includes('judge node "gate"') && w.includes("no upstream"))).toBe(
      true,
    );
  });

  test("a judge node named as the entry warns", () => {
    const bad = projectLoop({
      target: "graph",
      model: "m",
      entry: "gate",
      nodes: { gate: { kind: "judge", judge: { criteria: "c" } }, a: { instructions: "x" } },
      edges: [{ from: "a", to: "gate" }],
    });
    expect(
      bad.warnings.some((w) => w.includes('entry "gate"') && w.includes("cannot be the entry")),
    ).toBe(true);
  });
});

// --- loadLoopProjection: compiler-first with local fallback -------------------------

describe("loadLoopProjection", () => {
  const CLI_YAML = "target: cli\nagent:\n  model: m\n  instructions: i\n";

  /** A minimal Response-like stub for the injected fetch. */
  function response(body: unknown, ok = true, status = 200): Response {
    return { ok, status, json: async () => body } as unknown as Response;
  }

  test("returns the compiler-worker's projection on success (POST <url>/loop { yaml })", async () => {
    const serverLoop: LoopProjection = {
      kind: "ring",
      target: "cli",
      ring: { segments: [] },
      warnings: ["projected-by-server"],
    };
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calledUrl = String(url);
      calledInit = init;
      return response({ ok: true, loop: serverLoop, issues: [] });
    }) as unknown as typeof fetch;
    const p = await loadLoopProjection({ yaml: CLI_YAML, url: "https://c.example/", fetchImpl });
    expect(p.warnings).toContain("projected-by-server");
    expect(calledUrl).toBe("https://c.example/loop"); // trailing slash collapsed
    expect(calledInit?.method).toBe("POST");
    expect(JSON.parse(String(calledInit?.body))).toEqual({ yaml: CLI_YAML });
  });

  test("falls back to the local projection on a non-2xx response", async () => {
    const fetchImpl = (async () => response({}, false, 500)) as unknown as typeof fetch;
    const p = await loadLoopProjection({ yaml: CLI_YAML, url: "https://c.example", fetchImpl });
    expect(p.warnings).not.toContain("projected-by-server");
    expect(p.kind).toBe("ring");
    expect(p.warnings).toContain(NO_BUDGET_WARNING); // the local cli projection
  });

  test("falls back when the body is a parse error ({ ok: false })", async () => {
    const fetchImpl = (async () =>
      response({ ok: false, issues: [{ message: "bad" }] })) as unknown as typeof fetch;
    const p = await loadLoopProjection({ yaml: CLI_YAML, url: "https://c.example", fetchImpl });
    expect(p.kind).toBe("ring");
    expect(p.warnings).toContain(NO_BUDGET_WARNING);
  });

  test("falls back when the returned loop fails the shape guard", async () => {
    const fetchImpl = (async () =>
      response({ ok: true, loop: { kind: "banana" } })) as unknown as typeof fetch;
    const p = await loadLoopProjection({ yaml: CLI_YAML, url: "https://c.example", fetchImpl });
    expect(p.kind).toBe("ring");
    expect(p.target).toBe("cli");
  });

  test("falls back when fetch throws (offline)", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const p = await loadLoopProjection({ yaml: CLI_YAML, url: "https://c.example", fetchImpl });
    expect(p.kind).toBe("ring");
    expect(p.target).toBe("cli");
  });

  test("uses the local projection directly when no url is given (never fetches)", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return response({ ok: true, loop: {} });
    }) as unknown as typeof fetch;
    const p = await loadLoopProjection({
      yaml: "target: workflow\nmodel: m\nsteps:\n  - name: a\n    instructions: x\n",
      fetchImpl,
    });
    expect(fetched).toBe(false);
    expect(p.kind).toBe("canvas");
    expect(p.target).toBe("workflow");
  });

  test("an unparseable spec still resolves (inactive ring, never throws)", async () => {
    const p = await loadLoopProjection({ yaml: "a: [1, 2" });
    expect(p.kind).toBe("ring");
    expect(p.ring?.segments.every((s) => !s.active)).toBe(true);
  });

  test("isLoopProjection accepts real projections and rejects junk", () => {
    expect(
      isLoopProjection(projectLoop({ target: "cli", agent: { model: "m", instructions: "i" } })),
    ).toBe(true);
    expect(isLoopProjection(projectLoop({ target: "workflow", model: "m", steps: [] }))).toBe(true);
    for (const junk of [
      null,
      {},
      { kind: "ring" },
      { kind: "ring", target: "cli", warnings: [] }, // no ring.segments
      { kind: "canvas", target: "x", warnings: [], canvas: { nodes: [] } }, // no canvas.edges
    ]) {
      expect(isLoopProjection(junk)).toBe(false);
    }
  });
});
