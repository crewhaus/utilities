/**
 * `@crewhaus/grader-builder` — guided eval-grader creation.
 *
 * Headless question/answer state machine for building one grader
 * entry of an `eval` spec's `graders:` array. Both the CLI
 * (`bun run start`) and the studio-ui "Graders" tab drive the same
 * logic over `startGraderBuilder → nextQuestion → answerGrader →
 * compileGrader` — the builder returns YAML, never renders UI.
 *
 * Compiled entries use the shape `@crewhaus/spec`'s eval target
 * requires — strict `{ name, opts? }` items, where `name` doubles as
 * the grader type the compiled eval bundle hands to
 * `@crewhaus/eval-grader`'s `parseGradersConfig`. The six kinds and
 * their opts mirror that parser:
 *
 *   exact_match        → trim (default true), case_insensitive (default false);
 *                        compares against the sample's expected_output
 *   contains           → substring (required), case_insensitive
 *   regex              → pattern (required, JS RegExp), flags
 *   json_path          → path (required, $-rooted), expected (optional JSON)
 *   tool_call_sequence → expected (required, tool names), mode (exact|subseq|set,
 *                        default subseq)
 *   llm_judge          → rubric { criteria: [{ name, description, anchors 1–5 }],
 *                        passing_score? }, model, weight — scored 1–5 by
 *                        `@crewhaus/eval-judge`, default passing score 3
 *
 * Question flow branches on the chosen kind:
 *   kind → <kind-specific questions>
 *
 * Unlike `@crewhaus/wizard`, `answerGrader` validates every answer
 * and throws `GraderBuilderError` with a human-readable message —
 * the studio-server surfaces those as HTTP 400s, which is what
 * powers inline field errors in the Graders tab.
 *
 * No dependencies: the package stays testable in minimal checkouts,
 * so `GraderBuilderError` mirrors `CrewhausError`'s shape (a `code`
 * field) without importing `@crewhaus/errors`.
 */

export class GraderBuilderError extends Error {
  override readonly name = "GraderBuilderError";
  readonly code = "config";
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export type GraderKind =
  | "exact_match"
  | "contains"
  | "regex"
  | "json_path"
  | "tool_call_sequence"
  | "llm_judge";

export type SequenceMode = "exact" | "subseq" | "set";

/** The 1–5 anchor descriptions of one rubric criterion, worst to best. */
export type RubricAnchors = {
  readonly "1": string;
  readonly "2": string;
  readonly "3": string;
  readonly "4": string;
  readonly "5": string;
};

export type RubricConfig = {
  readonly criteria: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly anchors: RubricAnchors;
  }>;
  readonly passing_score?: number;
};

/**
 * Structured grader entry — one item of an eval spec's `graders:`
 * array, exactly as `@crewhaus/spec` parses it: `name` is the grader
 * type, `opts` its configuration. Default-valued opts are omitted.
 */
export type GraderConfig =
  | {
      readonly name: "exact_match";
      readonly opts?: { readonly trim?: boolean; readonly case_insensitive?: boolean };
    }
  | {
      readonly name: "contains";
      readonly opts: { readonly substring: string; readonly case_insensitive?: boolean };
    }
  | {
      readonly name: "regex";
      readonly opts: { readonly pattern: string; readonly flags?: string };
    }
  | {
      readonly name: "json_path";
      readonly opts: { readonly path: string; readonly expected?: unknown };
    }
  | {
      readonly name: "tool_call_sequence";
      readonly opts: { readonly expected: ReadonlyArray<string>; readonly mode?: SequenceMode };
    }
  | {
      readonly name: "llm_judge";
      readonly opts: {
        readonly rubric: RubricConfig;
        readonly model: string;
        readonly weight?: number;
      };
    };

