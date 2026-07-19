// Spec-schema descriptor for the loop builder: which target shapes exist and
// which top-level blocks a `crewhaus.yaml` may carry per target, with a
// one-line description each — the data the builder UI uses to offer "add a
// block" choices that the compiler will actually accept.
//
// The real authority is the factory compiler. `loadSpecSchema` therefore asks
// the compiler-worker for `GET <compilerUrl>/schema` first; that endpoint
// returns `{ version, schema }` where `schema` is the whole Spec grammar as a
// JSON-Schema document (root `$ref` → `#/definitions/CrewhausSpec`, one named
// definition per target shape — exactly `@crewhaus/spec`'s `specJsonSchema()`
// output). A `coerceSpecSchema` ADAPTER folds that JSON-Schema into the
// builder's `SpecSchema` shape. The endpoint only exists on the 0.4+ line, so
// on ANY failure — 404 from a 0.3.x deploy, network error, non-2xx, non-JSON,
// wrong shape — the loader falls back to the last-good cached copy and then to
// the embedded {@link FALLBACK_SCHEMA}. A successful fetch is re-cached.
//
// The embedded FALLBACK_SCHEMA is itself DERIVED from a checked-in snapshot of
// that same `specJsonSchema()` output (./spec-schema-snapshot.json, generated
// from factory `feat/loop-contract-0.4` @ 79251acd) through the same adapter —
// so the offline catalog can never silently diverge in STRUCTURE from the real
// grammar (which target shapes exist, and which blocks each accepts). The only
// hand-maintained pieces are (a) a small friendly-description overlay layered
// over the schema's terse/absent block descriptions and (b) the loop-contract
// 0.4 block-version markers ({@link FALLBACK_BLOCK_VERSIONS}); a drift test
// asserts every marked block still exists in the snapshot and that the
// snapshot still carries exactly the 14 canonical targets.
//
// Discipline (mirrors ./templates.ts / ./fleet.ts / ./github-spec-store.ts):
// this file imports NOTHING from ./compiler or ./cloudflare — those pull in
// the `__COMPILER_URL__` vite define, which is undefined under `bun test` and
// would break the suite (the embedded snapshot JSON is inert data). The
// compiler URL arrives as an ARGUMENT, the fetch is an injectable seam
// (SpecFetch pattern), and the cache is an injectable plain get/set async
// interface — the PAGE backs it with IndexedDB; this lib stays
// storage-agnostic and touches NO DOM. Unit tests run fully offline.

import SNAPSHOT from "./spec-schema-snapshot.json";

/** Injectable fetch seam, mirroring SpecFetch in ./github-spec-store.ts. */
export type SchemaFetch = typeof fetch;

// --- shapes ------------------------------------------------------------------

/** One top-level spec block the builder can offer for a target. */
export type SpecSchemaBlock = {
  readonly key: string;
  /** One-line, builder-facing description of what the block does. */
  readonly description: string;
  /**
   * Minimum crewhaus version the block needs when it is NEWER than the
   * deployed 0.3.x compiler line (e.g. "0.4.0"). Absent for blocks every
   * live compiler accepts. The builder still authors marked blocks — the
   * validity badge downgrades a remote unknown-key error on them to a
   * "needs compiler <version>" note instead of a red spec error.
   */
  readonly requiresVersion?: string;
};

/**
 * The schema descriptor: the known `target:` values, a catalog of one-line
 * block descriptions, and the per-target list of top-level blocks that
 * actually validate on that target. `name`, `version`, and `target` are
 * universal spec keys and are NOT listed per target; neither are per-target
 * scalar core fields (workflow/graph/crew `model`, graph/crew `entry`,
 * research `goal`/`branchingFactor`, …) — those are the spec-core form's job,
 * not palette blocks.
 */
