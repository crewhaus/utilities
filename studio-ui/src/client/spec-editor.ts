/**
 * Structured spec editor for the local Studio — the browser half of the
 * "schema-driven form editing + loop projection" parity items.
 *
 * Renders schema-driven form fields (and the agent-loop projection) over a
 * spec's YAML, editing it comment/order-preserving. All the logic — field
 * derivation, edit coercion + write-back, loop projection, undo/redo history —
 * comes from the shared `@crewhaus/spec-forms` package that the iPad PWA's
 * `/builder` also drives, so the two Studios stay at parity.
 *
 * This module is BUNDLED for the browser (bun build, see build-editor.ts) and
 * served at /spec-editor.js; the string-based studio-ui SPA (getStudioJs) loads
 * it and calls `window.CrewhausSpecEditor.mountSpecEditor` when a spec opens.
 * It builds DOM with createElement/textContent only (no innerHTML).
 */
import {
  addEdge,
  addNode,
  addRole,
  addStep,
  applyFieldEdit,
  blocksForTarget,
  createBuilderState,
  deletePath,
  detectTargetFromModel,
  FALLBACK_SCHEMA,
  fieldsForBlock,
  createRunReducer,
  type FormField,
  type LoopCanvas,
  type LoopProjection,
  type LoopSegment,
  type NamedEntityKind,
  parseSpecModel,
  projectLoop,
  removeNamed,
  renameNamed,
  type RunState,
  serializeSpecModel,
  setPath,
  type TraceStreamEvent,
} from "@crewhaus/spec-forms";

type Doc = ReturnType<typeof parseSpecModel>["doc"];
type EditCtx = { doc: NonNullable<Doc>; commit: (yaml: string) => void };

/** Which named-entity kind a canvas target authors (for the Add button). */
function primaryKind(target: string, canvas: LoopCanvas): NamedEntityKind {
  for (const n of canvas.nodes) {
    if (n.kind === "step" || n.kind === "node" || n.kind === "role") return n.kind;
  }
  if (target === "graph") return "node";
  if (target === "crew") return "role";
  return "step"; // workflow / pipeline / research / batch
}

function addEntity(ctx: EditCtx, kind: NamedEntityKind) {
  const r = kind === "node" ? addNode(ctx.doc) : kind === "role" ? addRole(ctx.doc) : addStep(ctx.doc);
  if (r.ok) ctx.commit(serializeSpecModel(ctx.doc));
  else alert(r.error);
}

export type MountOptions = {
  /** Initial spec YAML. */
  readonly yaml: string;
  /** Called (debounced) whenever an edit changes the YAML. */
  readonly onChange?: (yaml: string) => void;
};

export type SpecEditorHandle = {
  /** Current YAML (source of truth). */
  getYaml(): string;
  /** Replace the YAML (e.g. after an external save/reload) and re-render. */
  setYaml(yaml: string): void;
  /** Tear down listeners. */
  destroy(): void;
};

// Blocks whose entries are structural (steps/nodes/roles/edges/hooks) — edited
// on the loop canvas, not as a single form. Shown here as a summary + count.
const STRUCTURAL_BLOCKS = new Set(["steps", "nodes", "roles", "edges", "hooks"]);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const kid of kids) node.append(kid);
  return node;
}

