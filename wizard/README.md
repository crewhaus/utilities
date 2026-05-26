# `@crewhaus/wizard`

Headless 5-question state machine for guided spec creation. Both `crewhaus init --wizard` and the studio-ui "new spec" tab drive the same logic — the wizard returns YAML, never renders UI.

## Install

```bash
bun add @crewhaus/wizard
```

In the `demos/` workspace it resolves as `workspace:*`.

## The 5 questions

1. **target** — one of `cli | channel | graph | managed | pipeline | crew | research | batch | voice | browser`
2. **name** — kebab-case spec name
3. **model** — primary model (suggested: `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-opus-4-7`)
4. **tools** — comma-separated tool list (only applicable for `cli` / `research` / `batch`; other targets use shape-specific defaults)
5. **permissionMode** — `default | plan | auto`

## Quick start

```typescript
import {
  startWizard,
  nextQuestion,
  answerWizard,
  compileWizard,
} from "@crewhaus/wizard";

let state = startWizard();
let q = nextQuestion(state);

// Answer the 5 questions in order.
state = answerWizard(state, { question: "target", value: "cli" });
state = answerWizard(state, { question: "name", value: "my-coder" });
state = answerWizard(state, { question: "model", value: "claude-sonnet-4-6" });
state = answerWizard(state, { question: "tools", value: ["read", "write", "bash"] });
state = answerWizard(state, { question: "permissionMode", value: "default" });

const { yaml, envExample, target, name } = compileWizard(state);
// → yaml: the cli-coding-agent template with name/model/tools/mode patched in
// → envExample: a .env.example body listing every $VAR_NAME found in the yaml
```

`compileWizard` throws `WizardError` if `target` was never answered. Other answers fall back to sensible defaults (`my-<target>`, `claude-sonnet-4-6`, no tools, mode `default`).

## API surface

| Export | Kind | Summary |
|---|---|---|
| `startWizard()` | function | returns the empty `WizardState` |
| `nextQuestion(state)` | function | returns the next `WizardQuestion` or `undefined` when complete |
| `answerWizard(state, answer)` | function | returns a new state with `answer` appended |
| `compileWizard(state)` | function | returns `{ yaml, envExample, target, name }`; throws `WizardError` if target missing |
| `WizardError` | class | thrown when a required answer is missing |
| `WizardState` | type | `{ step, answers[] }` (immutable) |
| `WizardQuestion` | type | discriminated union keyed by `id` |
| `WizardAnswer` | type | discriminated union keyed by `question` |
| `WizardResult` | type | `{ yaml, envExample, target, name }` |
| `TargetShape` | type | the 10 target-shape literals |

## Template mapping

Each target maps to one [scaffold-templates](../scaffold-templates/) entry:

| Target | Template |
|---|---|
| `cli` | `cli-coding-agent` |
| `channel` | `slack-bot` |
| `graph` | `graph-stateful` |
| `managed` | `managed-multitenant` |
| `pipeline` | `rag-bot` |
| `crew` | `crew-research` |
| `research` | `research-agent` |
| `batch` | `batch-worker` |
| `voice` | `voice-realtime` |
| `browser` | `browser-driver` |

## Pairs with

- [scaffold-templates](../scaffold-templates/) — provides the YAML body per target
- [studio-server](../studio-server/) — drives the state machine over HTTP at `POST /api/wizard/{start,step,compile}`

## Related

- Source: [src/index.ts](./src/index.ts)
