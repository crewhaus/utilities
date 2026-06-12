import { describe, expect, test } from "bun:test";

import { parseSpec } from "@crewhaus/spec";

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
  test("listGraderKinds exposes the six real kinds, in order, with titles + descriptions", () => {
    const kinds = listGraderKinds();
    expect(kinds.map((k) => k.kind)).toEqual([
      "exact_match",
      "contains",
      "regex",
      "json_path",
      "tool_call_sequence",
      "llm_judge",
    ]);
    for (const k of kinds) {
      expect(k.title.length).toBeGreaterThan(0);
      expect(k.description.length).toBeGreaterThan(0);
    }
  });

  test("first question is the kind picker with one choice per kind", () => {
    const q = nextQuestion(startGraderBuilder());
    expect(q?.id).toBe("kind");
    if (q?.id === "kind") {
      expect(q.choices.map((c) => c.value)).toEqual(listGraderKinds().map((k) => k.kind));
    }
  });
});

describe("grader-builder (question sequences)", () => {
  const sequences: Record<string, string[]> = {
    exact_match: ["kind", "trim", "caseInsensitive"],
    contains: ["kind", "substring", "caseInsensitive"],
    regex: ["kind", "pattern", "flags"],
    json_path: ["kind", "path", "expectedJson"],
    tool_call_sequence: ["kind", "toolCalls", "sequenceMode"],
    llm_judge: [
      "kind",
      "criterionName",
      "criterionDescription",
      "anchors",
      "passingScore",
      "judgeModel",
      "judgeWeight",
    ],
  };
  const answersFor: Record<string, GraderAnswer> = {
    trim: { question: "trim", value: true },
    caseInsensitive: { question: "caseInsensitive", value: false },
    substring: { question: "substring", value: "refund" },
    pattern: { question: "pattern", value: "refund(ed|s)?" },
    flags: { question: "flags", value: undefined },
    path: { question: "path", value: "$.status" },
    expectedJson: { question: "expectedJson", value: undefined },
    toolCalls: { question: "toolCalls", value: ["bash", "read"] },
    sequenceMode: { question: "sequenceMode", value: undefined },
    criterionName: { question: "criterionName", value: "helpfulness" },
    criterionDescription: {
      question: "criterionDescription",
      value: "Answers the question directly.",
    },
    anchors: { question: "anchors", value: undefined },
    passingScore: { question: "passingScore", value: undefined },
    judgeModel: { question: "judgeModel", value: "claude-sonnet-4-6" },
    judgeWeight: { question: "judgeWeight", value: undefined },
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
    expect(nextQuestion(startGraderBuilder())?.id).toBe("kind");
  });

  test("sequenceMode question is optional with a subseq default", () => {
    const q = nextQuestion(run([{ question: "kind", value: "tool_call_sequence" }, { question: "toolCalls", value: ["bash"] }]));
    expect(q?.id).toBe("sequenceMode");
    if (q?.id === "sequenceMode") {
      expect(q.optional).toBe(true);
      expect(q.defaultValue).toBe("subseq");
      expect(q.choices.map((c) => c.value)).toEqual(["exact", "subseq", "set"]);
    }
  });

  test("judgeModel question suggests the spec wizard's model list", () => {
    const q = nextQuestion(
      run([
        { question: "kind", value: "llm_judge" },
        { question: "criterionName", value: "tone" },
        { question: "criterionDescription", value: "Be polite." },
        { question: "anchors", value: undefined },
        { question: "passingScore", value: undefined },
      ]),
    );
    expect(q?.id).toBe("judgeModel");
    if (q?.id === "judgeModel") {
      expect(q.suggested).toEqual([
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-7",
      ]);
    }
  });
});

