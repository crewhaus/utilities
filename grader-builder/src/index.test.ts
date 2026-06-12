import { describe, expect, test } from "bun:test";

import {
  type GraderAnswer,
  type GraderBuilderState,
  GraderBuilderError,
  answerGrader,
  appendGraderToSpecYaml,
  compileGrader,
  listGraderKinds,
  nextQuestion,
  startGraderBuilder,
} from "./index";

function run(answers: ReadonlyArray<GraderAnswer>): GraderBuilderState {
  let state = startGraderBuilder();
  for (const a of answers) state = answerGrader(state, a);
  return state;
}

describe("grader-builder (catalog)", () => {
  test("listGraderKinds exposes all six kinds with titles + descriptions", () => {
    const kinds = listGraderKinds();
    expect(kinds.map((k) => k.kind)).toEqual([
      "exact-match",
      "contains",
      "numeric-tolerance",
      "json-schema",
      "llm-judge",
      "custom-script",
    ]);
    for (const k of kinds) {
      expect(k.title.length).toBeGreaterThan(0);
      expect(k.description.length).toBeGreaterThan(0);
    }
  });

  test("first question is the kind picker with one choice per kind", () => {
    const q = nextQuestion(startGraderBuilder());
    expect(q?.id).toBe("kind");
    if (q?.id === "kind") expect(q.choices.length).toBe(6);
  });
});

describe("grader-builder (question sequences)", () => {
  const sequences: Record<string, string[]> = {
    "exact-match": ["kind", "id", "expected", "caseSensitive", "weight"],
    contains: ["kind", "id", "isRegex", "pattern", "caseSensitive", "weight"],
    "numeric-tolerance": ["kind", "id", "expectedNumber", "tolerance", "toleranceMode", "weight"],
    "json-schema": ["kind", "id", "schemaJson", "weight"],
    "llm-judge": ["kind", "id", "rubric", "judgeModel", "threshold", "weight"],
    "custom-script": ["kind", "id", "scriptPath", "timeoutMs", "weight"],
  };
  const answersFor: Record<string, GraderAnswer> = {
    id: { question: "id", value: "g-1" },
    expected: { question: "expected", value: "42" },
    caseSensitive: { question: "caseSensitive", value: true },
    isRegex: { question: "isRegex", value: false },
    pattern: { question: "pattern", value: "refund" },
    expectedNumber: { question: "expectedNumber", value: 19.99 },
    tolerance: { question: "tolerance", value: 0.05 },
    toleranceMode: { question: "toleranceMode", value: "absolute" },
    schemaJson: { question: "schemaJson", value: '{"type":"object"}' },
    rubric: { question: "rubric", value: "Be polite." },
    judgeModel: { question: "judgeModel", value: "claude-sonnet-4-6" },
    threshold: { question: "threshold", value: 0.7 },
    scriptPath: { question: "scriptPath", value: "./graders/check.ts" },
    timeoutMs: { question: "timeoutMs", value: undefined },
    weight: { question: "weight", value: undefined },
  };

  for (const [kind, seq] of Object.entries(sequences)) {
    test(`${kind}: asks ${seq.join(" → ")} then completes`, () => {
      let state = startGraderBuilder();
      for (const expected of seq) {
        const q = nextQuestion(state);
        expect(q?.id).toBe(expected as NonNullable<ReturnType<typeof nextQuestion>>["id"]);
        const answer =
          expected === "kind"
            ? ({ question: "kind", value: kind } as GraderAnswer)
            : (answersFor[expected] as GraderAnswer);
        state = answerGrader(state, answer);
      }
      expect(nextQuestion(state)).toBeUndefined();
    });
  }

  test("only the kind question is asked until kind is answered", () => {
    const state = startGraderBuilder();
    expect(nextQuestion(state)?.id).toBe("kind");
  });

  test("pattern question prompt flips between substring and regex wording", () => {
    const literal = run([
      { question: "kind", value: "contains" },
      { question: "id", value: "g" },
      { question: "isRegex", value: false },
    ]);
    const regex = run([
      { question: "kind", value: "contains" },
      { question: "id", value: "g" },
      { question: "isRegex", value: true },
    ]);
    const ql = nextQuestion(literal);
    const qr = nextQuestion(regex);
    expect(ql?.id === "pattern" && ql.prompt).toContain("substring");
    expect(qr?.id === "pattern" && qr.prompt).toContain("regular expression");
  });
});

