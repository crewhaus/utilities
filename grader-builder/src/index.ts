/**
 * `@crewhaus/grader-builder` — guided eval-grader creation.
 *
 * Headless question/answer state machine for building one grader
 * entry of an `eval` spec's `graders:` array. Both the CLI
 * (`bun run start`) and the studio-ui "Graders" tab drive the same
 * logic over `startGraderBuilder → nextQuestion → answerGrader →
 * compileGrader` — the builder returns YAML, never renders UI.
 *
 * Question flow (branches on the chosen kind):
 *   kind → id → <kind-specific questions> → weight
 *
 *   exact-match       → expected, caseSensitive
 *   contains          → isRegex, pattern, caseSensitive
 *   numeric-tolerance → expectedNumber, tolerance, toleranceMode
 *   json-schema       → schemaJson
 *   llm-judge         → rubric, judgeModel, threshold
 *   custom-script     → scriptPath, timeoutMs
 *
 * Unlike `@crewhaus/wizard`, `answerGrader` validates every answer
 * and throws `GraderBuilderError` with a human-readable message —
 * the studio-server surfaces those as HTTP 400s, which is what
 * powers inline field errors in the Graders tab.
 *
 * No dependencies: the package stays testable in factory-less
 * checkouts, so `GraderBuilderError` mirrors `CrewhausError`'s shape
 * (a `code` field) without importing `@crewhaus/errors`.
 */