export type SpecSchema = {
  /** Provenance stamp, e.g. "fallback-0.4-77c74616" or a server version. */
  readonly schemaVersion: string;
  /** Every recognized `target:` value. */
  readonly targets: readonly string[];
  /** Block key -> one-line description, for every key used in blocksByTarget. */
  readonly blocks: Readonly<Record<string, string>>;
  /** Target -> the top-level block keys that apply to that target. */
  readonly blocksByTarget: Readonly<Record<string, readonly string[]>>;
  /**
   * Block key -> minimum crewhaus version, listing ONLY keys newer than the
   * deployed 0.3.x compiler line (see SpecSchemaBlock.requiresVersion).
   * Optional so pre-0.4 cached copies and version-less remote bodies stay
   * valid schemas.
   */
  readonly blockVersions?: Readonly<Record<string, string>>;
};

/** Where a loaded schema came from (the page surfaces this honestly). */
export type SpecSchemaSource = "remote" | "cache" | "fallback";

export type LoadedSpecSchema = {
  readonly schema: SpecSchema;
  readonly source: SpecSchemaSource;
};

/**
 * The injectable last-good cache seam: a plain async get/set keyed store.
 * Storage-agnostic on purpose — the page backs it with IndexedDB, the tests
 * with a Map. Errors thrown by either method are swallowed by the loader (a
 * broken cache must never take the builder down).
 */
export type SpecSchemaCache = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
};

/** The single cache key `loadSpecSchema` reads/writes its last-good copy under. */
export const SPEC_SCHEMA_CACHE_KEY = "spec-schema:last-good:v1";

// --- the JSON-Schema -> SpecSchema adapter -----------------------------------
//
// `specJsonSchema()` emits a draft-07 document: a root `$ref` to
// `#/definitions/CrewhausSpec` (the target-discriminated union) plus one named
// definition per target shape (`#/definitions/cli`, …/workflow, …). Each
// target definition is `{ type: "object", properties, required,
// additionalProperties: false }`. The adapter reads that structure:
//
//   - targets       = definition names other than the union `CrewhausSpec`;
//   - blocksByTarget = each target's STRUCTURED properties (objects, arrays,
//     unions, and $refs), minus the universal name/version/target keys —
//     scalar properties (model/entry/goal/branchingFactor/…) are spec-core
//     fields, never palette blocks;
//   - blocks         = each block's `description`, taken from the schema's own
//     `.describe()` when present, else the friendly overlay below, else "".
//
// zod-to-json-schema INLINES the first occurrence of a shared block and emits
// `$ref` for the rest, so a block's inline `description` (when any) always
// rides its first-seen occurrence — which is exactly where the overlay lookup
// resolves it from.

/** The universal spec keys, listed on every target but never palette blocks. */
const UNIVERSAL_KEYS: ReadonlySet<string> = new Set(["name", "version", "target"]);

/** The union definition name in the snapshot — a target-less discriminator. */
const UNION_DEFINITION = "CrewhausSpec";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True iff a target property is a palette BLOCK (structured) rather than a
 * scalar spec-core field. Objects, arrays, unions (`anyOf`/`oneOf`/`allOf`,
 * e.g. `continuity: false | {…}`), and `$ref`s are blocks; a plain
 * string/number/integer/boolean scalar is a core field the spec-core form owns
 * (model, entry, goal, branchingFactor, concurrency, seed, groundingModel, …).
 */
function isBlockProperty(node: unknown): boolean {
  if (!isRecord(node)) return false;
  if ("$ref" in node || "anyOf" in node || "oneOf" in node || "allOf" in node) return true;
  const type = node["type"];
  if (type === "object" || type === "array") return true;
  return "properties" in node || "items" in node;
}

/** Collapse any whitespace run to a single space (descriptions stay one line). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The friendly-description overlay: builder-facing one-liners layered over the
 * schema, whose block-level `.describe()` annotations are terse or absent. The
 * schema's OWN description always wins when it carries one (see the adapter);
 * this only fills the gaps. A key here that the snapshot no longer carries is
 * simply dead (harmless); a snapshot block missing from here degrades to an
 * empty tooltip — the drift test flags that so a tooltip can be added.
 */