export type GraderAnswer =
  | { question: "kind"; value: GraderKind }
  | { question: "trim"; value: boolean }
  | { question: "caseInsensitive"; value: boolean }
  | { question: "substring"; value: string }
  | { question: "pattern"; value: string }
  | { question: "flags"; value: string | undefined }
  | { question: "path"; value: string }
  | { question: "expectedJson"; value: string | undefined }
  | { question: "toolCalls"; value: ReadonlyArray<string> }
  | { question: "sequenceMode"; value: SequenceMode | undefined }
  | { question: "criterionName"; value: string }
  | { question: "criterionDescription"; value: string }
  | { question: "anchors"; value: ReadonlyArray<string> | undefined }
  | { question: "passingScore"; value: number | undefined }
  | { question: "judgeModel"; value: string }
  | { question: "judgeWeight"; value: number | undefined };

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
  | { readonly id: "trim"; readonly prompt: string; readonly defaultValue: boolean }
  | { readonly id: "caseInsensitive"; readonly prompt: string; readonly defaultValue: boolean }
  | { readonly id: "substring"; readonly prompt: string; readonly hint: string }
  | { readonly id: "pattern"; readonly prompt: string; readonly hint: string }
  | {
      readonly id: "flags";
      readonly prompt: string;
      readonly hint: string;
      readonly optional: true;
    }
  | { readonly id: "path"; readonly prompt: string; readonly hint: string }
  | {
      readonly id: "expectedJson";
      readonly prompt: string;
      readonly hint: string;
      readonly optional: true;
    }
  | { readonly id: "toolCalls"; readonly prompt: string; readonly hint: string }
  | {
      readonly id: "sequenceMode";
      readonly prompt: string;
      readonly choices: ReadonlyArray<{ readonly value: SequenceMode; readonly label: string }>;
      readonly optional: true;
      readonly defaultValue: SequenceMode;
    }
  | { readonly id: "criterionName"; readonly prompt: string; readonly hint: string }
  | { readonly id: "criterionDescription"; readonly prompt: string; readonly hint: string }
  | {
      readonly id: "anchors";
      readonly prompt: string;
      readonly hint: string;
      readonly optional: true;
    }
  | {
      readonly id: "passingScore";
      readonly prompt: string;
      readonly hint: string;
      readonly optional: true;
      readonly defaultValue: number;
    }
  | {
      readonly id: "judgeModel";
      readonly prompt: string;
      readonly suggested: ReadonlyArray<string>;
    }
  | {
      readonly id: "judgeWeight";
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
  /** One `- name: …` list item, base indent 0 — for appending under `graders:`. */
  readonly yamlEntry: string;
  /** `graders:\n  - name: …` — a full block for copy/paste into a spec. */
  readonly yamlBlock: string;
};

const KINDS: ReadonlyArray<{ kind: GraderKind; title: string; description: string }> = [
  {
    kind: "exact_match",
    title: "Exact match",
    description:
      "Pass when the output equals the sample's expected_output (after optional trimming / case folding).",
  },
  {
    kind: "contains",
    title: "Contains substring",
    description: "Pass when the output contains a fixed substring.",
  },
  {
    kind: "regex",
    title: "Regex",
    description: "Pass when the output matches a JavaScript regular expression.",
  },
  {
    kind: "json_path",
    title: "JSON path",
    description:
      "Parse the output as JSON and require a JSONPath match (optionally equal to an expected value).",
  },
  {
    kind: "tool_call_sequence",
    title: "Tool-call sequence",
    description:
      "Pass when the run's tool calls match an expected sequence — exactly, as a subsequence, or as a set.",
  },
  {
    kind: "llm_judge",
    title: "LLM judge",
    description:
      "A judge model scores the output 1–5 against a rubric; pass at or above the passing score (default 3).",
  },
];

/** Same suggestion list the spec wizard offers for its model question. */
const SUGGESTED_JUDGE_MODELS: ReadonlyArray<string> = [
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-7",
];

const DEFAULT_SEQUENCE_MODE: SequenceMode = "subseq";
const DEFAULT_PASSING_SCORE = 3;

/** Generic 1–5 anchors used when the rubric author skips the anchors question. */
const DEFAULT_ANCHORS: ReadonlyArray<string> = [
  "Fails the criterion entirely.",
  "Mostly fails; major gaps remain.",
  "Mixed; meets the bar in places with clear gaps.",
  "Meets the criterion with only minor gaps.",
  "Fully meets the criterion.",
];

