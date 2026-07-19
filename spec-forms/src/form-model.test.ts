import { describe, expect, test } from "bun:test";
import { parseSpecModel, serializeSpecModel, type SpecPath } from "./spec-model";
import { FALLBACK_SCHEMA } from "./spec-schema";
import {
  addEdge,
  addJudgeNode,
  addJudgeStep,
  addNode,
  addRole,
  addStep,
  applyFieldEdit,
  BUILTIN_TOOL_NAMES,
  fieldsForBlock,
  type FormField,
  HOOK_EVENTS,
  NEW_INSTRUCTIONS_PLACEHOLDER,
  NEW_JUDGE_CRITERIA_PLACEHOLDER,
  removeNamed,
  renameNamed,
  SAFE_NAME_RE,
} from "./form-model";

// --- fixtures ---------------------------------------------------------------
// Written in the yaml stringifier's canonical style (2-space indent, indented
// sequences) so byte-level round-trip assertions are fair — same convention
// as spec-model.test.ts. Comments sit on the lines the edits must NOT touch.

const CLI_SPEC = `# my assistant
name: helper
target: cli
agent:
  # the reasoning model
  model: claude-haiku-4-5-20251001
  instructions: Be concise. # stay short
tools:
  - read
  - webFetch
# spend ceiling
budget:
  usd: 5
totally_unknown_block:
  keep: me
`;

const WORKFLOW_SPEC = `name: pipeline
target: workflow
model: claude-sonnet-4-6
steps:
  # step one comment
  - name: brainstorm
    instructions: Think of three angles. # keep this
  - name: pick
    instructions: Choose the strongest.
`;

const GRAPH_SPEC = `name: dag
target: graph
model: claude-sonnet-4-6
entry: draft
nodes:
  # the writer
  draft:
    instructions: Write it. # inline note
  review:
    instructions: Check it.
  publish:
    instructions: Ship it.
edges:
  - from: draft
    to: review
  - from: review
    to: publish
    when:
      key: review
      equals: approved
parallel:
  - - review
    - publish
`;

const CREW_SPEC = `name: newsroom
target: crew
model: claude-sonnet-4-6
entry: writer
roles:
  writer:
    instructions: Draft the story. # writer note
  editor:
    instructions: Edit the story.
routing:
  kind: match
  match:
    writer:
      - contains: publish
        to: editor
    editor:
      - contains: rewrite
        to: writer
`;

/** parse + assert validity, returning the non-null doc for edit tests. */
function docOf(text: string) {
  const parsed = parseSpecModel(text);
  expect(parsed.errors).toEqual([]);
  if (parsed.doc === null) throw new Error("unreachable: fixture must parse");
  return parsed.doc;
}

/** Serialize + re-parse, asserting the edited document is still valid YAML. */
function reserialized(doc: ReturnType<typeof docOf>): string {
  const text = serializeSpecModel(doc);
  expect(parseSpecModel(text).errors).toEqual([]);
  return text;
}

function fieldAt(fields: FormField[], path: SpecPath): FormField {
  const found = fields.find((f) => JSON.stringify(f.path) === JSON.stringify(path));
  if (!found) {
    throw new Error(`no field at ${JSON.stringify(path)} in ${JSON.stringify(fields.map((f) => f.path))}`);
  }
  return found;
}

const S = FALLBACK_SCHEMA;

// --- fieldsForBlock: spec core ------------------------------------------------

describe("fieldsForBlock — spec core ([])", () => {
  test("cli core is name+version; name is required", () => {
    const fields = fieldsForBlock(S, "cli", []);
    expect(fields.map((f) => f.path)).toEqual([["name"], ["version"]]);
    expect(fieldAt(fields, ["name"]).required).toBe(true);
    expect(fieldAt(fields, ["version"]).integer).toBe(true);
  });

  test("workflow/graph/crew add their top-level model (and entry) as required", () => {
    expect(fieldAt(fieldsForBlock(S, "workflow", []), ["model"]).required).toBe(true);
    const graph = fieldsForBlock(S, "graph", []);
    expect(fieldAt(graph, ["model"]).required).toBe(true);
    expect(fieldAt(graph, ["entry"]).required).toBe(true);
    const crew = fieldsForBlock(S, "crew", []);
    expect(fieldAt(crew, ["entry"]).required).toBe(true);
  });

  test("research adds goal (required) and branchingFactor (integer)", () => {
    const fields = fieldsForBlock(S, "research", []);
    expect(fieldAt(fields, ["goal"]).required).toBe(true);
    expect(fieldAt(fields, ["branchingFactor"]).integer).toBe(true);
  });
});

// --- fieldsForBlock: agent ------------------------------------------------------

describe("fieldsForBlock — agent", () => {
  test("cli agent: model/instructions required; thinking+streaming+rate_limits marked 0.4.0", () => {
    const fields = fieldsForBlock(S, "cli", ["agent"]);
    expect(fieldAt(fields, ["agent", "model"]).required).toBe(true);
    expect(fieldAt(fields, ["agent", "instructions"]).required).toBe(true);
    // max_tokens is a 0.3-era cli key — NO marker.
    expect(fieldAt(fields, ["agent", "max_tokens"]).requiresVersion).toBeUndefined();
    expect(fieldAt(fields, ["agent", "thinking", "budget_tokens"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["agent", "thinking", "effort"]).enumValues).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(fieldAt(fields, ["agent", "streaming"]).requiresVersion).toBe("0.4.0");
    const rateLimits = fieldAt(fields, ["agent", "rate_limits"]);
    expect(rateLimits.kind).toBe("record");
    expect(rateLimits.requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["agent", "model_fallbacks"]).kind).toBe("string-list");
  });

  test("channel agent nests tools (with builtin suggestions); no streaming field", () => {
    const fields = fieldsForBlock(S, "channel", ["agent"]);
    const tools = fieldAt(fields, ["agent", "tools"]);
    expect(tools.kind).toBe("string-list");
    expect(tools.suggestions).toEqual(BUILTIN_TOOL_NAMES);
    expect(fields.some((f) => f.path.at(-1) === "streaming")).toBe(false);
  });

  test("managed agent carries thinking but neither streaming nor tools", () => {
    const fields = fieldsForBlock(S, "managed", ["agent"]);
    expect(fields.some((f) => f.path.includes("thinking"))).toBe(true);
    expect(fields.some((f) => f.path.at(-1) === "streaming")).toBe(false);
    expect(fields.some((f) => f.path.at(-1) === "tools")).toBe(false);
  });

  test("research/batch/browser agents: max_tokens exists and is 0.4.0-marked; no thinking", () => {
    for (const target of ["research", "batch", "browser"]) {
      const fields = fieldsForBlock(S, target, ["agent"]);
      expect(fieldAt(fields, ["agent", "max_tokens"]).requiresVersion).toBe("0.4.0");
      expect(fields.some((f) => f.path.includes("thinking"))).toBe(false);
      expect(fields.some((f) => f.path.at(-1) === "rate_limits")).toBe(false);
    }
  });

  test("pipeline/voice/eval agents: only model+instructions (no max_tokens)", () => {
    for (const target of ["pipeline", "voice", "eval", "onchain", "onchain-game"]) {
      const fields = fieldsForBlock(S, target, ["agent"]);
      expect(fields.map((f) => f.path.at(-1))).toEqual(["model", "instructions"]);
    }
  });
});

