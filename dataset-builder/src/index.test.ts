import { describe, expect, test } from "bun:test";
import { parseSpec } from "@crewhaus/spec";
import {
  type DatasetAnswer,
  type DatasetBuilderState,
  DatasetBuilderError,
  answerDataset,
  buildEvalSpecStarterYaml,
  compileDataset,
  isDatasetNameSafe,
  isDatasetVersionSafe,
  listDatasetSources,
  nextQuestion,
  parseDatasetJsonl,
  setDatasetInSpecYaml,
  startDatasetBuilder,
} from "./index";

/** Fold a list of answers through the machine from a fresh start. */
function run(answers: ReadonlyArray<DatasetAnswer>): DatasetBuilderState {
  let state = startDatasetBuilder();
  for (const a of answers) state = answerDataset(state, a);
  return state;
}

const MANUAL_ANSWERS: ReadonlyArray<DatasetAnswer> = [
  { question: "source", value: "manual" },
  { question: "datasetName", value: "support-tickets" },
  { question: "version", value: "1" },
  { question: "split", value: undefined },
  {
    question: "cases",
    value: [
      { input: "hello", expected_output: "hi there" },
      { id: "refund-1", input: "I want a refund", expected_output: "refund issued" },
    ],
  },
];

const JSONL_ANSWERS: ReadonlyArray<DatasetAnswer> = [
  { question: "source", value: "paste_jsonl" },
  { question: "datasetName", value: "support-tickets" },
  { question: "version", value: "2025-q2" },
  { question: "split", value: "test" },
  {
    question: "jsonl",
    value:
      '{"input": "hello", "expected_output": "hi"}\n{"id": "c2", "input": "bye", "metadata": {"lang": "en"}}',
  },
];

