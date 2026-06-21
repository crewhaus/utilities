# `@crewhaus/dataset-builder`

Headless guided builder for eval datasets. Both the CLI (`bun run start`) and the studio-ui "Datasets" tab drive the same question/answer state machine — the builder returns YAML + JSONL for an `eval` spec, never renders UI.

`@crewhaus/spec`'s eval target carries only a dataset *reference* (`dataset: { name, version, split }`, resolved at run time via the §29 dataset-registry) — cases never live inline in the spec. The builder therefore compiles two artifacts that belong together:

- **`yamlBlock`** — the strict `dataset:` coordinate block for the spec
- **`jsonl`** — the cases themselves, one JSON object per line, stored as `datasets/<name>/<version>/<split>.jsonl` in the studio workspace (the layout `studio-server` serves back over `/api/datasets`)

## Try it

```bash
cd dataset-builder
bun run start
# Interactive: prompts for the case source, the dataset coordinate
# (name / version / split), then the cases, and prints the dataset
# YAML block + JSONL to stdout.

# Or pipe answers in for a non-interactive demo (two manual cases;
# the blank line ends case entry):
printf 'manual\nsupport-tickets\n1\n\nhello => hi there\nI want a refund => refund issued\n\n' | bun run start
```

## The question flow

Every flow starts with **source** and branches on it:

| Source | Branch questions | Cases come from |
|---|---|---|
| `manual` | datasetName, version, split, cases | structured case objects (the Studio's row editor; `input => expected_output` lines in the CLI) |
| `paste_jsonl` | datasetName, version, split, jsonl | pasted JSON Lines, validated line by line with line numbers in every error |

`split` is optional and defaults to `dev`; the default is omitted from the YAML (the spec parser fills it back in). Dataset names (`letters/digits/hyphens`) and versions (`letters/digits/._-`) are constrained to path-safe charsets — stricter than `@crewhaus/spec`'s `safeName` — so every coordinate stays addressable as a URL path segment and a directory name. Example output:

```yaml
dataset:
  name: support-tickets
  version: "1"          # number-like versions stay quoted strings
```

```jsonl
{"id":"case-001","input":"hello","expected_output":"hi there"}
{"id":"case-002","input":"I want a refund","expected_output":"refund issued"}
```

Explicit ids (e.g. `refund-1`) come from the `paste_jsonl` branch or programmatic use — the CLI's `input => expected_output` shorthand always auto-fills.

## The case shape

One case per JSONL line — the utilities-side authoring schema (the factory-side §29 dataset-registry consumes this layout):

| Key | Required | Meaning |
|---|---|---|
| `id` | no (auto-filled `case-001`, …) | unique within the file; letters/digits/`._-` |
| `input` | **yes** | what the eval agent is prompted with |
| `expected_output` | no | what reference graders (`exact_match`, `contains`, …) compare against — `llm_judge`/`regex` graders need none |
| `metadata` | no | free-form JSON object (finite numbers only — `1e999` would silently become `null` on re-emission) |

Unknown keys are rejected. Validation runs at answer time so errors land on the offending field (and line), which is what powers inline errors in the Datasets tab.

## Programmatic use

```typescript
import {
  startDatasetBuilder,
  nextQuestion,
  answerDataset,
  compileDataset,
  setDatasetInSpecYaml,
  buildEvalSpecStarterYaml,
} from "@crewhaus/dataset-builder";

let state = startDatasetBuilder();
state = answerDataset(state, { question: "source", value: "manual" });
state = answerDataset(state, { question: "datasetName", value: "support-tickets" });
state = answerDataset(state, { question: "version", value: "1" });
state = answerDataset(state, { question: "split", value: undefined }); // dev
state = answerDataset(state, {
  question: "cases",
  value: [{ input: "hello", expected_output: "hi there" }],
});

const result = compileDataset(state);
result.yamlBlock; // dataset:\n  name: support-tickets\n  version: "1"
result.jsonl;     // {"id":"case-001","input":"hello","expected_output":"hi there"}\n
result.path;      // datasets/support-tickets/1/dev.jsonl

// Point an existing eval spec at the new coordinate (comment-preserving
// pure-text splice; replaces the old dataset: block in place):
const nextYaml = setDatasetInSpecYaml(specYaml, result.yamlBlock);

// …or wrap the dataset in a brand-new minimal eval spec (a single
// default exact_match grader — refine in the Graders tab):
const starter = buildEvalSpecStarterYaml(result, {
  specName: "ticket-eval",
  model: "claude-sonnet-4-6",
  instructions: "Answer the customer briefly.",
});
```

`answerDataset` validates every answer and throws `DatasetBuilderError` with a human-readable message; the studio-server surfaces those as HTTP 400s. States are plain JSON (they ride over HTTP), and the server replays them through the machine rather than trusting them.

## API surface

| Export | What it does |
|---|---|
| `startDatasetBuilder()` | fresh `{ step: 0, answers: [] }` state |
| `nextQuestion(state)` | the next `DatasetQuestion` (with prompts/choices/hints), or `undefined` when complete |
| `answerDataset(state, answer)` | validate + append one answer; throws `DatasetBuilderError` on invalid input |
| `compileDataset(state)` | `{ dataset, cases, yamlBlock, jsonl, path }` |
| `parseDatasetJsonl(jsonl)` | parse + validate a JSONL document into cases (missing ids auto-filled); the studio-server re-validates stored files with this on read |
| `setDatasetInSpecYaml(specYaml, yamlBlock)` | replace/insert the spec's `dataset:` block, preserving comments + key order |
| `buildEvalSpecStarterYaml(result, opts)` | wrap a compiled dataset in a minimal, strictly-valid eval spec |
| `listDatasetSources()` | the source catalog driving the Studio cards + CLI menu |
| `isDatasetNameSafe(s)` / `isDatasetVersionSafe(s)` | the path-safety predicates the server reuses for route params |
| `DatasetBuilderError` | thrown on any invalid answer/state — carries `code: "config"` |
| `DatasetBuilderState`, `DatasetQuestion`, `DatasetAnswer` | types — the state machine's surface (state is plain JSON; it rides over HTTP) |
| `DatasetConfig`, `DatasetCase`, `DatasetCaseInput`, `DatasetResult` | types — the coordinate, one case (authored vs compiled), and the compile output |
| `DatasetSource`, `DatasetSplit`, `EvalSpecStarterOptions` | types — the two source literals, the three split literals, and the starter-spec options |

## Pairs with

- [studio-server](../studio-server/) — exposes this machine over HTTP (`POST /api/dataset-wizard/{start,step,compile}`), stores the JSONL under `<workspace>/datasets/`, and wires `POST /api/specs/:name/dataset` for write-back / spec creation
- [studio-ui](../studio-ui/) — the "Datasets" tab drives those endpoints with a live YAML + JSONL preview
- [grader-builder](../grader-builder/) — the same builder pattern for the `graders:` array; together they author a complete eval spec
- [wizard](../wizard/) — the spec-level 5-question wizard for the runtime targets

## Related

- [crewhaus/factory](https://github.com/crewhaus/factory) — the compiler whose §29 dataset-registry resolves the emitted coordinates at run time

> Inside this workspace, resolves as `workspace:*`. Published to npm as `@crewhaus/dataset-builder@0.1.5`.
