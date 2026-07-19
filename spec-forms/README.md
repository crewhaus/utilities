# `@crewhaus/spec-forms`

The shared, framework-agnostic **authoring engine** for CrewHaus specs — pure
logic, no DOM. It turns a spec's YAML into typed form fields, applies edits back
to the YAML document (comment- and order-preserving via the `yaml` CST),
projects a spec into its agent-loop shape, and drives an undo/redo + autosave
edit history.

Both Studios author specs through this one engine so they stay at feature
parity: the **iPad PWA** ([crewhaus/studio-pwa](https://github.com/crewhaus/studio-pwa) `/builder`)
and the **local-machine Studio** ([studio-ui](../studio-ui/)) each render their
own DOM over the same field / loop / state model.

## Layers

| Module | Role |
|---|---|
| `spec-model`    | Parse/serialize a spec into a mutable `yaml` Document + path `get`/`set`/`delete` — the substrate every edit rides on. |
| `spec-schema`   | Load the machine-readable spec schema (remote → cache → bundled 0.4 fallback) that drives which fields exist. |
| `form-model`    | Schema-driven typed fields per spec block (`fieldsForBlock`), edit coercion + write-back (`applyFieldEdit`), and structural add/rename/remove of steps/nodes/roles/edges/judge gates. |
| `loop-model`    | Project a spec into the observe→curate→reason→act→evaluate→update **ring** (single agent) or a **node canvas** (workflow/graph/crew/pipeline/research/batch). |
| `builder-state` | Text-first undo/redo history with coalescing + an autosave hook. YAML text stays the source of truth. |

## Use it

```typescript
import {
  parseSpecModel,
  serializeSpecModel,
  fieldsForBlock,
  applyFieldEdit,
  projectLoop,
  createBuilderState,
  loadSpecSchema,
} from "@crewhaus/spec-forms";

// Turn YAML into a mutable doc, render fields for a block, apply an edit:
const { doc } = parseSpecModel(yaml);
const fields = fieldsForBlock(doc, schema, "agent");
applyFieldEdit(doc, ["agent", "model"], "claude-sonnet-4-6");
const nextYaml = serializeSpecModel(doc); // comments + key order preserved

// Project the spec into its loop for a canvas/ring view:
const loop = projectLoop(parseSpecModel(yaml).model);
```

## Verify

```bash
bun test src   # form-model · loop-model · builder-state · spec-schema · spec-model
```

## Notes

- **Zero DOM.** Rendering is the consumer's job; this package is data + logic
  only, so it unit-tests fully offline and runs in any JS runtime.
- The bundled `spec-schema-snapshot.json` is a frozen 0.4 schema used as the
  offline fallback when the live compiler `/schema` endpoint is unreachable.
- Sources are kept byte-identical to studio-pwa's `src/lib/*` so the two Studios
  never drift; the PWA consumes this package once it is published to npm.

> Inside this workspace, resolves as `workspace:*`. Depends only on `yaml`.