export class GraderBuilderError extends Error {
  override readonly name = "GraderBuilderError";
  readonly code = "config";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export type GraderKind =
  | "exact-match"
  | "contains"
  | "numeric-tolerance"
  | "json-schema"
  | "llm-judge"
  | "custom-script";

/** Structured grader entry — one item of an eval spec's `graders:` array. */
export type GraderConfig =
  | {
      readonly id: string;
      readonly kind: "exact-match";
      readonly expected: string;
      readonly caseSensitive: boolean;
      readonly weight?: number;
    }
  | {
      readonly id: string;
      readonly kind: "contains";
      readonly pattern: string;
      readonly regex: boolean;
      readonly caseSensitive: boolean;
      readonly weight?: number;
    }
  | {
      readonly id: string;
      readonly kind: "numeric-tolerance";
      readonly expected: number;
      readonly tolerance: number;
      readonly mode: "absolute" | "relative";
      readonly weight?: number;
    }
  | {
      readonly id: string;
      readonly kind: "json-schema";
      readonly schema: Record<string, unknown>;
      readonly weight?: number;
    }
  | {
      readonly id: string;
      readonly kind: "llm-judge";
      readonly model: string;
      readonly threshold: number;
      readonly rubric: string;
      readonly weight?: number;
    }
  | {
      readonly id: string;
      readonly kind: "custom-script";
      readonly script: string;
      readonly timeoutMs?: number;
      readonly weight?: number;
    };

export type GraderAnswer =
  | { question: "kind"; value: GraderKind }
  | { question: "id"; value: string }
  | { question: "expected"; value: string }
  | { question: "caseSensitive"; value: boolean }
  | { question: "isRegex"; value: boolean }
  | { question: "pattern"; value: string }
  | { question: "expectedNumber"; value: number }
  | { question: "tolerance"; value: number }
  | { question: "toleranceMode"; value: "absolute" | "relative" }
  | { question: "schemaJson"; value: string }
  | { question: "rubric"; value: string }
  | { question: "judgeModel"; value: string }
  | { question: "threshold"; value: number }
  | { question: "scriptPath"; value: string }
  | { question: "timeoutMs"; value: number | undefined }
  | { question: "weight"; value: number | undefined };

type QuestionId = GraderAnswer["question"];

export type GraderQuestion =
  | {
      readonly id: "kind";
      readonly prompt: string;
      readonly choices: ReadonlyArray<{
        readonly value: GraderKind;
        readonly label: string;
        readonly description: string;
      }>;
    }
  | { readonly id: "id"; readonly prompt: string; readonly hint: string }
  | { readonly id: "expected"; readonly prompt: string; readonly hint: string }
  | { readonly id: "caseSensitive"; readonly prompt: string; readonly defaultValue: boolean }
  | { readonly id: "isRegex"; readonly prompt: string; readonly defaultValue: boolean }
  | { readonly id: "pattern"; readonly prompt: string; readonly hint: string }
  | { readonly id: "expectedNumber"; readonly prompt: string; readonly hint: string }
  | { readonly id: "tolerance"; readonly prompt: string; readonly hint: string }
  | {
      readonly id: "toleranceMode";
      readonly prompt: string;
      readonly choices: ReadonlyArray<{
        readonly value: "absolute" | "relative";
        readonly label: string;
      }>;
    }
  | { readonly id: "schemaJson"; readonly prompt: string; readonly hint: string }
  | { readonly id: "rubric"; readonly prompt: string; readonly hint: string }
  | {
      readonly id: "judgeModel";
      readonly prompt: string;
      readonly suggested: ReadonlyArray<string>;
    }
  | {
      readonly id: "threshold";
      readonly prompt: string;
      readonly hint: string;
      readonly defaultValue: number;
    }
  | { readonly id: "scriptPath"; readonly prompt: string; readonly hint: string }
  | {
      readonly id: "timeoutMs";
      readonly prompt: string;
      readonly hint: string;
      readonly optional: true;
    }
  | {
      readonly id: "weight";
      readonly prompt: string;
      readonly hint: string;
      readonly optional: true;
    };

export type GraderBuilderState = {
  /** Index into the (kind-dependent) question sequence. */
  readonly step: number;
  /** Answers collected so far. */
  readonly answers: ReadonlyArray<GraderAnswer>;
};

export type GraderResult = {
  readonly grader: GraderConfig;
  /** One `- id: …` list item, base indent 0 — for appending under `graders:`. */
  readonly yamlEntry: string;
  /** `graders:\n  - id: …` — a full block for copy/paste into a spec. */
  readonly yamlBlock: string;
};

const KINDS: ReadonlyArray<{ kind: GraderKind; title: string; description: string }> = [
  {
    kind: "exact-match",
    title: "Exact match",
    description: "Pass when the output equals an expected string exactly.",
  },
  {
    kind: "contains",
    title: "Contains / regex",
    description: "Pass when the output contains a substring or matches a regular expression.",
  },
  {
    kind: "numeric-tolerance",
    title: "Numeric tolerance",
    description: "Pass when a numeric output is within a tolerance of the expected value.",
  },
  {
    kind: "json-schema",
    title: "JSON schema",
    description: "Pass when the output parses as JSON and validates against a JSON Schema.",
  },
  {
    kind: "llm-judge",
    title: "LLM judge",
    description: "A judge model scores the output against a rubric; pass above a threshold.",
  },
  {
    kind: "custom-script",
    title: "Custom script",
    description: "Your own script grades each sample (JSON on stdin, verdict JSON on stdout).",
  },
];

/** Same suggestion list the spec wizard offers for its model question. */
const SUGGESTED_JUDGE_MODELS: ReadonlyArray<string> = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
];

const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-6";
const DEFAULT_THRESHOLD = 0.7;

/** Same rule studio-server applies to spec names. */
const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const KIND_BRANCH: Record<GraderKind, ReadonlyArray<QuestionId>> = {
  "exact-match": ["expected", "caseSensitive"],
  contains: ["isRegex", "pattern", "caseSensitive"],
  "numeric-tolerance": ["expectedNumber", "tolerance", "toleranceMode"],
  "json-schema": ["schemaJson"],
  "llm-judge": ["rubric", "judgeModel", "threshold"],
  "custom-script": ["scriptPath", "timeoutMs"],
};

/** Catalog of grader kinds — drives the studio-ui cards and the CLI menu. */
export function listGraderKinds(): ReadonlyArray<{
  kind: GraderKind;
  title: string;
  description: string;
}> {
  return KINDS;
}

export function startGraderBuilder(): GraderBuilderState {
  return { step: 0, answers: [] };
}

type AnswerValueOf = { [A in GraderAnswer as A["question"]]: A["value"] };