const BLOCK_DESCRIPTION_OVERLAY: Readonly<Record<string, string>> = {
  agent:
    "The agent definition — model + instructions, plus (by target) max_tokens, thinking, streaming, rate_limits, model_fallbacks, tools.",
  tools: "Allow-list of built-in tool names the agent may call.",
  tool_config: "Per-tool configuration overrides for entries in tools.",
  mcp_servers: "MCP server definitions the harness may connect to (command/url + $ENV refs).",
  permissions: "Permission rules gating tool use (allow / deny / ask).",
  memory: "Persistent remember/recall memory stores scoped to the spec.",
  continuity: "Session continuity — persist and restore conversation state across restarts.",
  thredz: "Thredz wiki integration — a living knowledge base the agent reads and writes.",
  learning: "Self-learning loop — distills run experience back into guidance.",
  budget: "Spend ceiling for a run (USD / token caps).",
  limits: "Hard runtime ceilings — tool iterations, timeouts, context cap, loop detection.",
  hooks: "Lifecycle hooks — run a command at session/tool/model/compaction events.",
  evaluation:
    "In-loop output evaluation — score each finished turn and retry/halt/note when it misses the bar.",
  compaction: "Context-window compaction strategy (autocompact / curator / snip).",
  security: "Security fabric — redaction, audit, and boundary controls.",
  failure_taxonomy: "Named failure classes for classifying and reporting run failures.",
  feedback: "Ratings capture (rate / distill, Slack reactions) feeding the optimizer.",
  observability: "Metrics and SLO thresholds with mitigations.",
  steps: "Ordered workflow steps, each with instructions and optional model/tools (or a judge step).",
  nodes: "Graph nodes — named LLM-backed stages with instructions (and optional hitl / judge).",
  edges: "Graph edges — from/to links wiring nodes into a DAG.",
  parallel: "Parallel barrier groups — sets of graph nodes that execute concurrently.",
  roles: "Crew roles — named agent-shaped blocks sharing the crew model default.",
  routing: "Routing — channel: which key groups a session; crew: role-routing rules.",
  retrieve:
    "Retrieval config — embedder + vector backend (pipeline) or allowed origins/roots (research).",
  indexing: "Indexing pipeline — chunk strategy, sizes, and the documents to index.",
  channels: "Chat-surface bindings (slack / telegram / discord / whatsapp / imessage).",
  heartbeat: "Periodic self-prompt — run instructions on an interval.",
  gateway: "Control-UI gateway — a status endpoint (and optional dashboard) on a port.",
  tenants: "Managed tenants, each with its own token budget.",
  queue: "Job-queue binding (adapter, visibility, retries) for the batch worker.",
  voice: "Voice runtime — provider, voice id, VAD, barge-in tuning.",
  telephony: "Telephony provider binding (twilio / livekit-sip / in-memory).",
  driver: "Browser driver — backend, viewport, start URL.",
  dataset: "Eval dataset reference (name / version / split) from the dataset registry.",
  graders: "Eval graders scoring each sample (registry names + options).",
  triggers: "Onchain triggers — contract events, block scans, or address watches.",
  game: "Game binding — contract, state reader, turn semantics, objective.",
  chains: "Chain bindings the harness may read/write.",
  chain: "The single chain binding (onchain-game).",
  wallets: "Wallet bindings for signing transactions.",
  wallet: "The single wallet binding (onchain-game).",
  contracts: "Contract bindings (address + ABI) the agent may call.",
  transaction_policy: "Write-approval, contract allow-list, and simulation policy.",
  cli: "CLI-shape options (e.g. the cold-start banner).",
};

