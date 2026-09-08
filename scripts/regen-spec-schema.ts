#!/usr/bin/env bun
/**
 * regen-spec-schema.ts — regenerate `spec-forms`' offline spec-schema snapshot
 * from the compiler's OWN `specJsonSchema()` export.
 *
 * `@crewhaus/spec-forms` drives the Studios' form engine off
 * `spec-forms/src/spec-schema-snapshot.json`: a checked-in copy of the
 * `specJsonSchema()` document, served whenever neither the compiler `/schema`
 * endpoint nor a cached last-good copy is reachable. It used to be refreshed by
 * hand, so it drifted a whole release line behind the grammar. This script
 * replaces that: it imports the real export, writes the document verbatim, and
 * stamps a provenance sidecar (`spec-schema-snapshot.meta.json`) that
 * `FALLBACK_SCHEMA_VERSION` is derived from — no hand-pinned version string.
 *
 * Run:
 *   bun scripts/regen-spec-schema.ts                       # regenerate + report
 *   bun scripts/regen-spec-schema.ts --check               # diff-only, no writes
 *   bun scripts/regen-spec-schema.ts --factory ../factory  # explicit checkout
 *   CREWHAUS_FACTORY=… bun scripts/regen-spec-schema.ts    # same, via env
 *
 * Where the compiler comes from, first hit wins — never a hard-coded path:
 *   1. `--factory <dir>`     — an explicit factory checkout;
 *   2. `$CREWHAUS_FACTORY`   — the same, from the environment;
 *   3. `<repo>/../factory`   — a sibling checkout of
 *      https://github.com/crewhaus/factory (the layout `bun install` already
 *      assumes for cross-repo work);
 *   4. the published `@crewhaus/spec` npm package — the zero-checkout path,
 *      which is what most contributors have. It can only ever produce the
 *      RELEASED grammar, so regenerating for an unreleased line (the usual
 *      reason to run this) needs one of 1–3.
 * 1 and 2 are explicit, so a missing/!checkout path there is a hard error
 * rather than a silent slide down to a stale npm copy.
 *
 * After a regen, run the package's own drift tests — they pin the target list,
 * demand a one-line description for every block key the snapshot introduces,
 * and re-derive the provenance digest:
 *
 *   bun test spec-forms/src
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Json = Record<string, unknown>;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const CHECK = has("check");
const ROOT = resolve(flag("root") ?? dirname(import.meta.dir));

const SNAPSHOT_PATH = join(ROOT, "spec-forms/src/spec-schema-snapshot.json");
const META_PATH = join(ROOT, "spec-forms/src/spec-schema-snapshot.meta.json");

/** The union member `specJsonSchema()` emits alongside the target shapes. */
const UNION_DEFINITION = "CrewhausSpec";
/** The canonical target shapes; fewer than this means a broken import. */
const MIN_TARGETS = 14;

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function rel(path: string): string {
  return relative(ROOT, path) || path;
}

// --- resolving the compiler ---------------------------------------------------

type SpecModuleSource = {
  /** How it was found, for the run report and the provenance stamp. */
  readonly kind: "checkout" | "npm";
  /** Human-readable origin (never an absolute path in the written files). */
  readonly label: string;
  /** Module specifier to import `specJsonSchema` from. */
  readonly specifier: string;
  /** The `@crewhaus/spec` package.json backing it. */
  readonly packageJson: string;
};

/** A factory checkout's spec package, or null when `dir` is not one. */
function checkoutSource(dir: string, label: string): SpecModuleSource | null {
  const entry = join(dir, "packages/spec/src/index.ts");
  const packageJson = join(dir, "packages/spec/package.json");
  if (!existsSync(entry) || !existsSync(packageJson)) return null;
  return { kind: "checkout", label, specifier: pathToFileURL(entry).href, packageJson };
}

/** The installed `@crewhaus/spec`, or null when it is not installed here. */
function npmSource(): SpecModuleSource | null {
  try {
    const packageJson = Bun.resolveSync("@crewhaus/spec/package.json", ROOT);
    return {
      kind: "npm",
      label: "the published @crewhaus/spec package",
      specifier: "@crewhaus/spec",
      packageJson,
    };
  } catch {
    return null;
  }
}

function resolveSpecModule(): SpecModuleSource {
  const explicit = flag("factory") ?? process.env["CREWHAUS_FACTORY"];
  if (explicit) {
    const dir = resolve(ROOT, explicit);
    const from = flag("factory") ? "--factory" : "$CREWHAUS_FACTORY";
    return (
      checkoutSource(dir, `a factory checkout (${from})`) ??
      fail(`${from} is not a factory checkout: no packages/spec/src/index.ts under ${explicit}`)
    );
  }
  const sibling = checkoutSource(join(ROOT, "..", "factory"), "the sibling factory checkout");
  if (sibling) return sibling;
  const published = npmSource();
  if (published) return published;
  return fail(
    "no compiler to read: pass --factory <dir>, set $CREWHAUS_FACTORY, check out crewhaus/factory next to this repo, or `bun install` so @crewhaus/spec resolves.",
  );
}