function answerOf<K extends QuestionId>(
  answers: ReadonlyArray<GraderAnswer>,
  question: K,
): AnswerValueOf[K] | undefined {
  const a = answers.find((x) => x.question === question);
  return a?.value as AnswerValueOf[K] | undefined;
}

/**
 * The full question sequence implied by the answers so far. Until
 * `kind` is answered the sequence is just `["kind"]`, so branch
 * questions are never asked prematurely.
 */
function sequence(answers: ReadonlyArray<GraderAnswer>): ReadonlyArray<QuestionId> {
  const kind = answerOf(answers, "kind");
  if (kind === undefined || KIND_BRANCH[kind] === undefined) return ["kind"];
  return ["kind", "id", ...KIND_BRANCH[kind], "weight"];
}

export function nextQuestion(state: GraderBuilderState): GraderQuestion | undefined {
  const qid = sequence(state.answers)[state.step];
  if (qid === undefined) return undefined; // builder complete
  switch (qid) {
    case "kind":
      return {
        id: "kind",
        prompt: "What kind of grader do you want?",
        choices: KINDS.map((k) => ({
          value: k.kind,
          label: k.title,
          description: k.description,
        })),
      };
    case "id":
      return {
        id: "id",
        prompt: "What should this grader be called? (kebab-case id, unique within the spec)",
        hint: "e.g. exact-answer, helpfulness",
      };
    case "expected":
      return {
        id: "expected",
        prompt: "What exact output should count as a pass?",
        hint: "compared against the full output string",
      };
    case "caseSensitive":
      return {
        id: "caseSensitive",
        prompt: "Should the comparison be case-sensitive?",
        defaultValue: true,
      };
    case "isRegex":
      return {
        id: "isRegex",
        prompt: "Is the pattern a regular expression? (no = literal substring)",
        defaultValue: false,
      };
    case "pattern":
      return answerOf(state.answers, "isRegex") === true
        ? {
            id: "pattern",
            prompt: "Which regular expression must the output match?",
            hint: "JavaScript RegExp syntax, e.g. refund(ed|s)?",
          }
        : {
            id: "pattern",
            prompt: "Which substring must the output contain?",
            hint: "matched literally",
          };
    case "expectedNumber":
      return {
        id: "expectedNumber",
        prompt: "What is the expected numeric value?",
        hint: "e.g. 19.99",
      };
    case "tolerance":
      return {
        id: "tolerance",
        prompt: "How much may the output deviate?",
        hint: "non-negative number, e.g. 0.05",
      };
    case "toleranceMode":
      return {
        id: "toleranceMode",
        prompt: "Is the tolerance absolute or relative?",
        choices: [
          { value: "absolute", label: "absolute — |output − expected| ≤ tolerance" },
          { value: "relative", label: "relative — |output − expected| ≤ tolerance × |expected|" },
        ],
      };
    case "schemaJson":
      return {
        id: "schemaJson",
        prompt: "Paste the JSON Schema the output must validate against (as JSON):",
        hint: 'e.g. {"type":"object","required":["status"]}',
      };
    case "rubric":
      return {
        id: "rubric",
        prompt: "Describe the rubric the judge model should score against:",
        hint: "plain language; the judge returns a 0..1 score",
      };
    case "judgeModel":
      return {
        id: "judgeModel",
        prompt: "Which model should judge?",
        suggested: SUGGESTED_JUDGE_MODELS,
      };
    case "threshold":
      return {
        id: "threshold",
        prompt: "Minimum judge score (0..1) to count as a pass?",
        hint: "0.7 is a sensible default",
        defaultValue: DEFAULT_THRESHOLD,
      };
    case "scriptPath":
      return {
        id: "scriptPath",
        prompt: "Path to your grading script (relative to the spec file)?",
        hint: "receives the sample as JSON on stdin; prints {\"passed\": bool, \"score\": number}",
      };
    case "timeoutMs":
      return {
        id: "timeoutMs",
        prompt: "Script timeout in milliseconds? (optional, default 30000)",
        hint: "positive integer; leave empty to use the default",
        optional: true,
      };
    case "weight":
      return {
        id: "weight",
        prompt: "Weight relative to other graders? (optional, default 1)",
        hint: "positive number; leave empty to skip",
        optional: true,
      };
  }
}

