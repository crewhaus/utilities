// Static gallery of starter `crewhaus.yaml` templates the user can load into
// the editor.
//
// Pure data + logic. Imports nothing from ./compiler or ./cloudflare (the
// `__COMPILER_URL__` vite define is undefined under `bun test`), so it stays
// offline-testable — same discipline as ./byo-deploy/providers.ts and
// ./github-spec-store.ts.
//
// Scope discipline: every shipped template's `target` is one of the three
// BROWSER_DEPLOYABLE_TARGETS in index.astro (["cli","workflow","graph"]), so
// each one is actually deployable from the browser today. channel/voice/browser
// and the other starters parse but are NOT browser-deployable yet, so they are
// intentionally cut from this gallery.
//
// The cli templates are copied verbatim from the authored starter specs; the
// workflow and graph templates are ADAPTED so they actually compile to a
// Cloudflare Worker today — the cf-worker emitters reject step/node tools (all
// targets) and HITL/branching (graph) in M2, so those features are removed:
//   - hello-cli: the DEFAULT_YAML inlined at the top of index.astro (default).
//   - hello (cli): demos/starters/cli/crewhaus.yaml (verbatim).
//   - workflow:    adapted from demos/starters/workflow — tools-free.
//   - graph:       adapted from demos/starters/graph — HITL-free, linear.
// They are embedded (not imported) so this module pulls nothing from outside
// src/ and `bun test` stays hermetic. The browser-deployability of every
// shipped template is guarded in templates.test.ts.

/** The browser-deployable target shapes a shipped template may declare. */
export type BrowserDeployableTarget = "cli" | "workflow" | "graph";

/** Stable identifiers for the gallery templates. Default ("hello-cli") first. */
export type TemplateId = "hello-cli" | "hello" | "workflow" | "graph";

export type SpecTemplate = {
  readonly id: TemplateId;
  /** Display label for the gallery UI. */
  readonly label: string;
  /** The browser-deployable target this template compiles to. */
  readonly target: BrowserDeployableTarget;
  /** One-line description of what the template does. */
  readonly description: string;
  /** The full `crewhaus.yaml` source, ready to drop into the editor. */
  readonly yaml: string;
};

// --- Embedded starter YAML (verbatim) -------------------------------------

// Verbatim copy of DEFAULT_YAML inlined at the top of index.astro (the
// friendly hello-cli spec). Kept as the default so the gallery is a superset
// of today's editor default.
const HELLO_CLI_YAML = `name: hello-cli
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are a friendly assistant running inside a CrewHaus harness
    on the user's own Cloudflare Worker. Be concise and warm.
`;

// Verbatim copy of demos/starters/cli/crewhaus.yaml.
const HELLO_YAML = `name: hello
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a helpful, concise assistant. Reply in two sentences or fewer
    unless the user asks for more detail.
`;

// Adapted from demos/starters/workflow/crewhaus.yaml — the Bash tool (and its
// permission rule) are removed so this compiles to a cf-worker: the
// cf-worker-workflow emitter rejects any step that declares tools in M2.
const WORKFLOW_YAML = `name: hello-workflow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: brainstorm
    instructions: |
      The user will give you a topic or question. Produce three distinct,
      concrete angles for approaching it, as a short bulleted list.
      No preamble, no tools — just the three angles.
  - name: summarize
    instructions: |
      You will receive the previous step's three angles as context.
      Choose the single strongest one and explain, in one short paragraph,
      why it is the best starting point. Do not call any tools.
`;

// Adapted from demos/starters/graph/crewhaus.yaml — the human-in-the-loop
// (hitl) gate on the execute node is removed so this compiles to a cf-worker:
// the cf-worker-graph emitter supports only linear, HITL-free, tools-free
// graphs in M2 (HITL/branching need the local graph target).
const GRAPH_YAML = `name: hello-graph
target: graph
model: claude-sonnet-4-6
entry: plan
nodes:
  plan:
    instructions: |
      You are the PLAN node of a 3-node graph (plan -> execute -> summarise).
      Read the user's input from the Upstream state and produce a 3-bullet
      plan for how to address it. Return only the plan, no preamble.
  execute:
    instructions: |
      You are the EXECUTE node. Read the plan from the Upstream state's
      plan field and execute it: produce concrete findings, talking points,
      or evidence in 4-6 sentences. Stay grounded in the plan; do not
      free-associate.
  summarise:
    instructions: |
      You are the SUMMARISE node. Read the plan and execute results from
      the Upstream state and produce a 2-sentence executive summary.
      Prose only — no lists or bullets.
edges:
  - from: plan
    to: execute
  - from: execute
    to: summarise
`;

// --- Registry --------------------------------------------------------------

export const TEMPLATES: Record<TemplateId, SpecTemplate> = {
  "hello-cli": {
    id: "hello-cli",
    label: "Hello (CLI)",
    target: "cli",
    description:
      "A friendly single-agent CLI harness — the default starter. Chat with a warm, concise assistant on your own Worker.",
    yaml: HELLO_CLI_YAML,
  },
  hello: {
    id: "hello",
    label: "Concise assistant (CLI)",
    target: "cli",
    description:
      "A minimal single-agent CLI that answers in two sentences or fewer unless asked for more detail.",
    yaml: HELLO_YAML,
  },
  workflow: {
    id: "workflow",
    label: "Two-step workflow",
    target: "workflow",
    description:
      "A tools-free two-step workflow: brainstorm three angles on the user's topic, then pick and justify the strongest.",
    yaml: WORKFLOW_YAML,
  },
  graph: {
    id: "graph",
    label: "Plan → execute → summarise graph",
    target: "graph",
    description:
      "A three-node linear graph (plan → execute → summarise): plan an approach, execute it, then write a short summary.",
    yaml: GRAPH_YAML,
  },
};

/**
 * Stable ordering of template ids for iterating the gallery in the UI.
 * The default template ("hello-cli", matching index.astro's DEFAULT_YAML) is
 * first.
 */
export const TEMPLATE_IDS: readonly TemplateId[] = [
  "hello-cli",
  "hello",
  "workflow",
  "graph",
];

/** Look up a template by id. */
export function getTemplate(id: TemplateId): SpecTemplate {
  return TEMPLATES[id];
}

/**
 * Extract the declared `target` from a `crewhaus.yaml` source, defaulting to
 * "cli" when absent. Uses the SAME regex index.astro's updateTargetIndicator
 * applies (`/^\s*target:\s*([a-z-]+)/m`); re-implemented here so the .astro
 * handler can optionally reuse it without importing from the page.
 */
export function detectTarget(yaml: string): string {
  const match = yaml.match(/^\s*target:\s*([a-z-]+)/m);
  return match ? match[1] : "cli";
}
