// Schema -> form descriptor layer for the /builder inspector (B2): given a
// block of a `crewhaus.yaml` spec, describe the fields an editing form should
// render (`fieldsForBlock`), coerce+write one field edit back into the
// comment-preserving Document (`applyFieldEdit`), and perform the canvas's
// structural operations — add/remove/rename workflow steps, graph nodes, crew
// roles, and graph edges — as Document edits (`addStep` / `addNode` /
// `addRole` / `addEdge` / `removeNamed` / `renameNamed`).
//
// YAML text stays the SOURCE OF TRUTH: every write goes through spec-model's
// Document (setPath/deletePath or targeted node mutation), so the user's
// comments, key order, anchors, and unknown keys survive every form edit. A
// field's `path` is therefore ABSOLUTE from the document root (sequence
// indexes as numbers, e.g. `["steps", 0, "name"]`) — `applyFieldEdit` needs
// no other context than the Document and the field.
//
// The field catalog is hand-ground-truthed against factory
// packages/spec/src/index.ts across the loop-contract-0.4 line:
//   - the released v0.3.x tags (what the deployed compiler-worker validates);
//   - Batch-A additions (agent.thinking, limits, hooks, compaction.threshold,
//     edges[].when, …);
//   - Batch-B additions (the top-level `evaluation:` block and the `kind:
//     judge` step/node `judge:` gate) — ground-truthed against the pinned
//     factory commit's packages/spec.
// The `permissions.ask_mode` field and the observability
// trace/metrics/cost/alerts/incidents/otel fields are loop-contract-0.4
// Batch-C keys (AGENT-LOOPS-PLAN G11 and G26) authored slightly AHEAD of the
// pinned factory spec — real planned keys the deployed compiler does not yet
// validate — so they are ground-truthed against the plan and reconcile with
// packages/spec once Batch C lands.
// Fields the deployed 0.3.x line does not know carry `requiresVersion:
// "0.4.0"` — the builder still authors them, and the validity badge uses the
// marker to classify a remote unknown-key error as "needs compiler 0.4.0"
// instead of a genuine spec error. Block-LEVEL markers come from the schema's
// `blockVersions` (see ./spec-schema.ts); the per-field markers here cover
// keys nested inside blocks the schema does not version-mark (agent.thinking,
// compaction.threshold, edges[].when, evaluation.*, judge.*, ask_mode, …).
//
// Discipline (mirrors ./spec-model.ts / ./loop-model.ts / ./fleet.ts): this
// file imports NOTHING from ./compiler or ./cloudflare — those pull in the
// `__COMPILER_URL__` vite define, which is undefined under `bun test` and
// would break the suite. It performs no fetch and touches NO DOM (pure
// descriptor + Document-edit logic; /builder owns all rendering), so the unit
// tests run fully offline.

import type { Document } from "yaml";
import { isMap, isScalar, isSeq } from "yaml";
import { deletePath, getPath, parseSpecModel, setPath, type SpecPath } from "./spec-model";
import type { SpecSchema } from "./spec-schema";

// --- shapes -----------------------------------------------------------------

/**
 * How a field is edited (and coerced from the form's raw string):
 *   - "string"      — free text, stored verbatim (whitespace-only clears).
 *   - "number"      — Number() coercion; `integer` additionally rejects floats.
 *   - "boolean"     — checkbox (boolean rawValue) or "true"/"false" text.
 *   - "enum"        — one of `enumValues`.
 *   - "string-list" — comma/newline-separated names -> array of strings.
 *   - "record"      — YAML text that must parse to a mapping.
 *   - "yaml"        — YAML text, any value (the fallback for deep structure).
 */
export type FormFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "string-list"
  | "record"
  | "yaml";

/**
 * One editable field of a block. `path` is absolute from the document root
 * (see the header); everything else is presentation + coercion metadata. A
 * `required` field refuses to be cleared (the spec would stop validating);
 * `requiresVersion` marks fields the DEPLOYED 0.3.x compiler rejects (see the
 * header); `enumVersions` marks individual enum VALUES the same way (e.g.
 * crew `routing.kind: llm`).
 */
export type FormField = {
  readonly path: SpecPath;
  readonly label: string;
  readonly kind: FormFieldKind;
  /** Allowed values, for kind "enum". */
  readonly enumValues?: readonly string[];
  /** One-line, operator-facing description (shown as the field's help text). */
  readonly description?: string;
  /** Example value for an empty input. */
  readonly placeholder?: string;
  /** Minimum crewhaus version the KEY needs (e.g. "0.4.0"); see header. */
  readonly requiresVersion?: string;
  /** True when the spec stops validating without this field. */
  readonly required?: boolean;
  /** For kind "number": reject non-integers at coercion time. */
  readonly integer?: boolean;
  /** For kind "string-list": completion hints (NOT an allow-list). */
  readonly suggestions?: readonly string[];
  /** For kind "enum": per-VALUE minimum crewhaus versions (e.g. { llm: "0.4.0" }). */
  readonly enumVersions?: Readonly<Record<string, string>>;
};

/** Result of a single-field or structural Document edit. */
export type FieldEditResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Result of a structural ADD: the created entity's name and Document path. */
export type StructuralAddResult =
  | { readonly ok: true; readonly name: string; readonly path: SpecPath }
  | { readonly ok: false; readonly error: string };

/** The named canvas entities the structural helpers operate on. */
export type NamedEntityKind = "step" | "node" | "role";

// --- shared vocab ------------------------------------------------------------

/** The loop-contract-0.4 marker every Batch-A field carries. */
const V040 = "0.4.0";

/**
 * The builtin tool names the compiled targets can resolve — suggestion list
 * for `tools:` fields. DUPLICATED from BUILTIN_TOOL_MAP in factory
 * packages/target-cli/src/index.ts (the emitters' source of truth); an
 * unknown name here only weakens suggestions, never validation, so drift is
 * cosmetic. Keep in sync when factory adds a tool.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "bashOutput",
  "killShell",
  "todoWrite",
  "webFetch",
  "webSearch",
  "readImage",
  "fetch",
  "python",
  "javascript",
  "shell",
  "imageGenerate",
  "ingestDocument",
  "codegraphSearch",
  "codegraphCallers",
  "codegraphCallees",
  "codegraphImpact",
];

/**
 * The hook-event names a spec `hooks:` entry accepts. DUPLICATED from
 * SPEC_HOOK_EVENTS in factory packages/spec/src/index.ts (loop contract 0.4
 * Batch A). Keep in sync.
 */
export const HOOK_EVENTS: readonly string[] = [
  "session-start",
  "stop",
  "pre-tool",
  "post-tool",
  "pre-model",
  "post-model",
  "pre-compact",
  "post-compact",
  "pre-slash",
  "alert",
];

/**
 * The factory spec's `safeName` grammar (names of specs, steps, nodes, roles,
 * sub-agents): letters/digits/underscore plus space, dot, dash, colon.
 * Mirrored so structural ops refuse to author a name the compiler rejects.
 */
export const SAFE_NAME_RE = /^[\w .:-]+$/;

/** Instructions skeleton for newly added steps/nodes/roles (schema: min 1 char). */
export const NEW_INSTRUCTIONS_PLACEHOLDER = "Describe what this should do.";

/** Criteria skeleton for newly added judge steps/nodes (schema: min 1 char). */
export const NEW_JUDGE_CRITERIA_PLACEHOLDER = "Describe what a passing result must satisfy.";

// The agent-bearing target families whose agent blocks differ (ground truth
// in the header). Interactive agents carry the full 0.4 feature set;
// max-tokens-0.4 agents gained `max_tokens` only in the 0.4 line.
const INTERACTIVE_AGENT_TARGETS = new Set(["cli", "channel", "managed"]);
const MAX_TOKENS_040_AGENT_TARGETS = new Set(["research", "batch", "browser"]);

// --- field helpers -------------------------------------------------------------

type FieldSeed = Omit<FormField, "path"> & { readonly rel: SpecPath };

/** Prefix every seed's relative path with the block's base path. */
function at(base: SpecPath, seeds: readonly FieldSeed[]): FormField[] {
  return seeds.map(({ rel, ...field }) => ({ ...field, path: [...base, ...rel] }));
}