describe("grader-builder (validation)", () => {
  const start = startGraderBuilder();

  test("unknown kind is rejected with the kind list", () => {
    expect(() =>
      answerGrader(start, { question: "kind", value: "vibes" } as unknown as GraderAnswer),
    ).toThrow('unknown grader kind "vibes"');
    expect(() =>
      answerGrader(start, { question: "kind", value: "vibes" } as unknown as GraderAnswer),
    ).toThrow(GraderBuilderError);
  });

  test("out-of-order answers are rejected", () => {
    expect(() => answerGrader(start, { question: "substring", value: "x" })).toThrow(
      'expected an answer for "kind", got "substring"',
    );
  });

  test("answering past the end is rejected", () => {
    const done = run([
      { question: "kind", value: "exact_match" },
      { question: "trim", value: true },
      { question: "caseInsensitive", value: false },
    ]);
    expect(() => answerGrader(done, { question: "trim", value: true })).toThrow(
      "all questions are already answered",
    );
  });

  test("trim / caseInsensitive must be booleans", () => {
    const s = run([{ question: "kind", value: "exact_match" }]);
    expect(() =>
      answerGrader(s, { question: "trim", value: "yes" } as unknown as GraderAnswer),
    ).toThrow("trim must be true or false");
    const withTrim = answerGrader(s, { question: "trim", value: false });
    expect(() =>
      answerGrader(withTrim, {
        question: "caseInsensitive",
        value: 1,
      } as unknown as GraderAnswer),
    ).toThrow("caseInsensitive must be true or false");
  });

  test("substring must be a non-empty string", () => {
    const s = run([{ question: "kind", value: "contains" }]);
    expect(() => answerGrader(s, { question: "substring", value: "" })).toThrow(
      "substring must not be empty",
    );
    expect(() =>
      answerGrader(s, { question: "substring", value: 42 } as unknown as GraderAnswer),
    ).toThrow("substring must be a string");
  });

  test("empty or invalid regex pattern is rejected", () => {
    const s = run([{ question: "kind", value: "regex" }]);
    expect(() => answerGrader(s, { question: "pattern", value: "" })).toThrow(
      "pattern must not be empty",
    );
    expect(() => answerGrader(s, { question: "pattern", value: "(unclosed" })).toThrow(
      "invalid regular expression",
    );
  });

  test("invalid regex flags are rejected", () => {
    const s = run([
      { question: "kind", value: "regex" },
      { question: "pattern", value: "refund" },
    ]);
    expect(() => answerGrader(s, { question: "flags", value: "ii" })).toThrow(
      'invalid regex flags "ii"',
    );
    expect(() => answerGrader(s, { question: "flags", value: undefined })).not.toThrow();
    expect(() => answerGrader(s, { question: "flags", value: "im" })).not.toThrow();
  });

  test("path must be a $-rooted single-line JSONPath", () => {
    const s = run([{ question: "kind", value: "json_path" }]);
    expect(() => answerGrader(s, { question: "path", value: "status" })).toThrow(
      'JSONPath must start with "$"',
    );
    expect(() => answerGrader(s, { question: "path", value: "$.a\n.b" })).toThrow(
      "path must be a non-empty single-line JSONPath",
    );
    expect(() => answerGrader(s, { question: "path", value: "" })).toThrow(
      "path must be a non-empty single-line JSONPath",
    );
  });

  test("expectedJson must parse as JSON when given", () => {
    const s = run([
      { question: "kind", value: "json_path" },
      { question: "path", value: "$.status" },
    ]);
    expect(() => answerGrader(s, { question: "expectedJson", value: "not json" })).toThrow(
      "expected value is not valid JSON",
    );
    expect(() => answerGrader(s, { question: "expectedJson", value: undefined })).not.toThrow();
    expect(() => answerGrader(s, { question: "expectedJson", value: '"resolved"' })).not.toThrow();
  });

  test("toolCalls must be a non-empty list of single-line names", () => {
    const s = run([{ question: "kind", value: "tool_call_sequence" }]);
    expect(() => answerGrader(s, { question: "toolCalls", value: [] })).toThrow(
      "expected at least one tool name",
    );
    expect(() => answerGrader(s, { question: "toolCalls", value: ["bash\nread"] })).toThrow(
      "tool names must be non-empty single-line strings",
    );
    expect(() => answerGrader(s, { question: "toolCalls", value: ["  "] })).toThrow(
      "tool names must be non-empty single-line strings",
    );
  });

  test("sequenceMode outside the enum is rejected", () => {
    const s = run([
      { question: "kind", value: "tool_call_sequence" },
      { question: "toolCalls", value: ["bash"] },
    ]);
    expect(() =>
      answerGrader(s, { question: "sequenceMode", value: "ordered" } as unknown as GraderAnswer),
    ).toThrow('sequence mode must be "exact", "subseq", or "set"');
  });

  test("criterion name and description must be non-empty", () => {
    const s = run([{ question: "kind", value: "llm_judge" }]);
    expect(() => answerGrader(s, { question: "criterionName", value: "" })).toThrow(
      "criterion name must be a non-empty single line",
    );
    expect(() => answerGrader(s, { question: "criterionName", value: "a\nb" })).toThrow(
      "criterion name must be a non-empty single line",
    );
    const named = answerGrader(s, { question: "criterionName", value: "tone" });
    expect(() => answerGrader(named, { question: "criterionDescription", value: "  " })).toThrow(
      "criterion description must not be empty",
    );
  });

  test("anchors must be exactly five non-empty descriptions", () => {
    const s = run([
      { question: "kind", value: "llm_judge" },
      { question: "criterionName", value: "tone" },
      { question: "criterionDescription", value: "Be polite." },
    ]);
    expect(() =>
      answerGrader(s, { question: "anchors", value: ["a", "b", "c", "d"] }),
    ).toThrow("anchors must be exactly 5 descriptions");
    expect(() =>
      answerGrader(s, { question: "anchors", value: ["a", "b", "", "d", "e"] }),
    ).toThrow("each anchor description must be a non-empty string");
    expect(() => answerGrader(s, { question: "anchors", value: undefined })).not.toThrow();
  });

  test("passing score must be between 1 and 5", () => {
    const s = run([
      { question: "kind", value: "llm_judge" },
      { question: "criterionName", value: "tone" },
      { question: "criterionDescription", value: "Be polite." },
      { question: "anchors", value: undefined },
    ]);
    expect(() => answerGrader(s, { question: "passingScore", value: 0 })).toThrow(
      "passing score must be between 1 and 5",
    );
    expect(() => answerGrader(s, { question: "passingScore", value: 6 })).toThrow(
      "passing score must be between 1 and 5",
    );
    expect(() => answerGrader(s, { question: "passingScore", value: 1 })).not.toThrow();
    expect(() => answerGrader(s, { question: "passingScore", value: 5 })).not.toThrow();
  });

  test("judge model must be non-empty; weight must be > 0 when given", () => {
    const s = run([
      { question: "kind", value: "llm_judge" },
      { question: "criterionName", value: "tone" },
      { question: "criterionDescription", value: "Be polite." },
      { question: "anchors", value: undefined },
      { question: "passingScore", value: undefined },
    ]);
    expect(() => answerGrader(s, { question: "judgeModel", value: " " })).toThrow(
      "model must not be empty",
    );
    const withModel = answerGrader(s, { question: "judgeModel", value: "claude-sonnet-4-6" });
    expect(() => answerGrader(withModel, { question: "judgeWeight", value: 0 })).toThrow(
      "weight must be > 0",
    );
    expect(() => answerGrader(withModel, { question: "judgeWeight", value: -2 })).toThrow(
      "weight must be > 0",
    );
    expect(() =>
      answerGrader(withModel, { question: "judgeWeight", value: undefined }),
    ).not.toThrow();
  });
});

