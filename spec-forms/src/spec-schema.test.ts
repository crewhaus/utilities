import { describe, expect, test } from "bun:test";
import SNAPSHOT from "./spec-schema-snapshot.json";
import {
  blocksForTarget,
  coerceSpecSchema,
  FALLBACK_BLOCK_VERSIONS,
  FALLBACK_SCHEMA,
  FALLBACK_SCHEMA_VERSION,
  loadSpecSchema,
  SPEC_SCHEMA_CACHE_KEY,
  specSchemaFromJsonSchema,
  type SchemaFetch,
  type SpecSchema,
  type SpecSchemaCache,
} from "./spec-schema";

// --- offline seams ------------------------------------------------------------

// A mocked fetch seam that records requests and returns a canned Response.
// Never hits the network — modeled on fleet.test.ts's mockFetch.
type Observed = { url: string; init: RequestInit };

function mockFetch(respond: (url: string) => Response | Promise<Response>): {
  fetchImpl: SchemaFetch;
  calls: Observed[];
} {
  const calls: Observed[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const observed: Observed = { url: String(url), init: init ?? {} };
    calls.push(observed);
    return respond(observed.url);
  }) as unknown as SchemaFetch;
  return { fetchImpl, calls };
}

/** A Map-backed cache seam (the page will back the real one with IndexedDB). */
function mapCache(seed?: Record<string, unknown>): {
  cache: SpecSchemaCache;
  store: Map<string, unknown>;
} {
  const store = new Map<string, unknown>(Object.entries(seed ?? {}));
  const cache: SpecSchemaCache = {
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
  };
  return { cache, store };
}

const COMPILER = "https://compiler.example.dev";

// The 14 canonical target shapes, in the snapshot's declared order.
const EXPECTED_TARGETS = [
  "cli",
  "workflow",
  "channel",
  "graph",
  "managed",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
  "eval",
  "onchain",
  "onchain-game",
];

// The nine loop-running shapes that carry limits/hooks (loop contract 0.4).
const LOOP_RUNNING = [
  "cli",
  "workflow",
  "channel",
  "graph",
  "managed",
  "crew",
  "research",
  "batch",
  "browser",
];

// Scalar spec-core fields the palette must NEVER surface as blocks (they are
// the spec-core form's job) — the adapter filters them out by type.
const SCALAR_CORE_FIELDS = [
  "model",
  "entry",
  "goal",
  "branchingFactor",
  "maxDurationMs",
  "concurrency",
  "idempotencyWindowMs",
  "seed",
  "groundingModel",
];

/**
 * A minimal, self-contained `specJsonSchema()`-shaped document distinct from
 * the real snapshot: exercises union exclusion, scalar-vs-block filtering, and
 * schema-description-wins. `note` is a scalar (excluded); `budget` carries its
 * own `.describe()` (must win over the overlay).
 */
const REMOTE_JSON_SCHEMA = {
  $ref: "#/definitions/CrewhausSpec",
  definitions: {
    cli: {
      type: "object",
      properties: {
        name: { type: "string" },
        version: { type: "integer" },
        target: { type: "string", const: "cli" },
        agent: { type: "object", properties: { model: { type: "string" } } },
        tools: { type: "array", items: { type: "string" } },
        limits: { type: "object", properties: { deadline_ms: { type: "integer" } } },
        budget: { type: "object", description: "Server-authored budget blurb." },
        note: { type: "string" },
      },
      required: ["name", "target", "agent"],
      additionalProperties: false,
    },
    workflow: {
      type: "object",
      properties: {
        name: { type: "string" },
        target: { type: "string", const: "workflow" },
        model: { type: "string" },
        steps: { type: "array", items: { type: "object" } },
        continuity: { anyOf: [{ type: "boolean" }, { type: "object" }] },
      },
      required: ["name", "target", "model", "steps"],
      additionalProperties: false,
    },
    CrewhausSpec: {
      anyOf: [{ $ref: "#/definitions/cli" }, { $ref: "#/definitions/workflow" }],
    },
  },
  $schema: "http://json-schema.org/draft-07/schema#",
};