const KIND_BRANCH: Record<GraderKind, ReadonlyArray<QuestionId>> = {
  exact_match: ["trim", "caseInsensitive"],
  contains: ["substring", "caseInsensitive"],
  regex: ["pattern", "flags"],
  json_path: ["path", "expectedJson"],
  tool_call_sequence: ["toolCalls", "sequenceMode"],
  llm_judge: [
    "criterionName",
    "criterionDescription",
    "anchors",
    "passingScore",
    "judgeModel",
    "judgeWeight",
  ],
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
  return ["kind", ...KIND_BRANCH[kind]];
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
    case "trim":
      return {
        id: "trim",
        prompt: "Trim surrounding whitespace before comparing?",
        defaultValue: true,
      };
    case "caseInsensitive":
      return {
        id: "caseInsensitive",
        prompt: "Should the comparison ignore case?",
        defaultValue: false,
      };
    case "substring":
      return {
        id: "substring",
        prompt: "Which substring must the output contain?",
        hint: "matched literally",
      };
    case "pattern":
      return {
        id: "pattern",
        prompt: "Which regular expression must the output match?",
        hint: "JavaScript RegExp syntax, e.g. refund(ed|s)?",
      };
    case "flags":
      return {
        id: "flags",
        prompt: "Regex flags? (optional)",
        hint: 'e.g. "i" for case-insensitive, "m" for multiline; leave empty for none',
        optional: true,
      };
    case "path":
      return {
        id: "path",
        prompt: "Which JSONPath must match in the (JSON) output?",
        hint: "$-rooted, e.g. $.status or $.items[*].id",
      };
    case "expectedJson":
      return {
        id: "expectedJson",
        prompt: "Expected value at that path? (optional, as JSON)",
        hint: 'e.g. "resolved" or 42 — leave empty to only require a match',
        optional: true,
      };
    case "toolCalls":
      return {
        id: "toolCalls",
        prompt: "Which tool names must the run call, in order?",
        hint: "e.g. bash, read — names as the spec's tools: list declares them",
      };
    case "sequenceMode":
      return {
        id: "sequenceMode",
        prompt: "How strictly should the sequence match?",
        choices: [
          { value: "exact", label: "exact — the full call list, in order, nothing else" },
          { value: "subseq", label: "subseq — expected tools appear in order, others may interleave" },
          { value: "set", label: "set — every expected tool was called, order ignored" },
        ],
        optional: true,
        defaultValue: DEFAULT_SEQUENCE_MODE,
      };
    case "criterionName":
      return {
        id: "criterionName",
        prompt: "Name of the rubric criterion the judge scores?",
        hint: "e.g. helpfulness, accuracy",
      };
    case "criterionDescription":
      return {
        id: "criterionDescription",
        prompt: "Describe what the judge should look for:",
        hint: "plain language; the judge scores 1–5 against this",
      };
    case "anchors":
      return {
        id: "anchors",
        prompt: "Anchor descriptions for scores 1–5? (optional)",
        hint: "five lines, worst (1) to best (5); leave empty for generic anchors",
        optional: true,
      };
    case "passingScore":
      return {
        id: "passingScore",
        prompt: "Minimum judge score (1–5) to count as a pass? (optional)",
        hint: "defaults to 3",
        optional: true,
        defaultValue: DEFAULT_PASSING_SCORE,
      };
    case "judgeModel":
      return {
        id: "judgeModel",
        prompt: "Which model should judge?",
        suggested: SUGGESTED_JUDGE_MODELS,
      };
    case "judgeWeight":
      return {
        id: "judgeWeight",
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
 * Reject JSON values the YAML emitter cannot represent faithfully:
 * nested arrays (unsupported in v0) and non-finite numbers (JSON text
 * like `1e999` overflows to Infinity, which YAML would re-read as a
 * string).
 */
function assertEmittable(value: unknown, what: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    fail(`${what} must contain only finite numbers`);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item)) fail(`${what}: nested arrays are not supported in grader opts (v0)`);
      assertEmittable(item, what);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) assertEmittable(v, what);
  }
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
        fail(
          `unknown grader kind "${String(answer.value)}" — pick one of: ${KINDS.map((k) => k.kind).join(", ")}`,
        );
      }
      return;
    case "trim":
    case "caseInsensitive": {
      const q = answer.question;
      if (typeof answer.value !== "boolean") fail(`${q} must be true or false`);
      return;
    }
    case "substring":
      if (requireString(answer.value, "substring") === "") fail("substring must not be empty");
      return;
    case "pattern": {
      const v = requireString(answer.value, "pattern");
      if (v === "") fail("pattern must not be empty");
      try {
        new RegExp(v);
      } catch (err) {
        fail(`invalid regular expression: ${(err as Error).message}`);
      }
      return;
    }
    case "flags": {
      if (answer.value === undefined) return;
      const v = requireString(answer.value, "flags");
      try {
        new RegExp(answerOf(state.answers, "pattern") ?? "", v);
      } catch (err) {
        fail(`invalid regex flags "${v}": ${(err as Error).message}`);
      }
      return;
    }
    case "path": {
      const v = requireString(answer.value, "path");
      if (v === "" || /[\n\r]/.test(v)) fail("path must be a non-empty single-line JSONPath");
      if (!v.startsWith("$")) fail(`JSONPath must start with "$" (got "${v}")`);
      return;
    }
    case "expectedJson": {
      if (answer.value === undefined) return;
      const v = requireString(answer.value, "expected value");
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch (err) {
        fail(`expected value is not valid JSON: ${(err as Error).message}`);
      }
      // Mirror the emitter's limits up front so the error lands on this
      // field instead of surfacing later from compile.
      assertEmittable(parsed, "expected value");
      return;
    }
    case "toolCalls": {
      if (!Array.isArray(answer.value) || answer.value.length === 0) {
        fail("expected at least one tool name");
      }
      for (const t of answer.value) {
        if (typeof t !== "string" || t.trim() === "" || /[\n\r]/.test(t)) {
          fail("tool names must be non-empty single-line strings");
        }
      }
      return;
    }
    case "sequenceMode":
      if (
        answer.value !== undefined &&
        answer.value !== "exact" &&
        answer.value !== "subseq" &&
        answer.value !== "set"
      ) {
        fail('sequence mode must be "exact", "subseq", or "set"');
      }
      return;
    case "criterionName": {
      const v = requireString(answer.value, "criterion name");
      if (v.trim() === "" || /[\n\r]/.test(v)) {
        fail("criterion name must be a non-empty single line");
      }
      return;
    }
    case "criterionDescription":
      if (requireString(answer.value, "criterion description").trim() === "") {
        fail("criterion description must not be empty");
      }
      return;
    case "anchors": {
      if (answer.value === undefined) return;
      if (!Array.isArray(answer.value) || answer.value.length !== 5) {
        fail("anchors must be exactly 5 descriptions, worst (1) to best (5)");
      }
      for (const a of answer.value) {
        if (typeof a !== "string" || a.trim() === "") {
          fail("each anchor description must be a non-empty string");
        }
      }
      return;
    }
    case "passingScore": {
      if (answer.value === undefined) return;
      const v = requireFinite(answer.value, "passing score");
      if (v < 1 || v > 5) fail("passing score must be between 1 and 5");
      return;
    }
    case "judgeModel":
      if (requireString(answer.value, "model").trim() === "") fail("model must not be empty");
      return;
    case "judgeWeight":
      if (answer.value === undefined) return;
      if (requireFinite(answer.value, "weight") <= 0) fail("weight must be > 0");
      return;
  }
}