describe("grader-builder (compile)", () => {
  test("exact_match: all defaults compile to a bare name with no opts key", () => {
    const { grader, yamlEntry, yamlBlock } = compileGrader(
      run([
        { question: "kind", value: "exact_match" },
        { question: "trim", value: true },
        { question: "caseInsensitive", value: false },
      ]),
    );
    expect(grader).toEqual({ name: "exact_match" });
    expect(yamlEntry).toBe("- name: exact_match");
    expect(yamlEntry).not.toContain("opts");
    expect(yamlBlock).toBe("graders:\n  - name: exact_match");
  });

  test("exact_match: non-default trim/case_insensitive are emitted", () => {
    const { grader, yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "exact_match" },
        { question: "trim", value: false },
        { question: "caseInsensitive", value: true },
      ]),
    );
    expect(grader).toEqual({
      name: "exact_match",
      opts: { trim: false, case_insensitive: true },
    });
    expect(yamlEntry).toBe(
      ["- name: exact_match", "  opts:", "    trim: false", "    case_insensitive: true"].join(
        "\n",
      ),
    );
  });

  test("contains: default case_insensitive omitted; substring emitted", () => {
    const { grader, yamlEntry, yamlBlock } = compileGrader(
      run([
        { question: "kind", value: "contains" },
        { question: "substring", value: "refund" },
        { question: "caseInsensitive", value: false },
      ]),
    );
    expect(grader).toEqual({ name: "contains", opts: { substring: "refund" } });
    expect(yamlEntry).toBe(["- name: contains", "  opts:", "    substring: refund"].join("\n"));
    expect(yamlEntry).not.toContain("case_insensitive");
    expect(yamlBlock).toBe(
      ["graders:", "  - name: contains", "    opts:", "      substring: refund"].join("\n"),
    );
  });

  test("contains: case_insensitive true is emitted; ambiguous substrings stay quoted", () => {
    const { grader, yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "contains" },
        { question: "substring", value: "42" },
        { question: "caseInsensitive", value: true },
      ]),
    );
    expect(grader).toEqual({
      name: "contains",
      opts: { substring: "42", case_insensitive: true },
    });
    expect(yamlEntry).toContain('substring: "42"');
    expect(yamlEntry).toContain("case_insensitive: true");
  });

  test("regex: pattern quoted when non-plain; flags emitted when given", () => {
    const { grader, yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "regex" },
        { question: "pattern", value: "refund(ed|s)?" },
        { question: "flags", value: "i" },
      ]),
    );
    expect(grader).toEqual({ name: "regex", opts: { pattern: "refund(ed|s)?", flags: "i" } });
    expect(yamlEntry).toBe(
      ["- name: regex", "  opts:", '    pattern: "refund(ed|s)?"', "    flags: i"].join("\n"),
    );
  });

  test("regex: undefined or empty flags are omitted", () => {
    const base: ReadonlyArray<GraderAnswer> = [
      { question: "kind", value: "regex" },
      { question: "pattern", value: "ok" },
    ];
    const skipped = compileGrader(run([...base, { question: "flags", value: undefined }]));
    expect(skipped.grader).toEqual({ name: "regex", opts: { pattern: "ok" } });
    expect(skipped.yamlEntry).not.toContain("flags");
    const empty = compileGrader(run([...base, { question: "flags", value: "" }]));
    expect(empty.grader).toEqual({ name: "regex", opts: { pattern: "ok" } });
    expect(empty.yamlEntry).not.toContain("flags");
  });

  test("json_path: expected parsed from JSON and emitted; omitted when skipped", () => {
    const withExpected = compileGrader(
      run([
        { question: "kind", value: "json_path" },
        { question: "path", value: "$.status" },
        { question: "expectedJson", value: '"resolved"' },
      ]),
    );
    expect(withExpected.grader).toEqual({
      name: "json_path",
      opts: { path: "$.status", expected: "resolved" },
    });
    expect(withExpected.yamlEntry).toBe(
      ["- name: json_path", "  opts:", "    path: $.status", "    expected: resolved"].join("\n"),
    );
    const matchOnly = compileGrader(
      run([
        { question: "kind", value: "json_path" },
        { question: "path", value: "$.items[*].id" },
        { question: "expectedJson", value: undefined },
      ]),
    );
    expect(matchOnly.grader).toEqual({ name: "json_path", opts: { path: "$.items[*].id" } });
    expect(matchOnly.yamlEntry).not.toContain("expected");
  });

  test("tool_call_sequence: default subseq mode omitted (undefined and explicit)", () => {
    const base: ReadonlyArray<GraderAnswer> = [
      { question: "kind", value: "tool_call_sequence" },
      { question: "toolCalls", value: ["bash", "read"] },
    ];
    const expectedYaml = [
      "- name: tool_call_sequence",
      "  opts:",
      "    expected:",
      "      - bash",
      "      - read",
    ].join("\n");
    const skipped = compileGrader(run([...base, { question: "sequenceMode", value: undefined }]));
    expect(skipped.grader).toEqual({
      name: "tool_call_sequence",
      opts: { expected: ["bash", "read"] },
    });
    expect(skipped.yamlEntry).toBe(expectedYaml);
    const explicit = compileGrader(run([...base, { question: "sequenceMode", value: "subseq" }]));
    expect(explicit.grader).toEqual(skipped.grader);
    expect(explicit.yamlEntry).toBe(expectedYaml);
  });

  test("tool_call_sequence: explicit exact mode is emitted", () => {
    const { grader, yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "tool_call_sequence" },
        { question: "toolCalls", value: ["bash", "read"] },
        { question: "sequenceMode", value: "exact" },
      ]),
    );
    expect(grader).toEqual({
      name: "tool_call_sequence",
      opts: { expected: ["bash", "read"], mode: "exact" },
    });
    expect(yamlEntry).toBe(
      [
        "- name: tool_call_sequence",
        "  opts:",
        "    expected:",
        "      - bash",
        "      - read",
        "    mode: exact",
      ].join("\n"),
    );
  });

  test("llm_judge: skipped anchors fall back to the five generic anchors with quoted keys", () => {
    const { grader, yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "llm_judge" },
        { question: "criterionName", value: "helpfulness" },
        { question: "criterionDescription", value: "Answers the question directly." },
        { question: "anchors", value: undefined },
        { question: "passingScore", value: undefined },
        { question: "judgeModel", value: "claude-sonnet-4-6" },
        { question: "judgeWeight", value: undefined },
      ]),
    );
    if (grader.name !== "llm_judge") throw new Error("expected an llm_judge grader");
    expect(grader.opts.rubric.criteria[0]?.anchors).toEqual({
      "1": "Fails the criterion entirely.",
      "2": "Mostly fails; major gaps remain.",
      "3": "Mixed; meets the bar in places with clear gaps.",
      "4": "Meets the criterion with only minor gaps.",
      "5": "Fully meets the criterion.",
    });
    expect(grader.opts.model).toBe("claude-sonnet-4-6");
    expect(grader.opts.rubric.passing_score).toBeUndefined();
    expect(grader.opts.weight).toBeUndefined();
    expect(yamlEntry).toContain('"1": Fails the criterion entirely.');
    expect(yamlEntry).toContain('"2": "Mostly fails; major gaps remain."');
    expect(yamlEntry).toContain('"5": Fully meets the criterion.');
    expect(yamlEntry).toContain("model: claude-sonnet-4-6");
    expect(yamlEntry).not.toContain("passing_score");
    expect(yamlEntry).not.toContain("weight");
  });

  test("llm_judge: custom anchors, block-scalar description, passing_score 4, weight", () => {
    const { grader, yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "llm_judge" },
        { question: "criterionName", value: "tone" },
        { question: "criterionDescription", value: "Scores politeness.\nPenalize rudeness." },
        { question: "anchors", value: ["bad", "poor", "okay", "good", "great"] },
        { question: "passingScore", value: 4 },
        { question: "judgeModel", value: "claude-sonnet-4-6" },
        { question: "judgeWeight", value: 2 },
      ]),
    );
    expect(grader).toEqual({
      name: "llm_judge",
      opts: {
        rubric: {
          criteria: [
            {
              name: "tone",
              description: "Scores politeness.\nPenalize rudeness.",
              anchors: { "1": "bad", "2": "poor", "3": "okay", "4": "good", "5": "great" },
            },
          ],
          passing_score: 4,
        },
        model: "claude-sonnet-4-6",
        weight: 2,
      },
    });
    expect(yamlEntry).toBe(
      [
        "- name: llm_judge",
        "  opts:",
        "    rubric:",
        "      criteria:",
        "        - name: tone",
        "          description: |-",
        "            Scores politeness.",
        "            Penalize rudeness.",
        "          anchors:",
        '            "1": bad',
        '            "2": poor',
        '            "3": okay',
        '            "4": good',
        '            "5": great',
        "      passing_score: 4",
        "    model: claude-sonnet-4-6",
        "    weight: 2",
      ].join("\n"),
    );
  });

  test("llm_judge: explicit default passing score 3 is omitted", () => {
    const { grader, yamlEntry } = compileGrader(
      run([
        { question: "kind", value: "llm_judge" },
        { question: "criterionName", value: "tone" },
        { question: "criterionDescription", value: "Be polite." },
        { question: "anchors", value: undefined },
        { question: "passingScore", value: 3 },
        { question: "judgeModel", value: "claude-sonnet-4-6" },
        { question: "judgeWeight", value: undefined },
      ]),
    );
    if (grader.name !== "llm_judge") throw new Error("expected an llm_judge grader");
    expect(grader.opts.rubric.passing_score).toBeUndefined();
    expect(yamlEntry).not.toContain("passing_score");
  });

  test("compile throws on incomplete states", () => {
    expect(() => compileGrader(startGraderBuilder())).toThrow("kind not answered");
    expect(() => compileGrader(run([{ question: "kind", value: "contains" }]))).toThrow(
      "substring not answered",
    );
    expect(() => compileGrader(run([{ question: "kind", value: "regex" }]))).toThrow(
      "pattern not answered",
    );
    expect(() => compileGrader(run([{ question: "kind", value: "json_path" }]))).toThrow(
      "path not answered",
    );
    expect(() => compileGrader(run([{ question: "kind", value: "tool_call_sequence" }]))).toThrow(
      "tool names not answered",
    );
    // Hand-built state, as the studio-server sees it over HTTP: kind
    // answered but the rubric only partially collected.
    const partial: GraderBuilderState = {
      step: 2,
      answers: [
        { question: "kind", value: "llm_judge" },
        { question: "criterionName", value: "helpfulness" },
      ],
    };
    expect(() => compileGrader(partial)).toThrow("rubric criterion not answered");
  });

  test("exact_match with only kind answered compiles to all defaults", () => {
    const { grader, yamlEntry } = compileGrader(run([{ question: "kind", value: "exact_match" }]));
    expect(grader).toEqual({ name: "exact_match" });
    expect(yamlEntry).toBe("- name: exact_match");
  });

  test("state survives a JSON round-trip (HTTP transport)", () => {
    const state = run([
      { question: "kind", value: "llm_judge" },
      { question: "criterionName", value: "helpfulness" },
      { question: "criterionDescription", value: "Be polite." },
      { question: "anchors", value: undefined },
      { question: "passingScore", value: undefined },
      { question: "judgeModel", value: "claude-sonnet-4-6" },
      { question: "judgeWeight", value: undefined },
    ]);
    const revived = JSON.parse(JSON.stringify(state)) as GraderBuilderState;
    expect(compileGrader(revived).yamlEntry).toBe(compileGrader(state).yamlEntry);
  });
});