/** The full compiler `/schema` body wrapping the document above. */
const REMOTE_BODY = { version: "0.4.0", schema: REMOTE_JSON_SCHEMA };

// The snapshot's target-definition map (drops the union discriminator).
type Defs = Record<string, { properties?: Record<string, unknown> }>;
const SNAPSHOT_DEFS = (SNAPSHOT as { definitions: Defs }).definitions;
const SNAPSHOT_TARGETS = Object.keys(SNAPSHOT_DEFS).filter((k) => k !== "CrewhausSpec");

// --- the embedded snapshot (drift guards) -------------------------------------

describe("spec-schema snapshot (drift guards vs the real specJsonSchema())", () => {
  test("is a specJsonSchema() document: root union $ref + named definitions", () => {
    expect((SNAPSHOT as { $ref: string }).$ref).toBe("#/definitions/CrewhausSpec");
    expect(SNAPSHOT_DEFS["CrewhausSpec"]).toBeDefined();
  });

  test("carries exactly the 14 canonical targets (order preserved)", () => {
    expect(SNAPSHOT_TARGETS).toEqual(EXPECTED_TARGETS);
    expect(SNAPSHOT_TARGETS.length).toBe(14);
  });

  test("every 0.4.0-marked block actually exists in the snapshot", () => {
    for (const key of Object.keys(FALLBACK_BLOCK_VERSIONS)) {
      const present = SNAPSHOT_TARGETS.some((t) =>
        Object.keys(SNAPSHOT_DEFS[t]?.properties ?? {}).includes(key),
      );
      // Reported as {key, present} so a failure names the drifted marker.
      expect({ key, present }).toEqual({ key, present: true });
    }
  });

  test("workflow steps allow a `kind: judge` step (loop contract 0.4 Batch B)", () => {
    const steps = SNAPSHOT_DEFS["workflow"]?.properties?.["steps"] as {
      items?: { anyOf?: Array<{ properties?: { kind?: { const?: string } } }> };
    };
    const branches = steps?.items?.anyOf ?? [];
    const judge = branches.some((b) => b.properties?.kind?.const === "judge");
    expect(judge).toBe(true);
  });

  test("evaluation is a real block on cli/channel/managed in the snapshot", () => {
    for (const t of ["cli", "channel", "managed"]) {
      expect(Object.keys(SNAPSHOT_DEFS[t]?.properties ?? {})).toContain("evaluation");
    }
    // …and NOT on the orchestration shapes (judging rides steps/nodes there).
    for (const t of ["workflow", "graph"]) {
      expect(Object.keys(SNAPSHOT_DEFS[t]?.properties ?? {})).not.toContain("evaluation");
    }
  });

  test("observability is a real block on cli/channel/managed/crew (Batch E)", () => {
    for (const t of ["cli", "channel", "managed", "crew"]) {
      expect(Object.keys(SNAPSHOT_DEFS[t]?.properties ?? {})).toContain("observability");
    }
    // …and NOT on the shapes that never carry the SLO control surface.
    for (const t of ["workflow", "graph", "pipeline"]) {
      expect(Object.keys(SNAPSHOT_DEFS[t]?.properties ?? {})).not.toContain("observability");
    }
  });

  test("permissions.ask_mode is a FIELD inside the permissions block (Batch E)", () => {
    // A field-level 0.4 addition (form-model.ts owns the field catalog); it must
    // NOT surface as a new top-level block key on any target.
    const perms = SNAPSHOT_DEFS["cli"]?.properties?.["permissions"] as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(perms?.properties ?? {})).toContain("ask_mode");
    for (const t of SNAPSHOT_TARGETS) {
      expect(Object.keys(SNAPSHOT_DEFS[t]?.properties ?? {})).not.toContain("ask_mode");
    }
  });
});

