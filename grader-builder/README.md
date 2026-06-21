# `@crewhaus/grader-builder`

Headless guided builder for eval graders. Both the CLI (`bun run start`) and the studio-ui "Graders" tab drive the same question/answer state machine — the builder returns YAML for an eval spec's `graders:` array, never renders UI.

Compiled entries are the strict `{ name, opts? }` items `@crewhaus/spec`'s eval target requires; `name` doubles as the grader type the compiled eval bundle hands to `@crewhaus/eval-grader`'s `parseGradersConfig`.

## Try it

```bash
cd grader-builder
bun run start
# Interactive: prompts for the grader kind, then the kind-specific
# fields, and prints the grader YAML to stdout.

# Or pipe answers in for a non-interactive demo (an llm_judge grader):
printf "llm_judge\nhelpfulness\nPolite and cites a source.\n\n\nclaude-sonnet-4-6\n\n" | bun run start
```

## The question flow

Every flow starts with **kind** and branches on it:

| Kind | Branch questions | Emitted `opts` |
|---|---|---|
| `exact_match` | trim, caseInsensitive | `trim` (omitted when `true`), `case_insensitive` (omitted when `false`); compares against the sample's `expected_output` |
| `contains` | substring, caseInsensitive | `substring`, `case_insensitive` (omitted when `false`) |
| `regex` | pattern, flags | `pattern` (JS RegExp), `flags` (omitted when empty) |
| `json_path` | path, expectedJson | `path` ($-rooted JSONPath), `expected` (parsed from the JSON you enter; omitted = any non-empty match passes) |
| `tool_call_sequence` | toolCalls, sequenceMode | `expected` (tool names), `mode` — `exact` \| `subseq` \| `set` (omitted when `subseq`) |
| `llm_judge` | criterionName, criterionDescription, anchors, passingScore, judgeModel, judgeWeight | `rubric` (`criteria` with 1–5 `anchors`, plus `passing_score` omitted when `3`), `model`, `weight` (omitted when unset) |

Default-valued opts are omitted from the YAML — an all-default `exact_match` emits no `opts` key at all. Example output for each kind:

```yaml
graders:
  - name: exact_match           # all-default opts → no opts key at all
  - name: contains
    opts:
      substring: refund
  - name: regex
    opts:
      pattern: "refund(ed|s)?"
      flags: i
  - name: json_path
    opts:
      path: $.status
      expected: resolved
  - name: tool_call_sequence
    opts:
      expected:
        - bash
        - read
      mode: exact               # default subseq (omitted)
  - name: llm_judge
    opts:
      rubric:
        criteria:
          - name: helpfulness
            description: Polite and cites a source when one exists.
            anchors:
              "1": Unhelpful or wrong.
              "2": Mostly misses the question.
              "3": Answers but cites nothing.
              "4": Helpful with a source.
              "5": Helpful and well-sourced.
        passing_score: 4        # default 3 (omitted)
      model: claude-sonnet-4-6
      weight: 2
```

The judge model scores the output 1–5 against the rubric; skip the anchors question and generic worst-to-best anchors are filled in.

## Programmatic use

```typescript
import {
  startGraderBuilder,
  nextQuestion,
  answerGrader,
  compileGrader,
  appendGraderToSpecYaml,
} from "@crewhaus/grader-builder";

let state = startGraderBuilder();

state = answerGrader(state, { question: "kind", value: "llm_judge" });
state = answerGrader(state, { question: "criterionName", value: "helpfulness" });
state = answerGrader(state, { question: "criterionDescription", value: "Polite and cites a source." });
state = answerGrader(state, { question: "anchors", value: undefined });       // generic 1–5 anchors
state = answerGrader(state, { question: "passingScore", value: undefined }); // default 3 (omitted)
state = answerGrader(state, { question: "judgeModel", value: "claude-sonnet-4-6" });
state = answerGrader(state, { question: "judgeWeight", value: 2 });

const { grader, yamlEntry, yamlBlock } = compileGrader(state);
// → grader:    { name: "llm_judge", opts: { rubric: {…}, model: "claude-sonnet-4-6", weight: 2 } }
// → yamlEntry: one "- name: …" list item to append under graders:
// → yamlBlock: "graders:\n  - name: …" for copy/paste

// Comment-preserving write-back into an existing eval spec:
const nextSpecYaml = appendGraderToSpecYaml(specYaml, yamlEntry);
```

Unlike `@crewhaus/wizard`, `answerGrader` **validates** every answer (the regex compiles, the JSONPath starts with `$`, expected values parse as JSON, exactly five anchors, passing score 1–5, weight > 0, …) and throws `GraderBuilderError` with a message safe to show verbatim — the studio-server maps those to HTTP 400s, which powers the inline field errors in the Graders tab.

## API surface

| Export | Kind | Summary |
|---|---|---|
| `startGraderBuilder()` | function | returns the empty `GraderBuilderState` |
| `nextQuestion(state)` | function | returns the next `GraderQuestion` or `undefined` when complete |
| `answerGrader(state, answer)` | function | validates + appends; throws `GraderBuilderError` on bad/out-of-order answers |
| `compileGrader(state)` | function | returns `{ grader, yamlEntry, yamlBlock }`; throws if required answers are missing |
| `listGraderKinds()` | function | catalog of the 6 kinds with titles + descriptions (drives UI cards / CLI menu) |
| `appendGraderToSpecYaml(specYaml, yamlEntry)` | function | pure text insertion into the spec's `graders:` block (preserves comments + key order) |
| `GraderBuilderError` | class | thrown on invalid answers / incomplete compile / flow-style `graders:` |
| `GraderBuilderState` | type | `{ step, answers[] }` (immutable, JSON-serializable) |
| `GraderQuestion` | type | discriminated union keyed by `id` |
| `GraderAnswer` | type | discriminated union keyed by `question` |
| `GraderConfig` | type | structured `{ name, opts? }` entry, discriminated union keyed by `name` |
| `GraderResult` | type | `{ grader, yamlEntry, yamlBlock }` |
| `GraderKind` | type | the 6 grader-type literals |
| `SequenceMode`, `RubricConfig`, `RubricAnchors` | types | `tool_call_sequence` mode + `llm_judge` rubric shapes |

The package has no runtime dependencies — the round-trip against the real parser (every compiled entry passes `parseSpec` inside a valid eval spec) lives in the tests via a `@crewhaus/spec` devDependency.

## Pairs with

- [studio-server](../studio-server/) — drives the state machine over HTTP at `POST /api/grader-wizard/{start,step,compile}` and appends via `POST /api/specs/:name/graders`
- [studio-ui](../studio-ui/) — the "Graders" tab form UI
- [dataset-builder](../dataset-builder/) — the same builder pattern for the eval spec's `dataset:`; together they author a complete eval spec
- [wizard](../wizard/) — the same state-machine pattern for whole-spec creation

## Related

- Source: [src/index.ts](./src/index.ts), [src/scripts/start.ts](./src/scripts/start.ts)

> Inside this workspace, resolves as `workspace:*`. Published to npm as `@crewhaus/grader-builder@0.1.5`.