describe("grader-builder (appendGraderToSpecYaml)", () => {
  const entry = "- name: contains\n  opts:\n    substring: hi";

  test("appends into an existing block list, before the next top-level key, preserving comments", () => {
    const spec = [
      "name: my-eval",
      "target: eval",
      "# the corpus",
      "dataset:",
      "  name: support-tickets",
      '  version: "1"',
      "graders:",
      "  - name: exact_match",
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
        "  name: support-tickets",
        '  version: "1"',
        "graders:",
        "  - name: exact_match",
        "  - name: contains",
        "    opts:",
        "      substring: hi",
        "",
        "agent:",
        "  model: claude-sonnet-4-6",
        "",
      ].join("\n"),
    );
  });

  test("replaces an empty graders: [] line", () => {
    const spec = "name: e\ntarget: eval\ngraders: []\nseed: 7\n";
    const next = appendGraderToSpecYaml(spec, entry);
    expect(next).toBe(
      "name: e\ntarget: eval\ngraders:\n  - name: contains\n    opts:\n      substring: hi\nseed: 7\n",
    );
  });

  test("creates the graders block at EOF when the key is missing", () => {
    const spec = "name: e\ntarget: eval\nseed: 7";
    const next = appendGraderToSpecYaml(spec, entry);
    expect(next).toBe(
      "name: e\ntarget: eval\nseed: 7\ngraders:\n  - name: contains\n    opts:\n      substring: hi\n",
    );
  });

  test("appends when graders is the last block in the file", () => {
    const spec = "name: e\ntarget: eval\ngraders:\n  - name: exact_match\n";
    const next = appendGraderToSpecYaml(spec, entry);
    expect(next).toBe(
      "name: e\ntarget: eval\ngraders:\n  - name: exact_match\n  - name: contains\n    opts:\n      substring: hi\n",
    );
  });

  test("rejects inline flow style graders", () => {
    expect(() => appendGraderToSpecYaml("name: e\ngraders: [a]\n", entry)).toThrow("flow style");
    expect(() => appendGraderToSpecYaml("name: e\ngraders: [a]\n", entry)).toThrow(
      GraderBuilderError,
    );
  });
});