// --- FALLBACK_SCHEMA (derived from the snapshot) ------------------------------

describe("FALLBACK_SCHEMA (snapshot-derived)", () => {
  test("stamps the snapshot provenance version", () => {
    expect(FALLBACK_SCHEMA.schemaVersion).toBe(FALLBACK_SCHEMA_VERSION);
    expect(FALLBACK_SCHEMA_VERSION).toContain("79251acd");
  });

  test("lists exactly the 14 canonical target shapes", () => {
    expect(FALLBACK_SCHEMA.targets.length).toBe(14);
    expect([...FALLBACK_SCHEMA.targets]).toEqual(EXPECTED_TARGETS);
  });

  test("blocksByTarget covers every target and nothing else", () => {
    expect(Object.keys(FALLBACK_SCHEMA.blocksByTarget).sort()).toEqual(
      [...FALLBACK_SCHEMA.targets].sort(),
    );
  });

  test("every per-target block key has a non-empty one-line description", () => {
    for (const [target, keys] of Object.entries(FALLBACK_SCHEMA.blocksByTarget)) {
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        const description = FALLBACK_SCHEMA.blocks[key];
        // Reported as {target, key, ok} so a failure names the hole to fill.
        expect({
          target,
          key,
          ok: typeof description === "string" && description.length > 0,
        }).toEqual({ target, key, ok: true });
        expect(description).not.toContain("\n");
      }
    }
  });

  test("no per-target list repeats a key", () => {
    for (const [target, keys] of Object.entries(FALLBACK_SCHEMA.blocksByTarget)) {
      expect({ target, unique: new Set(keys).size === keys.length }).toEqual({
        target,
        unique: true,
      });
    }
  });

  test("universal spec keys (name/version/target) are never listed as blocks", () => {
    for (const keys of Object.values(FALLBACK_SCHEMA.blocksByTarget)) {
      expect(keys).not.toContain("name");
      expect(keys).not.toContain("version");
      expect(keys).not.toContain("target");
    }
  });

  test("scalar core fields (model/entry/goal/…) are never listed as blocks", () => {
    for (const [target, keys] of Object.entries(FALLBACK_SCHEMA.blocksByTarget)) {
      for (const scalar of SCALAR_CORE_FIELDS) {
        expect({ target, scalar, leaked: keys.includes(scalar) }).toEqual({
          target,
          scalar,
          leaked: false,
        });
      }
    }
  });

  // Ground-truth spot checks — the same shape facts the old hand-maintained
  // descriptor pinned, now proven straight off the derived snapshot.
  test("cli carries the full single-agent feature set incl. security/feedback/evaluation", () => {
    const keys = FALLBACK_SCHEMA.blocksByTarget["cli"] ?? [];
    for (const k of [
      "agent",
      "tools",
      "mcp_servers",
      "permissions",
      "memory",
      "continuity",
      "thredz",
      "learning",
      "budget",
      "compaction",
      "security",
      "failure_taxonomy",
      "feedback",
      "observability",
      "evaluation",
      "limits",
      "hooks",
    ]) {
      expect(keys).toContain(k);
    }
    expect(keys).not.toContain("steps");
    expect(keys).not.toContain("nodes");
  });

  test("workflow is steps-shaped: steps yes; agent/tools/memory no; budget now offered", () => {
    const keys = FALLBACK_SCHEMA.blocksByTarget["workflow"] ?? [];
    expect(keys).toContain("steps");
    expect(keys).toContain("continuity");
    // The snapshot offers budget on workflow (the old hand catalog missed it).
    expect(keys).toContain("budget");
    expect(keys).not.toContain("agent");
    // tools live per-step on workflow, not top-level.
    expect(keys).not.toContain("tools");
    expect(keys).not.toContain("memory");
    // model is a scalar core field, not a block.
    expect(keys).not.toContain("model");
  });

  test("graph is nodes+edges-shaped and has no top-level agent/tools/mcp_servers", () => {
    const keys = FALLBACK_SCHEMA.blocksByTarget["graph"] ?? [];
    expect(keys).toContain("nodes");
    expect(keys).toContain("edges");
    expect(keys).not.toContain("agent");
    expect(keys).not.toContain("tools");
    expect(keys).not.toContain("mcp_servers");
    expect(keys).not.toContain("entry"); // scalar core field
  });

  test("crew/pipeline/eval/channel/onchain carry their signature blocks", () => {
    expect(FALLBACK_SCHEMA.blocksByTarget["crew"]).toContain("roles");
    expect(FALLBACK_SCHEMA.blocksByTarget["pipeline"]).toContain("retrieve");
    expect(FALLBACK_SCHEMA.blocksByTarget["pipeline"]).toContain("indexing");
    expect(FALLBACK_SCHEMA.blocksByTarget["eval"]).toContain("dataset");
    expect(FALLBACK_SCHEMA.blocksByTarget["eval"]).toContain("graders");
    expect(FALLBACK_SCHEMA.blocksByTarget["channel"]).toContain("channels");
    expect(FALLBACK_SCHEMA.blocksByTarget["onchain"]).toContain("triggers");
    expect(FALLBACK_SCHEMA.blocksByTarget["onchain-game"]).toContain("game");
  });

  // Loop contract 0.4: limits/hooks/parallel/evaluation are REAL spec keys on
  // factory main but the deployed compiler-worker still runs 0.3.x — so they
  // are offered WITH a "0.4.0" marker (the validity badge downgrades remote
  // unknown-key errors on them to "needs compiler 0.4.0").
  test("limits/hooks are offered on exactly the nine loop-running shapes, 0.4.0-marked", () => {
    for (const target of FALLBACK_SCHEMA.targets) {
      const keys = FALLBACK_SCHEMA.blocksByTarget[target] ?? [];
      const expected = LOOP_RUNNING.includes(target);
      expect({ target, limits: keys.includes("limits") }).toEqual({ target, limits: expected });
      expect({ target, hooks: keys.includes("hooks") }).toEqual({ target, hooks: expected });
    }
    expect(FALLBACK_SCHEMA.blockVersions?.["limits"]).toBe("0.4.0");
    expect(FALLBACK_SCHEMA.blockVersions?.["hooks"]).toBe("0.4.0");
  });

  test("parallel is offered on graph only, 0.4.0-marked", () => {
    for (const target of FALLBACK_SCHEMA.targets) {
      const keys = FALLBACK_SCHEMA.blocksByTarget[target] ?? [];
      expect({ target, parallel: keys.includes("parallel") }).toEqual({
        target,
        parallel: target === "graph",
      });
    }
    expect(FALLBACK_SCHEMA.blockVersions?.["parallel"]).toBe("0.4.0");
  });

  test("evaluation is offered on cli/channel/managed only, 0.4.0-marked", () => {
    for (const target of FALLBACK_SCHEMA.targets) {
      const keys = FALLBACK_SCHEMA.blocksByTarget[target] ?? [];
      const expected = ["cli", "channel", "managed"].includes(target);
      expect({ target, evaluation: keys.includes("evaluation") }).toEqual({
        target,
        evaluation: expected,
      });
    }
    expect(FALLBACK_SCHEMA.blockVersions?.["evaluation"]).toBe("0.4.0");
  });

  // observability is offered on cli/channel/managed and (new in the Batch-E
  // snapshot) crew — but it stays an UNMARKED block: its `slo` shape ships on
  // the deployed 0.3.x line, and its 0.4 additions are FIELD-level markers in
  // ./form-model.ts. Whole-block-marking it would cascade "0.4.0" onto the
  // pre-existing slo.* fields via form-model's block-marker fallback.
  test("observability is offered on cli/channel/managed/crew only, and stays UNMARKED", () => {
    for (const target of FALLBACK_SCHEMA.targets) {
      const keys = FALLBACK_SCHEMA.blocksByTarget[target] ?? [];
      const expected = ["cli", "channel", "managed", "crew"].includes(target);
      expect({ target, observability: keys.includes("observability") }).toEqual({
        target,
        observability: expected,
      });
    }
    expect(FALLBACK_SCHEMA.blockVersions?.["observability"]).toBeUndefined();
  });

  test("only the Batch-A/B loop keys carry a version marker (0.3 blocks stay unmarked)", () => {
    expect(Object.keys(FALLBACK_SCHEMA.blockVersions ?? {}).sort()).toEqual([
      "evaluation",
      "hooks",
      "limits",
      "parallel",
    ]);
    // 0.3-era blocks present on cli must NOT be marked (observability included).
    for (const k of ["agent", "budget", "memory", "permissions", "observability"]) {
      expect(FALLBACK_SCHEMA.blockVersions?.[k]).toBeUndefined();
    }
  });

  test("round-trips through its own coercion (it is a valid stored schema)", () => {
    expect(coerceSpecSchema(FALLBACK_SCHEMA)).toEqual(FALLBACK_SCHEMA);
    // And through JSON — it must survive the cache seam losslessly.
    expect(coerceSpecSchema(JSON.parse(JSON.stringify(FALLBACK_SCHEMA)))).toEqual(FALLBACK_SCHEMA);
  });
});