/**
 * Loop contract 0.4 — the hand-curated block-level version markers: exactly
 * the WHOLE top-level keys the deployed 0.3.x compiler-worker rejects as
 * unknown until factory 0.4.0 deploys. `limits`/`hooks` ride the nine
 * loop-running shapes, `parallel` is graph-only, and `evaluation` is the new
 * in-loop grader on cli/channel/managed. FIELD-level 0.4.0 markers (e.g.
 * `agent.thinking`, `compaction.threshold`, `edges[].when`,
 * `permissions.ask_mode`, and observability's new `trace`/`metrics`/`otel`
 * sub-blocks) live in ./form-model.ts's field catalog — this map only covers
 * whole blocks. NOTE: `observability` is a 0.3-era block (its `slo` shape ships
 * on the deployed line), so it stays UNMARKED here even though the Batch-E
 * snapshot extends it — marking the whole block would wrongly cascade "0.4.0"
 * onto its pre-existing `slo.*` fields via form-model's block-marker fallback.
 *
 * Attached to the EMBEDDED fallback only: a live remote `/schema` is a 0.4+
 * compiler that natively validates every block it advertises, so
 * remote-derived schemas carry no markers. A drift test pins every key here to
 * an actual block in the snapshot.
 */
export const FALLBACK_BLOCK_VERSIONS: Readonly<Record<string, string>> = {
  limits: "0.4.0",
  hooks: "0.4.0",
  parallel: "0.4.0",
  evaluation: "0.4.0",
};

/**
 * Fold a `specJsonSchema()` JSON-Schema document into a {@link SpecSchema}, or
 * return null when it is not a usable schema document (no object `definitions`,
 * or no target definitions once the union is dropped). `schemaVersion` stamps
 * the result's provenance. `blockVersions` — the hand-curated 0.4 markers —
 * is attached ONLY for keys that actually surface as a block (advisory markers
 * for absent blocks are dropped, never a reason to reject the schema); pass it
 * for the embedded fallback and omit it for live-remote schemas.
 */
export function specSchemaFromJsonSchema(
  doc: unknown,
  schemaVersion: string,
  blockVersions?: Readonly<Record<string, string>>,
): SpecSchema | null {
  if (!isRecord(doc)) return null;
  const definitions = doc["definitions"];
  if (!isRecord(definitions)) return null;

  const targets = Object.keys(definitions).filter(
    (name) => name !== UNION_DEFINITION && isRecord(definitions[name]),
  );
  if (targets.length === 0) return null;

  // First-seen inline `.describe()` per block key (the overlay fills the rest).
  const schemaDescriptions: Record<string, string> = {};

  const blocks: Record<string, string> = {};
  const blocksByTarget: Record<string, readonly string[]> = {};

  for (const target of targets) {
    const def = definitions[target] as JsonRecord;
    const properties = isRecord(def["properties"]) ? (def["properties"] as JsonRecord) : {};
    const keys: string[] = [];
    for (const [key, node] of Object.entries(properties)) {
      if (UNIVERSAL_KEYS.has(key)) continue;
      if (!isBlockProperty(node)) continue; // scalar spec-core field — not a block
      keys.push(key);
      if (
        schemaDescriptions[key] === undefined &&
        isRecord(node) &&
        typeof node["description"] === "string" &&
        node["description"].trim().length > 0
      ) {
        schemaDescriptions[key] = oneLine(node["description"]);
      }
      if (blocks[key] === undefined) {
        blocks[key] = schemaDescriptions[key] ?? oneLine(BLOCK_DESCRIPTION_OVERLAY[key] ?? "");
      }
    }
    blocksByTarget[target] = keys;
  }
  // A schema `.describe()` seen only on a LATER target still wins over the
  // overlay — re-resolve now that every occurrence has been scanned.
  for (const key of Object.keys(blocks)) {
    if (schemaDescriptions[key] !== undefined) blocks[key] = schemaDescriptions[key];
  }

  const attachedVersions: Record<string, string> = {};
  if (blockVersions) {
    for (const [key, version] of Object.entries(blockVersions)) {
      if (blocks[key] !== undefined && typeof version === "string" && version.length > 0) {
        attachedVersions[key] = version;
      }
    }
  }

  return {
    schemaVersion,
    targets,
    blocks,
    blocksByTarget,
    ...(Object.keys(attachedVersions).length > 0 ? { blockVersions: attachedVersions } : {}),
  };
}