function fail(message: string): never {
  throw new GraderBuilderError(message);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") fail(`${what} must be a string`);
  return value;
}

function requireFinite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${what} must be a finite number`);
  }
  return value;
}

/**
 * Validate one answer against the question the machine expects next.
 * Throws `GraderBuilderError` (message is safe to show verbatim in a
 * UI) on out-of-order answers or invalid values.
 */
export function answerGrader(state: GraderBuilderState, answer: GraderAnswer): GraderBuilderState {
  const expected = sequence(state.answers)[state.step];
  if (expected === undefined) fail("all questions are already answered");
  if (answer.question !== expected) {
    fail(`expected an answer for "${expected}", got "${answer.question}"`);
  }
  validateAnswer(state, answer);
  return { step: state.step + 1, answers: [...state.answers, answer] };
}

function validateAnswer(state: GraderBuilderState, answer: GraderAnswer): void {
  switch (answer.question) {
    case "kind":
      if (!KINDS.some((k) => k.kind === answer.value)) {
        fail(`unknown grader kind "${String(answer.value)}" — pick one of: ${KINDS.map((k) => k.kind).join(", ")}`);
      }
      return;
    case "id": {
      const v = requireString(answer.value, "id");
      if (!ID_RE.test(v)) {
        fail(`id "${v}" must be kebab-case: lowercase letters, digits and hyphens, e.g. my-grader`);
      }
      return;
    }
    case "expected":
      requireString(answer.value, "expected");
      return;
    case "caseSensitive":
    case "isRegex": {
      const q = answer.question;
      if (typeof answer.value !== "boolean") fail(`${q} must be true or false`);
      return;
    }
    case "pattern": {
      const v = requireString(answer.value, "pattern");
      if (v === "") fail("pattern must not be empty");
      if (answerOf(state.answers, "isRegex") === true) {
        try {
          new RegExp(v);
        } catch (err) {
          fail(`invalid regular expression: ${(err as Error).message}`);
        }
      }
      return;
    }
    case "expectedNumber":
      requireFinite(answer.value, "expected value");
      return;
    case "tolerance":
      if (requireFinite(answer.value, "tolerance") < 0) fail("tolerance must be >= 0");
      return;
    case "toleranceMode":
      if (answer.value !== "absolute" && answer.value !== "relative") {
        fail('tolerance mode must be "absolute" or "relative"');
      }
      return;
    case "schemaJson": {
      const v = requireString(answer.value, "schema");
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch (err) {
        fail(`schema is not valid JSON: ${(err as Error).message}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        fail("schema must be a JSON object, e.g. {\"type\": \"object\"}");
      }
      return;
    }
    case "rubric":
      if (requireString(answer.value, "rubric").trim() === "") fail("rubric must not be empty");
      return;
    case "judgeModel":
      if (requireString(answer.value, "model").trim() === "") fail("model must not be empty");
      return;
    case "threshold": {
      const v = requireFinite(answer.value, "threshold");
      if (v < 0 || v > 1) fail("threshold must be between 0 and 1");
      return;
    }
    case "scriptPath": {
      const v = requireString(answer.value, "script path");
      // Existence is deliberately not checked — specs may be authored
      // before the script.
      if (v === "" || /[\0\n\r]/.test(v)) fail("script path must be a non-empty single-line path");
      return;
    }
    case "timeoutMs":
      if (answer.value === undefined) return;
      if (!Number.isInteger(answer.value) || (answer.value as number) <= 0) {
        fail("timeout must be a positive integer (milliseconds)");
      }
      return;
    case "weight":
      if (answer.value === undefined) return;
      if (requireFinite(answer.value, "weight") <= 0) fail("weight must be > 0");
      return;
  }
}

/**
 * Take a completed builder state and synthesize the structured grader
 * plus its YAML forms. Throws if `kind`, `id`, or the kind's required
 * field is missing; optional answers fall back to their defaults
 * (`caseSensitive: true`, literal substring, absolute tolerance,
 * `claude-sonnet-4-6` judge at threshold 0.7).
 */