/**
 * Take a completed builder state and synthesize the structured grader
 * plus its YAML forms. Throws if `kind` or a kind's required field is
 * missing; optional answers fall back to their defaults, and
 * default-valued opts are omitted from the YAML (`trim: true`,
 * `case_insensitive: false`, `mode: subseq`, `passing_score: 3`).
 */
export function compileGrader(state: GraderBuilderState): GraderResult {
  const a = state.answers;
  const kind = answerOf(a, "kind");
  if (kind === undefined) fail("compileGrader: kind not answered yet");

  const grader = ((): GraderConfig => {
    switch (kind) {
      case "exact_match": {
        const trim = answerOf(a, "trim") ?? true;
        const ci = answerOf(a, "caseInsensitive") ?? false;
        const opts = {
          ...(trim === false ? { trim: false } : {}),
          ...(ci === true ? { case_insensitive: true } : {}),
        };
        return Object.keys(opts).length > 0 ? { name: kind, opts } : { name: kind };
      }
      case "contains": {
        const substring = answerOf(a, "substring");
        if (substring === undefined) fail("compileGrader: substring not answered yet");
        return {
          name: kind,
          opts: {
            substring,
            ...(answerOf(a, "caseInsensitive") === true ? { case_insensitive: true } : {}),
          },
        };
      }
      case "regex": {
        const pattern = answerOf(a, "pattern");
        if (pattern === undefined) fail("compileGrader: pattern not answered yet");
        const flags = answerOf(a, "flags");
        return {
          name: kind,
          opts: {
            pattern,
            ...(flags !== undefined && flags !== "" ? { flags } : {}),
          },
        };
      }
      case "json_path": {
        const path = answerOf(a, "path");
        if (path === undefined) fail("compileGrader: path not answered yet");
        const expectedJson = answerOf(a, "expectedJson");
        return {
          name: kind,
          opts: {
            path,
            ...(expectedJson !== undefined
              ? { expected: JSON.parse(expectedJson) as unknown }
              : {}),
          },
        };
      }
      case "tool_call_sequence": {
        const expected = answerOf(a, "toolCalls");
        if (expected === undefined) fail("compileGrader: tool names not answered yet");
        const mode = answerOf(a, "sequenceMode");
        return {
          name: kind,
          opts: {
            expected,
            ...(mode !== undefined && mode !== DEFAULT_SEQUENCE_MODE ? { mode } : {}),
          },
        };
      }
      case "llm_judge": {
        const criterionName = answerOf(a, "criterionName");
        const description = answerOf(a, "criterionDescription");
        if (criterionName === undefined || description === undefined) {
          fail("compileGrader: rubric criterion not answered yet");
        }
        const anchorList = answerOf(a, "anchors") ?? DEFAULT_ANCHORS;
        const anchors: RubricAnchors = {
          "1": anchorList[0] as string,
          "2": anchorList[1] as string,
          "3": anchorList[2] as string,
          "4": anchorList[3] as string,
          "5": anchorList[4] as string,
        };
        const passingScore = answerOf(a, "passingScore");
        const weight = answerOf(a, "judgeWeight");
        return {
          name: kind,
          opts: {
            rubric: {
              criteria: [{ name: criterionName, description, anchors }],
              ...(passingScore !== undefined && passingScore !== DEFAULT_PASSING_SCORE
                ? { passing_score: passingScore }
                : {}),
            },
            model: answerOf(a, "judgeModel") ?? (SUGGESTED_JUDGE_MODELS[0] as string),
            ...(weight !== undefined ? { weight } : {}),
          },
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
// rubric anchor keys are emitted double-quoted so they stay string keys.
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

function indent(block: string, by: number): string {
  const pad = " ".repeat(by);
  return block
    .split("\n")
    .map((l) => (l === "" ? l : pad + l))
    .join("\n");
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
        fail("nested arrays are not supported in grader opts (v0)");
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

/** Quote map keys that YAML would otherwise read as numbers (rubric anchors). */
function yamlKey(key: string): string {
  return /^[A-Za-z_][\w-]*$/.test(key) ? key : JSON.stringify(key);
}

/** One `- name: …` list item at base indent 0, deterministic key order. */
function emitGraderEntry(grader: GraderConfig): string {
  const pairs: Array<[string, unknown]> = [["name", grader.name]];
  if (grader.opts !== undefined && Object.keys(grader.opts).length > 0) {
    pairs.push(["opts", grader.opts]);
  }
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

  // Block ends at the next top-level key, a document marker (`---`,
  // `...`), or EOF; insert before any trailing blank lines so block
  // separation stays intact.
  let end = lines.length;
  for (let i = gradersIdx + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (TOP_LEVEL_KEY_RE.test(line) || /^(---|\.\.\.)\s*$/.test(line)) {
      end = i;
      break;
    }
  }
  while (end > gradersIdx + 1 && (lines[end - 1] as string).trim() === "") end--;
  lines.splice(end, 0, ...entry.split("\n"));
  return lines.join("\n");
}