function controlFor(field: FormField, value: unknown, onEdit: (raw: string | boolean) => void): HTMLElement {
  const wrap = el("div", { class: "sf-field" });
  const id = "sf-" + field.path.join("-");
  if (field.kind === "boolean") {
    const label = el("label", { class: "sf-check", for: id });
    const input = el("input", { type: "checkbox", id });
    if (value === true) input.checked = true;
    input.addEventListener("change", () => onEdit(input.checked));
    label.append(input, document.createTextNode(field.label));
    wrap.append(label);
  } else {
    wrap.append(el("label", { for: id }, field.label + (field.required ? " *" : "")));
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (field.kind === "enum") {
      const sel = el("select", { id });
      if (!field.required) sel.append(el("option", { value: "" }, "—"));
      for (const v of field.enumValues ?? []) sel.append(el("option", { value: v }, v));
      if (typeof value === "string") sel.value = value;
      sel.addEventListener("change", () => onEdit(sel.value));
      input = sel;
    } else if (field.kind === "string-list" || field.kind === "record" || field.kind === "yaml") {
      const ta = el("textarea", { id, rows: field.kind === "string-list" ? "3" : "5" });
      ta.value = stringifyValue(field.kind, value);
      ta.addEventListener("change", () => onEdit(ta.value));
      input = ta;
    } else {
      const i = el("input", {
        id,
        type: field.kind === "number" ? "number" : "text",
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      });
      if (value !== undefined && value !== null) i.value = String(value);
      i.addEventListener("change", () => onEdit(i.value));
      input = i;
    }
    wrap.append(input);
  }
  if (field.description) wrap.append(el("div", { class: "sf-hint" }, field.description));
  if (field.requiresVersion) {
    wrap.append(el("div", { class: "sf-badge" }, "needs crewhaus " + field.requiresVersion));
  }
  const err = el("div", { class: "sf-error" });
  wrap.append(err);
  return wrap;
}

