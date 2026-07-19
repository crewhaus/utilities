/**
 * `@crewhaus/spec-forms` — the shared, framework-agnostic authoring engine for
 * CrewHaus specs. Pure logic (no DOM): it turns a spec's YAML into typed form
 * fields, applies edits back to the YAML document (comment/order-preserving via
 * the `yaml` CST), projects a spec into its agent-loop shape (ring or node
 * canvas), and drives an undo/redo + autosave edit history.
 *
 * Both Studios author specs through this one engine so they stay at feature
 * parity: the iPad PWA (crewhaus/studio-pwa `/builder`) and the local-machine
 * Studio (crewhaus/utilities `studio-ui`) each render their own DOM over the
 * same field/loop/state model.
 *
 * Layers:
 *   - spec-model    — parse/serialize a spec into a mutable `yaml` Document +
 *                     path get/set/delete (the substrate every edit rides on).
 *   - spec-schema   — load the machine-readable spec schema (remote → cache →
 *                     bundled 0.4 fallback) that drives which fields exist.
 *   - form-model    — schema-driven typed fields per spec block, edit coercion
 *                     + write-back, and structural add/rename/remove of
 *                     steps/nodes/roles/edges/judge gates.
 *   - loop-model    — project a spec into the observe→…→update ring (single
 *                     agent) or a node canvas (workflow/graph/crew/…).
 *   - builder-state — text-first undo/redo history + coalescing + autosave hook.
 *   - trace-stream  — consume a deployed harness's /chat SSE, surfacing verbatim
 *                     TraceEvent frames (the "watch a run" transport).
 *   - run-model     — fold a live trace stream into RunState the loop overlay
 *                     renders (active ring segment / canvas node, cost, tokens).
 */

export * from "./spec-model";
export * from "./spec-schema";
export * from "./form-model";
export * from "./loop-model";
export * from "./builder-state";
export * from "./trace-stream";
export * from "./run-model";