// --- embedded fallback ---------------------------------------------------------

/** Provenance stamp for the snapshot-derived embedded fallback. */
export const FALLBACK_SCHEMA_VERSION = "fallback-0.4-79251acd";

/**
 * The embedded fallback schema: the checked-in `specJsonSchema()` snapshot
 * (./spec-schema-snapshot.json) run through {@link specSchemaFromJsonSchema}
 * with the hand-curated 0.4 markers. Served whenever neither the compiler
 * `/schema` endpoint nor a cached last-good copy is available. Building it at
 * module load also fail-fasts a malformed snapshot (a build-time error, not a
 * silent empty catalog).
 */
export const FALLBACK_SCHEMA: SpecSchema = (() => {
  const built = specSchemaFromJsonSchema(SNAPSHOT, FALLBACK_SCHEMA_VERSION, FALLBACK_BLOCK_VERSIONS);
  if (!built) {
    throw new Error("spec-schema: embedded snapshot is not a usable JSON-Schema document");
  }
  return built;
})();

// --- validation / coercion ------------------------------------------------------

/** True iff `value` is an array of non-empty strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === "string" && s.length > 0);
}

/**
 * Validate an already-{@link SpecSchema}-shaped value (a last-good cache blob
 * this loader itself stored) into a SpecSchema, or return null when it doesn't
 * qualify. Requires non-empty `targets` and a complete `blocksByTarget` record
 * of string arrays — a schema without the per-target map is useless to the
 * builder, so it does NOT count as a successful load (the fallback serves
 * better). Missing `blocks` descriptions degrade to an empty catalog; missing
 * `schemaVersion` is stamped "remote". `blockVersions` is passed through when
 * it is a record of non-empty strings (non-string entries drop out; a
 * malformed or absent map is simply omitted — version markers are advisory,
 * never a reason to reject a schema).
 */
function coerceStoredSpecSchema(record: JsonRecord): SpecSchema | null {
  if (!isStringArray(record["targets"]) || record["targets"].length === 0) return null;
  const targets = [...record["targets"]];

  const rawByTarget = record["blocksByTarget"];
  if (!isRecord(rawByTarget)) return null;
  const blocksByTarget: Record<string, readonly string[]> = {};
  for (const [target, keys] of Object.entries(rawByTarget)) {
    if (!isStringArray(keys)) return null;
    blocksByTarget[target] = [...keys];
  }

  const blocks: Record<string, string> = {};
  const rawBlocks = record["blocks"];
  if (isRecord(rawBlocks)) {
    for (const [key, description] of Object.entries(rawBlocks)) {
      if (typeof description === "string") blocks[key] = description;
    }
  }

  const schemaVersion =
    typeof record["schemaVersion"] === "string" && record["schemaVersion"].length > 0
      ? record["schemaVersion"]
      : "remote";

  const blockVersions: Record<string, string> = {};
  const rawVersions = record["blockVersions"];
  if (isRecord(rawVersions)) {
    for (const [key, version] of Object.entries(rawVersions)) {
      if (typeof version === "string" && version.length > 0) blockVersions[key] = version;
    }
  }

  return {
    schemaVersion,
    targets,
    blocks,
    blocksByTarget,
    ...(Object.keys(blockVersions).length > 0 ? { blockVersions } : {}),
  };
}

/**
 * Coerce an untrusted value into a SpecSchema, or null when it doesn't
 * qualify. Handles BOTH shapes the loader may hand it:
 *
 *   - a live compiler `/schema` body `{ version, schema }` — or a bare
 *     `specJsonSchema()` document with top-level `definitions` — is folded
 *     through {@link specSchemaFromJsonSchema} (no version markers: a 0.4+
 *     compiler natively validates every block it advertises);
 *   - an already-{@link SpecSchema}-shaped value (the last-good cache blob) is
 *     validated and passed through.
 *
 * Detection keys on `definitions`/`schema.definitions` (only the JSON-Schema
 * document carries those) so a cached SpecSchema — which has `blocksByTarget`
 * and no `definitions` — never mis-routes.
 */