// --- fieldsForBlock: catalogued blocks ----------------------------------------------

describe("fieldsForBlock — catalogued blocks", () => {
  test("tools is one string-list field with the builtin names as suggestions", () => {
    const fields = fieldsForBlock(S, "cli", ["tools"]);
    expect(fields.length).toBe(1);
    expect(fields[0]?.kind).toBe("string-list");
    expect(fields[0]?.suggestions).toEqual(BUILTIN_TOOL_NAMES);
    expect(BUILTIN_TOOL_NAMES).toContain("webFetch");
    expect(BUILTIN_TOOL_NAMES).toContain("bash");
  });

  test("mcp_servers is one record field (yaml mapping fallback)", () => {
    const fields = fieldsForBlock(S, "cli", ["mcp_servers"]);
    expect(fields.length).toBe(1);
    expect(fields[0]?.kind).toBe("record");
  });

  test("permissions: mode enum (no bypass!) + rules yaml", () => {
    const fields = fieldsForBlock(S, "cli", ["permissions"]);
    expect(fieldAt(fields, ["permissions", "mode"]).enumValues).toEqual([
      "default",
      "plan",
      "auto",
    ]);
    expect(fieldAt(fields, ["permissions", "rules"]).kind).toBe("yaml");
  });

  test("budget: usd required number; on_exceed action enum + degrade model", () => {
    const fields = fieldsForBlock(S, "cli", ["budget"]);
    const usd = fieldAt(fields, ["budget", "usd"]);
    expect(usd.required).toBe(true);
    expect(usd.kind).toBe("number");
    expect(usd.integer).toBeUndefined(); // fractional dollars are legal
    expect(fieldAt(fields, ["budget", "on_exceed", "action"]).enumValues).toEqual([
      "stop",
      "degrade",
    ]);
    expect(fieldAt(fields, ["budget", "on_exceed", "model"]).kind).toBe("string");
  });

  test("memory: backend enum; top-level embedder is the ONLY 0.4.0-marked field", () => {
    const fields = fieldsForBlock(S, "cli", ["memory"]);
    expect(fieldAt(fields, ["memory", "backend"]).enumValues).toEqual(["file", "thredz"]);
    for (const f of fields) {
      const marked = f.requiresVersion !== undefined;
      expect({ path: f.path, marked }).toEqual({
        path: f.path,
        marked: f.path.at(-1) === "embedder",
      });
    }
    expect(fieldAt(fields, ["memory", "wiki"]).kind).toBe("yaml");
    expect(fieldAt(fields, ["memory", "dream"]).kind).toBe("yaml");
  });

  test("continuity: proof/scope enums + boolean toggles, no version markers", () => {
    const fields = fieldsForBlock(S, "cli", ["continuity"]);
    expect(fieldAt(fields, ["continuity", "proof"]).enumValues).toEqual([
      "ladder",
      "require",
      "off",
    ]);
    expect(fieldAt(fields, ["continuity", "scope"]).enumValues).toEqual([
      "auto",
      "spec",
      "session",
    ]);
    expect(fields.every((f) => f.requiresVersion === undefined)).toBe(true);
  });

  test("thredz: api_key required with $ENV placeholder; learning: domain required", () => {
    const thredz = fieldsForBlock(S, "cli", ["thredz"]);
    const apiKey = fieldAt(thredz, ["thredz", "api_key"]);
    expect(apiKey.required).toBe(true);
    expect(apiKey.placeholder).toBe("$THREDZ_API_KEY");
    const learning = fieldsForBlock(S, "cli", ["learning"]);
    expect(fieldAt(learning, ["learning", "domain"]).required).toBe(true);
    expect(fieldAt(learning, ["learning", "sources"]).kind).toBe("string-list");
  });

  test("compaction: threshold + snip knobs marked 0.4.0, 0.3-era knobs unmarked", () => {
    const fields = fieldsForBlock(S, "cli", ["compaction"]);
    expect(fieldAt(fields, ["compaction", "threshold"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["compaction", "snip_keep_head"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["compaction", "snip_keep_tail"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["compaction", "model"]).requiresVersion).toBeUndefined();
    expect(fieldAt(fields, ["compaction", "curate"]).requiresVersion).toBeUndefined();
    // threshold is fractional (0.5–0.99) — must NOT demand an integer.
    expect(fieldAt(fields, ["compaction", "threshold"]).integer).toBeUndefined();
  });

  test("feedback: modality enum; observability: slo fields + mitigation suggestions", () => {
    const feedback = fieldsForBlock(S, "cli", ["feedback"]);
    expect(fieldAt(feedback, ["feedback", "modality"]).enumValues).toEqual([
      "binary",
      "stars",
      "scale",
      "comment",
    ]);
    const obs = fieldsForBlock(S, "cli", ["observability"]);
    expect(fieldAt(obs, ["observability", "slo", "error_rate"]).kind).toBe("number");
    expect(fieldAt(obs, ["observability", "slo", "mitigation"]).suggestions).toEqual([
      "alert",
      "pause-intake",
      "rollback",
    ]);
  });

  test("security: judge + egressMatcher enums", () => {
    const fields = fieldsForBlock(S, "cli", ["security"]);
    expect(fieldAt(fields, ["security", "justification", "judge"]).enumValues).toEqual([
      "rule-based",
      "claude",
    ]);
    expect(fieldAt(fields, ["security", "egressMatcher"]).enumValues).toEqual([
      "substring",
      "semantic",
    ]);
  });

  test("heartbeat/gateway (channel): required every+instructions / port", () => {
    const heartbeat = fieldsForBlock(S, "channel", ["heartbeat"]);
    expect(fieldAt(heartbeat, ["heartbeat", "every"]).required).toBe(true);
    expect(fieldAt(heartbeat, ["heartbeat", "instructions"]).required).toBe(true);
    const gateway = fieldsForBlock(S, "channel", ["gateway"]);
    expect(fieldAt(gateway, ["gateway", "port"]).required).toBe(true);
    expect(fieldAt(gateway, ["gateway", "ui"]).kind).toBe("boolean");
  });

  test("failure_taxonomy and other deep blocks degrade to one yaml field with the catalog description", () => {
    for (const key of ["failure_taxonomy", "channels", "retrieve", "queue", "tenants"]) {
      const fields = fieldsForBlock(S, "cli", [key]);
      expect(fields.length).toBe(1);
      expect(fields[0]?.kind).toBe("yaml");
      expect(fields[0]?.path).toEqual([key]);
      // Known blocks pick up the palette description.
      if (S.blocks[key]) expect(fields[0]?.description).toBe(S.blocks[key]);
    }
  });

  test("a totally unknown block still yields an editable yaml field", () => {
    const fields = fieldsForBlock(S, "cli", ["x-vendor-extension"]);
    expect(fields).toEqual([
      { path: ["x-vendor-extension"], label: "X vendor extension", kind: "yaml" },
    ]);
  });
});

// --- fieldsForBlock: limits / hooks / routing (per-target) ----------------------------

describe("fieldsForBlock — limits, hooks, routing", () => {
  test("limits: every field 0.4.0-marked incl. nested loop_detection", () => {
    const fields = fieldsForBlock(S, "cli", ["limits"]);
    expect(fields.length).toBeGreaterThanOrEqual(9);
    for (const f of fields) expect(f.requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["limits", "max_tool_iterations"]).integer).toBe(true);
    expect(fieldAt(fields, ["limits", "loop_detection", "escalation"]).enumValues).toEqual([
      "warn",
      "justify",
      "abort",
    ]);
    // The crew orchestration sub-block is NOT offered off-crew…
    expect(fields.some((f) => f.path.includes("crew"))).toBe(false);
  });

  test("limits on crew adds the crew: orchestration ceilings", () => {
    const fields = fieldsForBlock(S, "crew", ["limits"]);
    expect(fieldAt(fields, ["limits", "crew", "max_activations"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["limits", "crew", "refusal_depth"]).integer).toBe(true);
    expect(fieldAt(fields, ["limits", "crew", "max_a2a_depth"]).kind).toBe("number");
  });

  test("hooks entry: event enum over the ten lifecycle events; command required; all 0.4.0", () => {
    const fields = fieldsForBlock(S, "cli", ["hooks", 0]);
    const event = fieldAt(fields, ["hooks", 0, "event"]);
    expect(event.enumValues).toEqual(HOOK_EVENTS);
    expect(HOOK_EVENTS.length).toBe(10);
    expect(event.required).toBe(true);
    expect(fieldAt(fields, ["hooks", 0, "command"]).required).toBe(true);
    expect(fieldAt(fields, ["hooks", 0, "timeout_ms"]).integer).toBe(true);
    for (const f of fields) expect(f.requiresVersion).toBe("0.4.0");
  });

  test("hooks as a whole block falls back to yaml, inheriting the block's 0.4.0 marker", () => {
    const fields = fieldsForBlock(S, "cli", ["hooks"]);
    expect(fields.length).toBe(1);
    expect(fields[0]?.kind).toBe("yaml");
    expect(fields[0]?.requiresVersion).toBe("0.4.0");
  });

  test("parallel (graph) inherits its 0.4.0 marker from the schema's blockVersions", () => {
    const fields = fieldsForBlock(S, "graph", ["parallel"]);
    expect(fields.length).toBe(1);
    expect(fields[0]?.requiresVersion).toBe("0.4.0");
  });

  test("routing on channel is the sessionKey enum; on crew kind enum marks llm as 0.4.0", () => {
    const channel = fieldsForBlock(S, "channel", ["routing"]);
    expect(fieldAt(channel, ["routing", "sessionKey"]).enumValues).toEqual([
      "thread",
      "user",
      "channel",
    ]);
    const crew = fieldsForBlock(S, "crew", ["routing"]);
    const kind = fieldAt(crew, ["routing", "kind"]);
    expect(kind.enumValues).toEqual(["match", "llm"]);
    // The llm VALUE parses on 0.3.x but only routes at runtime on >= 0.4.0.
    expect(kind.enumVersions).toEqual({ llm: "0.4.0" });
    expect(kind.requiresVersion).toBeUndefined();
    expect(fieldAt(crew, ["routing", "match"]).kind).toBe("record");
    // Any other target has no structured routing form — yaml fallback.
    expect(fieldsForBlock(S, "cli", ["routing"])[0]?.kind).toBe("yaml");
  });
});

// --- fieldsForBlock: steps / nodes / roles / edges -------------------------------------

describe("fieldsForBlock — canvas entries", () => {
  test("workflow step: name+instructions required; thinking AND max_tokens 0.4.0-marked", () => {
    const fields = fieldsForBlock(S, "workflow", ["steps", 0]);
    expect(fieldAt(fields, ["steps", 0, "name"]).required).toBe(true);
    expect(fieldAt(fields, ["steps", 0, "instructions"]).required).toBe(true);
    expect(fieldAt(fields, ["steps", 0, "model"]).required).toBeUndefined();
    // Ground truth: step-level max_tokens + thinking are both Batch-A (0.4.0).
    expect(fieldAt(fields, ["steps", 0, "max_tokens"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["steps", 0, "thinking", "effort"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["steps", 0, "tools"]).suggestions).toEqual(BUILTIN_TOOL_NAMES);
  });

  test("graph node: no name field (the map key is the name); hitl prompt offered", () => {
    const fields = fieldsForBlock(S, "graph", ["nodes", "draft"]);
    expect(fields.some((f) => f.path.at(-1) === "name")).toBe(false);
    expect(fieldAt(fields, ["nodes", "draft", "instructions"]).required).toBe(true);
    expect(fieldAt(fields, ["nodes", "draft", "hitl", "prompt"]).kind).toBe("string");
  });

  test("crew role: instructions required, no hitl", () => {
    const fields = fieldsForBlock(S, "crew", ["roles", "writer"]);
    expect(fieldAt(fields, ["roles", "writer", "instructions"]).required).toBe(true);
    expect(fields.some((f) => f.path.includes("hitl"))).toBe(false);
  });

  test("graph edge: from/to required; when.* marked 0.4.0", () => {
    const fields = fieldsForBlock(S, "graph", ["edges", 1]);
    expect(fieldAt(fields, ["edges", 1, "from"]).required).toBe(true);
    expect(fieldAt(fields, ["edges", 1, "to"]).required).toBe(true);
    expect(fieldAt(fields, ["edges", 1, "when", "key"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["edges", 1, "when", "equals"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["edges", 1, "when", "exists"]).requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["edges", 1, "when", "equals"]).kind).toBe("yaml");
  });

  test("a deeper path under an entry resolves to the entry's form", () => {
    const fields = fieldsForBlock(S, "graph", ["nodes", "draft", "hitl"]);
    expect(fieldAt(fields, ["nodes", "draft", "instructions"]).required).toBe(true);
  });

  test("every field's path starts with its block path", () => {
    const cases: Array<[string, SpecPath]> = [
      ["cli", ["agent"]],
      ["cli", ["limits"]],
      ["cli", ["memory"]],
      ["workflow", ["steps", 0]],
      ["graph", ["edges", 2]],
      ["crew", ["routing"]],
    ];
    for (const [target, blockPath] of cases) {
      for (const f of fieldsForBlock(S, target, blockPath)) {
        expect(f.path.slice(0, blockPath.length)).toEqual([...blockPath]);
      }
    }
  });
});

// --- applyFieldEdit: coercion --------------------------------------------------------

describe("applyFieldEdit — coercion", () => {
  const modelField = (): FormField =>
    fieldAt(fieldsForBlock(S, "cli", ["agent"]), ["agent", "model"]);
  const maxTokensField = (): FormField =>
    fieldAt(fieldsForBlock(S, "cli", ["agent"]), ["agent", "max_tokens"]);

  test("string edit is a byte-exact value swap — every comment and key survives", () => {
    const doc = docOf(CLI_SPEC);
    const result = applyFieldEdit(doc, modelField(), "claude-sonnet-4-6");
    expect(result).toEqual({ ok: true });
    // The fixture is written in the stringifier's canonical style, so the
    // edit must serialize to EXACTLY the original text with one value swapped
    // (same guarantee spec-model.test.ts pins for raw setPath).
    expect(reserialized(doc)).toBe(
      CLI_SPEC.replace("claude-haiku-4-5-20251001", "claude-sonnet-4-6"),
    );
  });

  test("number coerces '8192' to a real number", () => {
    const doc = docOf(CLI_SPEC);
    expect(applyFieldEdit(doc, maxTokensField(), " 8192 ")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["agent"]["max_tokens"]).toBe(8192);
  });

  test("number rejects garbage; integer fields reject floats; doc untouched", () => {
    const doc = docOf(CLI_SPEC);
    const before = serializeSpecModel(doc);
    const bad = applyFieldEdit(doc, maxTokensField(), "lots");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("must be a number");
    const float = applyFieldEdit(doc, maxTokensField(), "3.5");
    expect(float.ok).toBe(false);
    if (!float.ok) expect(float.error).toContain("integer");
    expect(serializeSpecModel(doc)).toBe(before);
  });

  test("fractional numbers pass on non-integer fields (compaction.threshold)", () => {
    const doc = docOf(CLI_SPEC);
    const threshold = fieldAt(fieldsForBlock(S, "cli", ["compaction"]), [
      "compaction",
      "threshold",
    ]);
    expect(applyFieldEdit(doc, threshold, "0.85")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["compaction"]["threshold"]).toBe(0.85);
  });

  test("boolean accepts checkbox booleans and 'true'/'false' text, rejects the rest", () => {
    const doc = docOf(CLI_SPEC);
    const streaming = fieldAt(fieldsForBlock(S, "cli", ["agent"]), ["agent", "streaming"]);
    expect(applyFieldEdit(doc, streaming, true)).toEqual({ ok: true });
    expect((parseSpecModel(serializeSpecModel(doc)).model as any)["agent"]["streaming"]).toBe(true);
    expect(applyFieldEdit(doc, streaming, "false")).toEqual({ ok: true });
    expect((parseSpecModel(serializeSpecModel(doc)).model as any)["agent"]["streaming"]).toBe(
      false,
    );
    const bad = applyFieldEdit(doc, streaming, "maybe");
    expect(bad.ok).toBe(false);
  });

  test("a checkbox boolean on a text field is refused (page bug guard)", () => {
    const doc = docOf(CLI_SPEC);
    const result = applyFieldEdit(doc, modelField(), true);
    expect(result.ok).toBe(false);
  });

  test("enum accepts listed values only, naming the alternatives in the error", () => {
    const doc = docOf(CLI_SPEC);
    const mode = fieldAt(fieldsForBlock(S, "cli", ["permissions"]), ["permissions", "mode"]);
    expect(applyFieldEdit(doc, mode, "plan")).toEqual({ ok: true });
    const bad = applyFieldEdit(doc, mode, "bypass");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("default, plan, auto");
  });

  test("string-list splits on commas AND newlines, trimming entries", () => {
    const doc = docOf(CLI_SPEC);
    const tools = fieldsForBlock(S, "cli", ["tools"])[0];
    if (!tools) throw new Error("unreachable");
    expect(applyFieldEdit(doc, tools, "read, write\nbash ,webFetch")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["tools"]).toEqual(["read", "write", "bash", "webFetch"]);
  });

  test("record parses YAML mappings and rejects lists/scalars", () => {
    const doc = docOf(CLI_SPEC);
    const mcp = fieldsForBlock(S, "cli", ["mcp_servers"])[0];
    if (!mcp) throw new Error("unreachable");
    const ok = applyFieldEdit(doc, mcp, "docs:\n  transport: stdio\n  command: bunx");
    expect(ok).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["mcp_servers"]["docs"]["transport"]).toBe("stdio");
    const list = applyFieldEdit(doc, mcp, "- not\n- a-mapping");
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.error).toContain("mapping");
  });

  test("yaml accepts lists, surfaces parse errors verbatim-ish, and types scalars", () => {
    const doc = docOf(CLI_SPEC);
    const rules = fieldAt(fieldsForBlock(S, "cli", ["permissions"]), ["permissions", "rules"]);
    expect(
      applyFieldEdit(doc, rules, "- type: alwaysAllow\n  pattern: read"),
    ).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["permissions"]["rules"]).toEqual([{ type: "alwaysAllow", pattern: "read" }]);
    const bad = applyFieldEdit(doc, rules, "[unclosed");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("invalid YAML");
    // Scalar yaml values keep their YAML types (edges[].when.equals).
    const graph = docOf(GRAPH_SPEC);
    const equals = fieldAt(fieldsForBlock(S, "graph", ["edges", 0]), [
      "edges",
      0,
      "when",
      "equals",
    ]);
    expect(applyFieldEdit(graph, equals, "true")).toEqual({ ok: true });
    const graphModel = parseSpecModel(serializeSpecModel(graph)).model as Record<string, any>;
    expect(graphModel["edges"][0]["when"]["equals"]).toBe(true);
  });
});

// --- applyFieldEdit: clearing, pruning, shorthand replacement ---------------------------

describe("applyFieldEdit — clear/prune/shorthand", () => {
  test("an empty value clears the key (comments elsewhere untouched)", () => {
    const doc = docOf(CLI_SPEC);
    const usd = fieldAt(fieldsForBlock(S, "cli", ["budget"]), ["budget", "usd"]);
    // usd is required — clearing it must refuse…
    const refused = applyFieldEdit(doc, usd, "   ");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("required");
    // …but an optional field clears cleanly.
    const action = fieldAt(fieldsForBlock(S, "cli", ["budget"]), [
      "budget",
      "on_exceed",
      "action",
    ]);
    expect(applyFieldEdit(doc, action, "stop")).toEqual({ ok: true });
    expect(applyFieldEdit(doc, action, "")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["budget"]).toEqual({ usd: 5 });
    expect(serializeSpecModel(doc)).toContain("# spend ceiling");
  });

  test("clearing the last nested key prunes the emptied parent map (no thinking: {})", () => {
    const doc = docOf(CLI_SPEC);
    const budgetTokens = fieldAt(fieldsForBlock(S, "cli", ["agent"]), [
      "agent",
      "thinking",
      "budget_tokens",
    ]);
    expect(applyFieldEdit(doc, budgetTokens, "2048")).toEqual({ ok: true });
    expect((parseSpecModel(serializeSpecModel(doc)).model as any)["agent"]["thinking"]).toEqual({
      budget_tokens: 2048,
    });
    expect(applyFieldEdit(doc, budgetTokens, "")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["agent"]).not.toContainKey("thinking");
    // The agent block itself survives, comments intact.
    expect(serializeSpecModel(doc)).toContain("# the reasoning model");
  });

  test("clearing an already-absent optional key is an ok no-op", () => {
    const doc = docOf(CLI_SPEC);
    const before = serializeSpecModel(doc);
    const ttl = fieldAt(fieldsForBlock(S, "cli", ["memory"]), ["memory", "ttl"]);
    expect(applyFieldEdit(doc, ttl, "")).toEqual({ ok: true });
    expect(serializeSpecModel(doc)).toBe(before);
  });

  test("empty yaml/list values clear the key too", () => {
    const doc = docOf(CLI_SPEC);
    const tools = fieldsForBlock(S, "cli", ["tools"])[0];
    if (!tools) throw new Error("unreachable");
    expect(applyFieldEdit(doc, tools, " , ,\n")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model).not.toContainKey("tools");
  });

  test("editing a sub-field through a boolean shorthand replaces it in place", () => {
    const doc = docOf("name: x\ntarget: cli\ncontinuity: false\n# tail comment\n");
    const proof = fieldAt(fieldsForBlock(S, "cli", ["continuity"]), ["continuity", "proof"]);
    expect(applyFieldEdit(doc, proof, "ladder")).toEqual({ ok: true });
    const text = reserialized(doc);
    expect(text).toContain("continuity:\n  proof: ladder");
    expect(text).toContain("# tail comment");
    // Position preserved: continuity still precedes the tail comment line.
    expect(text.indexOf("continuity:")).toBeLessThan(text.indexOf("# tail comment"));
  });

  test("thredz: true shorthand upgrades to the object form on api_key edit", () => {
    const doc = docOf("name: x\ntarget: cli\nthredz: true\n");
    const apiKey = fieldAt(fieldsForBlock(S, "cli", ["thredz"]), ["thredz", "api_key"]);
    expect(applyFieldEdit(doc, apiKey, "$THREDZ_API_KEY")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["thredz"]).toEqual({ api_key: "$THREDZ_API_KEY" });
  });

  test("null-valued blocks (memory: with nothing) upgrade the same way", () => {
    const doc = docOf("name: x\ntarget: cli\nmemory:\n");
    const backend = fieldAt(fieldsForBlock(S, "cli", ["memory"]), ["memory", "backend"]);
    expect(applyFieldEdit(doc, backend, "thredz")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["memory"]).toEqual({ backend: "thredz" });
  });

  test("creating a deep path from nothing builds the intermediate maps", () => {
    const doc = docOf("name: x\ntarget: cli\n");
    const judge = fieldAt(fieldsForBlock(S, "cli", ["security"]), [
      "security",
      "justification",
      "judge",
    ]);
    expect(applyFieldEdit(doc, judge, "claude")).toEqual({ ok: true });
    const model = parseSpecModel(serializeSpecModel(doc)).model as Record<string, any>;
    expect(model["security"]).toEqual({ justification: { judge: "claude" } });
  });
});

// --- structural ops: steps ---------------------------------------------------------

describe("structural ops — workflow steps", () => {
  test("addStep appends a named skeleton and keeps the spec valid", () => {
    const doc = docOf(WORKFLOW_SPEC);
    const result = addStep(doc);
    expect(result).toEqual({ ok: true, name: "step-3", path: ["steps", 2] });
    const text = reserialized(doc);
    expect(text).toContain("# step one comment");
    expect(text).toContain("# keep this");
    const model = parseSpecModel(text).model as Record<string, any>;
    expect(model["steps"]).toHaveLength(3);
    expect(model["steps"][2]).toEqual({
      name: "step-3",
      instructions: NEW_INSTRUCTIONS_PLACEHOLDER,
    });
  });

  test("addStep with an explicit name refuses collisions and unsafe names", () => {
    const doc = docOf(WORKFLOW_SPEC);
    const dup = addStep(doc, "brainstorm");
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("already exists");
    const unsafe = addStep(doc, "bad/name");
    expect(unsafe.ok).toBe(false);
    expect(addStep(doc, "wrap-up").ok).toBe(true);
    expect(SAFE_NAME_RE.test("wrap-up")).toBe(true);
  });

  test("addStep auto-name skips names already taken", () => {
    const doc = docOf("name: w\ntarget: workflow\nmodel: m\nsteps:\n  - name: step-2\n    instructions: hi\n");
    const result = addStep(doc);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name).toBe("step-3");
  });

  test("addStep creates steps: when absent and errors when it is not a list", () => {
    const empty = docOf("name: w\ntarget: workflow\nmodel: m\n");
    const created = addStep(empty);
    expect(created).toEqual({ ok: true, name: "step-1", path: ["steps", 0] });
    const scalar = docOf("name: w\ntarget: workflow\nmodel: m\nsteps: oops\n");
    const bad = addStep(scalar);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("not a list");
  });

  test("a null collection (the in-progress 'steps:' / 'nodes:' state) counts as empty", () => {
    const steps = docOf("name: w\ntarget: workflow\nmodel: m\nsteps:\n");
    expect(addStep(steps)).toEqual({ ok: true, name: "step-1", path: ["steps", 0] });
    expect(parseSpecModel(reserialized(steps)).model).toMatchObject({
      steps: [{ name: "step-1" }],
    });
    const nodes = docOf("name: g\ntarget: graph\nmodel: m\nentry: a\nnodes:\n");
    expect(addNode(nodes, "a")).toEqual({ ok: true, name: "a", path: ["nodes", "a"] });
    const edges = docOf("name: g\ntarget: graph\nmodel: m\nentry: a\nnodes:\n  a:\n    instructions: hi\nedges:\n");
    expect(addEdge(edges, "a", "a").ok).toBe(true);
    expect((parseSpecModel(reserialized(edges)).model as any)["edges"]).toEqual([
      { from: "a", to: "a" },
    ]);
  });

  test("removeNamed step deletes exactly that step (others' comments survive)", () => {
    const doc = docOf(WORKFLOW_SPEC);
    expect(removeNamed(doc, "step", "pick")).toEqual({ ok: true });
    const text = reserialized(doc);
    expect(text).toContain("brainstorm");
    expect(text).toContain("# keep this");
    expect(text).not.toContain("pick");
    expect(removeNamed(doc, "step", "nope").ok).toBe(false);
  });

  test("renameNamed step edits only the name field", () => {
    const doc = docOf(WORKFLOW_SPEC);
    expect(renameNamed(doc, "step", "pick", "decide")).toEqual({ ok: true });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    expect(model["steps"][1]["name"]).toBe("decide");
    expect(model["steps"][1]["instructions"]).toBe("Choose the strongest.");
  });
});

// --- structural ops: graph nodes + edges ----------------------------------------------

describe("structural ops — graph nodes and edges", () => {
  test("addNode adds a map entry with skeleton instructions", () => {
    const doc = docOf(GRAPH_SPEC);
    const result = addNode(doc, "verify");
    expect(result).toEqual({ ok: true, name: "verify", path: ["nodes", "verify"] });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    expect(model["nodes"]["verify"]).toEqual({ instructions: NEW_INSTRUCTIONS_PLACEHOLDER });
  });

  test("addNode auto-names node-N past existing keys and refuses collisions", () => {
    const doc = docOf(GRAPH_SPEC);
    const auto = addNode(doc);
    expect(auto.ok).toBe(true);
    if (auto.ok) expect(auto.name).toBe("node-4");
    const dup = addNode(doc, "draft");
    expect(dup.ok).toBe(false);
  });

  test("addEdge appends (creating edges: when absent)", () => {
    const doc = docOf(GRAPH_SPEC);
    const result = addEdge(doc, "draft", "publish");
    expect(result).toEqual({ ok: true, name: "draft -> publish", path: ["edges", 2] });
    const bare = docOf("name: g\ntarget: graph\nmodel: m\nentry: a\nnodes:\n  a:\n    instructions: hi\n");
    expect(addEdge(bare, "a", "a")).toEqual({ ok: true, name: "a -> a", path: ["edges", 0] });
    expect(addEdge(bare, " ", "a").ok).toBe(false);
  });

  test("removeNamed node drops the node, every touching edge, and thin parallel groups", () => {
    const doc = docOf(GRAPH_SPEC);
    expect(removeNamed(doc, "node", "review")).toEqual({ ok: true });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    expect(Object.keys(model["nodes"])).toEqual(["draft", "publish"]);
    // draft->review (to), review->publish (from + when.key review) both die.
    expect(model["edges"]).toEqual([]);
    // The [review, publish] group shrank below 2 — parallel: is gone entirely.
    expect(model).not.toContainKey("parallel");
    // entry: draft was untouched.
    expect(model["entry"]).toBe("draft");
  });

  test("removeNamed node keeps parallel groups that stay >= 2 and unrelated edges", () => {
    const doc = docOf(`name: dag
target: graph
model: m
entry: a
nodes:
  a:
    instructions: hi
  b:
    instructions: hi
  c:
    instructions: hi
  d:
    instructions: hi
edges:
  - from: a
    to: b
  - from: c
    to: d
parallel:
  - - b
    - c
    - d
`);
    expect(removeNamed(doc, "node", "b")).toEqual({ ok: true });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    expect(model["edges"]).toEqual([{ from: "c", to: "d" }]);
    expect(model["parallel"]).toEqual([["c", "d"]]);
  });

  test("removeNamed node also removes edges conditioned on it via when.key", () => {
    const doc = docOf(`name: dag
target: graph
model: m
entry: a
nodes:
  a:
    instructions: hi
  b:
    instructions: hi
  c:
    instructions: hi
edges:
  - from: a
    to: b
    when:
      key: c
      exists: true
`);
    expect(removeNamed(doc, "node", "c")).toEqual({ ok: true });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    // The a->b edge read state[c] — it could never fire again; it is gone.
    expect(model["edges"]).toEqual([]);
  });

  test("renameNamed node renames the key IN PLACE and rewires entry/edges/when/parallel", () => {
    const doc = docOf(GRAPH_SPEC);
    expect(renameNamed(doc, "node", "review", "critique")).toEqual({ ok: true });
    const text = reserialized(doc);
    const model = parseSpecModel(text).model as Record<string, any>;
    expect(Object.keys(model["nodes"])).toEqual(["draft", "critique", "publish"]); // order kept
    expect(model["edges"][0]).toEqual({ from: "draft", to: "critique" });
    expect(model["edges"][1]["from"]).toBe("critique");
    expect(model["edges"][1]["when"]["key"]).toBe("critique");
    expect(model["parallel"]).toEqual([["critique", "publish"]]);
    // Comments inside sibling nodes survive the key rename.
    expect(text).toContain("# the writer");
    expect(text).toContain("# inline note");
  });

  test("renameNamed rewires entry when it names the renamed node", () => {
    const doc = docOf(GRAPH_SPEC);
    expect(renameNamed(doc, "node", "draft", "compose")).toEqual({ ok: true });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    expect(model["entry"]).toBe("compose");
    expect(model["edges"][0]["from"]).toBe("compose");
  });

  test("renameNamed refuses collisions, unknown names, and unsafe names; same-name is a no-op", () => {
    const doc = docOf(GRAPH_SPEC);
    expect(renameNamed(doc, "node", "draft", "review").ok).toBe(false);
    expect(renameNamed(doc, "node", "ghost", "x").ok).toBe(false);
    expect(renameNamed(doc, "node", "draft", "a/b").ok).toBe(false);
    const before = serializeSpecModel(doc);
    expect(renameNamed(doc, "node", "draft", "draft")).toEqual({ ok: true });
    expect(serializeSpecModel(doc)).toBe(before);
  });
});

// --- structural ops: crew roles --------------------------------------------------------

describe("structural ops — crew roles", () => {
  test("addRole mirrors addNode under roles:", () => {
    const doc = docOf(CREW_SPEC);
    const result = addRole(doc, "publisher");
    expect(result).toEqual({ ok: true, name: "publisher", path: ["roles", "publisher"] });
    const auto = addRole(doc);
    expect(auto.ok).toBe(true);
    if (auto.ok) expect(auto.name).toBe("role-4");
  });

  test("removeNamed role drops its match key and rules targeting it", () => {
    const doc = docOf(CREW_SPEC);
    expect(removeNamed(doc, "role", "editor")).toEqual({ ok: true });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    expect(Object.keys(model["roles"])).toEqual(["writer"]);
    // writer's only rule handed off to editor -> writer key removed; editor's
    // own key removed; the emptied match: map is gone too.
    expect(model["routing"]).toEqual({ kind: "match" });
  });

  test("removeNamed role keeps other rules in a mixed list", () => {
    const doc = docOf(`name: crew
target: crew
model: m
entry: a
roles:
  a:
    instructions: hi
  b:
    instructions: hi
  c:
    instructions: hi
routing:
  kind: match
  match:
    a:
      - contains: two
        to: b
      - contains: three
        to: c
`);
    expect(removeNamed(doc, "role", "b")).toEqual({ ok: true });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    expect(model["routing"]["match"]["a"]).toEqual([{ contains: "three", to: "c" }]);
  });

  test("renameNamed role rewires entry, match keys, and rule targets (comments survive)", () => {
    const doc = docOf(CREW_SPEC);
    expect(renameNamed(doc, "role", "writer", "author")).toEqual({ ok: true });
    const text = reserialized(doc);
    const model = parseSpecModel(text).model as Record<string, any>;
    expect(Object.keys(model["roles"])).toEqual(["author", "editor"]);
    expect(model["entry"]).toBe("author");
    expect(Object.keys(model["routing"]["match"])).toEqual(["author", "editor"]);
    expect(model["routing"]["match"]["editor"]).toEqual([{ contains: "rewrite", to: "author" }]);
    expect(text).toContain("# writer note");
  });
});

// --- 0.4.0 marking sweep ----------------------------------------------------------------

describe("0.4.0 marking", () => {
  test("markers are exactly '0.4.0' wherever they appear, across every target x block", () => {
    for (const target of S.targets) {
      for (const key of S.blocksByTarget[target] ?? []) {
        for (const f of fieldsForBlock(S, target, [key])) {
          if (f.requiresVersion !== undefined) expect(f.requiresVersion).toBe("0.4.0");
        }
      }
    }
  });

  test("the honesty list is fully covered: limits/thinking/hooks/rate_limits/when/parallel", () => {
    const marked = (target: string, blockPath: SpecPath, tail: string | number): boolean =>
      fieldsForBlock(S, target, blockPath).some(
        (f) => f.path.at(-1) === tail && f.requiresVersion === "0.4.0",
      );
    expect(marked("cli", ["limits"], "max_tool_iterations")).toBe(true);
    expect(marked("cli", ["agent"], "budget_tokens")).toBe(true); // thinking
    expect(marked("cli", ["hooks", 0], "command")).toBe(true);
    expect(marked("cli", ["agent"], "rate_limits")).toBe(true);
    expect(marked("graph", ["edges", 0], "key")).toBe(true); // when.key
    expect(fieldsForBlock(S, "graph", ["parallel"])[0]?.requiresVersion).toBe("0.4.0");
  });

  test("0.3-era fields carry no marker (agent.model, budget.usd, permissions.mode)", () => {
    expect(
      fieldAt(fieldsForBlock(S, "cli", ["agent"]), ["agent", "model"]).requiresVersion,
    ).toBeUndefined();
    expect(
      fieldAt(fieldsForBlock(S, "cli", ["budget"]), ["budget", "usd"]).requiresVersion,
    ).toBeUndefined();
    expect(
      fieldAt(fieldsForBlock(S, "cli", ["permissions"]), ["permissions", "mode"]).requiresVersion,
    ).toBeUndefined();
  });
});

// --- fieldsForBlock: evaluation + judge (loop contract 0.4) ---------------------------

describe("fieldsForBlock — evaluation block", () => {
  test("grader.type is a required 0.4.0 segmented enum; per-type + gate fields follow", () => {
    const fields = fieldsForBlock(S, "cli", ["evaluation"]);
    const graderType = fieldAt(fields, ["evaluation", "grader", "type"]);
    expect(graderType.kind).toBe("enum");
    expect(graderType.enumValues).toEqual(["llm_judge", "contains", "regex"]);
    expect(graderType.required).toBe(true);
    expect(fieldAt(fields, ["evaluation", "grader", "criteria"]).kind).toBe("string");
    expect(fieldAt(fields, ["evaluation", "grader", "model"]).kind).toBe("string");
    expect(fieldAt(fields, ["evaluation", "grader", "value"]).kind).toBe("string");
    // threshold is fractional 0..1 — must NOT demand an integer.
    const threshold = fieldAt(fields, ["evaluation", "threshold"]);
    expect(threshold.kind).toBe("number");
    expect(threshold.integer).toBeUndefined();
    expect(fieldAt(fields, ["evaluation", "on_fail"]).enumValues).toEqual(["retry", "halt", "note"]);
    expect(fieldAt(fields, ["evaluation", "max_retries"]).integer).toBe(true);
    // The whole evaluation block is 0.4.0.
    for (const f of fields) expect(f.requiresVersion).toBe("0.4.0");
  });
});

describe("fieldsForBlock — judge steps/nodes (kind: judge)", () => {
  const JUDGE = { kind: "judge", judge: { criteria: "accurate" } };

  test("a workflow judge step gets the judge sub-form (name + judge.*), all 0.4.0", () => {
    const fields = fieldsForBlock(S, "workflow", ["steps", 2], JUDGE);
    expect(fieldAt(fields, ["steps", 2, "name"]).required).toBe(true);
    expect(fieldAt(fields, ["steps", 2, "judge", "criteria"]).required).toBe(true);
    expect(fieldAt(fields, ["steps", 2, "judge", "model"]).kind).toBe("string");
    const threshold = fieldAt(fields, ["steps", 2, "judge", "threshold"]);
    expect(threshold.kind).toBe("number");
    expect(threshold.integer).toBeUndefined();
    expect(fieldAt(fields, ["steps", 2, "judge", "on_fail"]).enumValues).toEqual([
      "retry_previous",
      "halt",
      "continue",
    ]);
    expect(fieldAt(fields, ["steps", 2, "judge", "max_retries"]).integer).toBe(true);
    for (const f of fields) expect(f.requiresVersion).toBe("0.4.0");
    // A judge step runs no agent turn — no instructions/tools of its own.
    expect(fields.some((f) => f.path.at(-1) === "instructions")).toBe(false);
    expect(fields.some((f) => f.path.at(-1) === "tools")).toBe(false);
  });

  test("a graph judge node gets the judge sub-form WITHOUT a name field (map key is the name)", () => {
    const fields = fieldsForBlock(S, "graph", ["nodes", "gate"], JUDGE);
    expect(fields.some((f) => f.path.at(-1) === "name")).toBe(false);
    expect(fieldAt(fields, ["nodes", "gate", "judge", "criteria"]).required).toBe(true);
    expect(fieldAt(fields, ["nodes", "gate", "judge", "on_fail"]).enumValues).toEqual([
      "retry_previous",
      "halt",
      "continue",
    ]);
  });

  test("without a judge record, steps/nodes keep the regular form", () => {
    const step = fieldsForBlock(S, "workflow", ["steps", 0]);
    expect(fieldAt(step, ["steps", 0, "instructions"]).required).toBe(true);
    expect(step.some((f) => f.path.includes("judge"))).toBe(false);
    // A non-judge record likewise resolves to the ordinary form.
    const node = fieldsForBlock(S, "graph", ["nodes", "draft"], { instructions: "x" });
    expect(fieldAt(node, ["nodes", "draft", "instructions"]).required).toBe(true);
    expect(node.some((f) => f.path.includes("judge"))).toBe(false);
  });
});

// --- fieldsForBlock: ask_mode + observability extension (Batch C) ---------------------

describe("fieldsForBlock — permissions.ask_mode + observability", () => {
  test("permissions gains ask_mode (pause|deny, 0.4.0); mode stays unmarked", () => {
    const fields = fieldsForBlock(S, "channel", ["permissions"]);
    const askMode = fieldAt(fields, ["permissions", "ask_mode"]);
    expect(askMode.enumValues).toEqual(["pause", "deny"]);
    expect(askMode.requiresVersion).toBe("0.4.0");
    expect(fieldAt(fields, ["permissions", "mode"]).requiresVersion).toBeUndefined();
  });

  test("observability gains trace.level + metrics/cost/alerts/incidents + otel.endpoint, all 0.4.0", () => {
    const fields = fieldsForBlock(S, "cli", ["observability"]);
    expect(fieldAt(fields, ["observability", "trace", "level"]).enumValues).toEqual([
      "off",
      "basic",
      "full",
    ]);
    for (const key of ["metrics", "cost", "alerts", "incidents"]) {
      expect(fieldAt(fields, ["observability", key]).kind).toBe("boolean");
    }
    expect(fieldAt(fields, ["observability", "otel", "endpoint"]).kind).toBe("string");
    // The new sub-blocks are 0.4.0; the pre-existing slo.* fields stay unmarked.
    const newRoots = new Set(["trace", "metrics", "cost", "alerts", "incidents", "otel"]);
    for (const f of fields) {
      const isNew = newRoots.has(String(f.path[1]));
      expect({ path: f.path, v: f.requiresVersion }).toEqual({
        path: f.path,
        v: isNew ? "0.4.0" : undefined,
      });
    }
  });
});

// --- structural ops: judge steps/nodes -----------------------------------------------

describe("structural ops — addJudgeStep", () => {
  test("appends a judge step gating the last step by default (valid YAML, comments kept)", () => {
    const doc = docOf(WORKFLOW_SPEC);
    const result = addJudgeStep(doc);
    expect(result).toEqual({ ok: true, name: "judge-1", path: ["steps", 2] });
    const text = reserialized(doc);
    expect(text).toContain("# step one comment");
    expect(text).toContain("# keep this");
    const model = parseSpecModel(text).model as Record<string, any>;
    expect(model["steps"]).toHaveLength(3);
    expect(model["steps"][2]).toEqual({
      name: "judge-1",
      kind: "judge",
      judge: { criteria: NEW_JUDGE_CRITERIA_PLACEHOLDER, on_fail: "retry_previous" },
    });
  });

  test("inserts immediately after the named step it gates", () => {
    const doc = docOf(WORKFLOW_SPEC);
    const result = addJudgeStep(doc, "brainstorm");
    expect(result).toEqual({ ok: true, name: "judge-1", path: ["steps", 1] });
    const model = parseSpecModel(reserialized(doc)).model as Record<string, any>;
    expect(model["steps"].map((s: Record<string, unknown>) => s["name"])).toEqual([
      "brainstorm",
      "judge-1",
      "pick",
    ]);
  });

  test("refuses when there is no step to gate, an unknown afterStep, or a non-list steps:", () => {
    const empty = docOf("name: w\ntarget: workflow\nmodel: m\n");
    const noSteps = addJudgeStep(empty);
    expect(noSteps.ok).toBe(false);
    if (!noSteps.ok) expect(noSteps.error).toContain("must follow a step");
    const scalar = docOf("name: w\ntarget: workflow\nmodel: m\nsteps: oops\n");
    expect(addJudgeStep(scalar).ok).toBe(false);
    const unknown = addJudgeStep(docOf(WORKFLOW_SPEC), "ghost");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('no step named "ghost"');
  });

  test("auto-names judge-N past existing judge steps", () => {
    const doc = docOf(WORKFLOW_SPEC);
    expect(addJudgeStep(doc, "brainstorm").ok).toBe(true);
    const second = addJudgeStep(doc, "pick");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.name).toBe("judge-2");
  });
});

describe("structural ops — addJudgeNode", () => {
  test("adds a judge node and wires gatesNode -> judge (valid YAML, comments kept)", () => {
    const doc = docOf(GRAPH_SPEC);
    const result = addJudgeNode(doc, "review");
    expect(result).toEqual({ ok: true, name: "judge-1", path: ["nodes", "judge-1"] });
    const text = reserialized(doc);
    expect(text).toContain("# the writer");
    const model = parseSpecModel(text).model as Record<string, any>;
    expect(model["nodes"]["judge-1"]).toEqual({
      kind: "judge",
      judge: { criteria: NEW_JUDGE_CRITERIA_PLACEHOLDER, on_fail: "retry_previous" },
    });
    // The downstream edge review -> judge-1 was appended.
    expect(model["edges"]).toContainEqual({ from: "review", to: "judge-1" });
  });

  test("refuses an empty or unknown gated node", () => {
    const doc = docOf(GRAPH_SPEC);
    expect(addJudgeNode(doc, "  ").ok).toBe(false);
    const unknown = addJudgeNode(doc, "ghost");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('no node named "ghost"');
  });
});