/** The whole-block yaml fallback field (unknown or deep-structured blocks). */
function yamlFallback(schema: SpecSchema, blockPath: SpecPath, key: string): FormField[] {
  const requiresVersion = schema.blockVersions?.[key];
  const description = schema.blocks[key];
  return [
    {
      path: [...blockPath],
      label: humanize(key),
      kind: "yaml",
      ...(description ? { description } : {}),
      ...(requiresVersion ? { requiresVersion } : {}),
    },
  ];
}

/** "max_tool_iterations" -> "Max tool iterations". */
function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// --- the field catalog -----------------------------------------------------------

function specCoreFields(target: string): FieldSeed[] {
  const seeds: FieldSeed[] = [
    {
      rel: ["name"],
      label: "Name",
      kind: "string",
      required: true,
      placeholder: "my-agent",
      description: "Spec name — letters, digits, spaces, and '_ . - :' only.",
    },
    {
      rel: ["version"],
      label: "Version",
      kind: "number",
      integer: true,
      description: "Optional integer version stamp for the spec.",
    },
  ];
  if (target === "workflow" || target === "graph" || target === "crew") {
    seeds.push({
      rel: ["model"],
      label: "Model",
      kind: "string",
      required: true,
      placeholder: "claude-sonnet-4-6",
      description:
        target === "crew"
          ? "Crew-wide model used by any role that declares none of its own."
          : `Model every ${target === "workflow" ? "step" : "node"} uses unless it overrides.`,
    });
  }
  if (target === "graph" || target === "crew") {
    seeds.push({
      rel: ["entry"],
      label: "Entry",
      kind: "string",
      required: true,
      description: `Name of the ${target === "graph" ? "node" : "role"} that runs first.`,
    });
  }
  if (target === "research") {
    seeds.push(
      {
        rel: ["goal"],
        label: "Goal",
        kind: "string",
        required: true,
        description: "The research question the daemon decomposes into branches.",
      },
      {
        rel: ["branchingFactor"],
        label: "Branching factor",
        kind: "number",
        integer: true,
        placeholder: "3",
        description: "Parallel research branches (1–8).",
      },
    );
  }
  return seeds;
}

/** thinking{budget_tokens|effort} — per-agent AND per-step/node/role, all 0.4.0. */
function thinkingSeeds(): FieldSeed[] {
  return [
    {
      rel: ["thinking", "budget_tokens"],
      label: "Thinking budget (tokens)",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      placeholder: "4096",
      description:
        "Extended-thinking token budget (>= 1024). Declare exactly ONE of budget or effort.",
    },
    {
      rel: ["thinking", "effort"],
      label: "Thinking effort",
      kind: "enum",
      enumValues: ["low", "medium", "high"],
      requiresVersion: V040,
      description:
        "Portable effort preset the adapter maps to a provider budget. Declare exactly ONE of budget or effort.",
    },
  ];
}

function toolsSeed(rel: SpecPath): FieldSeed {
  return {
    rel,
    label: "Tools",
    kind: "string-list",
    suggestions: BUILTIN_TOOL_NAMES,
    description: "Built-in tool names, comma- or newline-separated (e.g. read, bash, webFetch).",
  };
}

function agentFields(target: string): FieldSeed[] {
  const interactive = INTERACTIVE_AGENT_TARGETS.has(target);
  const seeds: FieldSeed[] = [
    {
      rel: ["model"],
      label: "Model",
      kind: "string",
      required: true,
      placeholder: "claude-sonnet-4-6",
      description: "The model this agent reasons with.",
    },
    {
      rel: ["instructions"],
      label: "Instructions",
      kind: "string",
      required: true,
      description: "The agent's system instructions — who it is and how it behaves.",
    },
  ];
  if (interactive || MAX_TOKENS_040_AGENT_TARGETS.has(target)) {
    seeds.push({
      rel: ["max_tokens"],
      label: "Max output tokens",
      kind: "number",
      integer: true,
      placeholder: "8192",
      description: "Model max OUTPUT tokens per turn; raise for large multi-file edits.",
      // research/batch/browser agents gained max_tokens only in the 0.4 line.
      ...(interactive ? {} : { requiresVersion: V040 }),
    });
  }
  if (interactive) {
    seeds.push(...thinkingSeeds());
    if (target === "cli") {
      seeds.push({
        rel: ["streaming"],
        label: "Streaming",
        kind: "boolean",
        requiresVersion: V040,
        description: "Stream partial output tokens as they generate (cli default: off).",
      });
    }
    seeds.push(
      {
        rel: ["rate_limits"],
        label: "Rate limits",
        kind: "record",
        requiresVersion: V040,
        placeholder: 'webFetch:\n  rpm: 30\n  burst: 10\n"*":\n  rpm: 120',
        description: "Per-tool requests-per-minute ceilings — toolName: { rpm, burst? }; '*' catches all.",
      },
      {
        rel: ["model_fallbacks"],
        label: "Model fallbacks",
        kind: "string-list",
        description: "Provider failover chain, tried in declared order when the primary fails.",
      },
    );
    if (target === "channel") {
      // channel nests the tool allow-list under agent: (no top-level tools).
      seeds.push(toolsSeed(["tools"]));
    }
  }
  return seeds;
}

function stepNodeRoleFields(kind: NamedEntityKind): FieldSeed[] {
  const noun = kind === "step" ? "step" : kind === "node" ? "node" : "role";
  const seeds: FieldSeed[] = [];
  if (kind === "step") {
    seeds.push({
      rel: ["name"],
      label: "Name",
      kind: "string",
      required: true,
      description: "Step name — letters, digits, spaces, and '_ . - :' only.",
    });
  }
  seeds.push(
    {
      rel: ["instructions"],
      label: "Instructions",
      kind: "string",
      required: true,
      description: `What this ${noun} should do.`,
    },
    {
      rel: ["model"],
      label: "Model",
      kind: "string",
      placeholder: "claude-haiku-4-5",
      description: `Model override for this ${noun} (omit to inherit the spec-level model).`,
    },
    {
      rel: ["max_tokens"],
      label: "Max output tokens",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      description: `Model max OUTPUT tokens for this ${noun}'s turns.`,
    },
    ...thinkingSeeds(),
    toolsSeed(["tools"]),
  );
  if (kind === "node") {
    seeds.push({
      rel: ["hitl", "prompt"],
      label: "Approval prompt (HITL)",
      kind: "string",
      description: "When set, the run pauses at this node until a human approves.",
    });
  }
  return seeds;
}

/**
 * Loop contract 0.4 (Batch B) — the `judge:` sub-form of a `kind: judge`
 * workflow step / graph node. Judge steps/nodes run no agent turn of their own
 * (no instructions / model / tools) — only the gate config over the previous
 * step's (workflow) / upstream node's (graph) output. A workflow judge step
 * keeps its `name`; a graph judge node is keyed by its map name. Whole block
 * is 0.4.0. `on_fail` differs from the top-level `evaluation` block's:
 * retry_previous re-runs the gated step/node.
 */
function judgeStepNodeFields(kind: "step" | "node"): FieldSeed[] {
  const seeds: FieldSeed[] = [];
  if (kind === "step") {
    seeds.push({
      rel: ["name"],
      label: "Name",
      kind: "string",
      required: true,
      requiresVersion: V040,
      description: "Judge step name — letters, digits, spaces, and '_ . - :' only.",
    });
  }
  seeds.push(
    {
      rel: ["judge", "criteria"],
      label: "Criteria",
      kind: "string",
      required: true,
      requiresVersion: V040,
      description: "What a passing upstream output must satisfy — the judge scores against this.",
    },
    {
      rel: ["judge", "model"],
      label: "Judge model",
      kind: "string",
      requiresVersion: V040,
      placeholder: "claude-haiku-4-5",
      description: "Judge model id (defaults to the shape's top-level model).",
    },
    {
      rel: ["judge", "threshold"],
      label: "Threshold",
      kind: "number",
      requiresVersion: V040,
      placeholder: "0.7",
      description: "Passing score in 0..1 (default 0.7).",
    },
    {
      rel: ["judge", "on_fail"],
      label: "On fail",
      kind: "enum",
      enumValues: ["retry_previous", "halt", "continue"],
      requiresVersion: V040,
      description:
        "retry_previous re-runs the gated step/node (default), halt aborts classified, continue records the verdict and proceeds.",
    },
    {
      rel: ["judge", "max_retries"],
      label: "Max retries",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      description: "Hard cap on judge-triggered re-runs of the gated step/node (default 1, max 5).",
    },
  );
  return seeds;
}