// --- adapter goldens (blocksForTarget over the derived fallback) --------------

describe("blocksForTarget — snapshot-derived goldens", () => {
  test("cli includes evaluation + limits + hooks, each 0.4.0-marked", () => {
    const blocks = blocksForTarget(FALLBACK_SCHEMA, "cli");
    const byKey = new Map(blocks.map((b) => [b.key, b]));
    for (const key of ["evaluation", "limits", "hooks"]) {
      expect(byKey.has(key)).toBe(true);
      expect(byKey.get(key)?.requiresVersion).toBe("0.4.0");
    }
    // A plain 0.3-era block carries NO requiresVersion property (clean spread).
    const agent = byKey.get("agent");
    expect(agent).toBeDefined();
    expect(agent && "requiresVersion" in agent).toBe(false);
  });

  test("resolves keys to {key, description} pairs in declared order", () => {
    const result = blocksForTarget(FALLBACK_SCHEMA, "eval");
    expect(result.map((b) => b.key)).toEqual([...(FALLBACK_SCHEMA.blocksByTarget["eval"] ?? [])]);
    for (const block of result) {
      expect(block.description).toBe(FALLBACK_SCHEMA.blocks[block.key] ?? "");
      expect(block.description.length).toBeGreaterThan(0);
    }
  });

  test("returns [] for an unknown target", () => {
    expect(blocksForTarget(FALLBACK_SCHEMA, "no-such-shape")).toEqual([]);
    expect(blocksForTarget(FALLBACK_SCHEMA, "")).toEqual([]);
  });

  test("fills a missing catalog description with an empty string and dedupes keys", () => {
    const schema: SpecSchema = {
      schemaVersion: "t",
      targets: ["cli"],
      blocks: { agent: "The agent." },
      blocksByTarget: { cli: ["agent", "mystery", "agent"] },
    };
    expect(blocksForTarget(schema, "cli")).toEqual([
      { key: "agent", description: "The agent." },
      { key: "mystery", description: "" },
    ]);
  });

  test("attaches requiresVersion from blockVersions (and only then)", () => {
    const graphParallel = blocksForTarget(FALLBACK_SCHEMA, "graph").find(
      (b) => b.key === "parallel",
    );
    expect(graphParallel?.requiresVersion).toBe("0.4.0");
    const graphNodes = blocksForTarget(FALLBACK_SCHEMA, "graph").find((b) => b.key === "nodes");
    expect(graphNodes && "requiresVersion" in graphNodes).toBe(false);
  });

  test("resolves every fallback target to a non-empty, fully-described list", () => {
    for (const target of FALLBACK_SCHEMA.targets) {
      const blocks = blocksForTarget(FALLBACK_SCHEMA, target);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b.description.length).toBeGreaterThan(0);
    }
  });
});

