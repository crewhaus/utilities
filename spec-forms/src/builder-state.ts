// Draft state machine for the /builder page: the YAML text (source of truth),
// its parsed model snapshot, the current segment/node selection, a bounded
// undo/redo ring, and a dirty flag — everything the page renders FROM, with
// the page owning all DOM.
//
// B1 is read-only in the UI, but the state machine already carries the edit
// transaction (beginEdit/commitEdit/undo/redo) so B2's palette + inspector
// forms land on a tested core. YAML text stays the source of truth: every
// mutation goes text-first, and the model snapshot is re-derived via the
// INJECTED `parse` function — this module deliberately imports NOTHING (not
// spec-model, not ./compiler, not ./cloudflare — the `__COMPILER_URL__` vite
// define is undefined under `bun test`), so it stays independently testable
// and offline. `serialize` is accepted now (same injection seam) for B2's
// model→text flows; B1 never calls it. No DOM, no fetch, no globals beyond
// plain JS — same discipline as templates.ts / fleet.ts / share.ts.
//
// Semantics worth knowing (all unit-tested):
//   - `dirty` derives from `text !== <text at last load()>` — undoing back to
//     the loaded text clears it, no bookkeeping calls needed.
//   - `model` is the LAST-GOOD parse: while the current text fails to parse,
//     `parseError` is set and `model` keeps the previous good snapshot so the
//     canvas doesn't blank mid-edit. load() resets the last-good model first,
//     so a bad load shows `model: undefined`, not the previous document.
//   - `beginEdit()` opens a coalescing transaction: however many
//     `commitEdit()` calls follow, ONE undo entry (the transaction's base
//     text) is recorded. `commitEdit()` without `beginEdit()` is a
//     single-shot edit (one entry each). undo()/redo()/load() end any open
//     transaction.
//   - The undo ring is bounded (default 100, DEFAULT_HISTORY_LIMIT): the
//     oldest entry falls off; redo is cleared by any new committed edit.

// --- injected seams -----------------------------------------------------------

/**
 * Parse YAML text into a model object (e.g. spec-model's parse). May throw on
 * invalid input — the state machine catches and surfaces it as `parseError`.
 */
export type ParseSpec = (text: string) => unknown;

/** Serialize a model back to YAML text. Reserved for B2 editing flows. */
export type SerializeSpec = (model: unknown) => string;

// --- shapes --------------------------------------------------------------------

export type BuilderStateOptions = {
  /** The initial YAML text; behaves exactly like a first load(initialText). */
  readonly initialText: string;
  /** Injected YAML→model parse. Omit for a text-only state (model stays undefined). */
  readonly parse?: ParseSpec;
  /** Injected model→YAML serialize. Reserved for B2; never called in B1. */
  readonly serialize?: SerializeSpec;
  /** Undo ring capacity (entries). Default DEFAULT_HISTORY_LIMIT. */
  readonly historyLimit?: number;
};

/** Immutable view of the current state, rebuilt on every change. */
export type BuilderSnapshot = {
  /** The YAML text — the source of truth. */
  readonly text: string;
  /** The last-GOOD parsed model (see header); undefined before any good parse. */
  readonly model: unknown;
  /** The current text's parse failure, or undefined when it parsed clean. */
  readonly parseError: string | undefined;
  /** Selected ring-segment / canvas-node id, or null. Pure view state. */
  readonly selection: string | null;
  /** True iff text differs from the text at the last load(). */
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

export type BuilderListener = (snapshot: BuilderSnapshot) => void;

export type BuilderState = {
  /** Current snapshot (subscribe() does not replay it — read this first). */
  get(): BuilderSnapshot;
  /** Replace the document (open a spec): resets history, dirty, selection. */
  load(text: string): void;
  /** Select a segment/node id (null clears). No-op when unchanged. */
  select(id: string | null): void;
  /** Start a coalescing edit transaction (see header), ending any open one. */
  beginEdit(): void;
  /** Commit new text (no-op when identical to the current text). */
  commitEdit(newText: string): void;
  /** Step back one committed edit. Returns false when there is nothing to undo. */
  undo(): boolean;
  /** Re-apply the last undone edit. Returns false when there is nothing to redo. */
  redo(): boolean;
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe(listener: BuilderListener): () => void;
};

/** Default undo-ring capacity. */
export const DEFAULT_HISTORY_LIMIT = 100;

// --- factory --------------------------------------------------------------------

export function createBuilderState(options: BuilderStateOptions): BuilderState {
  const parse = options.parse;
  const limit = Math.max(1, Math.floor(options.historyLimit ?? DEFAULT_HISTORY_LIMIT));

  let text = options.initialText;
  let savedText = options.initialText; // text at the last load() — dirty baseline
  let model: unknown; // last-good parse
  let parseError: string | undefined;
  let selection: string | null = null;
  let undoStack: string[] = [];
  let redoStack: string[] = [];
  // Open edit transaction: the base text already pushed to the undo stack for
  // this transaction (so further commits coalesce), or null when none is open.
  let transactionOpen = false;
  let transactionPushed = false;
  const listeners = new Set<BuilderListener>();

  /** Re-derive the model snapshot from `text`, keeping the last good model on failure. */
  function reparse(): void {
    if (!parse) {
      parseError = undefined;
      return;
    }
    try {
      model = parse(text);
      parseError = undefined;
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  function snapshot(): BuilderSnapshot {
    return {
      text,
      model,
      parseError,
      selection,
      dirty: text !== savedText,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    };
  }

  function notify(): void {
    const snap = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(snap);
      } catch {
        // One misbehaving listener must not starve the rest (or crash a
        // state transition). The page owns error surfacing.
      }
    }
  }

  function endTransaction(): void {
    transactionOpen = false;
    transactionPushed = false;
  }

  function pushUndo(entry: string): void {
    undoStack.push(entry);
    if (undoStack.length > limit) undoStack = undoStack.slice(undoStack.length - limit);
  }

  reparse();

  return {
    get: snapshot,

    load(newText: string): void {
      text = newText;
      savedText = newText;
      selection = null;
      undoStack = [];
      redoStack = [];
      endTransaction();
      model = undefined; // a bad load must not show the previous document's model
      reparse();
      notify();
    },

    select(id: string | null): void {
      if (id === selection) return;
      selection = id;
      notify();
    },

    beginEdit(): void {
      // Unconditionally start fresh: each beginEdit() marks a new burst, so a
      // second call after some commits opens a NEW transaction (one more undo
      // entry) rather than coalescing into the old one forever.
      transactionOpen = true;
      transactionPushed = false;
    },

    commitEdit(newText: string): void {
      if (newText === text) return;
      if (!transactionOpen || !transactionPushed) {
        pushUndo(text);
        transactionPushed = transactionOpen; // single-shot edits never coalesce
      }
      text = newText;
      redoStack = [];
      reparse();
      notify();
    },

    undo(): boolean {
      const prev = undoStack.pop();
      if (prev === undefined) return false;
      endTransaction();
      redoStack.push(text);
      if (redoStack.length > limit) redoStack = redoStack.slice(redoStack.length - limit);
      text = prev;
      reparse();
      notify();
      return true;
    },

    redo(): boolean {
      const next = redoStack.pop();
      if (next === undefined) return false;
      endTransaction();
      pushUndo(text);
      text = next;
      reparse();
      notify();
      return true;
    },

    subscribe(listener: BuilderListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
