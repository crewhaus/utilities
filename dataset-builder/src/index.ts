/**
 * `@crewhaus/dataset-builder` — guided eval-dataset creation.
 *
 * Headless question/answer state machine for building the dataset an
 * `eval` spec runs against. Both the CLI (`bun run start`) and the
 * studio-ui "Datasets" tab drive the same logic over
 * `startDatasetBuilder → nextQuestion → answerDataset →
 * compileDataset` — the builder returns YAML + JSONL, never renders
 * UI.
 *
 * `@crewhaus/spec`'s eval target carries only a dataset *reference*
 * (`dataset: { name, version, split }`, resolved at run time via the
 * §29 dataset-registry) — cases never live inline in the spec. The
 * builder therefore compiles two artifacts that belong together:
 *
 *   yamlBlock → the strict `dataset:` coordinate block for the spec
 *   jsonl     → the cases themselves, one JSON object per line, for
 *               `datasets/<name>/<version>/<split>.jsonl` in the
 *               studio workspace (the registry layout the studio-server
 *               serves back over `/api/datasets`)
 *
 * A case is `{ id, input, expected_output?, metadata? }` — the
 * utilities-side authoring schema. `input` is what the eval agent is
 * prompted with; `expected_output` is what reference graders
 * (exact_match, contains, …) compare against, so it is optional —
 * llm_judge and regex graders need no reference answer. Missing ids
 * are filled in positionally (`case-001`, `case-002`, …).
 *
 * Question flow branches on the case source:
 *   source → datasetName → version → split → cases | jsonl
 *
 * Dataset names and versions are constrained to path-safe charsets
 * stricter than `@crewhaus/spec`'s `safeName` so every coordinate
 * stays addressable as a URL path segment and a directory name.
 *
 * Like `@crewhaus/grader-builder`, `answerDataset` validates every
 * answer and throws `DatasetBuilderError` with a human-readable
 * message — the studio-server surfaces those as HTTP 400s, which is
 * what powers inline field errors in the Datasets tab.
 *
 * No dependencies: the package stays testable in minimal checkouts,
 * so `DatasetBuilderError` mirrors `CrewhausError`'s shape (a `code`
 * field) without importing `@crewhaus/errors`.
 */