describe("grader-builder (validation)", () => {
  const start = startGraderBuilder();

  test("unknown kind is rejected with the kind list", () => {
    expect(() =>
      answerGrader(start, { question: "kind", value: "vibes" } as unknown as GraderAnswer),
    ).toThrow(GraderBuilderError);
  });

  test("out-of-order answers are rejected", () => {
    expect(() => answerGrader(start, { question: "id", value: "g" })).toThrow(
      'expected an answer for "kind"',
    );
  });

  test("answering past the end is rejected", () => {
    const done = run([
      { question: "kind", value: "json-schema" },
      { question: "id", value: "g" },
      { question: "schemaJson", value: "{}" },
      { question: "weight", value: undefined },
    ]);
    expect(() => answerGrader(done, { question: "weight", value: 1 })).toThrow(
      GraderBuilderError,
    );
  });

  test("non-kebab-case id is rejected", () => {
    const s = run([{ question: "kind", value: "exact-match" }]);
    expect(() => answerGrader(s, { question: "id", value: "My Grader" })).toThrow("kebab-case");
    expect(() => answerGrader(s, { question: "id", value: "-leading" })).toThrow(
      GraderBuilderError,
    );
  });

  test("invalid regex is rejected with the RegExp message", () => {
    const s = run([
      { question: "kind", value: "contains" },
      { question: "id", value: "g" },
      { question: "isRegex", value: true },
    ]);
    expect(() => answerGrader(s, { question: "pattern", value: "(unclosed" })).toThrow(
      "invalid regular expression",
    );
  });

  test("literal pattern is not regex-validated", () => {
    const s = run([
      { question: "kind", value: "contains" },
      { question: "id", value: "g" },
      { question: "isRegex", value: false },
    ]);
    expect(() => answerGrader(s, { question: "pattern", value: "(unclosed" })).not.toThrow();
  });

  test("negative tolerance is rejected", () => {
    const s = run([
      { question: "kind", value: "numeric-tolerance" },
      { question: "id", value: "g" },
      { question: "expectedNumber", value: 1 },
    ]);
    expect(() => answerGrader(s, { question: "tolerance", value: -0.1 })).toThrow(">= 0");
  });

  test("threshold outside 0..1 is rejected", () => {
    const s = run([
      { question: "kind", value: "llm-judge" },
      { question: "id", value: "g" },
      { question: "rubric", value: "r" },
      { question: "judgeModel", value: "m" },
    ]);
    expect(() => answerGrader(s, { question: "threshold", value: 1.5 })).toThrow(
      "between 0 and 1",
    );
  });

  test("schema must be a JSON object", () => {
    const s = run([
      { question: "kind", value: "json-schema" },
      { question: "id", value: "g" },
    ]);
    expect(() => answerGrader(s, { question: "schemaJson", value: "not json" })).toThrow(
      "not valid JSON",
    );
    expect(() => answerGrader(s, { question: "schemaJson", value: "[1,2]" })).toThrow(
      "JSON object",
    );
  });

  test("script path must be a single line; timeout a positive integer", () => {
    const s = run([
      { question: "kind", value: "custom-script" },
      { question: "id", value: "g" },
    ]);
    expect(() => answerGrader(s, { question: "scriptPath", value: "" })).toThrow(
      GraderBuilderError,
    );
    expect(() => answerGrader(s, { question: "scriptPath", value: "a\nb" })).toThrow(
      GraderBuilderError,
    );
    const withScript = answerGrader(s, { question: "scriptPath", value: "./g.ts" });
    expect(() => answerGrader(withScript, { question: "timeoutMs", value: 0 })).toThrow(
      "positive integer",
    );
    expect(() => answerGrader(withScript, { question: "timeoutMs", value: 1.5 })).toThrow(
      "positive integer",
    );
  });

  test("weight must be > 0 when given", () => {
    const s = run([
      { question: "kind", value: "json-schema" },
      { question: "id", value: "g" },
      { question: "schemaJson", value: "{}" },
    ]);
    expect(() => answerGrader(s, { question: "weight", value: 0 })).toThrow("> 0");
    expect(() => answerGrader(s, { question: "weight", value: undefined })).not.toThrow();
  });

  test("wrong value types from untrusted JSON are rejected", () => {
    const s = run([{ question: "kind", value: "exact-match" }]);
    expect(() =>
      answerGrader(s, { question: "id", value: 42 } as unknown as GraderAnswer),
    ).toThrow("must be a string");
  });
});