export function compileGrader(state: GraderBuilderState): GraderResult {
  const a = state.answers;
  const kind = answerOf(a, "kind");
  if (kind === undefined) fail("compileGrader: kind not answered yet");
  const id = answerOf(a, "id");
  if (id === undefined) fail("compileGrader: id not answered yet");
  const weight = answerOf(a, "weight");

  const grader = ((): GraderConfig => {
    switch (kind) {
      case "exact-match": {
        const expected = answerOf(a, "expected");
        if (expected === undefined) fail("compileGrader: expected not answered yet");
        return {
          id,
          kind,
          expected,
          caseSensitive: answerOf(a, "caseSensitive") ?? true,
          ...(weight !== undefined ? { weight } : {}),
        };
      }
      case "contains": {
        const pattern = answerOf(a, "pattern");
        if (pattern === undefined) fail("compileGrader: pattern not answered yet");
        return {
          id,
          kind,
          pattern,
          regex: answerOf(a, "isRegex") ?? false,
          caseSensitive: answerOf(a, "caseSensitive") ?? true,
          ...(weight !== undefined ? { weight } : {}),
        };
      }
      case "numeric-tolerance": {
        const expected = answerOf(a, "expectedNumber");
        const tolerance = answerOf(a, "tolerance");
        if (expected === undefined || tolerance === undefined) {
          fail("compileGrader: expected value + tolerance not answered yet");
        }
        return {
          id,
          kind,
          expected,
          tolerance,
          mode: answerOf(a, "toleranceMode") ?? "absolute",
          ...(weight !== undefined ? { weight } : {}),
        };
      }
      case "json-schema": {
        const schemaJson = answerOf(a, "schemaJson");
        if (schemaJson === undefined) fail("compileGrader: schema not answered yet");
        return {
          id,
          kind,
          schema: JSON.parse(schemaJson) as Record<string, unknown>,
          ...(weight !== undefined ? { weight } : {}),
        };
      }
      case "llm-judge": {
        const rubric = answerOf(a, "rubric");
        if (rubric === undefined) fail("compileGrader: rubric not answered yet");
        return {
          id,
          kind,
          model: answerOf(a, "judgeModel") ?? DEFAULT_JUDGE_MODEL,
          threshold: answerOf(a, "threshold") ?? DEFAULT_THRESHOLD,
          rubric,
          ...(weight !== undefined ? { weight } : {}),
        };
      }
      case "custom-script": {
        const script = answerOf(a, "scriptPath");
        if (script === undefined) fail("compileGrader: script path not answered yet");
        const timeoutMs = answerOf(a, "timeoutMs");
        return {
          id,
          kind,
          script,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(weight !== undefined ? { weight } : {}),
        };
      }
    }
  })();

  const yamlEntry = emitGraderEntry(grader);
  const yamlBlock = `graders:\n${indent(yamlEntry, 2)}`;
  return { grader, yamlEntry, yamlBlock };
}

// ---------------------------------------------------------------------------
// YAML emission — tiny hand-rolled emitter so the package stays
// dependency-free. Handles the scalar/object/array shapes graders use;
// defaults are omitted (caseSensitive: true, regex: false, mode:
// absolute, no weight/timeout).
// ---------------------------------------------------------------------------

// First char excludes digits/`-` so number-like strings stay quoted.
const PLAIN_SCALAR_RE = /^[A-Za-z./_][A-Za-z0-9 _./-]*$/;
const YAML_AMBIGUOUS = new Set(["true", "false", "yes", "no", "on", "off", "null", "~"]);

function yamlScalar(v: string | number | boolean): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (PLAIN_SCALAR_RE.test(v) && !YAML_AMBIGUOUS.has(v.toLowerCase()) && v === v.trim()) {
    return v;
  }
  return JSON.stringify(v); // double-quoted JSON strings are valid YAML
}

function indent(block: string, by: number): string {
  const pad = " ".repeat(by);
  return block
    .split("\n")
    .map((l) => (l === "" ? l : pad + l))
    .join("\n");
}