export class DatasetBuilderError extends Error {
  override readonly name = "DatasetBuilderError";
  readonly code = "config";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export type DatasetSource = "manual" | "paste_jsonl";

export type DatasetSplit = "train" | "dev" | "test";

/**
 * The `dataset:` coordinate exactly as `@crewhaus/spec`'s eval target
 * parses it. `split` always present after compile (default `dev`);
 * the YAML omits it when default-valued.
 */
export type DatasetConfig = {
  readonly name: string;
  readonly version: string;
  readonly split: DatasetSplit;
};

/** One case as authors provide it — `id` may be omitted (auto-filled). */
export type DatasetCaseInput = {
  readonly id?: string;
  readonly input: string;
  readonly expected_output?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/** One compiled case — `id` is always present and unique within the file. */
export type DatasetCase = {
  readonly id: string;
  readonly input: string;
  readonly expected_output?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type DatasetAnswer =
  | { question: "source"; value: DatasetSource }
  | { question: "datasetName"; value: string }
  | { question: "version"; value: string }
  | { question: "split"; value: DatasetSplit | undefined }
  | { question: "cases"; value: ReadonlyArray<DatasetCaseInput> }
  | { question: "jsonl"; value: string };

type QuestionId = DatasetAnswer["question"];

export type DatasetQuestion =
  | {
      readonly id: "source";
      readonly prompt: string;
      readonly choices: ReadonlyArray<{
        readonly value: DatasetSource;
        readonly label: string;
        readonly description: string;
      }>;
    }
  | { readonly id: "datasetName"; readonly prompt: string; readonly hint: string }
  | { readonly id: "version"; readonly prompt: string; readonly hint: string }
  | {
      readonly id: "split";
      readonly prompt: string;
      readonly choices: ReadonlyArray<{ readonly value: DatasetSplit; readonly label: string }>;
      readonly optional: true;
      readonly defaultValue: DatasetSplit;
    }
  | { readonly id: "cases"; readonly prompt: string; readonly hint: string }
  | { readonly id: "jsonl"; readonly prompt: string; readonly hint: string };

export type DatasetBuilderState = {
  /** Index into the (source-dependent) question sequence. */
  readonly step: number;
  /** Answers collected so far. */
  readonly answers: ReadonlyArray<DatasetAnswer>;
};

export type DatasetResult = {
  readonly dataset: DatasetConfig;
  /** Compiled cases — every id present, unique within the file. */
  readonly cases: ReadonlyArray<DatasetCase>;
  /** `dataset:\n  name: …` — the coordinate block for the spec YAML. */
  readonly yamlBlock: string;
  /** One JSON object per line (trailing newline) — the sidecar file body. */
  readonly jsonl: string;
  /** Canonical workspace-relative file path for the JSONL sidecar. */
  readonly path: string;
};

const SOURCES: ReadonlyArray<{ source: DatasetSource; title: string; description: string }> = [
  {
    source: "manual",
    title: "Enter cases by hand",
    description:
      "Type each case's input and expected output; missing ids are filled in automatically (case-001, …).",
  },
  {
    source: "paste_jsonl",
    title: "Paste JSONL",
    description:
      "Compile existing JSON Lines — one {\"input\": …} object per line, validated line by line.",
  },
];

const DEFAULT_SPLIT: DatasetSplit = "dev";
const SPLITS: ReadonlyArray<DatasetSplit> = ["train", "dev", "test"];

/**
 * Stricter than `@crewhaus/spec`'s `safeName` (which allows spaces,
 * dots, and colons): a dataset name doubles as a URL path segment in
 * `/api/datasets/:name/:version/:split` and a directory name under
 * `datasets/`, so it must stay path- and route-safe.
 */
const DATASET_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** Path-safe version: alnum first + last, dots/underscores/hyphens inside. */
const DATASET_VERSION_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

/** Case ids land in JSONL + run reports — keep them single-line and plain. */
const CASE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;

const CASE_KEYS = new Set(["id", "input", "expected_output", "metadata"]);

export function isDatasetNameSafe(name: string): boolean {
  return DATASET_NAME_RE.test(name);
}

export function isDatasetVersionSafe(version: string): boolean {
  return DATASET_VERSION_RE.test(version);
}

const SOURCE_BRANCH: Record<DatasetSource, ReadonlyArray<QuestionId>> = {
  manual: ["datasetName", "version", "split", "cases"],
  paste_jsonl: ["datasetName", "version", "split", "jsonl"],
};

/** Catalog of case sources — drives the studio-ui cards and the CLI menu. */
export function listDatasetSources(): ReadonlyArray<{
  source: DatasetSource;
  title: string;
  description: string;
}> {
  return SOURCES;
}

export function startDatasetBuilder(): DatasetBuilderState {
  return { step: 0, answers: [] };
}

type AnswerValueOf = { [A in DatasetAnswer as A["question"]]: A["value"] };

function answerOf<K extends QuestionId>(
  answers: ReadonlyArray<DatasetAnswer>,
  question: K,
): AnswerValueOf[K] | undefined {
  const a = answers.find((x) => x.question === question);
  return a?.value as AnswerValueOf[K] | undefined;
}

/**
 * The full question sequence implied by the answers so far. Until
 * `source` is answered the sequence is just `["source"]`, so branch
 * questions are never asked prematurely.
 */
function sequence(answers: ReadonlyArray<DatasetAnswer>): ReadonlyArray<QuestionId> {
  const source = answerOf(answers, "source");
  if (source === undefined || SOURCE_BRANCH[source] === undefined) return ["source"];
  return ["source", ...SOURCE_BRANCH[source]];
}

export function nextQuestion(state: DatasetBuilderState): DatasetQuestion | undefined {
  const qid = sequence(state.answers)[state.step];
  if (qid === undefined) return undefined; // builder complete
  switch (qid) {
    case "source":
      return {
        id: "source",
        prompt: "Where do the dataset's cases come from?",
        choices: SOURCES.map((s) => ({
          value: s.source,
          label: s.title,
          description: s.description,
        })),
      };
    case "datasetName":
      return {
        id: "datasetName",
        prompt: "Dataset name?",
        hint: "letters, digits, hyphens — becomes datasets/<name>/<version>/<split>.jsonl",
      };
    case "version":
      return {
        id: "version",
        prompt: "Dataset version?",
        hint: 'path-safe, e.g. "1", "2025-q2", or "v1.2" — bump it instead of editing a published dataset',
      };
    case "split":
      return {
        id: "split",
        prompt: "Which split is this?",
        choices: [
          { value: "train", label: "train — examples graders and judges may tune against" },
          { value: "dev", label: "dev — the default split eval runs read" },
          { value: "test", label: "test — held out for final scoring" },
        ],
        optional: true,
        defaultValue: DEFAULT_SPLIT,
      };
    case "cases":
      return {
        id: "cases",
        prompt: "The cases themselves:",
        hint: "each case: input (required), expected_output (optional), id (optional — auto-filled case-001 style)",
      };
    case "jsonl":
      return {
        id: "jsonl",
        prompt: "Paste the JSONL:",
        hint: 'one JSON object per line: {"input": "…", "expected_output": "…"} — id and metadata optional',
      };
  }
}

function fail(message: string): never {
  throw new DatasetBuilderError(message);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") fail(`${what} must be a string`);
  return value;
}

/**
 * Reject values JSON Lines cannot carry faithfully: non-finite numbers
 * (JSON text like `1e999` overflows to Infinity, which
 * `JSON.stringify` would silently turn into `null`) and anything that
 * is not a JSON value to begin with.
 */
function assertJsonValue(value: unknown, what: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${what} must contain only finite numbers`);
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, what);
    return;
  }
  if (typeof value === "object") {
    // Class instances (Date, Map, Set, RegExp, …) often have no own
    // enumerable properties, so recursing over Object.values would pass
    // them — and JSON.stringify would then silently rewrite them ({} for
    // a Map, an ISO string for a Date). Require plain records.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      fail(`${what} must hold only plain JSON objects`);
    }
    for (const v of Object.values(value as Record<string, unknown>)) assertJsonValue(v, what);
    return;
  }
  fail(`${what} must hold only JSON values (got ${typeof value})`);
}

/**
 * Validate raw case inputs and assign final ids: provided ids are
 * kept, missing ones become `case-NNN` from the case's position.
 * `where(i)` names the offending case in errors ("case 2" from the
 * manual editor, "line 2" from pasted JSONL).
 */
function normalizeCases(
  raw: ReadonlyArray<unknown>,
  where: (index: number) => string,
): DatasetCase[] {
  if (raw.length === 0) fail("a dataset needs at least one case");
  const out: DatasetCase[] = [];
  for (let i = 0; i < raw.length; i++) {
    const at = where(i);
    const c = raw[i];
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      fail(`${at} must be a JSON object`);
    }
    const rec = c as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!CASE_KEYS.has(key)) {
        fail(`${at}: unknown key "${key}" — allowed: id, input, expected_output, metadata`);
      }
    }
    const input = rec["input"];
    if (typeof input !== "string" || input === "") {
      fail(`${at}: input must be a non-empty string`);
    }
    let id: string;
    if (rec["id"] !== undefined) {
      id = requireString(rec["id"], `${at}: id`);
      if (!CASE_ID_RE.test(id)) {
        fail(`${at}: id "${id}" may contain only letters, digits, and "._-" (alnum first)`);
      }
    } else {
      id = `case-${String(i + 1).padStart(3, "0")}`;
    }
    const expected = rec["expected_output"];
    if (expected !== undefined && typeof expected !== "string") {
      fail(`${at}: expected_output must be a string`);
    }
    const metadata = rec["metadata"];
    if (metadata !== undefined) {
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        fail(`${at}: metadata must be a JSON object`);
      }
      assertJsonValue(metadata, `${at}: metadata`);
    }
    out.push({
      id,
      input,
      ...(expected !== undefined ? { expected_output: expected as string } : {}),
      ...(metadata !== undefined
        ? { metadata: metadata as Readonly<Record<string, unknown>> }
        : {}),
    });
  }
  const seen = new Map<string, number>();
  for (let i = 0; i < out.length; i++) {
    const id = (out[i] as DatasetCase).id;
    const prev = seen.get(id);
    if (prev !== undefined) {
      fail(`duplicate case id "${id}" (${where(prev)} and ${where(i)})`);
    }
    seen.set(id, i);
  }
  return out;
}

/**
 * Parse + validate a JSONL document into compiled cases (missing ids
 * auto-filled). Throws `DatasetBuilderError` naming the offending
 * line. Used by the `paste_jsonl` branch and by the studio-server to
 * re-validate stored dataset files on read.
 */
export function parseDatasetJsonl(jsonl: string): ReadonlyArray<DatasetCase> {
  const records: unknown[] = [];
  const lineNos: number[] = [];
  const lines = jsonl.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      fail(`line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    records.push(parsed);
    lineNos.push(i + 1);
  }
  return normalizeCases(records, (i) => `line ${lineNos[i] ?? i + 1}`);
}

/**
 * Validate one answer against the question the machine expects next.
 * Throws `DatasetBuilderError` (message is safe to show verbatim in a
 * UI) on out-of-order answers or invalid values.
 */
export function answerDataset(
  state: DatasetBuilderState,
  answer: DatasetAnswer,
): DatasetBuilderState {
  const expected = sequence(state.answers)[state.step];
  if (expected === undefined) fail("all questions are already answered");
  if (answer.question !== expected) {
    fail(`expected an answer for "${expected}", got "${answer.question}"`);
  }
  validateAnswer(answer);
  return { step: state.step + 1, answers: [...state.answers, answer] };
}

function validateAnswer(answer: DatasetAnswer): void {
  switch (answer.question) {
    case "source":
      if (!SOURCES.some((s) => s.source === answer.value)) {
        fail(
          `unknown case source "${String(answer.value)}" — pick one of: ${SOURCES.map((s) => s.source).join(", ")}`,
        );
      }
      return;
    case "datasetName": {
      const v = requireString(answer.value, "dataset name");
      if (!DATASET_NAME_RE.test(v)) {
        fail(
          `dataset name "${v}" must be letters, digits, and hyphens (alnum first + last) — it becomes a URL path segment and a directory name`,
        );
      }
      return;
    }
    case "version": {
      const v = requireString(answer.value, "version");
      if (!DATASET_VERSION_RE.test(v)) {
        fail(
          `version "${v}" must be letters, digits, and "._-" (alnum first + last) so the dataset stays path-addressable`,
        );
      }
      return;
    }
    case "split":
      if (answer.value !== undefined && !SPLITS.includes(answer.value)) {
        fail('split must be "train", "dev", or "test"');
      }
      return;
    case "cases":
      if (!Array.isArray(answer.value)) fail("cases must be an array");
      normalizeCases(answer.value, (i) => `case ${i + 1}`);
      return;
    case "jsonl": {
      const v = requireString(answer.value, "jsonl");
      if (v.trim() === "") fail("paste at least one JSONL line");
      parseDatasetJsonl(v);
      return;
    }
  }
}

/**
 * Take a completed builder state and synthesize the dataset coordinate,
 * the compiled cases, and both serialized artifacts. Throws if a
 * required question is missing; `split` falls back to `dev` and is
 * omitted from the YAML when default-valued (the spec parser fills it
 * back in).
 */
export function compileDataset(state: DatasetBuilderState): DatasetResult {
  const a = state.answers;
  const source = answerOf(a, "source");
  if (source === undefined) fail("compileDataset: source not answered yet");
  const name = answerOf(a, "datasetName");
  if (name === undefined) fail("compileDataset: dataset name not answered yet");
  const version = answerOf(a, "version");
  if (version === undefined) fail("compileDataset: version not answered yet");
  const split = answerOf(a, "split") ?? DEFAULT_SPLIT;

  let cases: ReadonlyArray<DatasetCase>;
  if (source === "manual") {
    const raw = answerOf(a, "cases");
    if (raw === undefined) fail("compileDataset: cases not answered yet");
    cases = normalizeCases(raw, (i) => `case ${i + 1}`);
  } else {
    const raw = answerOf(a, "jsonl");
    if (raw === undefined) fail("compileDataset: jsonl not answered yet");
    cases = parseDatasetJsonl(raw);
  }

  const dataset: DatasetConfig = { name, version, split };
  const yamlBlock = yamlKeyLines(
    "dataset",
    {
      name,
      version,
      ...(split !== DEFAULT_SPLIT ? { split } : {}),
    },
    0,
  ).join("\n");
  const jsonl = `${cases.map((c) => JSON.stringify(caseRecord(c))).join("\n")}\n`;
  return {
    dataset,
    cases,
    yamlBlock,
    jsonl,
    path: `datasets/${name}/${version}/${split}.jsonl`,
  };
}

/** Deterministic JSONL key order: id, input, expected_output, metadata. */
function caseRecord(c: DatasetCase): Record<string, unknown> {
  return {
    id: c.id,
    input: c.input,
    ...(c.expected_output !== undefined ? { expected_output: c.expected_output } : {}),
    ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// YAML emission — same tiny hand-rolled emitter as @crewhaus/grader-builder
// (kept dependency-free; quoting rules carry its regression-tested
// hardening: number-like strings stay quoted, block scalars only when
// they round-trip exactly).
// ---------------------------------------------------------------------------

// First char excludes digits/`-`/`.` so number-like strings (including
// YAML 1.2 floats like `.5`, `.inf`, `.nan`) stay quoted.
const PLAIN_SCALAR_RE = /^[A-Za-z/_$][A-Za-z0-9 _./$()[\]*-]*$/;
const YAML_AMBIGUOUS = new Set(["true", "false", "yes", "no", "on", "off", "null", "~"]);

function yamlScalar(v: string | number | boolean): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (PLAIN_SCALAR_RE.test(v) && !YAML_AMBIGUOUS.has(v.toLowerCase()) && v === v.trim()) {
    return v;
  }
  return JSON.stringify(v); // double-quoted JSON strings are valid YAML
}

/**
 * Multi-line strings emit as `|-` literal block scalars only when that
 * round-trips exactly: no CR (YAML normalizes line breaks), no trailing
 * newline (`|-` chomps it), and a first line that isn't empty or
 * space-led (which would break block-indent auto-detection). Everything
 * else falls through to a JSON-quoted scalar, which is always exact.
 */
function safeBlockScalar(value: string): boolean {
  return !value.includes("\r") && !value.endsWith("\n") && /^\S/.test(value);
}

/** `key: value` lines for one key, handling block scalars + nested objects. */
function yamlKeyLines(key: string, value: unknown, depth: number): string[] {
  const pad = " ".repeat(depth * 2);
  if (typeof value === "string" && value.includes("\n") && safeBlockScalar(value)) {
    return [`${pad}${key}: |-`, ...value.split("\n").map((l) => `${pad}  ${l}`)];
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [`${pad}${key}: ${yamlScalar(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}: []`];
    const out = [`${pad}${key}:`];
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length === 0) {
          out.push(`${pad}  - {}`);
          continue;
        }
        const lines = entries.flatMap(([k, v]) => yamlKeyLines(yamlKey(k), v, 0));
        out.push(`${pad}  - ${lines[0]}`, ...lines.slice(1).map((l) => `${pad}    ${l}`));
      } else if (Array.isArray(item)) {
        fail("nested arrays are not supported in spec YAML emission (v0)");
      } else if (item === null) {
        out.push(`${pad}  - null`);
      } else {
        out.push(`${pad}  - ${yamlScalar(item as string | number | boolean)}`);
      }
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${pad}${key}: {}`];
    return [
      `${pad}${key}:`,
      ...entries.flatMap(([k, v]) => yamlKeyLines(yamlKey(k), v, depth + 1)),
    ];
  }
  return [`${pad}${key}: null`];
}

/** Quote map keys that YAML would otherwise read as numbers. */
function yamlKey(key: string): string {
  return /^[A-Za-z_][\w-]*$/.test(key) ? key : JSON.stringify(key);
}

// ---------------------------------------------------------------------------
// Spec write-back.
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEY_RE = /^[A-Za-z_][\w-]*:/;

/**
 * Set (replace or insert) the `dataset:` block of an eval spec's YAML,
 * preserving comments and key order everywhere else — the edit is a
 * pure text splice. Unlike `graders:` (a growable list this package's
 * sibling appends to), `dataset:` is a single mapping, so writing a
 * new coordinate replaces the old block in place; when the key is
 * missing the block is inserted just above `graders:` (house key
 * order) or appended at EOF. Throws when `dataset:` uses inline flow
 * style (`dataset: {name: …}`) — convert to a block mapping first.
 */
export function setDatasetInSpecYaml(specYaml: string, yamlBlock: string): string {
  const blockLines = yamlBlock.split("\n");
  const lines = specYaml.split("\n");

  const datasetIdx = lines.findIndex((l) => /^dataset:/.test(l));
  if (datasetIdx === -1) {
    const gradersIdx = lines.findIndex((l) => /^graders:/.test(l));
    if (gradersIdx === -1) {
      const base = specYaml.replace(/\n*$/, "\n");
      return `${base}${yamlBlock}\n`;
    }
    lines.splice(gradersIdx, 0, ...blockLines);
    return lines.join("\n");
  }

  const datasetLine = lines[datasetIdx] as string;
  if (!/^dataset:\s*(#.*)?$/.test(datasetLine)) {
    fail("the spec's dataset: key uses inline flow style — convert it to a block mapping first");
  }

  // Block ends at the next top-level key, a document marker (`---`,
  // `...`), or EOF. Unlike the grader append (a pure insertion), this
  // splice DELETES the old block — so back up past trailing blank
  // lines and column-0 comments, which annotate whatever follows the
  // block, not the block being replaced.
  let end = lines.length;
  for (let i = datasetIdx + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (TOP_LEVEL_KEY_RE.test(line) || /^(---|\.\.\.)\s*$/.test(line)) {
      end = i;
      break;
    }
  }
  while (end > datasetIdx + 1) {
    const tail = lines[end - 1] as string;
    if (tail.trim() !== "" && !/^#/.test(tail)) break;
    end--;
  }
  lines.splice(datasetIdx, end - datasetIdx, ...blockLines);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Starter eval spec — what makes the Studio's "create everything end to
// end" flow possible: the wizard has no eval target, so the Datasets
// tab (and the studio-server's create path) wrap a fresh dataset in a
// minimal, strictly-valid eval spec instead.
// ---------------------------------------------------------------------------

export type EvalSpecStarterOptions = {
  /** Spec name — must satisfy `@crewhaus/spec`'s safeName charset. */
  readonly specName: string;
  /** Model the eval agent runs with. */
  readonly model: string;
  /** Agent instructions; multi-line is fine. */
  readonly instructions: string;
};

/** Mirrors `@crewhaus/spec`'s safeName (no newlines, quotes, or slashes). */
const SPEC_NAME_RE = /^[\w .:-]+$/;

/**
 * Wrap a compiled dataset in a minimal eval spec: agent + dataset
 * coordinate + a single default `exact_match` grader (refine it in the
 * Graders tab / `@crewhaus/grader-builder`). The output parses under
 * `@crewhaus/spec` — regression-tested round-trip.
 */
export function buildEvalSpecStarterYaml(
  result: DatasetResult,
  opts: EvalSpecStarterOptions,
): string {
  if (!SPEC_NAME_RE.test(opts.specName)) {
    fail(
      `spec name "${opts.specName}" may contain only letters, digits, spaces, and "_ . - :"`,
    );
  }
  const model = requireString(opts.model, "model");
  if (model.trim() === "" || /[\n\r]/.test(model)) {
    fail("model must be a non-empty single line");
  }
  const instructions = requireString(opts.instructions, "instructions");
  if (instructions.trim() === "") fail("instructions must not be empty");

  const lines = [
    ...yamlKeyLines("name", opts.specName, 0),
    ...yamlKeyLines("target", "eval", 0),
    ...yamlKeyLines("agent", { model, instructions }, 0),
    result.yamlBlock,
    ...yamlKeyLines("graders", [{ name: "exact_match" }], 0),
  ];
  return `${lines.join("\n")}\n`;
}