describe("grader-builder (round-trip through @crewhaus/spec)", () => {
  test("one grader of each kind appended to an eval spec survives parseSpec", () => {
    const results = [
      run([
        { question: "kind", value: "exact_match" },
        { question: "trim", value: true },
        { question: "caseInsensitive", value: false },
      ]),
      run([
        { question: "kind", value: "contains" },
        { question: "substring", value: "hello" },
        { question: "caseInsensitive", value: true },
      ]),
      run([
        { question: "kind", value: "regex" },
        { question: "pattern", value: "refund(ed|s)?" },
        { question: "flags", value: "i" },
      ]),
      run([
        { question: "kind", value: "json_path" },
        { question: "path", value: "$.status" },
        { question: "expectedJson", value: '{"ok": true}' },
      ]),
      run([
        { question: "kind", value: "tool_call_sequence" },
        { question: "toolCalls", value: ["bash", "read"] },
        { question: "sequenceMode", value: "exact" },
      ]),
      run([
        { question: "kind", value: "llm_judge" },
        { question: "criterionName", value: "tone" },
        { question: "criterionDescription", value: "Scores politeness.\nPenalize rudeness." },
        { question: "anchors", value: ["bad", "poor", "okay", "good", "great"] },
        { question: "passingScore", value: 4 },
        { question: "judgeModel", value: "claude-sonnet-4-6" },
        { question: "judgeWeight", value: 2 },
      ]),
    ].map(compileGrader);

    let yaml = [
      "name: e1",
      "target: eval",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: answer briefly",
      "dataset:",
      "  name: support-tickets",
      '  version: "1"',
      "  split: dev",
      "graders: []",
      "",
    ].join("\n");
    for (const r of results) yaml = appendGraderToSpecYaml(yaml, r.yamlEntry);

    const spec = parseSpec(yaml);
    expect(spec.target).toBe("eval");
    if (spec.target !== "eval") throw new Error("expected an eval spec");
    expect(spec.graders).toEqual(results.map((r) => r.grader));
  });

  test("the standalone yamlBlock of every kind parses inside a valid eval spec", () => {
    const { yamlBlock } = compileGrader(
      run([
        { question: "kind", value: "llm_judge" },
        { question: "criterionName", value: "helpfulness" },
        { question: "criterionDescription", value: "Answers the question directly." },
        { question: "anchors", value: undefined },
        { question: "passingScore", value: undefined },
        { question: "judgeModel", value: "claude-sonnet-4-6" },
        { question: "judgeWeight", value: undefined },
      ]),
    );
    const yaml = [
      "name: e1",
      "target: eval",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: answer briefly",
      "dataset:",
      "  name: support-tickets",
      '  version: "1"',
      yamlBlock,
      "",
    ].join("\n");
    expect(() => parseSpec(yaml)).not.toThrow();
  });
});