describe("catalog", () => {
  test("listDatasetSources covers both sources with titles + descriptions", () => {
    const sources = listDatasetSources();
    expect(sources.map((s) => s.source)).toEqual(["manual", "paste_jsonl"]);
    for (const s of sources) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  test("name/version safety predicates match the answer validation", () => {
    expect(isDatasetNameSafe("support-tickets")).toBe(true);
    expect(isDatasetNameSafe("a")).toBe(true);
    expect(isDatasetNameSafe("-leading")).toBe(false);
    expect(isDatasetNameSafe("has space")).toBe(false);
    expect(isDatasetNameSafe("dots.not.ok")).toBe(false);
    expect(isDatasetVersionSafe("1")).toBe(true);
    expect(isDatasetVersionSafe("v1.2-rc.1")).toBe(true);
    expect(isDatasetVersionSafe(".5")).toBe(false);
    expect(isDatasetVersionSafe("1..2")).toBe(true); // mid-segment dots are path-safe
    expect(isDatasetVersionSafe("up/../escape")).toBe(false);
  });
});

describe("question sequence", () => {
  test("starts with the source question and its two choices", () => {
    const q = nextQuestion(startDatasetBuilder());
    expect(q?.id).toBe("source");
    if (q?.id === "source") {
      expect(q.choices.map((c) => c.value)).toEqual(["manual", "paste_jsonl"]);
    }
  });

  test.each([
    ["manual", ["datasetName", "version", "split", "cases"]],
    ["paste_jsonl", ["datasetName", "version", "split", "jsonl"]],
  ] as const)("source=%s walks its branch in order", (source, branch) => {
    let state = run([{ question: "source", value: source }]);
    const seen: string[] = [];
    const branchAnswers: Record<string, DatasetAnswer> = {
      datasetName: { question: "datasetName", value: "d1" },
      version: { question: "version", value: "1" },
      split: { question: "split", value: "dev" },
      cases: { question: "cases", value: [{ input: "x" }] },
      jsonl: { question: "jsonl", value: '{"input": "x"}' },
    };
    for (;;) {
      const q = nextQuestion(state);
      if (q === undefined) break;
      seen.push(q.id);
      state = answerDataset(state, branchAnswers[q.id] as DatasetAnswer);
    }
    expect(seen).toEqual([...branch]);
  });

  test("split question carries the dev default and is optional", () => {
    const state = run([
      { question: "source", value: "manual" },
      { question: "datasetName", value: "d1" },
      { question: "version", value: "1" },
    ]);
    const q = nextQuestion(state);
    expect(q?.id).toBe("split");
    if (q?.id === "split") {
      expect(q.optional).toBe(true);
      expect(q.defaultValue).toBe("dev");
      expect(q.choices.map((c) => c.value)).toEqual(["train", "dev", "test"]);
    }
  });

  test("out-of-order answers are rejected", () => {
    expect(() =>
      run([{ question: "datasetName", value: "d1" } as DatasetAnswer]),
    ).toThrow('expected an answer for "source"');
  });

  test("answering past the end is rejected", () => {
    const state = run(MANUAL_ANSWERS);
    expect(() => answerDataset(state, { question: "split", value: "dev" })).toThrow(
      "all questions are already answered",
    );
  });
});

describe("answer validation", () => {
  const upTo = (n: number): ReadonlyArray<DatasetAnswer> => MANUAL_ANSWERS.slice(0, n);

  test("unknown source lists the valid ones", () => {
    expect(() =>
      run([{ question: "source", value: "csv" } as unknown as DatasetAnswer]),
    ).toThrow("unknown case source");
  });

  test.each(["has space", "-leading", "trailing-", "dots.bad", "UPPER OK NOT"])(
    "dataset name %j is rejected with the path-safety message",
    (bad) => {
      expect(() =>
        run([...upTo(1), { question: "datasetName", value: bad }]),
      ).toThrow("URL path segment");
    },
  );

  test("uppercase names are allowed (mirrors the studio-server charset)", () => {
    expect(() => run([...upTo(1), { question: "datasetName", value: "Tickets-EU" }])).not.toThrow();
  });

  test.each([".5", "-1", "1.", "v 1", "a/b", ""])("version %j is rejected", (bad) => {
    expect(() => run([...upTo(2), { question: "version", value: bad }])).toThrow(
      "path-addressable",
    );
  });

  test("split rejects unknown values, accepts undefined", () => {
    expect(() =>
      run([...upTo(3), { question: "split", value: "prod" } as unknown as DatasetAnswer]),
    ).toThrow('split must be "train", "dev", or "test"');
    expect(() => run([...upTo(3), { question: "split", value: undefined }])).not.toThrow();
  });

  test("type-smuggled answers are rejected", () => {
    expect(() =>
      run([...upTo(1), { question: "datasetName", value: 42 } as unknown as DatasetAnswer]),
    ).toThrow("dataset name must be a string");
    expect(() =>
      run([...upTo(4), { question: "cases", value: "nope" } as unknown as DatasetAnswer]),
    ).toThrow("cases must be an array");
  });

  describe("cases", () => {
    const withCases = (value: unknown): ReadonlyArray<DatasetAnswer> => [
      ...upTo(4),
      { question: "cases", value } as DatasetAnswer,
    ];

    test("empty array is rejected", () => {
      expect(() => run(withCases([]))).toThrow("at least one case");
    });

    test("non-object case is rejected with its position", () => {
      expect(() => run(withCases([{ input: "a" }, "b"]))).toThrow("case 2 must be a JSON object");
    });

    test("unknown keys are rejected", () => {
      expect(() => run(withCases([{ input: "a", expected: "b" }]))).toThrow(
        'case 1: unknown key "expected"',
      );
    });

    test("missing or empty input is rejected", () => {
      expect(() => run(withCases([{ expected_output: "b" }]))).toThrow(
        "case 1: input must be a non-empty string",
      );
      expect(() => run(withCases([{ input: "" }]))).toThrow(
        "case 1: input must be a non-empty string",
      );
    });

    test("bad id charset is rejected", () => {
      expect(() => run(withCases([{ id: "no spaces", input: "a" }]))).toThrow(
        'id "no spaces" may contain only',
      );
      expect(() => run(withCases([{ id: "-lead", input: "a" }]))).toThrow("may contain only");
    });

    test("duplicate ids are rejected, including collisions with auto-ids", () => {
      expect(() =>
        run(withCases([{ id: "dup", input: "a" }, { id: "dup", input: "b" }])),
      ).toThrow('duplicate case id "dup" (case 1 and case 2)');
      // The second case auto-fills to case-002, colliding with the explicit id.
      expect(() =>
        run(withCases([{ id: "case-002", input: "a" }, { input: "b" }])),
      ).toThrow('duplicate case id "case-002"');
    });

    test("non-string expected_output is rejected", () => {
      expect(() => run(withCases([{ input: "a", expected_output: 1 }]))).toThrow(
        "case 1: expected_output must be a string",
      );
    });

    test("metadata must be a JSON object with finite numbers", () => {
      expect(() => run(withCases([{ input: "a", metadata: [1] }]))).toThrow(
        "case 1: metadata must be a JSON object",
      );
      expect(() =>
        run(withCases([{ input: "a", metadata: { score: Number.POSITIVE_INFINITY } }])),
      ).toThrow("finite numbers");
      expect(() =>
        run(withCases([{ input: "a", metadata: { fn: () => 1 } }])),
      ).toThrow("JSON values");
    });

    test("metadata rejects class instances JSON.stringify would silently rewrite", () => {
      // A Map has no own enumerable properties, so a values-only recursion
      // would pass it — and it would serialize as {} (a Date as an ISO
      // string), silently dropping the authored data.
      for (const v of [new Map([["a", 1]]), new Set([1]), new Date(0), /re/]) {
        expect(() => run(withCases([{ input: "a", metadata: { v } }]))).toThrow(
          "plain JSON objects",
        );
      }
      expect(() =>
        run(withCases([{ input: "a", metadata: { nested: { plain: true }, n: null } }])),
      ).not.toThrow();
    });
  });

  describe("jsonl", () => {
    const withJsonl = (value: string): ReadonlyArray<DatasetAnswer> => [
      { question: "source", value: "paste_jsonl" },
      ...upTo(4).slice(1),
      { question: "jsonl", value },
    ];

    test("blank paste is rejected", () => {
      expect(() => run(withJsonl("  \n \n"))).toThrow("paste at least one JSONL line");
    });

    test("invalid JSON names the offending line", () => {
      expect(() => run(withJsonl('{"input": "a"}\n{oops'))).toThrow("line 2 is not valid JSON");
    });

    test("blank lines are skipped, line numbers stay accurate", () => {
      expect(() => run(withJsonl('{"input": "a"}\n\n[1, 2]'))).toThrow(
        "line 3 must be a JSON object",
      );
    });

    test("non-finite numbers smuggled via JSON text are rejected", () => {
      // JSON.parse("1e999") overflows to Infinity; JSON.stringify would
      // silently rewrite it to null on the way back out.
      expect(() => run(withJsonl('{"input": "a", "metadata": {"x": 1e999}}'))).toThrow(
        "finite numbers",
      );
    });
  });
});

describe("parseDatasetJsonl", () => {
  test("auto-fills ids positionally and preserves provided ones", () => {
    const cases = parseDatasetJsonl('{"input": "a"}\n{"id": "kept", "input": "b"}\n{"input": "c"}');
    expect(cases.map((c) => c.id)).toEqual(["case-001", "kept", "case-003"]);
  });

  test("throws DatasetBuilderError (config code) on bad input", () => {
    try {
      parseDatasetJsonl("not json");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DatasetBuilderError);
      expect((err as DatasetBuilderError).code).toBe("config");
    }
  });
});

describe("compile", () => {
  test("manual: coordinate, cases, YAML block, JSONL, and path", () => {
    const result = compileDataset(run(MANUAL_ANSWERS));
    expect(result.dataset).toEqual({ name: "support-tickets", version: "1", split: "dev" });
    expect(result.cases.map((c) => c.id)).toEqual(["case-001", "refund-1"]);
    // Version is number-like, so it must stay quoted; default split is omitted.
    expect(result.yamlBlock).toBe('dataset:\n  name: support-tickets\n  version: "1"');
    expect(result.jsonl).toBe(
      '{"id":"case-001","input":"hello","expected_output":"hi there"}\n' +
        '{"id":"refund-1","input":"I want a refund","expected_output":"refund issued"}\n',
    );
    expect(result.path).toBe("datasets/support-tickets/1/dev.jsonl");
  });

  test("paste_jsonl: non-default split is emitted and lands in the path", () => {
    const result = compileDataset(run(JSONL_ANSWERS));
    // Digit-leading strings always emit quoted (the emitter cannot prove
    // YAML would read them back as strings otherwise).
    expect(result.yamlBlock).toBe(
      'dataset:\n  name: support-tickets\n  version: "2025-q2"\n  split: test',
    );
    expect(result.path).toBe("datasets/support-tickets/2025-q2/test.jsonl");
    expect(result.cases).toEqual([
      { id: "case-001", input: "hello", expected_output: "hi" },
      { id: "c2", input: "bye", metadata: { lang: "en" } },
    ]);
  });

  test("JSONL key order is deterministic: id, input, expected_output, metadata", () => {
    const result = compileDataset(
      run([
        { question: "source", value: "paste_jsonl" },
        { question: "datasetName", value: "d1" },
        { question: "version", value: "1" },
        { question: "split", value: undefined },
        { question: "jsonl", value: '{"metadata": {"k": 1}, "expected_output": "e", "id": "x", "input": "i"}' },
      ]),
    );
    expect(result.jsonl).toBe('{"id":"x","input":"i","expected_output":"e","metadata":{"k":1}}\n');
  });

  test("incomplete states fail with the missing question", () => {
    expect(() => compileDataset(startDatasetBuilder())).toThrow("source not answered yet");
    expect(() => compileDataset(run(MANUAL_ANSWERS.slice(0, 2)))).toThrow(
      "version not answered yet",
    );
    expect(() => compileDataset(run(MANUAL_ANSWERS.slice(0, 4)))).toThrow(
      "cases not answered yet",
    );
  });

  test("state survives a JSON round-trip (HTTP transport) and compiles identically", () => {
    const state = run(MANUAL_ANSWERS);
    const revived = JSON.parse(JSON.stringify(state)) as DatasetBuilderState;
    expect(compileDataset(revived)).toEqual(compileDataset(state));
  });
});

describe("setDatasetInSpecYaml", () => {
  const BLOCK = 'dataset:\n  name: support-tickets\n  version: "2"';

  test("replaces an existing block in place, preserving surrounding comments", () => {
    const spec = [
      "# my eval",
      "name: e1",
      "target: eval",
      "dataset:",
      "  name: old",
      '  version: "1"',
      "  split: test",
      "# graders below",
      "graders:",
      "  - name: exact_match",
      "",
    ].join("\n");
    const next = setDatasetInSpecYaml(spec, BLOCK);
    expect(next).toContain("# my eval");
    expect(next).toContain("# graders below");
    expect(next).toContain("name: support-tickets");
    expect(next).not.toContain("name: old");
    expect(next).not.toContain("split: test");
    expect(next.indexOf("dataset:")).toBeLessThan(next.indexOf("graders:"));
  });

  test("inserts above graders: when the key is missing", () => {
    const spec = "name: e1\ntarget: eval\ngraders:\n  - name: exact_match\n";
    const next = setDatasetInSpecYaml(spec, BLOCK);
    expect(next.indexOf("dataset:")).toBeLessThan(next.indexOf("graders:"));
    expect(next.endsWith("- name: exact_match\n")).toBe(true);
  });

  test("appends at EOF when neither dataset: nor graders: exists", () => {
    const next = setDatasetInSpecYaml("name: e1\ntarget: eval", BLOCK);
    expect(next).toBe(`name: e1\ntarget: eval\n${BLOCK}\n`);
  });

  test("normalizes runaway trailing newlines when appending", () => {
    const next = setDatasetInSpecYaml("name: e1\n\n\n", BLOCK);
    expect(next).toBe(`name: e1\n${BLOCK}\n`);
  });

  test("stops the old block at a document marker", () => {
    const spec = "dataset:\n  name: old\n  version: \"1\"\n---\nname: second-doc\n";
    const next = setDatasetInSpecYaml(spec, BLOCK);
    expect(next).toContain("---\nname: second-doc");
    expect(next).not.toContain("name: old");
  });

  test("keeps blank-line spacing between the new block and the next key", () => {
    const spec = "dataset:\n  name: old\n  version: \"1\"\n\ngraders:\n  - name: exact_match\n";
    const next = setDatasetInSpecYaml(spec, BLOCK);
    expect(next).toContain('version: "2"\n\ngraders:');
  });

  test("rejects inline flow style", () => {
    expect(() =>
      setDatasetInSpecYaml('dataset: {name: old, version: "1"}\n', BLOCK),
    ).toThrow("inline flow style");
  });

  test("a trailing comment on the dataset: line is fine", () => {
    const spec = "dataset: # coordinate\n  name: old\n  version: \"1\"\n";
    expect(setDatasetInSpecYaml(spec, BLOCK)).toContain("name: support-tickets");
  });
});

describe("buildEvalSpecStarterYaml", () => {
  const result = compileDataset(run(MANUAL_ANSWERS));

  test("emits a complete spec with a default exact_match grader", () => {
    const yaml = buildEvalSpecStarterYaml(result, {
      specName: "ticket-eval",
      model: "claude-sonnet-4-6",
      instructions: "Answer the customer briefly.",
    });
    expect(yaml).toBe(
      [
        "name: ticket-eval",
        "target: eval",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: Answer the customer briefly.",
        "dataset:",
        "  name: support-tickets",
        '  version: "1"',
        "graders:",
        "  - name: exact_match",
        "",
      ].join("\n"),
    );
  });

  test("multi-line instructions emit as a block scalar", () => {
    const yaml = buildEvalSpecStarterYaml(result, {
      specName: "ticket-eval",
      model: "claude-sonnet-4-6",
      instructions: "Answer briefly.\nCite a source.",
    });
    expect(yaml).toContain("  instructions: |-\n    Answer briefly.\n    Cite a source.");
  });

  test("rejects bad inputs with field-named messages", () => {
    const opts = { specName: "ok", model: "m", instructions: "i" };
    expect(() =>
      buildEvalSpecStarterYaml(result, { ...opts, specName: "bad/name" }),
    ).toThrow("spec name");
    expect(() => buildEvalSpecStarterYaml(result, { ...opts, model: " " })).toThrow(
      "model must be a non-empty single line",
    );
    expect(() =>
      buildEvalSpecStarterYaml(result, { ...opts, instructions: "" }),
    ).toThrow("instructions must not be empty");
  });

  test("instructions that defeat |- block scalars still round-trip exactly", () => {
    // Mirrors grader-builder's emitter regressions: trailing newline (|-
    // would chomp it), CRLF (YAML normalizes line breaks), and a space-led
    // first line (breaks block-indent auto-detection) must all fall back
    // to JSON quoting and survive parseSpec unchanged.
    for (const instructions of ["ends with newline\n", "crlf\r\nlines", " space-led\nsecond"]) {
      const yaml = buildEvalSpecStarterYaml(result, {
        specName: "e",
        model: "m",
        instructions,
      });
      const parsed = parseSpec(yaml);
      if (parsed.target !== "eval") throw new Error("expected eval target");
      expect(parsed.agent.instructions).toBe(instructions);
    }
  });
});

describe("DatasetBuilderError", () => {
  test("mirrors CrewhausError's shape: name + config code, no cause by default", () => {
    const err = new DatasetBuilderError("bad answer");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DatasetBuilderError");
    expect(err.code).toBe("config");
    expect(err.message).toBe("bad answer");
    expect(err.cause).toBeUndefined();
  });

  test("threads a cause through when given", () => {
    const cause = new Error("root");
    expect(new DatasetBuilderError("wrapped", cause).cause).toBe(cause);
  });

  test("builder failures are instances", () => {
    try {
      answerDataset(startDatasetBuilder(), { question: "source", value: "csv" } as never);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DatasetBuilderError);
    }
  });
});

