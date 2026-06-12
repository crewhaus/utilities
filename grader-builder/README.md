# `@crewhaus/grader-builder`

Headless guided builder for eval graders. Both the CLI (`bun run start`) and the studio-ui "Graders" tab drive the same question/answer state machine — the builder returns YAML for an eval spec's `graders:` array, never renders UI.

## Try it

```bash
cd grader-builder
bun run start
# Interactive: prompts for kind / id / kind-specific fields / weight,
# then prints the grader YAML to stdout.

# Or pipe answers in for a non-interactive demo (an llm-judge grader):
printf "llm-judge\nhelpfulness\nBe polite and cite a source.\nclaude-sonnet-4-6\n0.7\n\n" | bun run start
```

## The question flow

Every flow starts with **kind** and **id**, branches on the kind, and ends with an optional **weight**:

| Kind | Branch questions | Emitted fields |
|---|---|---|
| `exact-match` | expected, caseSensitive | `expected`, `caseSensitive` (omitted when `true`) |
| `contains` | isRegex, pattern, caseSensitive | `pattern`, `regex` (omitted when `false`), `caseSensitive` |
| `numeric-tolerance` | expectedNumber, tolerance, toleranceMode | `expected`, `tolerance`, `mode` (omitted when `absolute`) |
| `json-schema` | schemaJson (entered as JSON) | `schema` (serialized to YAML) |
| `llm-judge` | rubric, judgeModel, threshold | `model`, `threshold`, `rubric` (block scalar when multi-line) |
| `custom-script` | scriptPath, timeoutMs | `script`, `timeoutMs` (omitted when unset) |

Example output for each kind:

```yaml
graders:
  - id: exact-answer
    kind: exact-match
    expected: "42"
    caseSensitive: false      # default true (omitted)
  - id: mentions-refund
    kind: contains
    pattern: "refund(ed|s)?"
    regex: true               # default false = literal substring (omitted)
  - id: price-close
    kind: numeric-tolerance
    expected: 19.99
    tolerance: 0.05
    mode: relative            # default absolute (omitted)
  - id: valid-payload
    kind: json-schema
    schema:
      type: object
      required:
        - status
  - id: helpfulness
    kind: llm-judge
    model: claude-sonnet-4-6
    threshold: 0.7
    rubric: |
      Score 1 if the answer is polite and cites a source.
    weight: 2
  - id: domain-checks
    kind: custom-script
    script: ./graders/domain-checks.ts   # JSON sample on stdin → {"passed": bool, "score": number} on stdout
    timeoutMs: 30000
```

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

state = answerGrader(state, { question: "kind", value: "llm-judge" });
state = answerGrader(state, { question: "id", value: "helpfulness" });
state = answerGrader(state, { question: "rubric", value: "Be polite and cite a source." });
state = answerGrader(state, { question: "judgeModel", value: "claude-sonnet-4-6" });
state = answerGrader(state, { question: "threshold", value: 0.7 });
state = answerGrader(state, { question: "weight", value: undefined });

const { grader, yamlEntry, yamlBlock } = compileGrader(state);
// → yamlEntry: one "- id: …" list item to append under graders:
// → yamlBlock: "graders:\n  - id: …" for copy/paste

// Comment-preserving write-back into an existing eval spec:
const nextSpecYaml = appendGraderToSpecYaml(specYaml, yamlEntry);
```

Unlike `@crewhaus/wizard`, `answerGrader` **validates** every answer (kebab-case ids, regex compiles, threshold 0..1, schema parses as a JSON object, …) and throws `GraderBuilderError` with a message safe to show verbatim — the studio-server maps those to HTTP 400s, which powers the inline field errors in the Graders tab.

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
| `GraderConfig` | type | structured grader entry, discriminated union keyed by `kind` |
| `GraderResult` | type | `{ grader, yamlEntry, yamlBlock }` |
| `GraderKind` | type | the 6 grader-kind literals |

## Pairs with

- [studio-server](../studio-server/) — drives the state machine over HTTP at `POST /api/grader-wizard/{start,step,compile}` and appends via `POST /api/specs/:name/graders`
- [studio-ui](../studio-ui/) — the "Graders" tab form UI
- [wizard](../wizard/) — the same state-machine pattern for whole-spec creation

## Related

- Source: [src/index.ts](./src/index.ts), [src/scripts/start.ts](./src/scripts/start.ts)

> Inside this workspace, resolves as `workspace:*`. Not yet on npm.
