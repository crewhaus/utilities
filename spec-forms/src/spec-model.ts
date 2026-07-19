// Structured spec model for the loop builder: a comment/order-preserving YAML
// document the UI can read and edit path-by-path, plus a plain-JS mirror for
// display logic.
//
// This module is why `yaml` is the PWA's FIRST runtime dependency beyond
// astro: the loop builder edits the user's `crewhaus.yaml` structurally (set
// `agent.model`, add a `memory:` block, …) and those edits MUST NOT destroy
// anything else the user wrote — comments, key order, anchors/aliases, merge
// keys, block-scalar styles, unknown keys. That is a CST/AST concern no regex
// or JSON round-trip can honour, and `yaml` (v2) is the zero-dependency
// (`bun pm ls` shows no transitive deps), browser-safe library whose Document
// API is built for exactly this. The regex `detectTarget` in ./templates.ts
// stays untouched for its existing line-oriented callers;
// `detectTargetFromModel` below is the model-aware sibling for callers that
// already parsed.
//
// Discipline (mirrors ./templates.ts / ./fleet.ts / ./share.ts): this file
// imports NOTHING from ./compiler or ./cloudflare — those pull in the
// `__COMPILER_URL__` vite define, which is undefined under `bun test` and
// would break the suite. It performs no fetch and touches NO DOM (pure
// text -> model logic; pages own all rendering), so the unit tests run fully
// offline.

import type { Document } from "yaml";
import { isNode, parseDocument } from "yaml";

// --- parse ------------------------------------------------------------------

/** One parse problem, positioned when the parser could locate it (1-based). */
export type SpecModelError = {
  readonly message: string;
  readonly line?: number;
  readonly col?: number;
};

/**
 * Result of {@link parseSpecModel}.
 *
 * - Valid YAML  -> `doc` is the comment/order-preserving `yaml` Document (the
 *   thing to EDIT and serialize), `model` is its plain `toJS()` mirror (the
 *   thing to READ in display logic), `errors` is empty. An EMPTY input is
 *   valid YAML: `doc` non-null with `model` null.
 * - Invalid YAML -> `errors` is non-empty and `doc`/`model` are BOTH null, so
 *   a caller can never edit-and-serialize a half-parsed document back over
 *   the user's text (the editor keeps the raw string as source of truth until
 *   the YAML parses again).
 */
export type ParsedSpecModel = {
  readonly doc: Document | null;
  readonly model: unknown;
  readonly errors: readonly SpecModelError[];
};

/** Map a yaml `YAMLError`-ish object to our positioned error shape. */
function toSpecModelError(err: unknown): SpecModelError {
  if (err instanceof Error) {
    const linePos = (err as { linePos?: readonly { line: number; col: number }[] }).linePos;
    const pos = linePos?.[0];
    return {
      message: err.message,
      ...(pos ? { line: pos.line, col: pos.col } : {}),
    };
  }
  return { message: String(err) };
}

/**
 * Parse `crewhaus.yaml` text into a {@link ParsedSpecModel}. NEVER throws:
 * any parse failure (bad indent, unclosed flow, multiple documents, …) comes
 * back as `errors` with `doc`/`model` null.
 *
 * Parsed with `merge: true` so `<<: *anchor` merge keys resolve into `model`
 * the way an author expects, while the Document itself keeps the literal
 * `<<`/anchor nodes for a faithful re-serialize. Parser WARNINGS (e.g. odd
 * directives) are deliberately not errors — the text still parsed.
 */
export function parseSpecModel(text: string): ParsedSpecModel {
  let doc: Document;
  try {
    doc = parseDocument(text, { merge: true, prettyErrors: true });
  } catch (err) {
    // parseDocument collects rather than throws; this is belt-and-braces so a
    // caller still gets the documented shape if the parser ever does throw.
    return { doc: null, model: null, errors: [toSpecModelError(err)] };
  }
  const errors = (doc.errors ?? []).map(toSpecModelError);
  if (errors.length > 0) {
    return { doc: null, model: null, errors };
  }
  return { doc, model: doc.toJS(), errors: [] };
}

// --- serialize ---------------------------------------------------------------

/**
 * Serialize a Document back to YAML text, preserving comments, key order,
 * anchors/aliases, merge keys, and block-scalar styles.
 *
 * `lineWidth: 0` disables the stringifier's default 80-column folding so a
 * long line the user wrote (a big instructions sentence, a URL) is never
 * re-wrapped behind their back — untouched content stays byte-identical.
 */
export function serializeSpecModel(doc: Document): string {
  return doc.toString({ lineWidth: 0 });
}

// --- path helpers -------------------------------------------------------------

/**
 * A path into the document: map keys as strings, sequence indexes as numbers,
 * e.g. `["steps", 0, "instructions"]`. The empty path addresses the root.
 */
export type SpecPath = ReadonlyArray<string | number>;

/**
 * Read the plain-JS value at `path`, or `undefined` when absent. Scalars come
 * back as their JS values; maps/sequences are converted via `toJS` so callers
 * always receive plain data, never `yaml` Node objects.
 */
export function getPath(doc: Document, path: SpecPath): unknown {
  const value = doc.getIn(path);
  return isNode(value) ? value.toJS(doc) : value;
}

/**
 * Set the value at `path`, creating intermediate maps as needed (a numeric
 * step creates a sequence). Edits are LOCAL: comments, anchors, ordering, and
 * every other node in the document are left untouched — this is the whole
 * reason the builder edits the Document instead of re-emitting the model.
 * Throws (from yaml's `setIn`) when an EXISTING scalar blocks the path, e.g.
 * `setPath(doc, ["name", "x"], …)` on `name: hello` — a caller bug, not a
 * state to absorb: delete or overwrite the scalar first.
 */
export function setPath(doc: Document, path: SpecPath, value: unknown): void {
  doc.setIn(path, value);
}

/**
 * Delete the node at `path`. Returns true when something was removed, false
 * when the path did not resolve — including when an intermediate segment is
 * missing or is a scalar (yaml's raw `deleteIn` THROWS "Expected YAML
 * collection" there; a miss is a miss, so this wrapper absorbs it). Like
 * {@link setPath}, the rest of the document (comments included) is untouched.
 */
export function deletePath(doc: Document, path: SpecPath): boolean {
  try {
    return doc.deleteIn(path);
  } catch {
    return false;
  }
}

// --- target detection ----------------------------------------------------------

/**
 * Read the declared `target` from a parsed spec model, falling back to "cli"
 * — the same default as the regex `detectTarget` in ./templates.ts (which
 * stays as-is for its line-oriented callers on raw text). Use THIS one when a
 * parsed model is already in hand: it reads the real YAML value, so a target
 * inside a block scalar or comment can't false-positive. Any absent,
 * non-string, or empty/whitespace `target` falls back to "cli".
 */
export function detectTargetFromModel(model: unknown): string {
  if (typeof model !== "object" || model === null || Array.isArray(model)) return "cli";
  const target = (model as Record<string, unknown>)["target"];
  if (typeof target !== "string") return "cli";
  const trimmed = target.trim();
  return trimmed.length > 0 ? trimmed : "cli";
}