// --- specSchemaFromJsonSchema (the adapter itself) ----------------------------

describe("specSchemaFromJsonSchema", () => {
  test("drops the union definition and scalar core fields; keeps structured blocks", () => {
    const schema = specSchemaFromJsonSchema(REMOTE_JSON_SCHEMA, "srv-1");
    expect(schema).not.toBeNull();
    expect(schema?.schemaVersion).toBe("srv-1");
    expect(schema?.targets).toEqual(["cli", "workflow"]); // CrewhausSpec excluded
    expect(schema?.blocksByTarget["cli"]).toEqual(["agent", "tools", "limits", "budget"]); // note (scalar) dropped
    expect(schema?.blocksByTarget["workflow"]).toEqual(["steps", "continuity"]); // model (scalar) dropped
  });

  test("a schema's own .describe() wins over the friendly overlay", () => {
    const schema = specSchemaFromJsonSchema(REMOTE_JSON_SCHEMA, "srv-1");
    expect(schema?.blocks["budget"]).toBe("Server-authored budget blurb.");
    // A block with no schema description falls to the overlay one-liner.
    expect(schema?.blocks["agent"]).toContain("agent definition");
  });

  test("attaches blockVersions only for keys that surface as a block", () => {
    const schema = specSchemaFromJsonSchema(REMOTE_JSON_SCHEMA, "srv-1", {
      limits: "0.4.0",
      parallel: "0.4.0", // absent from this doc — must be dropped
    });
    expect(schema?.blockVersions).toEqual({ limits: "0.4.0" });
  });

  test("omits blockVersions entirely when none apply (remote 0.4+ path)", () => {
    const schema = specSchemaFromJsonSchema(REMOTE_JSON_SCHEMA, "srv-1");
    expect(schema && "blockVersions" in schema).toBe(false);
  });

  test.each([
    ["null", null],
    ["a string", "schema"],
    ["an array", []],
    ["no definitions", { $ref: "#/definitions/X" }],
    ["definitions not an object", { definitions: [] }],
    ["only the union definition", { definitions: { CrewhausSpec: { anyOf: [] } } }],
  ])("returns null for %s", (_label, value) => {
    expect(specSchemaFromJsonSchema(value, "v")).toBeNull();
  });
});