function edgeFields(): FieldSeed[] {
  return [
    {
      rel: ["from"],
      label: "From",
      kind: "string",
      required: true,
      description: "Source node name.",
    },
    { rel: ["to"], label: "To", kind: "string", required: true, description: "Target node name." },
    {
      rel: ["when", "key"],
      label: "Condition key",
      kind: "string",
      requiresVersion: V040,
      description: "Upstream NODE whose recorded output the edge predicate reads.",
    },
    {
      rel: ["when", "equals"],
      label: "Condition equals",
      kind: "yaml",
      requiresVersion: V040,
      description:
        "Take the edge when state[key] equals this scalar (string/number/boolean). Declare exactly ONE of equals / exists.",
    },
    {
      rel: ["when", "exists"],
      label: "Condition exists",
      kind: "boolean",
      requiresVersion: V040,
      description:
        "Take the edge once the key node has produced output (only `true` validates; clear the field instead of unchecking).",
    },
  ];
}

function hookEntryFields(): FieldSeed[] {
  // The whole hooks block is 0.4.0 — every entry field inherits the marker.
  return [
    {
      rel: ["event"],
      label: "Event",
      kind: "enum",
      enumValues: HOOK_EVENTS,
      required: true,
      requiresVersion: V040,
      description: "Lifecycle event that triggers the hook.",
    },
    {
      rel: ["matcher"],
      label: "Matcher",
      kind: "string",
      requiresVersion: V040,
      placeholder: "web*",
      description: "Optional glob filtering the event payload's name (e.g. a tool name).",
    },
    {
      rel: ["command"],
      label: "Command",
      kind: "string",
      required: true,
      requiresVersion: V040,
      placeholder: "./hooks/check.sh",
      description: "Command spawned when the event fires.",
    },
    {
      rel: ["timeout_ms"],
      label: "Timeout (ms)",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      description: "Kill the hook command after this many milliseconds.",
    },
  ];
}

function limitsFields(target: string): FieldSeed[] {
  // Loop contract 0.4 (Batch A): the whole block is 0.4.0-only.
  const ceiling = (
    key: string,
    label: string,
    description: string,
    placeholder?: string,
  ): FieldSeed => ({
    rel: [key],
    label,
    kind: "number",
    integer: true,
    requiresVersion: V040,
    description,
    ...(placeholder ? { placeholder } : {}),
  });
  const seeds: FieldSeed[] = [
    ceiling(
      "max_tool_iterations",
      "Max tool iterations",
      "Cap on tool-use round-trips per turn (the 500-iteration default otherwise).",
      "100",
    ),
    ceiling(
      "max_concurrent_tools",
      "Max concurrent tools",
      "Parallel tool-execution ceiling per block.",
    ),
    ceiling(
      "context_limit",
      "Context limit (tokens)",
      "Hard context-token ceiling (overrides the model's).",
    ),
    ceiling("deadline_ms", "Run deadline (ms)", "Wall-clock ceiling for the whole run."),
    ceiling("turn_timeout_ms", "Turn timeout (ms)", "Wall-clock ceiling for one turn."),
    ceiling(
      "model_call_timeout_ms",
      "Model call timeout (ms)",
      "Wall-clock ceiling for one model call.",
    ),
    {
      rel: ["loop_detection", "window"],
      label: "Loop detection window",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      description: "Trailing tool-call window inspected for runaway loops.",
    },
    {
      rel: ["loop_detection", "threshold"],
      label: "Loop detection threshold",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      description: "Identical calls inside the window that count as a loop (>= 2).",
    },
    {
      rel: ["loop_detection", "escalation"],
      label: "Loop escalation",
      kind: "enum",
      enumValues: ["warn", "justify", "abort"],
      requiresVersion: V040,
      description: "Response to a detected loop: trace-warn, demand justification, or abort.",
    },
  ];
  if (target === "crew") {
    // crew is the ONE shape whose limits block accepts the crew: sub-block.
    seeds.push(
      {
        rel: ["crew", "max_activations"],
        label: "Max role activations",
        kind: "number",
        integer: true,
        requiresVersion: V040,
        description: "Cap on total role activations per run.",
      },
      {
        rel: ["crew", "refusal_depth"],
        label: "Refusal depth",
        kind: "number",
        integer: true,
        requiresVersion: V040,
        description: "How many times a role may bounce a handoff back (0 = never refuse).",
      },
      {
        rel: ["crew", "max_a2a_depth"],
        label: "Max agent-to-agent depth",
        kind: "number",
        integer: true,
        requiresVersion: V040,
        description: "Cap on agent-to-agent delegation depth.",
      },
    );
  }
  return seeds;
}

function budgetFields(): FieldSeed[] {
  return [
    {
      rel: ["usd"],
      label: "Budget (USD)",
      kind: "number",
      required: true,
      placeholder: "5",
      description: "Dollar ceiling for one run; checked before each turn.",
    },
    {
      rel: ["on_exceed", "action"],
      label: "On exceed",
      kind: "enum",
      enumValues: ["stop", "degrade"],
      description: "stop = end the run cleanly; degrade = re-resolve onto a cheaper model.",
    },
    {
      rel: ["on_exceed", "model"],
      label: "Degrade to model",
      kind: "string",
      placeholder: "claude-haiku-4-5",
      description: "Cheaper model to continue on (required when action is degrade).",
    },
  ];
}

/**
 * Loop contract 0.4 (Batch B) — the top-level `evaluation:` block (in-loop
 * output evaluation on cli / channel / managed). `grader.type` is the
 * discriminant of a segmented union: llm_judge scores the reply in 0..1
 * against `criteria`; contains / regex are deterministic checks over `value`.
 * `threshold` applies to llm_judge only (the compiler rejects it with a
 * deterministic grader — the validity badge surfaces that; the form stays
 * permissive). Whole block is 0.4.0.
 */
function evaluationFields(): FieldSeed[] {
  return [
    {
      rel: ["grader", "type"],
      label: "Grader type",
      kind: "enum",
      enumValues: ["llm_judge", "contains", "regex"],
      required: true,
      requiresVersion: V040,
      description:
        "llm_judge scores the reply in 0..1 against criteria; contains / regex are deterministic text checks over value.",
    },
    {
      rel: ["grader", "criteria"],
      label: "Criteria (llm_judge)",
      kind: "string",
      requiresVersion: V040,
      description: "What a passing reply must satisfy — the judge scores the final text against this.",
    },
    {
      rel: ["grader", "model"],
      label: "Judge model (llm_judge)",
      kind: "string",
      requiresVersion: V040,
      placeholder: "claude-haiku-4-5",
      description: "Judge model id; defaults to the shape's primary model.",
    },
    {
      rel: ["grader", "value"],
      label: "Match value (contains / regex)",
      kind: "string",
      requiresVersion: V040,
      description:
        "Substring (contains) or JavaScript regular expression (regex) the final text must match.",
    },
    {
      rel: ["threshold"],
      label: "Threshold (llm_judge)",
      kind: "number",
      requiresVersion: V040,
      placeholder: "0.7",
      description: "Passing score in 0..1 (default 0.7); llm_judge grader only.",
    },
    {
      rel: ["on_fail"],
      label: "On fail",
      kind: "enum",
      enumValues: ["retry", "halt", "note"],
      requiresVersion: V040,
      description:
        "retry re-prompts with the judge rationale (default), halt aborts the turn classified, note emits a trace event only.",
    },
    {
      rel: ["max_retries"],
      label: "Max retries",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      description: "Hard cap on evaluation-triggered retries per turn (default 1, max 5).",
    },
  ];
}