function stringifyValue(kind: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (kind === "string-list" && Array.isArray(value)) return value.join("\n");
  if (kind === "record" && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join("\n");
  }
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function segStrip(segs: readonly LoopSegment[]): HTMLElement {
  const strip = el("div", { class: "sf-loop-strip" });
  for (const s of segs) {
    strip.append(el("span", { class: "sf-seg" + (s.active ? " on" : ""), title: s.summary }, s.id));
  }
  return strip;
}

function renderLoop(loop: LoopProjection, ctx?: EditCtx): HTMLElement {
  const box = el("div", { class: "sf-loop" });
  box.append(el("div", { class: "sf-loop-head" }, `Loop — ${loop.target} (${loop.kind})`));

  if (loop.kind === "ring" && loop.ring) {
    box.append(segStrip(loop.ring.segments));
  } else if (loop.kind === "canvas" && loop.canvas) {
    const canvas = loop.canvas;
    // Add-entity control (structural: addStep/addNode/addRole).
    if (ctx) {
      const kind = primaryKind(loop.target, canvas);
      const add = el("button", { class: "sf-btn add", type: "button" }, `+ add ${kind}`);
      add.addEventListener("click", () => addEntity(ctx, kind));
      box.append(el("div", { class: "sf-canvas-actions" }, add));
    }
    // Nodes — each with rename/remove when editable.
    for (const n of canvas.nodes) {
      const row = el("div", { class: "sf-node" });
      const head = el("div", { class: "sf-node-head" });
      head.append(el("strong", {}, n.label), el("span", { class: "sf-node-kind" }, ` [${n.kind}]`));
      if (n.hitl) head.append(el("span", { class: "sf-hitl" }, " ⛚ HITL"));
      const editable = ctx && (n.kind === "step" || n.kind === "node" || n.kind === "role");
      if (editable && ctx) {
        const nk = n.kind as NamedEntityKind;
        const ren = el("button", { class: "sf-icon", type: "button", title: "Rename" }, "✎");
        ren.addEventListener("click", () => {
          const next = prompt(`Rename ${nk} "${n.id}" to:`, n.id);
          if (next && next !== n.id) {
            const r = renameNamed(ctx.doc, nk, n.id, next);
            if (r.ok) ctx.commit(serializeSpecModel(ctx.doc));
            else alert(r.error);
          }
        });
        const rm = el("button", { class: "sf-icon danger", type: "button", title: "Remove" }, "×");
        rm.addEventListener("click", () => {
          if (!confirm(`Remove ${nk} "${n.id}"?`)) return;
          const r = removeNamed(ctx.doc, nk, n.id);
          if (r.ok) ctx.commit(serializeSpecModel(ctx.doc));
          else alert(r.error);
        });
        head.append(ren, rm);
      }
      row.append(head, segStrip(n.mini));
      box.append(row);
    }
    // Edges — list + add + remove when editable.
    box.append(renderEdges(canvas, ctx));
  }
  for (const w of loop.warnings) box.append(el("div", { class: "sf-warn" }, "⚠ " + w));
  return box;
}

function renderEdges(canvas: LoopCanvas, ctx?: EditCtx): HTMLElement {
  const wrap = el("div", { class: "sf-edges-box" });
  wrap.append(el("div", { class: "sf-edges-head" }, "Edges"));
  canvas.edges.forEach((e, i) => {
    const row = el(
      "div",
      { class: "sf-edge" },
      `${e.from} → ${e.to}${e.conditional ? " (conditional)" : ""}`,
    );
    if (ctx) {
      const rm = el("button", { class: "sf-icon danger", type: "button", title: "Remove edge" }, "×");
      rm.addEventListener("click", () => {
        deletePath(ctx.doc, ["edges", i]);
        ctx.commit(serializeSpecModel(ctx.doc));
      });
      row.append(rm);
    }
    wrap.append(row);
  });
  if (canvas.edges.length === 0) wrap.append(el("div", { class: "sf-hint" }, "no edges"));
  if (ctx && canvas.nodes.length >= 2) {
    const ids = canvas.nodes.map((n) => n.id);
    const from = el("select", { class: "sf-edge-sel" });
    const to = el("select", { class: "sf-edge-sel" });
    for (const id of ids) {
      from.append(el("option", { value: id }, id));
      to.append(el("option", { value: id }, id));
    }
    if (ids[1]) to.value = ids[1];
    const add = el("button", { class: "sf-btn add", type: "button" }, "+ edge");
    add.addEventListener("click", () => {
      const r = addEdge(ctx.doc, from.value, to.value);
      if (r.ok) ctx.commit(serializeSpecModel(ctx.doc));
      else alert(r.error);
    });
    wrap.append(el("div", { class: "sf-edge-add" }, from, el("span", {}, "→"), to, add));
  }
  return wrap;
}

export function mountSpecEditor(container: HTMLElement, opts: MountOptions): SpecEditorHandle {
  const schema = FALLBACK_SCHEMA;
  let onChangeTimer: ReturnType<typeof setTimeout> | undefined;

  const state = createBuilderState({
    initialText: opts.yaml,
    parse: (t) => parseSpecModel(t).model,
  });

  function emit(yaml: string) {
    if (!opts.onChange) return;
    clearTimeout(onChangeTimer);
    onChangeTimer = setTimeout(() => opts.onChange?.(yaml), 250);
  }

  function commit(yaml: string) {
    // Each structured edit is its own undo step (beginEdit opens a coalescing
    // transaction; one commitEdit per edit keeps them individually undoable).
    state.beginEdit();
    state.commitEdit(yaml);
    emit(yaml);
    render();
  }

  function render() {
    container.replaceChildren();
    const yaml = state.get().text;
    const parsed = parseSpecModel(yaml);
    if (parsed.doc === null) {
      container.append(el("div", { class: "sf-error" }, "YAML parse error — fix it in the raw editor"));
      return;
    }
    const doc = parsed.doc;
    const model = parsed.model;
    const target = detectTargetFromModel(model);

    // toolbar: undo/redo
    const bar = el("div", { class: "sf-toolbar" });
    const undo = el("button", { class: "sf-btn", type: "button", title: "Undo" }, "↩");
    const redo = el("button", { class: "sf-btn", type: "button", title: "Redo" }, "↪");
    undo.disabled = !state.get().canUndo;
    redo.disabled = !state.get().canRedo;
    undo.addEventListener("click", () => {
      if (state.undo()) {
        emit(state.get().text);
        render();
      }
    });
    redo.addEventListener("click", () => {
      if (state.redo()) {
        emit(state.get().text);
        render();
      }
    });
    bar.append(undo, redo);
    container.append(bar);

    // loop projection (interactive canvas: structural add/rename/remove)
    container.append(renderLoop(projectLoop(model), { doc, commit }));

    const modelRec = (model && typeof model === "object" ? (model as Record<string, unknown>) : {});

    // core fields (name/target/model/…)
    const coreFields = fieldsForBlock(schema, target, []);
    if (coreFields.length > 0) {
      container.append(el("h4", { class: "sf-block-title" }, "Core"));
      for (const f of coreFields) {
        container.append(controlFor(f, getAt(modelRec, f.path), (raw) => editField(doc, f, raw)));
      }
    }

    // per-block fields
    for (const block of blocksForTarget(schema, target)) {
      const record = modelRec[block.key];
      const present = record !== undefined;
      const title = el("h4", { class: "sf-block-title" }, block.key);
      if (block.requiresVersion) title.append(el("span", { class: "sf-badge" }, " " + block.requiresVersion));
      if (!present) {
        const add = el("button", { class: "sf-btn add", type: "button" }, "+ add " + block.key);
        add.addEventListener("click", () => {
          setPath(doc, [block.key], STRUCTURAL_BLOCKS.has(block.key) ? [] : {});
          commit(serializeSpecModel(doc));
        });
        container.append(el("div", { class: "sf-block sf-block-absent" }, title, add));
        continue;
      }
      if (STRUCTURAL_BLOCKS.has(block.key) && Array.isArray(record)) {
        container.append(
          el(
            "div",
            { class: "sf-block" },
            title,
            el("div", { class: "sf-hint" }, `${record.length} ${block.key} — edit structure in the loop view`),
          ),
        );
        continue;
      }
      const fields = fieldsForBlock(schema, target, [block.key], record);
      const blockEl = el("div", { class: "sf-block" }, title);
      for (const f of fields) {
        blockEl.append(controlFor(f, getAt(modelRec, f.path), (raw) => editField(doc, f, raw)));
      }
      container.append(blockEl);
    }
  }

  function editField(doc: Parameters<typeof applyFieldEdit>[0], field: FormField, raw: string | boolean) {
    const res = applyFieldEdit(doc, field, raw);
    if (!res.ok) {
      // Surface the error on the field without a full re-render.
      const wrap = container.querySelector(`.sf-field label[for="sf-${cssEscape(field.path.join("-"))}"]`)?.closest(".sf-field");
      const err = wrap?.querySelector(".sf-error");
      if (err) err.textContent = res.error;
      return;
    }
    commit(serializeSpecModel(doc));
  }

  render();

  return {
    getYaml: () => state.get().text,
    setYaml: (yaml: string) => {
      state.load(yaml);
      render();
    },
    destroy: () => {
      clearTimeout(onChangeTimer);
      container.replaceChildren();
    },
  };
}

/** Read a value at an absolute path out of the plain model (best-effort). */
function getAt(model: Record<string, unknown>, path: readonly (string | number)[]): unknown {
  let cur: unknown = model;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg as never];
  }
  return cur;
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// ===========================================================================
// RUN & WATCH — POST /api/runs → SSE → run-model reducer → live loop overlay
// ===========================================================================
// The studio-server emits flat {kind:"trace", subkind:…} envelopes; adapt them
// to run-model's nested TraceStreamEvent shape so the shared reducer folds them.
function adaptRunEvent(raw: Record<string, unknown>): TraceStreamEvent | null {
  const kind = raw["kind"];
  if (kind === "run_start") return null; // reducer starts from initial
  if (kind === "run_done" || kind === "run_finished") {
    return { kind: "done", stopReason: String(raw["stopReason"] ?? "done"), text: "" };
  }
  if (kind === "error" || kind === "run_failed") {
    return { kind: "error", message: String(raw["message"] ?? "run failed") };
  }
  if (kind === "text") return { kind: "text", text: String(raw["text"] ?? "") };
  if (kind === "trace") {
    const { kind: _k, subkind, ...rest } = raw;
    return { kind: "trace", event: { kind: String(subkind ?? "unknown"), ...rest } };
  }
  return null;
}

