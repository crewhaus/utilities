# `@crewhaus/spec-forms`

The shared, framework-agnostic **authoring engine** for CrewHaus specs — pure
logic, no DOM. It turns a spec's YAML into typed form fields, applies edits back
to the YAML document (comment- and order-preserving via the `yaml` CST),
projects a spec into its agent-loop shape, and drives an undo/redo + autosave
edit history.

Both Studios author specs through this one engine so they stay at feature
parity: the **iPad PWA** (the CrewHaus Studio PWA's `/builder` page)
and the **local-machine Studio** ([studio-ui](../studio-ui/)) each render their
own DOM over the same field / loop / state model.

## Layers

| Module | Role |
|---|---|
| `spec-model`    | Parse/serialize a spec into a mutable `yaml` Document + path `get`/`set`/`delete` — the substrate every edit rides on. |
| `spec-schema`   | Load the machine-readable spec schema (remote → cache → bundled snapshot fallback) that drives which fields exist. |
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

## Regenerate the bundled schema

`src/spec-schema-snapshot.json` is a checked-in copy of the compiler's own
`specJsonSchema()` document — the offline fallback the form engine drives from
when neither the live `/schema` endpoint nor a cached copy is reachable. It is
**generated, never hand-edited**. From the repo root:

```bash
bun scripts/regen-spec-schema.ts            # regenerate + report new block keys
bun scripts/regen-spec-schema.ts --check    # is the snapshot stale? (no writes)
```

The script resolves the compiler in this order, first hit wins: `--factory
<dir>`, `$CREWHAUS_FACTORY`, a sibling checkout of
[crewhaus/factory](https://github.com/crewhaus/factory), then the published
`@crewhaus/spec` package. The npm path can only ever produce the RELEASED
grammar, so regenerating for an unreleased line needs a checkout.

Along with the document it writes `src/spec-schema-snapshot.meta.json` — the
`@crewhaus/spec` version it read plus a content digest, which is what
`FALLBACK_SCHEMA_VERSION` is built from, so the provenance badge tracks the
snapshot instead of a pinned string. After a regen:

1. run `bun test src` — the drift tests re-derive the digest, pin the 14 target
   shapes, and fail on any new block key without a one-line description;
2. give each new block a description in `spec-schema.ts`'s overlay, and a
   `FALLBACK_BLOCK_VERSIONS` marker when the deployed compiler predates it;
3. add fields for new keys to `form-model.ts`'s catalog, marked with the
   crewhaus version that introduced them.

## Verify

```bash
bun test src   # form-model · loop-model · builder-state · spec-schema · spec-model
```

## Notes

- **Zero DOM.** Rendering is the consumer's job; this package is data + logic
  only, so it unit-tests fully offline and runs in any JS runtime.
- The bundled `spec-schema-snapshot.json` is the generated schema snapshot used
  as the offline fallback when the live compiler `/schema` endpoint is
  unreachable (see above).
- Sources are kept byte-identical to the Studio PWA's `src/lib/*` so the two Studios
  never drift; the PWA consumes this package once it is published to npm.

> Inside this workspace, resolves as `workspace:*`. Depends only on `yaml`.