describe("grader-builder (compile)", () => {
  test("exact-match: defaults omitted, expected quoted when ambiguous", () => {
    const { grader, yamlEntry, yamlBlock } = compileGrader(
      run([
        { question: "kind", value: "exact-match" },
        { question: "id", value: "exact-answer" },
        { question: "expected", value: "42" },
        { question: "caseSensitive", value: true },
        { question: "weight", value: undefined },
      ]),
    );
    expect(grader).toEqual({
      id: "exact-answer",
      kind: "exact-match",
      expected: "42",
      caseSensitive: true,
    });
    expect(yamlEntry).toBe('- id: exact-answer\n  kind: exact-match\n  expected: "42"');
    expect(yamlEntry).not.toContain("caseSensitive");
    expect(yamlBlock).toBe(`graders:\n${yamlEntry.split("\n").map((l) => `  ${l}`).join("\n")}`);
  });

  test("exact-match: caseSensitive false is emitted", () => {
    const { yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "exact-match" },
        { question: "id", value: "g" },
        { question: "expected", value: "ok" },
        { question: "caseSensitive", value: false },
        { question: "weight", value: undefined },
      ]),
    );
    expect(yamlEntry).toContain("caseSensitive: false");
  });

  test("contains: regex true emitted, pattern quoted", () => {
    const { yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "contains" },
        { question: "id", value: "mentions-refund" },
        { question: "isRegex", value: true },
        { question: "pattern", value: "refund(ed|s)?" },
        { question: "caseSensitive", value: true },
        { question: "weight", value: undefined },
      ]),
    );
    expect(yamlEntry).toContain("kind: contains");
    expect(yamlEntry).toContain('pattern: "refund(ed|s)?"');
    expect(yamlEntry).toContain("regex: true");
  });

  test("numeric-tolerance: absolute mode omitted, relative emitted", () => {
    const base: ReadonlyArray<GraderAnswer> = [
      { question: "kind", value: "numeric-tolerance" },
      { question: "id", value: "price-close" },
      { question: "expectedNumber", value: 19.99 },
      { question: "tolerance", value: 0.05 },
    ];
    const abs = compileGrader(
      run([...base, { question: "toleranceMode", value: "absolute" }, { question: "weight", value: undefined }]),
    );
    expect(abs.yamlEntry).toContain("expected: 19.99");
    expect(abs.yamlEntry).toContain("tolerance: 0.05");
    expect(abs.yamlEntry).not.toContain("mode:");
    const rel = compileGrader(
      run([...base, { question: "toleranceMode", value: "relative" }, { question: "weight", value: undefined }]),
    );
    expect(rel.yamlEntry).toContain("mode: relative");
  });

  test("json-schema: nested schema serialized as YAML", () => {
    const { yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "json-schema" },
        { question: "id", value: "valid-payload" },
        {
          question: "schemaJson",
          value: '{"type":"object","required":["status"],"properties":{"status":{"type":"string"}}}',
        },
        { question: "weight", value: undefined },
      ]),
    );
    expect(yamlEntry).toBe(
      [
        "- id: valid-payload",
        "  kind: json-schema",
        "  schema:",
        "    type: object",
        "    required:",
        "      - status",
        "    properties:",
        "      status:",
        "        type: string",
      ].join("\n"),
    );
  });

  test("llm-judge: multi-line rubric becomes a block scalar; weight emitted last", () => {
    const { yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "llm-judge" },
        { question: "id", value: "helpfulness" },
        { question: "rubric", value: "Score 1 if polite\nand cites a source." },
        { question: "judgeModel", value: "claude-sonnet-4-6" },
        { question: "threshold", value: 0.7 },
        { question: "weight", value: 2 },
      ]),
    );
    expect(yamlEntry).toBe(
      [
        "- id: helpfulness",
        "  kind: llm-judge",
        "  model: claude-sonnet-4-6",
        "  threshold: 0.7",
        "  rubric: |",
        "    Score 1 if polite",
        "    and cites a source.",
        "  weight: 2",
      ].join("\n"),
    );
  });

  test("custom-script: timeout omitted when unset, emitted when given", () => {
    const base: ReadonlyArray<GraderAnswer> = [
      { question: "kind", value: "custom-script" },
      { question: "id", value: "domain-checks" },
      { question: "scriptPath", value: "./graders/domain-checks.ts" },
    ];
    const noTimeout = compileGrader(
      run([...base, { question: "timeoutMs", value: undefined }, { question: "weight", value: undefined }]),
    );
    expect(noTimeout.yamlEntry).toContain("script: ./graders/domain-checks.ts");
    expect(noTimeout.yamlEntry).not.toContain("timeoutMs");
    const withTimeout = compileGrader(
      run([...base, { question: "timeoutMs", value: 30000 }, { question: "weight", value: undefined }]),
    );
    expect(withTimeout.yamlEntry).toContain("timeoutMs: 30000");
  });

  test("compile throws on incomplete state", () => {
    expect(() => compileGrader(startGraderBuilder())).toThrow("kind not answered");
    expect(() => compileGrader(run([{ question: "kind", value: "exact-match" }]))).toThrow(
      "id not answered",
    );
    expect(() =>
      compileGrader(
        run([
          { question: "kind", value: "exact-match" },
          { question: "id", value: "g" },
        ]),
      ),
    ).toThrow("expected not answered");
  });

  test("state survives a JSON round-trip (HTTP transport)", () => {
    const state = run([
      { question: "kind", value: "llm-judge" },
      { question: "id", value: "helpfulness" },
      { question: "rubric", value: "Be polite." },
      { question: "judgeModel", value: "claude-sonnet-4-6" },
      { question: "threshold", value: 0.7 },
      { question: "weight", value: undefined },
    ]);
    const revived = JSON.parse(JSON.stringify(state)) as GraderBuilderState;
    expect(compileGrader(revived).yamlEntry).toBe(compileGrader(state).yamlEntry);
  });
});