// --- coerceSpecSchema (dual-shape) --------------------------------------------

describe("coerceSpecSchema — remote {version, schema}", () => {
  test("folds a compiler /schema body through the adapter, stamping its version", () => {
    const coerced = coerceSpecSchema(REMOTE_BODY);
    expect(coerced?.schemaVersion).toBe("0.4.0");
    expect(coerced?.targets).toEqual(["cli", "workflow"]);
    expect(coerced?.blocksByTarget["cli"]).toContain("limits");
    // Live remote = a 0.4+ compiler; it validates every block it advertises,
    // so NO version markers ride a remote schema.
    expect(coerced && "blockVersions" in coerced).toBe(false);
  });

  test("accepts a bare specJsonSchema() document (no {version} wrapper)", () => {
    const coerced = coerceSpecSchema(REMOTE_JSON_SCHEMA);
    expect(coerced?.schemaVersion).toBe("remote");
    expect(coerced?.targets).toEqual(["cli", "workflow"]);
  });

  test("defaults a missing/blank version to \"remote\"", () => {
    expect(coerceSpecSchema({ schema: REMOTE_JSON_SCHEMA })?.schemaVersion).toBe("remote");
    expect(coerceSpecSchema({ version: "", schema: REMOTE_JSON_SCHEMA })?.schemaVersion).toBe(
      "remote",
    );
  });
});