// --- generating ----------------------------------------------------------------

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadSchema(source: SpecModuleSource): Promise<Json> {
  let mod: unknown;
  try {
    mod = await import(source.specifier);
  } catch (error) {
    return fail(`could not import ${source.label}: ${(error as Error).message}`);
  }
  const specJsonSchema = (mod as { specJsonSchema?: unknown }).specJsonSchema;
  if (typeof specJsonSchema !== "function") {
    return fail(`${source.label} exports no specJsonSchema() — is it an older @crewhaus/spec?`);
  }
  const schema = (specJsonSchema as () => unknown)();
  if (!isRecord(schema) || !isRecord(schema["definitions"])) {
    return fail("specJsonSchema() returned no `definitions` object");
  }
  const targets = Object.keys(schema["definitions"]).filter((n) => n !== UNION_DEFINITION);
  if (targets.length < MIN_TARGETS) {
    return fail(`specJsonSchema() emitted ${targets.length} target shapes, expected >= ${MIN_TARGETS}`);
  }
  return schema;
}

/** The one serialization both the snapshot and its digest are taken over. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Short content digest of the snapshot bytes — the provenance stamp's tail. */
function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Block keys per target (the palette's view), for the change report. */
function blockKeys(schema: Json): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const definitions = schema["definitions"] as Json;
  for (const [name, def] of Object.entries(definitions)) {
    if (name === UNION_DEFINITION || !isRecord(def)) continue;
    const properties = isRecord(def["properties"]) ? def["properties"] : {};
    out.set(name, new Set(Object.keys(properties)));
  }
  return out;
}

function reportKeyDelta(previous: Json | null, next: Json): void {
  if (!previous) return;
  const before = blockKeys(previous);
  const after = blockKeys(next);
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const [target, keys] of after) {
    for (const key of keys) if (!before.get(target)?.has(key)) added.add(key);
  }
  for (const [target, keys] of before) {
    for (const key of keys) if (!after.get(target)?.has(key)) removed.add(key);
  }
  if (added.size > 0) {
    console.log(`  new top-level keys: ${[...added].sort().join(", ")}`);
    console.log(
      "  → give each new BLOCK a one-line description in spec-schema.ts's overlay, and a",
    );
    console.log("    FALLBACK_BLOCK_VERSIONS marker when the deployed compiler predates it.");
  }
  if (removed.size > 0) console.log(`  dropped top-level keys: ${[...removed].sort().join(", ")}`);
}

// --- run -----------------------------------------------------------------------

const source = resolveSpecModule();
const specVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(source.packageJson, "utf-8")) as Json;
    const version = pkg["version"];
    return typeof version === "string" && version.length > 0 ? version : "unknown";
  } catch {
    return "unknown";
  }
})();

const schema = await loadSchema(source);
const snapshot = serialize(schema);
const digest = digestOf(snapshot);
const targets = Object.keys(schema["definitions"] as Json).filter((n) => n !== UNION_DEFINITION);

const meta = serialize({
  specPackageVersion: specVersion,
  digest,
  targets: targets.length,
  generator: "scripts/regen-spec-schema.ts",
});

const previousSnapshot = existsSync(SNAPSHOT_PATH) ? readFileSync(SNAPSHOT_PATH, "utf-8") : null;
const previousMeta = existsSync(META_PATH) ? readFileSync(META_PATH, "utf-8") : null;
const changed = previousSnapshot !== snapshot || previousMeta !== meta;

console.log(`spec schema ← ${source.label} (@crewhaus/spec ${specVersion})`);
console.log(`  ${targets.length} target shapes · digest ${digest}`);
reportKeyDelta(previousSnapshot ? (JSON.parse(previousSnapshot) as Json) : null, schema);

if (!changed) {
  console.log(`✓ ${rel(SNAPSHOT_PATH)} is already current`);
  process.exit(0);
}

if (CHECK) {
  console.error(`✗ ${rel(SNAPSHOT_PATH)} is stale — re-run without --check`);
  process.exit(1);
}

writeFileSync(SNAPSHOT_PATH, snapshot);
writeFileSync(META_PATH, meta);
console.log(`✓ wrote ${rel(SNAPSHOT_PATH)} + ${rel(META_PATH)}`);
console.log("  next: bun test spec-forms/src");