function permissionsFields(): FieldSeed[] {
  return [
    {
      rel: ["mode"],
      label: "Mode",
      kind: "enum",
      enumValues: ["default", "plan", "auto"],
      description: "Baseline permission posture (bypass is CLI-flag-only by design).",
    },
    {
      // Loop contract 0.4 (Batch C, G11) — headless approval mode.
      rel: ["ask_mode"],
      label: "Ask mode",
      kind: "enum",
      enumValues: ["pause", "deny"],
      requiresVersion: V040,
      description:
        "Headless behaviour on an ask-gated tool: pause persists a resumable approval (e.g. Slack approve/deny) instead of the legacy collapse-to-deny.",
    },
    {
      rel: ["rules"],
      label: "Rules",
      kind: "yaml",
      placeholder: "- type: alwaysAllow\n  pattern: read",
      description: "List of { type: alwaysAllow|alwaysDeny|alwaysAsk, pattern }.",
    },
  ];
}

function memoryFields(): FieldSeed[] {
  return [
    { rel: ["enabled"], label: "Enabled", kind: "boolean", description: "false disables the block." },
    {
      rel: ["backend"],
      label: "Backend",
      kind: "enum",
      enumValues: ["file", "thredz"],
      description: "Where memories persist: local files (default) or a hosted Thredz wiki.",
    },
    {
      rel: ["embedder"],
      label: "Embedder",
      kind: "string",
      requiresVersion: V040,
      placeholder: "hash",
      description: "Embedder factory for hybrid FACT recall (wiki.embedder covers the wiki tier).",
    },
    {
      rel: ["ttl"],
      label: "TTL",
      kind: "string",
      placeholder: "90d",
      description: "Forget auto-captured facts after this duration (>= 1h); omit to keep forever.",
    },
    {
      rel: ["autoCapture"],
      label: "Auto-capture",
      kind: "boolean",
      description: "Summarize durable outcomes into memory at run teardown.",
    },
    {
      rel: ["autoRecall"],
      label: "Auto-recall",
      kind: "boolean",
      description: "Inject the top relevant memories into the system prompt at session start.",
    },
    {
      rel: ["recallK"],
      label: "Recall K",
      kind: "number",
      integer: true,
      description: "How many memories auto-recall injects (max 50).",
    },
    {
      rel: ["wiki"],
      label: "Wiki tier",
      kind: "yaml",
      placeholder: "enabled: true\nrecallK: 5",
      description: "Semantic wiki tier — { enabled, recallK, embedder, autoRecall, requireSources }.",
    },
    {
      rel: ["dream"],
      label: "Dream",
      kind: "yaml",
      placeholder: 'every: 24h\nmode: full\nbudget_usd: 0.5',
      description: "Scheduled consolidation — { every, mode, budget_usd, instructions }.",
    },
  ];
}

function continuityFields(): FieldSeed[] {
  return [
    {
      rel: ["enabled"],
      label: "Enabled",
      kind: "boolean",
      description: "false restores pre-0.3 behavior exactly (same as `continuity: false`).",
    },
    {
      rel: ["plan"],
      label: "Plans & goals",
      kind: "boolean",
      description: "Persist plans/goals and register the Plan/Goal tool families.",
    },
    {
      rel: ["proof"],
      label: "Proof",
      kind: "enum",
      enumValues: ["ladder", "require", "off"],
      description: "Proof-of-action ladder: claimed-vs-proven, require proven, or off.",
    },
    { rel: ["ledger"], label: "Requirements ledger", kind: "boolean", description: "Keep the verbatim requirements ledger." },
    { rel: ["handoff"], label: "Teardown handoff", kind: "boolean", description: "Write handoff.md at teardown." },
    {
      rel: ["scope"],
      label: "Scope",
      kind: "enum",
      enumValues: ["auto", "spec", "session"],
      description: "auto resolves per shape; session is only accepted on session-routed shapes.",
    },
    {
      rel: ["focusMaxChars"],
      label: "Focus max chars",
      kind: "number",
      integer: true,
      placeholder: "4096",
      description: "Hard cap on the mutable focus block.",
    },
  ];
}

function thredzFields(): FieldSeed[] {
  return [
    {
      rel: ["api_key"],
      label: "API key",
      kind: "string",
      required: true,
      placeholder: "$THREDZ_API_KEY",
      description: "Env-ref credential ($VAR form) — resolved from the environment, never embedded.",
    },
    {
      rel: ["base_url"],
      label: "Base URL",
      kind: "string",
      placeholder: "https://thredz.example.dev",
      description: "Self-hosted / local Thredz API base (omit for hosted).",
    },
    {
      rel: ["visibility"],
      label: "Visibility",
      kind: "enum",
      enumValues: ["private", "shared"],
      description: "private (default) overrides Thredz's shared-by-default.",
    },
    {
      rel: ["goals"],
      label: "Mirror goals",
      kind: "boolean",
      description: "Mirror continuity goal writes to Thredz goal_write/goal_update.",
    },
    {
      rel: ["agents"],
      label: "Agent handle",
      kind: "yaml",
      placeholder: "true",
      description: "true derives an addressable handle from the spec name; or a lowercase handle string.",
    },
  ];
}

function learningFields(): FieldSeed[] {
  return [
    { rel: ["enabled"], label: "Enabled", kind: "boolean", description: "false disables the block." },
    {
      rel: ["domain"],
      label: "Domain",
      kind: "string",
      required: true,
      description: "One sentence naming the field of expertise the agent studies.",
    },
    {
      rel: ["curriculum"],
      label: "Curriculum file",
      kind: "string",
      placeholder: "curriculum.md",
      description: "Spec-relative checkbox-ladder file the agent edits (omit to keep it in the wiki).",
    },
    {
      rel: ["sources"],
      label: "Sources",
      kind: "string-list",
      description: "Source-allowlist hints (domains/patterns) for STUDY gathering.",
    },
    {
      rel: ["exam"],
      label: "Exam",
      kind: "yaml",
      placeholder: "dataset: exam.jsonl\ngraders: graders.yaml",
      description: "Competency exam — spec-relative { dataset, graders } paths.",
    },
    {
      rel: ["study"],
      label: "Unattended study",
      kind: "yaml",
      placeholder: "on_heartbeat: true\non_dream: true",
      description: "{ on_heartbeat, on_dream } toggles (both default on).",
    },
  ];
}

function compactionFields(): FieldSeed[] {
  return [
    {
      rel: ["model"],
      label: "Model",
      kind: "string",
      description: "Model the compaction summarizer uses (omit for the runtime default).",
    },
    {
      rel: ["threshold"],
      label: "Threshold",
      kind: "number",
      requiresVersion: V040,
      placeholder: "0.85",
      description: "Context-fill fraction (0.5–0.99) that triggers autocompaction.",
    },
    {
      rel: ["snip_keep_head"],
      label: "Snip keep head",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      description: "Messages preserved verbatim at the transcript HEAD before summarising.",
    },
    {
      rel: ["snip_keep_tail"],
      label: "Snip keep tail",
      kind: "number",
      integer: true,
      requiresVersion: V040,
      description: "Messages preserved verbatim at the transcript TAIL.",
    },
    {
      rel: ["curate"],
      label: "Curate",
      kind: "boolean",
      description: "Opt in to the pre-compaction curator pass (dedupe + relevance reorder).",
    },
    {
      rel: ["dedupeThreshold"],
      label: "Dedupe threshold",
      kind: "number",
      description: "Cosine similarity above which the curator treats two items as duplicates (0–1].",
    },
    {
      rel: ["relevanceTopK"],
      label: "Relevance top-K",
      kind: "number",
      integer: true,
      description: "Max items the curator keeps after the relevance reorder.",
    },
  ];
}