export type RunOverlayHandle = { destroy(): void };

export function mountRunOverlay(
  container: HTMLElement,
  opts: { specName: string; getYaml: () => string },
): RunOverlayHandle {
  const { initial, fold } = createRunReducer();
  let run: RunState = initial;
  let es: EventSource | null = null;

  const promptInput = el("input", { type: "text", placeholder: "Message to send the harness…" }) as HTMLInputElement;
  promptInput.value = "Hello";
  const runBtn = el("button", { class: "sf-btn add", type: "button" }, "▶ Run");
  const stopBtn = el("button", { class: "sf-btn", type: "button" }, "◼ Stop");
  stopBtn.disabled = true;
  const status = el("div", { class: "sf-run-status" });
  const loopBox = el("div");
  const stats = el("div", { class: "sf-run-stats" });
  const transcript = el("pre", { class: "sf-run-transcript" });

  container.replaceChildren(
    el("div", { class: "sf-run-bar" }, promptInput, runBtn, stopBtn),
    status,
    loopBox,
    stats,
    transcript,
  );

  function renderOverlay() {
    const parsed = parseSpecModel(opts.getYaml());
    if (parsed.model !== undefined) loopBox.replaceChildren(renderRunLoop(projectLoop(parsed.model), run));
    stats.textContent =
      `$${(run.costMicros / 1e6).toFixed(4)}  ·  ${run.tokensIn}↓ ${run.tokensOut}↑ tok  ·  ` +
      `${run.turns} turns  ·  ${run.toolCalls} tools  ·  ${run.errors} err`;
    transcript.textContent = run.transcript || "(no output yet)";
  }

  function finish(label: string) {
    if (!es && !runBtn.disabled) return; // already finished — guard double-fire
    es?.close();
    es = null;
    runBtn.disabled = false;
    stopBtn.disabled = true;
    status.textContent = run.done ? `done${run.stopReason ? " — " + run.stopReason : ""}` : label;
    renderOverlay();
  }

  async function start() {
    run = initial;
    runBtn.disabled = true;
    stopBtn.disabled = false;
    status.textContent = "starting…";
    renderOverlay();
    let runId: string;
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specName: opts.specName, prompt: promptInput.value }),
      });
      const body = (await r.json()) as { runId?: string; error?: string };
      if (!r.ok || !body.runId) throw new Error(body.error ?? `HTTP ${r.status}`);
      runId = body.runId;
    } catch (err) {
      status.textContent = "run failed: " + (err as Error).message;
      runBtn.disabled = false;
      stopBtn.disabled = true;
      return;
    }
    status.textContent = `running (${runId})`;
    es = new EventSource("/api/runs/" + runId + "/events");
    es.onmessage = (e) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(e.data);
      } catch {
        return;
      }
      const ev = adaptRunEvent(raw);
      if (ev) {
        run = fold(run, ev);
        renderOverlay();
      }
    };
    es.addEventListener("done", () => finish("complete"));
    es.onerror = () => finish("connection closed");
    stopBtn.onclick = async () => {
      try {
        await fetch("/api/runs/" + runId + "/cancel", { method: "POST" });
      } catch {
        /* best-effort */
      }
      finish("stopped");
    };
  }
  runBtn.addEventListener("click", () => void start());
  renderOverlay();

  return {
    destroy: () => {
      es?.close();
      container.replaceChildren();
    },
  };
}

function renderRunLoop(loop: LoopProjection, run: RunState): HTMLElement {
  const box = el("div", { class: "sf-loop" });
  box.append(el("div", { class: "sf-loop-head" }, `Live loop — ${loop.target}`));
  if (loop.kind === "ring" && loop.ring) {
    const strip = el("div", { class: "sf-loop-strip" });
    for (const seg of loop.ring.segments) {
      strip.append(el("span", { class: "sf-seg" + (seg.id === run.activeSegment ? " on" : "") }, seg.id));
    }
    box.append(strip);
  } else if (loop.kind === "canvas" && loop.canvas) {
    for (const n of loop.canvas.nodes) {
      const row = el("div", { class: "sf-node" + (n.id === run.activeNode ? " active" : "") });
      row.append(el("strong", {}, n.label), el("span", { class: "sf-node-kind" }, ` [${n.kind}]`));
      box.append(row);
    }
  }
  return box;
}

declare global {
  interface Window {
    CrewhausSpecEditor?: {
      mountSpecEditor: typeof mountSpecEditor;
      mountRunOverlay: typeof mountRunOverlay;
    };
  }
}

if (typeof window !== "undefined") {
  window.CrewhausSpecEditor = { mountSpecEditor, mountRunOverlay };
}