export function coerceSpecSchema(value: unknown): SpecSchema | null {
  if (!isRecord(value)) return null;

  const wrapped = value["schema"];
  const schemaDoc = isRecord(wrapped) && isRecord(wrapped["definitions"])
    ? wrapped
    : isRecord(value["definitions"])
      ? value
      : null;
  if (schemaDoc) {
    const version =
      typeof value["version"] === "string" && value["version"].length > 0
        ? value["version"]
        : "remote";
    return specSchemaFromJsonSchema(schemaDoc, version);
  }

  return coerceStoredSpecSchema(value);
}

// --- loading ---------------------------------------------------------------------

/**
 * Load the spec schema, best-source-first:
 *
 *  1. `GET <url>/schema` on the compiler-worker (source: "remote") — the
 *     `{ version, schema }` body is adapted and, on success, stored to `cache`
 *     under {@link SPEC_SCHEMA_CACHE_KEY} as the new last-good copy;
 *  2. else the cached last-good copy (source: "cache");
 *  3. else the embedded {@link FALLBACK_SCHEMA} (source: "fallback").
 *
 * NEVER throws and never returns a malformed schema: fetch/HTTP/JSON/shape
 * and even cache get/set failures are all swallowed into the next source down
 * (the endpoint is expected to 404 on a 0.3.x deploy). `url` is the
 * compiler-worker base URL, threaded in by the caller — this module does not
 * know the deploy-time compiler URL by design.
 */
export async function loadSpecSchema(args: {
  url: string;
  fetchImpl?: SchemaFetch;
  cache?: SpecSchemaCache;
}): Promise<LoadedSpecSchema> {
  const { url, cache } = args;
  // Under `bun test` the global fetch exists; the typeof guard keeps this
  // module import- and call-safe even in a fetch-less runtime.
  const fetchImpl = args.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);

  if (fetchImpl && url) {
    try {
      const res = await fetchImpl(`${url.replace(/\/+$/, "")}/schema`);
      if (res.ok) {
        const body = (await res.json()) as unknown;
        const schema = coerceSpecSchema(body);
        if (schema) {
          if (cache) {
            try {
              await cache.set(SPEC_SCHEMA_CACHE_KEY, schema);
            } catch {
              // A failing cache write must not block a successful load.
            }
          }
          return { schema, source: "remote" };
        }
      }
    } catch {
      // Network/JSON failure — fall through to cache, then fallback.
    }
  }

  if (cache) {
    try {
      const cached = coerceSpecSchema(await cache.get(SPEC_SCHEMA_CACHE_KEY));
      if (cached) return { schema: cached, source: "cache" };
    } catch {
      // A failing cache read degrades to the embedded fallback.
    }
  }

  return { schema: FALLBACK_SCHEMA, source: "fallback" };
}

// --- helpers ---------------------------------------------------------------------

/**
 * The blocks that apply to `target`, resolved to `{ key, description }` pairs
 * (description "" when the schema's catalog has no entry; `requiresVersion`
 * attached when the schema's blockVersions marks the key). Preserves the
 * schema's declared order and drops duplicate keys. An unknown target yields
 * an empty list — callers decide whether to fall back (detectTargetFromModel
 * already defaults the target itself to "cli").
 */
export function blocksForTarget(schema: SpecSchema, target: string): SpecSchemaBlock[] {
  const keys = schema.blocksByTarget[target] ?? [];
  const seen = new Set<string>();
  const out: SpecSchemaBlock[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const requiresVersion = schema.blockVersions?.[key];
    out.push({
      key,
      description: schema.blocks[key] ?? "",
      ...(requiresVersion ? { requiresVersion } : {}),
    });
  }
  return out;
}