function feedbackFields(): FieldSeed[] {
  return [
    { rel: ["enabled"], label: "Enabled", kind: "boolean", description: "false disables the block." },
    {
      rel: ["modality"],
      label: "Modality",
      kind: "enum",
      enumValues: ["binary", "stars", "scale", "comment"],
      description: "How ratings are captured (default binary 👍/👎).",
    },
    {
      rel: ["scale"],
      label: "Scale",
      kind: "yaml",
      placeholder: "min: 1\nmax: 10",
      description: "{ min, max } bounds for the scale modality.",
    },
    {
      rel: ["storage", "location"],
      label: "Storage location",
      kind: "string",
      description: "Named ratings store (safe-name).",
    },
    {
      rel: ["autoDistill"],
      label: "Auto-distill",
      kind: "boolean",
      description: "Turn accumulated ratings into registry datasets at run teardown.",
    },
    {
      rel: ["exitPrompt"],
      label: "Exit prompt",
      kind: "boolean",
      description: "One-keystroke REPL exit rating prompt (default on when the block is present).",
    },
    {
      rel: ["channelReactions"],
      label: "Channel reactions",
      kind: "boolean",
      description: "Wire Slack 👍/👎 reactions into feedback on the channel target.",
    },
  ];
}

function observabilityFields(): FieldSeed[] {
  const slo = (key: string, label: string, description: string, integer?: boolean): FieldSeed => ({
    rel: ["slo", key],
    label,
    kind: "number",
    description,
    ...(integer ? { integer: true } : {}),
  });
  return [
    slo("error_rate", "Error rate", "Fractional error-rate ceiling (unrecovered errors / model calls), e.g. 0.05."),
    slo("p95_latency_ms", "p95 latency (ms)", "p95 per-turn latency ceiling."),
    slo("ttft_ms", "TTFT (ms)", "p95 time-to-first-token ceiling."),
    slo("cost_per_hour_usd", "Cost per hour (USD)", "Cost burn ceiling per wall-clock hour."),
    slo("egress_block_rate", "Egress block rate", "Fractional egress-block-rate ceiling, e.g. 0.1."),
    slo("window_seconds", "Window (seconds)", "How long a breach must persist before mitigation fires (default 300).", true),
    {
      rel: ["slo", "mitigation"],
      label: "Mitigation ladder",
      kind: "string-list",
      suggestions: ["alert", "pause-intake", "rollback"],
      description: "Rungs walked in order on a sustained breach (alert / pause-intake / rollback).",
    },
    // Loop contract 0.4 (Batch C, G26) — the trace/metrics/cost/alerts/
    // incidents/otel sub-blocks that give observability a spec surface (the
    // deployed compiler carries only `slo`). All 0.4.0-marked.
    {
      rel: ["trace", "level"],
      label: "Trace level",
      kind: "enum",
      enumValues: ["off", "basic", "full"],
      requiresVersion: V040,
      description:
        "In-loop trace-ring detail: off, a low-overhead basic ring (the default-on target), or full spans.",
    },
    {
      rel: ["metrics"],
      label: "Metrics",
      kind: "boolean",
      requiresVersion: V040,
      description: "Emit the metrics subscriber (turn / tool / latency counters).",
    },
    {
      rel: ["cost"],
      label: "Cost tracking",
      kind: "boolean",
      requiresVersion: V040,
      description: "Accrue per-turn and per-tool cost (the default-on ring target).",
    },
    {
      rel: ["alerts"],
      label: "Alerts",
      kind: "boolean",
      requiresVersion: V040,
      description: "Enable the alert-watchdog subscriber.",
    },
    {
      rel: ["incidents"],
      label: "Incidents",
      kind: "boolean",
      requiresVersion: V040,
      description: "Capture incidents on sustained SLO breaches.",
    },
    {
      rel: ["otel", "endpoint"],
      label: "OTel endpoint",
      kind: "string",
      requiresVersion: V040,
      placeholder: "http://localhost:4318",
      description: "OpenTelemetry OTLP collector endpoint the exporter ships spans to.",
    },
  ];
}

function securityFields(): FieldSeed[] {
  return [
    {
      rel: ["justification", "judge"],
      label: "Justification judge",
      kind: "enum",
      enumValues: ["rule-based", "claude"],
      description: "Intent-gate judge: deterministic rules or the model-backed judge.",
    },
    {
      rel: ["justification", "model"],
      label: "Judge model",
      kind: "string",
      placeholder: "claude-haiku-4-5",
      description: "Model id for the claude judge (haiku-class default when omitted).",
    },
    {
      rel: ["egressMatcher"],
      label: "Egress matcher",
      kind: "enum",
      enumValues: ["substring", "semantic"],
      description: "How outbound payloads are matched against tagged data lineage.",
    },
  ];
}

function heartbeatFields(): FieldSeed[] {
  return [
    {
      rel: ["every"],
      label: "Every",
      kind: "string",
      required: true,
      placeholder: "2h",
      description: 'Wake interval — a duration like "1d", "2h", "30m", "60s".',
    },
    {
      rel: ["instructions"],
      label: "Instructions",
      kind: "string",
      required: true,
      description: "The synthetic message the daemon sends itself at each tick.",
    },
  ];
}

function gatewayFields(): FieldSeed[] {
  return [
    {
      rel: ["port"],
      label: "Port",
      kind: "number",
      integer: true,
      required: true,
      placeholder: "8787",
      description: "Port the control-UI gateway listens on (1–65535).",
    },
    {
      rel: ["ui"],
      label: "Dashboard",
      kind: "boolean",
      description: "Serve the minimal dashboard alongside the status endpoint.",
    },
  ];
}

function routingFields(schema: SpecSchema, target: string, base: SpecPath): FormField[] {
  if (target === "channel") {
    return at(base, [
      {
        rel: ["sessionKey"],
        label: "Session key",
        kind: "enum",
        enumValues: ["thread", "user", "channel"],
        required: true,
        description: "Which key groups messages into one conversation session.",
      },
    ]);
  }
  if (target === "crew") {
    return at(base, [
      {
        rel: ["kind"],
        label: "Kind",
        kind: "enum",
        enumValues: ["match", "llm"],
        required: true,
        enumVersions: { llm: V040 },
        description:
          "match routes on declared rules; llm lets a model pick the next role (routes at runtime with crewhaus >= 0.4.0 — earlier runtimes fall back to the entry role).",
      },
      {
        rel: ["match"],
        label: "Match rules",
        kind: "record",
        placeholder: "writer:\n  - contains: publish\n    to: editor",
        description: "role -> list of { contains, to } handoff rules.",
      },
    ]);
  }
  return yamlFallback(schema, base, "routing");
}

// --- fieldsForBlock ---------------------------------------------------------------

/**
 * Describe the editable fields of the block at `blockPath` for a spec of
 * `target`. `blockPath` is a Document path: `[]` for the spec-level core
 * fields (name/version + the target's own top-level scalars), `["agent"]` for
 * the agent block, `["steps", 0]` / `["nodes", "draft"]` / `["roles",
 * "writer"]` / `["edges", 1]` / `["hooks", 0]` for one collection entry
 * (sequence indexes as NUMBERS), and `["<key>"]` for any other top-level
 * block. Deeper paths under a collection resolve to that entry's form.
 *
 * Uncataloged blocks degrade to ONE whole-block "yaml" field (description
 * from the schema's catalog, requiresVersion from its blockVersions), so
 * every block the palette can add is at least yaml-editable. Availability is
 * the PALETTE's concern (blocksForTarget) — this function trusts the caller
 * and answers for whatever path it is handed.
 *
 * `record` is the block's CURRENT model value (the page already has it). It is
 * only consulted to resolve the ONE discriminated form in the catalog: a
 * `kind: judge` workflow step / graph node (loop contract 0.4) — which carries
 * a `judge:` gate instead of instructions/tools — gets the judge sub-form
 * ({@link judgeStepNodeFields}) rather than the regular step/node form. Omit it
 * (or pass a non-judge record) for the ordinary form; every other block
 * ignores it.
 */