describe("coerceSpecSchema — stored SpecSchema (cache blob)", () => {
  test("accepts a minimal valid shape and stamps a default schemaVersion", () => {
    const coerced = coerceSpecSchema({
      targets: ["cli"],
      blocksByTarget: { cli: ["agent"] },
    });
    expect(coerced).toEqual({
      schemaVersion: "remote",
      targets: ["cli"],
      blocks: {},
      blocksByTarget: { cli: ["agent"] },
    });
  });

  test("drops non-string block descriptions but keeps string ones", () => {
    const coerced = coerceSpecSchema({
      targets: ["cli"],
      blocks: { agent: "ok", bogus: 42 },
      blocksByTarget: { cli: ["agent"] },
    });
    expect(coerced?.blocks).toEqual({ agent: "ok" });
  });

  test("passes blockVersions through, dropping non-string entries", () => {
    const coerced = coerceSpecSchema({
      targets: ["cli"],
      blocksByTarget: { cli: ["limits"] },
      blockVersions: { limits: "0.4.0", bogus: 4, empty: "" },
    });
    expect(coerced?.blockVersions).toEqual({ limits: "0.4.0" });
  });

  test("omits blockVersions when absent or malformed (advisory, never fatal)", () => {
    const plain = coerceSpecSchema({ targets: ["cli"], blocksByTarget: { cli: ["agent"] } });
    expect(plain && "blockVersions" in plain).toBe(false);
    const malformed = coerceSpecSchema({
      targets: ["cli"],
      blocksByTarget: { cli: ["agent"] },
      blockVersions: ["not", "a", "map"],
    });
    expect(malformed).not.toBeNull();
    expect(malformed && "blockVersions" in malformed).toBe(false);
  });

  test.each([
    ["null", null],
    ["a string", "schema"],
    ["an array", []],
    ["missing targets", { blocksByTarget: {} }],
    ["empty targets", { targets: [], blocksByTarget: {} }],
    ["non-string target", { targets: ["cli", 7], blocksByTarget: {} }],
    ["missing blocksByTarget", { targets: ["cli"] }],
    ["array blocksByTarget", { targets: ["cli"], blocksByTarget: [] }],
    ["non-array block list", { targets: ["cli"], blocksByTarget: { cli: "agent" } }],
    ["non-string block key", { targets: ["cli"], blocksByTarget: { cli: [1] } }],
  ])("rejects %s", (_label, value) => {
    expect(coerceSpecSchema(value)).toBeNull();
  });
});

// --- loadSpecSchema ----------------------------------------------------------------