describe("round-trip through @crewhaus/spec", () => {
  test("setDatasetInSpecYaml output parses; the parsed dataset equals the compiled one", () => {
    const result = compileDataset(run(JSONL_ANSWERS));
    const spec = [
      "name: e1",
      "target: eval",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: answer briefly",
      "dataset:",
      "  name: old",
      '  version: "9"',
      "graders:",
      "  - name: exact_match",
      "",
    ].join("\n");
    const next = setDatasetInSpecYaml(spec, result.yamlBlock);
    const parsed = parseSpec(next);
    if (parsed.target !== "eval") throw new Error("expected eval target");
    expect(parsed.dataset).toEqual(result.dataset);
  });

  test("the default-split block round-trips: the parser fills dev back in", () => {
    const result = compileDataset(run(MANUAL_ANSWERS));
    const yaml = buildEvalSpecStarterYaml(result, {
      specName: "ticket-eval",
      model: "claude-sonnet-4-6",
      instructions: "Answer briefly.",
    });
    const parsed = parseSpec(yaml);
    if (parsed.target !== "eval") throw new Error("expected eval target");
    expect(parsed.dataset).toEqual({ name: "support-tickets", version: "1", split: "dev" });
    expect(parsed.graders).toEqual([{ name: "exact_match" }]);
  });
});