describe("GraderBuilderError", () => {
  test("carries the CrewhausError-compatible name and code", () => {
    const err = new GraderBuilderError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GraderBuilderError");
    expect(err.code).toBe("config");
    expect(err.message).toBe("nope");
    expect(err.cause).toBeUndefined();
  });

  test("passes a cause through when given", () => {
    const cause = new Error("inner");
    const err = new GraderBuilderError("outer", cause);
    expect(err.cause).toBe(cause);
  });

  test("builder failures throw GraderBuilderError instances", () => {
    let caught: unknown;
    try {
      answerGrader(startGraderBuilder(), {
        question: "kind",
        value: "vibes",
      } as unknown as GraderAnswer);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraderBuilderError);
    expect((caught as GraderBuilderError).code).toBe("config");
  });
});

// Regressions from the adversarial review: every case here produced
// silently-corrupted or unparseable YAML (or a late error) before the fix.
describe("grader-builder (YAML fidelity regressions)", () => {
  const BASE_SPEC = `name: e1
target: eval
agent:
  model: claude-sonnet-4-6
  instructions: answer briefly
dataset:
  name: d
  version: "1"
graders: []
`;

  function roundTrip(answers: ReadonlyArray<GraderAnswer>): unknown {
    const result = compileGrader(run(answers));
    const spec = parseSpec(appendGraderToSpecYaml(BASE_SPEC, result.yamlEntry)) as {
      graders: ReadonlyArray<unknown>;
    };
    expect(spec.graders[0]).toEqual(result.grader);
    return spec.graders[0];
  }

  test("dot-leading float-like strings stay strings (.5, .inf, .nan)", () => {
    for (const s of [".5", ".inf", ".nan", ".123e4", ".Inf"]) {
      roundTrip([
        { question: "kind", value: "contains" },
        { question: "substring", value: s },
        { question: "caseInsensitive", value: false },
      ]);
    }
  });

  test("trailing-newline strings round-trip exactly (JSON-quoted, not |- chomped)", () => {
    roundTrip([
      { question: "kind", value: "contains" },
      { question: "substring", value: "foo\nbar\n" },
      { question: "caseInsensitive", value: false },
    ]);
  });

  test("CRLF strings round-trip exactly", () => {
    roundTrip([
      { question: "kind", value: "contains" },
      { question: "substring", value: "a\r\nb" },
      { question: "caseInsensitive", value: false },
    ]);
  });

  test("multi-line string with space-led first line round-trips (no invalid block scalar)", () => {
    roundTrip([
      { question: "kind", value: "contains" },
      { question: "substring", value: "  lead\nrest" },
      { question: "caseInsensitive", value: false },
    ]);
    roundTrip([
      { question: "kind", value: "contains" },
      { question: "substring", value: "\nstarts empty" },
      { question: "caseInsensitive", value: false },
    ]);
  });

  test("safe multi-line strings still emit readable |- block scalars", () => {
    const result = compileGrader(
      run([
        { question: "kind", value: "contains" },
        { question: "substring", value: "line one\nline two" },
        { question: "caseInsensitive", value: false },
      ]),
    );
    expect(result.yamlEntry).toContain("substring: |-");
  });

  test("append stops before a YAML document-end marker", () => {
    const spec = `${BASE_SPEC.replace("graders: []", "graders:\n  - name: exact_match")}...\n`;
    const result = compileGrader(
      run([
        { question: "kind", value: "contains" },
        { question: "substring", value: "x" },
        { question: "caseInsensitive", value: false },
      ]),
    );
    const next = appendGraderToSpecYaml(spec, result.yamlEntry);
    expect(next.indexOf("name: contains")).toBeLessThan(next.indexOf("..."));
    const parsed = parseSpec(next) as { graders: ReadonlyArray<{ name: string }> };
    expect(parsed.graders.map((g) => g.name)).toEqual(["exact_match", "contains"]);
  });

  test("expectedJson rejects nested arrays at answer time", () => {
    const state = run([
      { question: "kind", value: "json_path" },
      { question: "path", value: "$.a" },
    ]);
    expect(() =>
      answerGrader(state, { question: "expectedJson", value: "[[1, 2]]" }),
    ).toThrow(/nested arrays/);
    expect(() =>
      answerGrader(state, { question: "expectedJson", value: '{"a": [[1]]}' }),
    ).toThrow(/nested arrays/);
  });

  test("expectedJson rejects numbers that overflow to Infinity", () => {
    const state = run([
      { question: "kind", value: "json_path" },
      { question: "path", value: "$.a" },
    ]);
    expect(() =>
      answerGrader(state, { question: "expectedJson", value: "1e999" }),
    ).toThrow(/finite/);
  });
});