export function fieldsForBlock(
  schema: SpecSchema,
  target: string,
  blockPath: SpecPath,
  record?: unknown,
): FormField[] {
  if (blockPath.length === 0) return at([], specCoreFields(target));

  const head = String(blockPath[0]);
  const blockVersion = schema.blockVersions?.[head];
  /** Apply the block-level version marker to fields without their own. */
  const marked = (fields: FormField[]): FormField[] =>
    blockVersion
      ? fields.map((f) => (f.requiresVersion ? f : { ...f, requiresVersion: blockVersion }))
      : fields;

  // Collection entries: ["steps", 0], ["nodes", "draft"], ["roles", "w"],
  // ["edges", 1], ["hooks", 0] (deeper paths resolve to the same entry).
  if (blockPath.length >= 2) {
    const base = blockPath.slice(0, 2);
    // A `kind: judge` step/node is a gate — its form is the judge sub-form.
    const isJudge = isRec(record) && record["kind"] === "judge";
    if (head === "steps") {
      return marked(at(base, isJudge ? judgeStepNodeFields("step") : stepNodeRoleFields("step")));
    }
    if (head === "nodes") {
      return marked(at(base, isJudge ? judgeStepNodeFields("node") : stepNodeRoleFields("node")));
    }
    if (head === "roles") return marked(at(base, stepNodeRoleFields("role")));
    if (head === "edges") return marked(at(base, edgeFields()));
    if (head === "hooks") return marked(at(base, hookEntryFields()));
    // An entry of an uncataloged collection: yaml-edit the entry itself.
    return marked([
      { path: [...base], label: humanize(head), kind: "yaml", description: schema.blocks[head] ?? "" },
    ]);
  }

  const base = blockPath;
  switch (head) {
    case "agent":
      return marked(at(base, agentFields(target)));
    case "tools":
      return marked(at(base, [toolsSeed([])]));
    case "mcp_servers":
      return marked(
        at(base, [
          {
            rel: [],
            label: "MCP servers",
            kind: "record",
            placeholder:
              "docs:\n  transport: stdio\n  command: bunx\n  args: [my-mcp]\n  env:\n    API_KEY: $API_KEY",
            description:
              "name -> { transport: stdio, command, args?, env? } or { transport: sse, url, headers? }.",
          },
        ]),
      );
    case "permissions":
      return marked(at(base, permissionsFields()));
    case "memory":
      return marked(at(base, memoryFields()));
    case "continuity":
      return marked(at(base, continuityFields()));
    case "thredz":
      return marked(at(base, thredzFields()));
    case "learning":
      return marked(at(base, learningFields()));
    case "budget":
      return marked(at(base, budgetFields()));
    case "evaluation":
      return marked(at(base, evaluationFields()));
    case "limits":
      return marked(at(base, limitsFields(target)));
    case "compaction":
      return marked(at(base, compactionFields()));
    case "feedback":
      return marked(at(base, feedbackFields()));
    case "observability":
      return marked(at(base, observabilityFields()));
    case "security":
      return marked(at(base, securityFields()));
    case "heartbeat":
      return marked(at(base, heartbeatFields()));
    case "gateway":
      return marked(at(base, gatewayFields()));
    case "routing":
      return marked(routingFields(schema, target, base));
    default:
      // failure_taxonomy, steps/nodes/roles/edges/hooks as WHOLE collections,
      // channels, retrieve, indexing, queue, voice, driver, dataset, graders,
      // tenants, triggers, game, chains, wallets, contracts,
      // transaction_policy, tool_config, cli, parallel, … — yaml fallback.
      return yamlFallback(schema, base, head);
  }
}

// --- applyFieldEdit -----------------------------------------------------------------

/** Build `{ a: { b: [ … ] } }`-style nesting for the remaining path segments. */
function nestValue(segments: SpecPath, leaf: unknown): unknown {
  let value = leaf;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i];
    if (typeof seg === "number") {
      const arr: unknown[] = [];
      arr[seg] = value;
      value = arr;
    } else {
      value = { [seg]: value };
    }
  }
  return value;
}

/** True for values that read as an EMPTY container/absence after YAML parse. */
function isEmptyYamlValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

/**
 * Write `value` at `path`, replacing a scalar/boolean-shorthand ancestor with
 * a map when needed (e.g. editing `continuity.proof` while the document says
 * `continuity: false` replaces the `false` with `{ proof: … }` IN PLACE —
 * key position and preceding comments survive; the scalar's own inline
 * comment goes with it). Plain `setPath` handles every other case, creating
 * intermediate maps/sequences as the path demands.
 */
function writeAtPath(doc: Document, path: SpecPath, value: unknown): FieldEditResult {
  try {
    for (let len = 1; len < path.length; len += 1) {
      const prefix = path.slice(0, len);
      const existing = getPath(doc, prefix);
      if (existing === undefined) break; // nothing deeper exists — setPath creates it
      if (existing === null || typeof existing !== "object") {
        // A scalar blocks the path: replace it with the nested remainder.
        // (NEVER pass an empty {} to setPath — yaml stores it as a raw JS
        // scalar, not a YAMLMap; nestValue always produces a non-empty one.)
        setPath(doc, prefix, nestValue(path.slice(len), value));
        return { ok: true };
      }
    }
    setPath(doc, path, value);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete `path`, then prune ancestor maps our delete emptied (deepest-first,
 * stopping at the first non-empty one) so clearing the last thinking knob
 * removes the now-invalid empty `thinking: {}` rather than leaving it. Only
 * `{}` maps are pruned — an empty ARRAY the user wrote stays.
 */
function deleteAndPrune(doc: Document, path: SpecPath): void {
  deletePath(doc, path);
  for (let len = path.length - 1; len >= 1; len -= 1) {
    const prefix = path.slice(0, len);
    const value = getPath(doc, prefix);
    const isEmptyMap =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 0;
    if (!isEmptyMap) break;
    deletePath(doc, prefix);
  }
}

/**
 * Apply one inspector edit: coerce the form's raw value by the field's kind
 * and write it at the field's absolute path via the Document (comments and
 * unrelated keys untouched). An EMPTY value (whitespace-only string, empty
 * list, empty yaml) CLEARS the field — `deletePath` plus empty-map pruning —
 * unless the field is `required`, which refuses with an error instead (the
 * spec would stop validating). Never throws; every failure is `{ ok: false,
 * error }` with the document unchanged.
 */
export function applyFieldEdit(
  doc: Document,
  field: FormField,
  rawValue: string | boolean,
): FieldEditResult {
  const clear = (): FieldEditResult => {
    if (field.required) return { ok: false, error: `${field.label} is required` };
    deleteAndPrune(doc, field.path);
    return { ok: true };
  };

  if (typeof rawValue === "boolean") {
    if (field.kind !== "boolean") {
      return { ok: false, error: `${field.label} expects text, not a checkbox value` };
    }
    return writeAtPath(doc, field.path, rawValue);
  }

  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return clear();

  switch (field.kind) {
    case "string":
      return writeAtPath(doc, field.path, rawValue.length === trimmed.length ? rawValue : trimmed);
    case "number": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, error: `${field.label} must be a number` };
      if (field.integer && !Number.isInteger(n)) {
        return { ok: false, error: `${field.label} must be an integer` };
      }
      return writeAtPath(doc, field.path, n);
    }
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (lower !== "true" && lower !== "false") {
        return { ok: false, error: `${field.label} must be true or false` };
      }
      return writeAtPath(doc, field.path, lower === "true");
    }
    case "enum": {
      const allowed = field.enumValues ?? [];
      if (!allowed.includes(trimmed)) {
        return { ok: false, error: `${field.label} must be one of: ${allowed.join(", ")}` };
      }
      return writeAtPath(doc, field.path, trimmed);
    }
    case "string-list": {
      const items = trimmed
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (items.length === 0) return clear();
      return writeAtPath(doc, field.path, items);
    }
    case "record":
    case "yaml": {
      const parsed = parseSpecModel(rawValue);
      if (parsed.errors.length > 0) {
        const first = parsed.errors[0];
        return { ok: false, error: `${field.label}: invalid YAML — ${first?.message ?? "parse error"}` };
      }
      if (isEmptyYamlValue(parsed.model)) return clear();
      if (
        field.kind === "record" &&
        (typeof parsed.model !== "object" || parsed.model === null || Array.isArray(parsed.model))
      ) {
        return { ok: false, error: `${field.label} must be a YAML mapping (key: value)` };
      }
      return writeAtPath(doc, field.path, parsed.model);
    }
  }
}