describe("grader-builder (appendGraderToSpecYaml)", () => {
  const entry = "- id: g2\n  kind: exact-match\n  expected: ok";

  test("appends into an existing populated graders block, preserving the rest", () => {
    const spec = [
      "name: my-eval",
      "target: eval",
      "# the corpus",
      "dataset:",
      "  path: ./data.jsonl",
      "graders:",
      "  - id: g1",
      "    kind: contains",
      "    pattern: hi",
      "",
      "agent:",
      "  model: claude-sonnet-4-6",
      "",
    ].join("\n");
    const next = appendGraderToSpecYaml(spec, entry);
    expect(next).toBe(
      [
        "name: my-eval",
        "target: eval",
        "# the corpus",
        "dataset:",
        "  path: ./data.jsonl",
        "graders:",
        "  - id: g1",
        "    kind: contains",
        "    pattern: hi",
        "  - id: g2",
        "    kind: exact-match",
        "    expected: ok",
        "",
        "agent:",
        "  model: claude-sonnet-4-6",
        "",
      ].join("\n"),
    );
  });

  test("replaces an empty graders: [] line", () => {
    const spec = "name: e\ntarget: eval\ngraders: []\nagent: {}\n";
    const next = appendGraderToSpecYaml(spec, entry);
    expect(next).toBe(
      "name: e\ntarget: eval\ngraders:\n  - id: g2\n    kind: exact-match\n    expected: ok\nagent: {}\n",
    );
  });

  test("creates the graders block at EOF when missing", () => {
    const spec = "name: e\ntarget: eval\nagent: {}";
    const next = appendGraderToSpecYaml(spec, entry);
    expect(next).toBe(
      "name: e\ntarget: eval\nagent: {}\ngraders:\n  - id: g2\n    kind: exact-match\n    expected: ok\n",
    );
  });

  test("appends when graders is the last block in the file", () => {
    const spec = "name: e\ntarget: eval\ngraders:\n  - id: g1\n    kind: contains\n    pattern: hi\n";
    const next = appendGraderToSpecYaml(spec, entry);
    expect(next).toBe(
      "name: e\ntarget: eval\ngraders:\n  - id: g1\n    kind: contains\n    pattern: hi\n  - id: g2\n    kind: exact-match\n    expected: ok\n",
    );
  });

  test("rejects inline flow style graders", () => {
    expect(() => appendGraderToSpecYaml("name: e\ngraders: [a, b]\n", entry)).toThrow(
      "flow style",
    );
  });
});