/** `key: value` lines for one key, handling block scalars + nested objects. */
function yamlKeyLines(key: string, value: unknown, depth: number): string[] {
  const pad = " ".repeat(depth * 2);
  if (typeof value === "string" && value.includes("\n")) {
    const body = value.replace(/\n+$/, "");
    return [`${pad}${key}: |`, ...body.split("\n").map((l) => `${pad}  ${l}`)];
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
        const lines = entries.flatMap(([k, v]) => yamlKeyLines(k, v, 0));
        out.push(`${pad}  - ${lines[0]}`, ...lines.slice(1).map((l) => `${pad}    ${l}`));
      } else if (Array.isArray(item)) {
        fail("nested arrays are not supported in grader schemas (v0)");
      } else {
        out.push(`${pad}  - ${yamlScalar(item as string | number | boolean)}`);
      }
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${pad}${key}: {}`];
    return [`${pad}${key}:`, ...entries.flatMap(([k, v]) => yamlKeyLines(k, v, depth + 1))];
  }
  return [`${pad}${key}: null`];
}

/** One `- id: …` list item at base indent 0, deterministic key order. */
function emitGraderEntry(grader: GraderConfig): string {
  const pairs: Array<[string, unknown]> = [
    ["id", grader.id],
    ["kind", grader.kind],
  ];
  switch (grader.kind) {
    case "exact-match":
      pairs.push(["expected", grader.expected]);
      if (!grader.caseSensitive) pairs.push(["caseSensitive", false]);
      break;
    case "contains":
      pairs.push(["pattern", grader.pattern]);
      if (grader.regex) pairs.push(["regex", true]);
      if (!grader.caseSensitive) pairs.push(["caseSensitive", false]);
      break;
    case "numeric-tolerance":
      pairs.push(["expected", grader.expected], ["tolerance", grader.tolerance]);
      if (grader.mode !== "absolute") pairs.push(["mode", grader.mode]);
      break;
    case "json-schema":
      pairs.push(["schema", grader.schema]);
      break;
    case "llm-judge":
      pairs.push(
        ["model", grader.model],
        ["threshold", grader.threshold],
        ["rubric", grader.rubric],
      );
      break;
    case "custom-script":
      pairs.push(["script", grader.script]);
      if (grader.timeoutMs !== undefined) pairs.push(["timeoutMs", grader.timeoutMs]);
      break;
  }
  if (grader.weight !== undefined) pairs.push(["weight", grader.weight]);

  const lines = pairs.flatMap(([k, v]) => yamlKeyLines(k, v, 0));
  return [`- ${lines[0]}`, ...lines.slice(1).map((l) => `  ${l}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Spec write-back.
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEY_RE = /^[A-Za-z_][\w-]*:/;

/**
 * Append a compiled `yamlEntry` to the `graders:` array of an eval
 * spec's YAML, preserving comments and key order — the edit is a pure
 * text insertion (replaces `graders: []`, extends an existing block,
 * or appends a new block at EOF). Throws when `graders:` uses inline
 * flow style (`graders: [a, b]`) — convert to block style first.
 */
export function appendGraderToSpecYaml(specYaml: string, yamlEntry: string): string {
  const entry = indent(yamlEntry, 2);
  const lines = specYaml.split("\n");

  const gradersIdx = lines.findIndex((l) => /^graders:/.test(l));
  if (gradersIdx === -1) {
    const base = specYaml.replace(/\n*$/, "\n");
    return `${base}graders:\n${entry}\n`;
  }

  const gradersLine = lines[gradersIdx] as string;
  if (/^graders:\s*\[\]\s*$/.test(gradersLine)) {
    lines.splice(gradersIdx, 1, "graders:", ...entry.split("\n"));
    return lines.join("\n");
  }
  if (!/^graders:\s*(#.*)?$/.test(gradersLine)) {
    fail("the spec's graders: key uses inline flow style — convert it to a block list first");
  }

  // Block ends at the next top-level key (or EOF); insert before any
  // trailing blank lines so block separation stays intact.
  let end = lines.length;
  for (let i = gradersIdx + 1; i < lines.length; i++) {
    if (TOP_LEVEL_KEY_RE.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  while (end > gradersIdx + 1 && (lines[end - 1] as string).trim() === "") end--;
  lines.splice(end, 0, ...entry.split("\n"));
  return lines.join("\n");
}