describe("YAML + JSONL fidelity regressions", () => {
  test("number-like and float-like versions stay quoted strings", () => {
    for (const version of ["1", "0.5", "1e3"]) {
      const result = compileDataset(
        run([
          { question: "source", value: "manual" },
          { question: "datasetName", value: "d1" },
          { question: "version", value: version },
          { question: "split", value: undefined },
          { question: "cases", value: [{ input: "x" }] },
        ]),
      );
      expect(result.yamlBlock).toContain(`version: ${JSON.stringify(version)}`);
      const parsed = parseSpec(
        buildEvalSpecStarterYaml(result, {
          specName: "e",
          model: "m",
          instructions: "i",
        }),
      );
      if (parsed.target !== "eval") throw new Error("expected eval target");
      expect(parsed.dataset.version).toBe(version);
    }
  });

  test("case text with newlines, quotes, and unicode survives the JSONL round-trip", () => {
    const input = 'line one\nline two — "quoted" éü';
    const result = compileDataset(
      run([
        { question: "source", value: "manual" },
        { question: "datasetName", value: "d1" },
        { question: "version", value: "1" },
        { question: "split", value: undefined },
        { question: "cases", value: [{ input, expected_output: "ok\r\nwin" }] },
      ]),
    );
    const back = parseDatasetJsonl(result.jsonl);
    expect(back[0]?.input).toBe(input);
    expect(back[0]?.expected_output).toBe("ok\r\nwin");
  });
});