// --- structural helpers ----------------------------------------------------------
// The canvas's add/remove/rename/rewire operations, all as Document edits so
// comments and unrelated keys survive. Reads go through the plain-JS mirror
// (getPath), writes through setPath/deletePath — plus one targeted
// key-scalar mutation for map renames, which is the only way to rename a
// `nodes:`/`roles:` key WITHOUT rebuilding the map (rebuilding would drop
// comments inside every sibling).

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/** The collection path + noun for a named-entity kind. */
function collectionOf(kind: NamedEntityKind): { key: "steps" | "nodes" | "roles"; noun: string } {
  if (kind === "step") return { key: "steps", noun: "step" };
  if (kind === "node") return { key: "nodes", noun: "node" };
  return { key: "roles", noun: "role" };
}

function validateName(noun: string, name: string): FieldEditResult {
  if (name.length === 0) return { ok: false, error: `${noun} name must not be empty` };
  if (!SAFE_NAME_RE.test(name)) {
    return {
      ok: false,
      error: `${noun} name may contain only letters, digits, spaces, and '_ . - :'`,
    };
  }
  return { ok: true };
}

/** Existing names in a step sequence / node-or-role map (malformed entries drop out). */
function existingNames(kind: NamedEntityKind, collection: unknown): Set<string> {
  if (kind === "step") {
    const names = new Set<string>();
    for (const entry of asArray(collection) ?? []) {
      if (isRec(entry) && typeof entry["name"] === "string") names.add(entry["name"]);
    }
    return names;
  }
  return new Set(isRec(collection) ? Object.keys(collection) : []);
}

/** First "<prefix>-N" (N counting up from the collection size) not in `taken`. */
function freshName(prefix: string, taken: Set<string>, start: number): string {
  let n = Math.max(1, start);
  let candidate = `${prefix}-${n}`;
  while (taken.has(candidate)) {
    n += 1;
    candidate = `${prefix}-${n}`;
  }
  return candidate;
}

function addNamed(doc: Document, kind: NamedEntityKind, name?: string): StructuralAddResult {
  const { key, noun } = collectionOf(kind);
  const collection = getPath(doc, [key]);
  // A null collection (`nodes:` with nothing under it — the natural
  // in-progress state) counts as empty: writeAtPath replaces the null.
  if (collection !== undefined && collection !== null) {
    const wantArray = kind === "step";
    if (wantArray ? !Array.isArray(collection) : !isRec(collection)) {
      return { ok: false, error: `${key}: is not a ${wantArray ? "list" : "map"} — fix the YAML first` };
    }
  }
  const taken = existingNames(kind, collection);
  const count = kind === "step" ? (asArray(collection)?.length ?? 0) : taken.size;
  const finalName = name?.trim() ?? freshName(noun, taken, count + 1);
  const valid = validateName(noun, finalName);
  if (!valid.ok) return valid;
  if (taken.has(finalName)) {
    return { ok: false, error: `a ${noun} named "${finalName}" already exists` };
  }

  const path: SpecPath = kind === "step" ? [key, asArray(collection)?.length ?? 0] : [key, finalName];
  const skeleton =
    kind === "step"
      ? { name: finalName, instructions: NEW_INSTRUCTIONS_PLACEHOLDER }
      : { instructions: NEW_INSTRUCTIONS_PLACEHOLDER };
  const written = writeAtPath(doc, path, skeleton);
  if (!written.ok) return written;
  return { ok: true, name: finalName, path };
}

/**
 * Append a workflow step (`steps[]`), auto-naming it "step-N" when `name` is
 * omitted. The skeleton carries the required `instructions` placeholder so
 * the spec keeps validating. An absent or NULL collection (`steps:` with
 * nothing under it) is created/replaced; anything else non-list fails, as do
 * a name collision or an invalid name (document untouched either way).
 */
export function addStep(doc: Document, name?: string): StructuralAddResult {
  return addNamed(doc, "step", name);
}

/** Add a graph node (`nodes.<name>`) — see {@link addStep} for the contract. */
export function addNode(doc: Document, name?: string): StructuralAddResult {
  return addNamed(doc, "node", name);
}

/** Add a crew role (`roles.<name>`) — see {@link addStep} for the contract. */
export function addRole(doc: Document, name?: string): StructuralAddResult {
  return addNamed(doc, "role", name);
}

/**
 * Append a graph edge `{ from, to }` to `edges[]` (created when absent).
 * Node existence is NOT enforced — the canvas projection already warns on
 * dangling references, and the palette wires edges between real nodes.
 */
export function addEdge(doc: Document, from: string, to: string): StructuralAddResult {
  const src = from.trim();
  const dst = to.trim();
  if (src.length === 0 || dst.length === 0) {
    return { ok: false, error: "edge needs both a from and a to node name" };
  }
  const edges = getPath(doc, ["edges"]);
  // `edges:` with nothing under it (null) counts as empty, like addNamed.
  if (edges !== undefined && edges !== null && !Array.isArray(edges)) {
    return { ok: false, error: "edges: is not a list — fix the YAML first" };
  }
  const index = asArray(edges)?.length ?? 0;
  const path: SpecPath = ["edges", index];
  const written = writeAtPath(doc, path, { from: src, to: dst });
  if (!written.ok) return written;
  return { ok: true, name: `${src} -> ${dst}`, path };
}

/**
 * Insert a `kind: judge` workflow step (loop contract 0.4). A judge step gates
 * the PREVIOUS step's output, so it is placed immediately AFTER the step it
 * gates — `afterStepName`, or the last step when omitted — via a sequence
 * splice that leaves sibling steps' comments intact. The skeleton carries a
 * placeholder `criteria` (required) and `on_fail: retry_previous` so the spec
 * keeps validating; the judge step is auto-named "judge-N". Refuses when there
 * are no steps to gate, when `afterStepName` is unknown, or when `steps:` is
 * not a list (document untouched either way).
 */
export function addJudgeStep(doc: Document, afterStepName?: string): StructuralAddResult {
  const collection = getPath(doc, ["steps"]);
  if (collection !== undefined && collection !== null && !Array.isArray(collection)) {
    return { ok: false, error: "steps: is not a list — fix the YAML first" };
  }
  const steps = asArray(collection) ?? [];
  if (steps.length === 0) {
    return { ok: false, error: "a judge step must follow a step to gate — add a step first" };
  }
  const gated = afterStepName?.trim();
  let gateIndex: number;
  if (gated !== undefined && gated.length > 0) {
    gateIndex = stepIndex(steps, gated);
    if (gateIndex === -1) return { ok: false, error: `no step named "${gated}"` };
  } else {
    gateIndex = steps.length - 1;
  }
  const insertAt = gateIndex + 1;

  const taken = existingNames("step", collection);
  const finalName = freshName("judge", taken, 1);
  const valid = validateName("judge step", finalName);
  if (!valid.ok) return valid;

  const seqNode = doc.getIn(["steps"]);
  if (!isSeq(seqNode)) return { ok: false, error: "steps: is not a list — fix the YAML first" };
  const node = doc.createNode({
    name: finalName,
    kind: "judge",
    judge: { criteria: NEW_JUDGE_CRITERIA_PLACEHOLDER, on_fail: "retry_previous" },
  });
  seqNode.items.splice(insertAt, 0, node);
  return { ok: true, name: finalName, path: ["steps", insertAt] };
}

/**
 * Add a `kind: judge` graph node that gates `gatesNode` (loop contract 0.4).
 * A judge node scores its upstream's output, so it is wired DOWNSTREAM: an edge
 * `gatesNode -> <judge>` is appended (creating `edges:` when absent). The
 * skeleton carries a placeholder `criteria` and `on_fail: retry_previous`; the
 * node is auto-named "judge-N". Refuses when `gatesNode` is empty or not a
 * declared node, or when `nodes:` is not a map (document untouched).
 */
export function addJudgeNode(doc: Document, gatesNode: string): StructuralAddResult {
  const gated = gatesNode.trim();
  if (gated.length === 0) {
    return { ok: false, error: "a judge node must gate a node — name the node it gates" };
  }
  const collection = getPath(doc, ["nodes"]);
  if (collection !== undefined && collection !== null && !isRec(collection)) {
    return { ok: false, error: "nodes: is not a map — fix the YAML first" };
  }
  const taken = existingNames("node", collection);
  if (!taken.has(gated)) return { ok: false, error: `no node named "${gated}" to gate` };
  const finalName = freshName("judge", taken, 1);
  const valid = validateName("judge node", finalName);
  if (!valid.ok) return valid;

  const written = writeAtPath(doc, ["nodes", finalName], {
    kind: "judge",
    judge: { criteria: NEW_JUDGE_CRITERIA_PLACEHOLDER, on_fail: "retry_previous" },
  });
  if (!written.ok) return written;
  // Wire the gated node -> judge so the judge sits downstream of what it scores.
  const edge = addEdge(doc, gated, finalName);
  if (!edge.ok) return edge;
  return { ok: true, name: finalName, path: ["nodes", finalName] };
}

