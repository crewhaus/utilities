# `@crewhaus/scaffold-templates`

Pure data module — ten built-in `crewhaus.yaml` templates, one per target shape. Returned as YAML strings (not parsed objects) so comments and formatting survive scaffolding.

## Install

```bash
bun add @crewhaus/scaffold-templates
```

## Quick start

```typescript
import { listTemplates, getTemplate, TEMPLATES } from "@crewhaus/scaffold-templates";

// Browse the catalog (id + target + title + description, no yaml body).
const summaries = listTemplates();

// Fetch the full template (with yaml body).
const t = getTemplate("cli-coding-agent");
console.log(t?.yaml); // ready to write to disk as crewhaus.yaml
```

## Templates

| `TemplateId` | Target | One-line |
|---|---|---|
| `cli-coding-agent` | `cli` | REPL coding agent with file + bash + grep tools |
| `slack-bot` | `channel` | long-running daemon that responds to Slack mentions |
| `research-agent` | `research` | decompose a research goal and synthesize a cited report |
| `rag-bot` | `pipeline` | indexes seed documents at boot; answers via `Retrieve` |
| `crew-research` | `crew` | researcher → writer → critic with handoff + A2A |
| `graph-stateful` | `graph` | plan → execute → summarise with optional HITL pause |
| `managed-multitenant` | `managed` | JWT-authenticated gateway with per-tenant budgets |
| `batch-worker` | `batch` | queue worker — pulls jobs and runs the agent per job |
| `voice-realtime` | `voice` | OpenAI Realtime daemon with VAD-backed barge-in |
| `browser-driver` | `browser` | drives chromium with `Screenshot` + `FindElement` + `Click` |

## API surface

| Export | Kind | Summary |
|---|---|---|
| `TEMPLATES` | `ReadonlyArray<Template>` | the full catalog |
| `getTemplate(id)` | function | full template (with yaml) or `undefined` |
| `listTemplates()` | function | summaries only — `{ id, target, title, description }[]` |
| `TemplateId` | type | the ten string literals above |
| `Template` | type | `{ id, target, title, description, yaml }` |

## Pairs with

- [wizard](../wizard/) — maps each `TargetShape` answer to a `TemplateId` and patches the chosen YAML
- [studio-server](../studio-server/) — exposes `GET /api/templates` and `GET /api/templates/:id`

## Related

- Source: [src/index.ts](./src/index.ts)