describe("loadSpecSchema", () => {
  test("fetches <url>/schema and returns the adapted remote schema on success", async () => {
    const { fetchImpl, calls } = mockFetch(() => Response.json(REMOTE_BODY));
    const { schema, source } = await loadSpecSchema({ url: COMPILER, fetchImpl });
    expect(source).toBe("remote");
    expect(schema.schemaVersion).toBe("0.4.0");
    expect(schema.targets).toEqual(["cli", "workflow"]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`${COMPILER}/schema`);
  });

  test("strips trailing slashes from the compiler url (no double slash)", async () => {
    const { fetchImpl, calls } = mockFetch(() => Response.json(REMOTE_BODY));
    await loadSpecSchema({ url: `${COMPILER}//`, fetchImpl });
    expect(calls[0]?.url).toBe(`${COMPILER}/schema`);
  });

  test("caches the ADAPTED schema as the last-good copy (not the raw body)", async () => {
    const { fetchImpl } = mockFetch(() => Response.json(REMOTE_BODY));
    const { cache, store } = mapCache();
    const { schema } = await loadSpecSchema({ url: COMPILER, fetchImpl, cache });
    expect(store.get(SPEC_SCHEMA_CACHE_KEY)).toEqual(schema);
    // The cached copy round-trips back through coerce (stored-schema path).
    expect(coerceSpecSchema(store.get(SPEC_SCHEMA_CACHE_KEY))).toEqual(schema);
  });

  test("404 (endpoint not on a 0.3.x deploy) with an empty cache falls back embedded", async () => {
    const { fetchImpl } = mockFetch(() => new Response("not found", { status: 404 }));
    const { cache } = mapCache();
    const { schema, source } = await loadSpecSchema({ url: COMPILER, fetchImpl, cache });
    expect(source).toBe("fallback");
    expect(schema).toEqual(FALLBACK_SCHEMA);
  });

  test("404 with a cached last-good copy serves the cache", async () => {
    const cached = coerceSpecSchema(REMOTE_BODY);
    const { fetchImpl } = mockFetch(() => new Response("not found", { status: 404 }));
    const { cache } = mapCache({ [SPEC_SCHEMA_CACHE_KEY]: cached });
    const { schema, source } = await loadSpecSchema({ url: COMPILER, fetchImpl, cache });
    expect(source).toBe("cache");
    expect(schema).toEqual(cached as SpecSchema);
  });

  test("network failure falls back (cache empty)", async () => {
    const { fetchImpl } = mockFetch(() => {
      throw new TypeError("Load failed");
    });
    const { schema, source } = await loadSpecSchema({ url: COMPILER, fetchImpl });
    expect(source).toBe("fallback");
    expect(schema).toEqual(FALLBACK_SCHEMA);
  });

  test("non-JSON body falls back", async () => {
    const { fetchImpl } = mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const { source } = await loadSpecSchema({ url: COMPILER, fetchImpl });
    expect(source).toBe("fallback");
  });

  test("JSON with the wrong shape falls back and is NOT cached", async () => {
    const { fetchImpl } = mockFetch(() => Response.json({ hello: "world" }));
    const { cache, store } = mapCache();
    const { source } = await loadSpecSchema({ url: COMPILER, fetchImpl, cache });
    expect(source).toBe("fallback");
    expect(store.has(SPEC_SCHEMA_CACHE_KEY)).toBe(false);
  });

  test("a garbage cached value degrades to the embedded fallback", async () => {
    const { fetchImpl } = mockFetch(() => new Response("nope", { status: 500 }));
    const { cache } = mapCache({ [SPEC_SCHEMA_CACHE_KEY]: { not: "a schema" } });
    const { source } = await loadSpecSchema({ url: COMPILER, fetchImpl, cache });
    expect(source).toBe("fallback");
  });

  test("a throwing cache.get is swallowed (fallback, no crash)", async () => {
    const { fetchImpl } = mockFetch(() => new Response("nope", { status: 500 }));
    const cache: SpecSchemaCache = {
      get: async () => {
        throw new Error("IndexedDB exploded");
      },
      set: async () => {},
    };
    const { source } = await loadSpecSchema({ url: COMPILER, fetchImpl, cache });
    expect(source).toBe("fallback");
  });

  test("a throwing cache.set does not block a successful remote load", async () => {
    const { fetchImpl } = mockFetch(() => Response.json(REMOTE_BODY));
    const cache: SpecSchemaCache = {
      get: async () => undefined,
      set: async () => {
        throw new Error("quota exceeded");
      },
    };
    const { schema, source } = await loadSpecSchema({ url: COMPILER, fetchImpl, cache });
    expect(source).toBe("remote");
    expect(schema.schemaVersion).toBe("0.4.0");
  });

  test("the remote result works with blocksForTarget end-to-end", async () => {
    const { fetchImpl } = mockFetch(() => Response.json(REMOTE_BODY));
    const { schema } = await loadSpecSchema({ url: COMPILER, fetchImpl });
    expect(blocksForTarget(schema, "workflow").map((b) => b.key)).toEqual(["steps", "continuity"]);
    // Remote schema carries no markers (0.4+ compiler validates natively).
    expect(blocksForTarget(schema, "cli").find((b) => b.key === "limits")?.requiresVersion).toBe(
      undefined,
    );
  });
});