/** Step index by name, or -1. */
function stepIndex(steps: unknown, name: string): number {
  const arr = asArray(steps) ?? [];
  return arr.findIndex((entry) => isRec(entry) && entry["name"] === name);
}

/** Indexes of `edges[]` entries referencing `name` (from, to, or when.key). */
function edgeIndexesReferencing(edges: unknown, name: string): number[] {
  const out: number[] = [];
  (asArray(edges) ?? []).forEach((entry, i) => {
    if (!isRec(entry)) return;
    const when = isRec(entry["when"]) ? (entry["when"] as Rec) : undefined;
    if (entry["from"] === name || entry["to"] === name || when?.["key"] === name) out.push(i);
  });
  return out;
}

/**
 * Remove a named step/node/role from the Document, cleaning up the pure
 * WIRING that referenced it so the spec keeps validating:
 *
 *   - node — every edge whose `from`/`to`/`when.key` names it is removed too
 *     (an edge conditioned on a deleted node's output could never fire, so
 *     dropping it preserves semantics); `parallel` groups lose the member,
 *     groups that shrink below the schema's 2-node floor are dropped, and an
 *     emptied `parallel:` is removed.
 *   - role — `routing.match` rules that hand off TO it are removed (a rule
 *     list emptied that way is removed with its key), and its own match key
 *     is removed; an emptied `match:` map is removed.
 *
 * `entry:` is deliberately LEFT ALONE when it names the removed entity —
 * which node runs first is a semantic choice the operator must re-make, and
 * the canvas already surfaces the dangling entry as a warning.
 */
export function removeNamed(doc: Document, kind: NamedEntityKind, name: string): FieldEditResult {
  const { key, noun } = collectionOf(kind);

  if (kind === "step") {
    const index = stepIndex(getPath(doc, [key]), name);
    if (index === -1) return { ok: false, error: `no ${noun} named "${name}"` };
    deletePath(doc, [key, index]);
    return { ok: true };
  }

  const collection = getPath(doc, [key]);
  if (!isRec(collection) || !(name in collection)) {
    return { ok: false, error: `no ${noun} named "${name}"` };
  }
  deletePath(doc, [key, name]);

  if (kind === "node") {
    // Edges referencing the node (delete back-to-front so indexes hold).
    for (const i of edgeIndexesReferencing(getPath(doc, ["edges"]), name).reverse()) {
      deletePath(doc, ["edges", i]);
    }
    // Parallel groups: drop the member; drop groups below the 2-node floor.
    const rawParallel = asArray(getPath(doc, ["parallel"]));
    if (rawParallel) {
      const groups = rawParallel
        .map((g) => (asArray(g) ?? []).filter((m) => m !== name))
        .filter((g) => g.length >= 2);
      if (groups.length === 0) deletePath(doc, ["parallel"]);
      else setPath(doc, ["parallel"], groups);
    }
  }

  if (kind === "role") {
    const match = getPath(doc, ["routing", "match"]);
    if (isRec(match)) {
      for (const [fromRole, rawRules] of Object.entries(match)) {
        if (fromRole === name) {
          deletePath(doc, ["routing", "match", fromRole]);
          continue;
        }
        const rules = asArray(rawRules) ?? [];
        const removeIndexes = rules
          .map((rule, i) => (isRec(rule) && rule["to"] === name ? i : -1))
          .filter((i) => i !== -1);
        if (removeIndexes.length === rules.length && rules.length > 0) {
          // Every rule handed off to the removed role — drop the whole key
          // (the schema requires at least one rule per key).
          deletePath(doc, ["routing", "match", fromRole]);
        } else {
          for (const i of removeIndexes.reverse()) {
            deletePath(doc, ["routing", "match", fromRole, i]);
          }
        }
      }
      const after = getPath(doc, ["routing", "match"]);
      if (isRec(after) && Object.keys(after).length === 0) {
        deletePath(doc, ["routing", "match"]);
      }
    }
  }

  return { ok: true };
}

/**
 * Rename a `nodes:`/`roles:` map key IN PLACE by mutating the key scalar of
 * its Pair — the one edit `setPath` can't express. The value node (and every
 * comment inside it) is untouched; the pair keeps its position.
 */
function renameMapKey(doc: Document, mapPath: SpecPath, oldKey: string, newKey: string): boolean {
  const node = doc.getIn(mapPath);
  if (!isMap(node)) return false;
  for (const pair of node.items) {
    if (isScalar(pair.key) && pair.key.value === oldKey) {
      pair.key.value = newKey;
      return true;
    }
  }
  return false;
}

/**
 * Rename a named step/node/role AND rewire every reference so the spec keeps
 * validating: graph `entry`, `edges[].from/to/when.key`, and `parallel`
 * membership follow a node; crew `entry`, `routing.match` keys, and rule
 * `to:` targets follow a role. A workflow step has no cross-references — only
 * its own `name:` changes. Map keys are renamed in place (comments inside
 * the entry survive). Renaming to the SAME name is a no-op success; a
 * collision, an unknown old name, or an invalid new name fails with the
 * document untouched.
 */
export function renameNamed(
  doc: Document,
  kind: NamedEntityKind,
  oldName: string,
  newName: string,
): FieldEditResult {
  const { key, noun } = collectionOf(kind);
  const finalName = newName.trim();
  const valid = validateName(noun, finalName);
  if (!valid.ok) return valid;
  if (finalName === oldName) return { ok: true };

  const collection = getPath(doc, [key]);
  const taken = existingNames(kind, collection);
  if (!taken.has(oldName)) return { ok: false, error: `no ${noun} named "${oldName}"` };
  if (taken.has(finalName)) {
    return { ok: false, error: `a ${noun} named "${finalName}" already exists` };
  }

  if (kind === "step") {
    const index = stepIndex(collection, oldName);
    setPath(doc, [key, index, "name"], finalName);
    return { ok: true };
  }

  if (!renameMapKey(doc, [key], oldName, finalName)) {
    return { ok: false, error: `could not rename ${noun} "${oldName}" — non-scalar map key` };
  }

  if (getPath(doc, ["entry"]) === oldName) setPath(doc, ["entry"], finalName);

  if (kind === "node") {
    const edges = asArray(getPath(doc, ["edges"])) ?? [];
    edges.forEach((entry, i) => {
      if (!isRec(entry)) return;
      if (entry["from"] === oldName) setPath(doc, ["edges", i, "from"], finalName);
      if (entry["to"] === oldName) setPath(doc, ["edges", i, "to"], finalName);
      const when = isRec(entry["when"]) ? (entry["when"] as Rec) : undefined;
      if (when?.["key"] === oldName) setPath(doc, ["edges", i, "when", "key"], finalName);
    });
    const parallel = asArray(getPath(doc, ["parallel"])) ?? [];
    parallel.forEach((group, gi) => {
      (asArray(group) ?? []).forEach((member, mi) => {
        if (member === oldName) setPath(doc, ["parallel", gi, mi], finalName);
      });
    });
  }

  if (kind === "role") {
    const match = getPath(doc, ["routing", "match"]);
    if (isRec(match)) {
      // Rewire rule targets FIRST (their paths still use the old key names),
      // then rename the role's own match key in place.
      for (const [fromRole, rawRules] of Object.entries(match)) {
        (asArray(rawRules) ?? []).forEach((rule, i) => {
          if (isRec(rule) && rule["to"] === oldName) {
            setPath(doc, ["routing", "match", fromRole, i, "to"], finalName);
          }
        });
      }
      if (oldName in match) renameMapKey(doc, ["routing", "match"], oldName, finalName);
    }
  }

  return { ok: true };
}
