/**
 * E53 — per-sample eval drill-down + the annotation write-path.
 *
 * Before this module the studio's eval surface was a run-level TABLE: it read
 * `.crewhaus/evals/index.jsonl` and rendered pass rate / mean score / sample
 * count per run. Everything a reviewer actually needs — which sample failed,
 * which grader failed it, what the grader said, and what the agent actually
 * produced — was already ON DISK and unserved.
 *
 * `crewhaus eval` persists (eval-runner, `.crewhaus/evals/<runId>/`):
 *
 *   run.json                       config snapshot
 *   results.json                   aggregates + one entry per sample
 *   <sampleId>/grades.json         { overall, perGrader }
 *   <sampleId>/meta.json           sampleId, sessionId, latency, tokens, model
 *   <sampleId>/transcript.jsonl    the session event log
 *   <sampleId>/events.jsonl        the trace-event log
 *
 * This module is the READ half (pure over an injectable root) plus the WRITE
 * half: an annotation is enqueued onto the Wave-3 human review queue
 * (`.crewhaus/review/queue.jsonl`) so it shows up in `crewhaus review list`
 * next to every other open item, and the verdict itself is durably recorded as
 * a `FeedbackRecord` on `.crewhaus/feedback/studio.jsonl`.
 *
 * WHAT THE FEEDBACK RECORD DOES *NOT* DO YET — do not promise the distill hop.
 * `crewhaus distill` joins FeedbackRecords to turns on (sessionId, turnNumber)
 * and derives those turns ONLY from `.crewhaus/sessions/<sessionId>.jsonl`
 * under its cwd. An eval sample's session log is written under the RUN dir
 * instead (eval-runner passes `sessionRootDir: <runDir>/<sampleId>` and renames
 * the log to `transcript.jsonl`), so a studio annotation has no session file to
 * pair with: today every one of these records lands in distill's unmatched
 * branch ("… has no matching turn in the transcript — skipped"), and in a
 * harness with an empty `.crewhaus/sessions` `distill --all-sessions` exits on
 * "no sessions found" before it reads the feedback dir at all. The record is
 * therefore the DURABLE CARRIER of the human verdict (and the reviewer's
 * correction) for the review queue and for a future distill path that resolves
 * `runId`-bearing records against the run dir — it is not, today, an input to
 * the next distilled dataset.
 *
 * WIRE-CONTRACT MIRRORS. The two record shapes below mirror
 * `@crewhaus/feedback-distill`'s `FeedbackRecord` and `ReviewQueueEntry`
 * exactly (schemaVersion 1, deterministic `rev_<kind>_<parts>` ids, the
 * `sess_<16 hex>` session-id form `isFeedbackRecord` requires). They are
 * re-declared here rather than imported because the studio consumes PUBLISHED
 * `@crewhaus/*` versions and the review queue ships in an unreleased line; the
 * round-trip tests pin the shapes so a drift is a failing test, not a silently
 * unreadable file.
 *
 * Every path segment that comes from a URL is validated before it touches the
 * filesystem — a run id or sample id is an opaque token here, so `..` and
 * separators are rejected outright rather than normalised.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Safe run/sample id: the tokens eval-runner mints plus dataset-authored
 *  sample ids. No separators, no dots-only traversal, bounded length. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeArtifactId(id: string): boolean {
  if (!SAFE_ID.test(id)) return false;
  // `..` can only appear mid-token given the anchor above, but reject it
  // anywhere so no future loosening of SAFE_ID can reintroduce traversal.
  return !id.includes("..");
}

/**
 * The `.crewhaus` root that carries eval artifacts. Mirrors the existing
 * `/api/evals` probe order: the repo root (the workspace's parent) first, then
 * the workspace itself. Returns `undefined` when neither exists — a workspace
 * that never ran an eval is an empty state, not an error.
 */
export function resolveEvalRoot(workspaceDir: string): string | undefined {
  for (const root of [dirname(workspaceDir), workspaceDir]) {
    if (existsSync(join(root, ".crewhaus", "evals"))) return join(root, ".crewhaus", "evals");
  }
  return undefined;
}

/**
 * The harness root the feedback + review sinks live under — the PARENT of the
 * `.crewhaus/evals` dir, so annotations land beside the run they annotate and
 * `crewhaus review list` in that harness sees them.
 *
 * DELIBERATE SANDBOX WIDENING, not an accident of the probe order. Every other
 * write endpoint is confined to `workspaceDir`; because {@link resolveEvalRoot}
 * probes `dirname(workspaceDir)` FIRST, an annotation on a repo-root eval run
 * writes to `<workspace parent>/.crewhaus/{feedback,review}`. That is the
 * semantically correct sink — the harness root is where `crewhaus review list`
 * and `crewhaus distill` look — but it is one level above the spec sandbox, so
 * {@link annotateSample} takes an explicit `allowedRoots` allow-list and
 * refuses to write anywhere else. The server passes exactly the two roots
 * `resolveEvalRoot` probes; nothing further up is ever reachable.
 */
export function harnessRootForEvals(evalRoot: string): string {
  return dirname(dirname(evalRoot));
}

export type SampleSummary = {
  readonly sampleId: string;
  readonly passed?: boolean;
  readonly score?: number;
  readonly error?: string;
  /** Whether per-sample artifacts exist on disk for the drill-down. */
  readonly hasArtifacts: boolean;
};

export type EvalRunDetail = {
  readonly runId: string;
  /** results.json verbatim (aggregates + per-sample results), when present. */
  readonly results: unknown;
  /** run.json verbatim (the config snapshot), when present. */
  readonly run: unknown;
  readonly samples: ReadonlyArray<SampleSummary>;
};

type ResultsShape = {
  samples?: ReadonlyArray<{
    sampleId?: unknown;
    passed?: unknown;
    error?: unknown;
    grades?: { overall?: { score?: unknown } };
  }>;
};

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A torn artifact must not 500 the drill-down — the caller renders the
    // rest of the run and the missing piece reads as absent.
    return undefined;
  }
}

/**
 * Load one run: results.json + run.json + the per-sample index the UI lists.
 * Returns `undefined` when the run directory does not exist.
 */
export function readEvalRun(evalRoot: string, runId: string): EvalRunDetail | undefined {
  if (!isSafeArtifactId(runId)) return undefined;
  const runDir = join(evalRoot, runId);
  if (!existsSync(runDir)) return undefined;
  const results = readJsonFile(join(runDir, "results.json"));
  const run = readJsonFile(join(runDir, "run.json"));

  // Sample list: prefer results.json (it carries pass/score per sample);
  // fall back to a directory scan so an interrupted run still drills down.
  const fromResults = (results as ResultsShape | undefined)?.samples;
  const dirIds = new Set<string>();
  try {
    for (const entry of readdirSync(runDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isSafeArtifactId(entry.name)) dirIds.add(entry.name);
    }
  } catch {
    // unreadable run dir — the empty sample list is the honest answer
  }
  const samples: SampleSummary[] = [];
  if (Array.isArray(fromResults)) {
    for (const s of fromResults) {
      const sampleId = typeof s.sampleId === "string" ? s.sampleId : undefined;
      if (sampleId === undefined) continue;
      const score = s.grades?.overall?.score;
      samples.push({
        sampleId,
        ...(typeof s.passed === "boolean" ? { passed: s.passed } : {}),
        ...(typeof score === "number" ? { score } : {}),
        ...(typeof s.error === "string" ? { error: s.error } : {}),
        hasArtifacts: dirIds.has(sampleId),
      });
      dirIds.delete(sampleId);
    }
  }
  // Sample dirs results.json never mentioned (crashed run, resumed run).
  for (const sampleId of [...dirIds].sort()) {
    samples.push({ sampleId, hasArtifacts: true });
  }
  return { runId, results, run, samples };
}

export type SampleDetail = {
  readonly runId: string;
  readonly sampleId: string;
  /** grades.json verbatim: { overall, perGrader } with rationales. */
  readonly grades: unknown;
  /** meta.json verbatim: sessionId, latency, tokens, model, metrics. */
  readonly meta: unknown;
  /** The session event log, one parsed object per line. */
  readonly transcript: ReadonlyArray<unknown>;
  /** The trace-event log, one parsed object per line (capped). */
  readonly events: ReadonlyArray<unknown>;
  /** True when either JSONL was truncated by {@link MAX_JSONL_LINES}. */
  readonly truncated: boolean;
};

/** Ceiling on lines served per JSONL — a long agentic sample must not turn one
 *  drill-down request into a hundred-megabyte JSON body. */
export const MAX_JSONL_LINES = 2000;

function readJsonl(path: string): { lines: unknown[]; truncated: boolean } {
  if (!existsSync(path)) return { lines: [], truncated: false };
  const out: unknown[] = [];
  let truncated = false;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (out.length >= MAX_JSONL_LINES) {
      truncated = true;
      break;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn append must not hide the rest of the log.
    }
  }
  return { lines: out, truncated };
}

/** Load one sample's artifacts. `undefined` when the sample dir is absent. */
export function readSampleDetail(
  evalRoot: string,
  runId: string,
  sampleId: string,
): SampleDetail | undefined {
  if (!isSafeArtifactId(runId) || !isSafeArtifactId(sampleId)) return undefined;
  const sampleDir = join(evalRoot, runId, sampleId);
  if (!existsSync(sampleDir)) return undefined;
  const transcript = readJsonl(join(sampleDir, "transcript.jsonl"));
  const events = readJsonl(join(sampleDir, "events.jsonl"));
  return {
    runId,
    sampleId,
    grades: readJsonFile(join(sampleDir, "grades.json")),
    meta: readJsonFile(join(sampleDir, "meta.json")),
    transcript: transcript.lines,
    events: events.lines,
    truncated: transcript.truncated || events.truncated,
  };
}

// ---------------------------------------------------------------------------
// The annotation write-path.
// ---------------------------------------------------------------------------

/** Mirror of `@crewhaus/feedback-distill`'s FeedbackRecord (schemaVersion 1). */
export type StudioFeedbackRecord = {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  runId?: string;
  turnNumber: number;
  modality: "binary" | "stars" | "scale" | "comment";
  rating: { thumbs?: "up" | "down"; stars?: number };
  comment?: string;
  correction?: string;
  source: "ui";
  rater?: string;
  /** B19 — an adjudication always wins a multi-rater disagreement at distill. */
  adjudication?: boolean;
  ts: string;
};

/** Mirror of `@crewhaus/feedback-distill`'s ReviewQueueEntry (schemaVersion 1). */
export type StudioReviewQueueEntry = {
  schemaVersion: 1;
  id: string;
  kind: "needs_review";
  sourceRef: { runId?: string; sampleId?: string };
  ts: string;
  status: "open";
  context?: string;
};

export type AnnotationInput = {
  readonly runId: string;
  readonly sampleId: string;
  /** The human verdict on this sample. */
  readonly verdict: "pass" | "fail";
  readonly comment?: string;
  /** A better answer, carried on the record for the human reviewer (see the
   *  module docs: it does NOT reach `crewhaus distill` today). */
  readonly correction?: string;
  readonly rater?: string;
  /** Mark the record as an adjudication (wins rater ties at distill). */
  readonly adjudicate?: boolean;
};

export class EvalAnnotationError extends Error {
  override readonly name = "EvalAnnotationError";
}

export type AnnotateSampleOptions = {
  /**
   * Directories the feedback + review sinks may be created under. When set,
   * the resolved harness root must be EXACTLY one of them — the annotate
   * endpoint is the studio's only write above the spec sandbox, so the caller
   * names the boundary rather than inheriting whatever the eval-root probe
   * happened to find. Omitted (library/test use) = no extra constraint.
   */
  readonly allowedRoots?: ReadonlyArray<string>;
};

/** Same bound + control-char strip the CLI applies at feedback ingestion. */
export const MAX_ANNOTATION_TEXT = 8192;
export function clipAnnotationText(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const printable =
      c === 9 || c === 10 || c === 13 || (c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f));
    if (printable) out += ch;
    if (out.length >= MAX_ANNOTATION_TEXT) break;
  }
  return out.slice(0, MAX_ANNOTATION_TEXT);
}

const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

/** Deterministic review-queue id — byte-identical to `reviewEntryId`. */
export function reviewEntryIdFor(runId: string, sampleId: string): string {
  const token = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
  return `rev_needs_review_${token(runId)}_${token(sampleId)}`;
}

export type AnnotationResult = {
  readonly feedback: StudioFeedbackRecord;
  readonly review: StudioReviewQueueEntry;
  readonly feedbackPath: string;
  readonly reviewPath: string;
  /** False when an entry with this id was already queued (idempotent). */
  readonly reviewAdded: boolean;
};

/**
 * Capture one human verdict on one eval sample.
 *
 * Two durable writes, both append-only:
 *   1. a `needs_review` entry on `.crewhaus/review/queue.jsonl` — deterministic
 *      id (byte-identical to `reviewEntryId`), so re-annotating the same sample
 *      keeps every vote in the feedback log without duplicating the queue item.
 *      This is the hop that WORKS end-to-end: `crewhaus review list` in the
 *      harness shows the item immediately.
 *   2. a `FeedbackRecord` on `.crewhaus/feedback/studio.jsonl` — the durable
 *      carrier of the verdict, the comment and the reviewer's correction, on
 *      the standard append-only feedback sink. It is NOT consumed by
 *      `crewhaus distill` today: see the module docs for why the
 *      (sessionId, turnNumber) join cannot resolve for an eval sample.
 *
 * The sample's REAL `sessionId` comes from its `meta.json`; a sample whose
 * meta is missing or malformed is refused rather than given a synthetic id
 * that nothing could ever pair back to a turn.
 */
export function annotateSample(
  evalRoot: string,
  input: AnnotationInput,
  now: () => Date = () => new Date(),
  opts: AnnotateSampleOptions = {},
): AnnotationResult {
  if (!isSafeArtifactId(input.runId) || !isSafeArtifactId(input.sampleId)) {
    throw new EvalAnnotationError("unsafe run/sample id");
  }
  if (input.verdict !== "pass" && input.verdict !== "fail") {
    throw new EvalAnnotationError('verdict must be "pass" or "fail"');
  }
  const detail = readSampleDetail(evalRoot, input.runId, input.sampleId);
  if (detail === undefined) {
    throw new EvalAnnotationError(`no artifacts for sample ${input.sampleId} in run ${input.runId}`);
  }
  const sessionId = (detail.meta as { sessionId?: unknown } | undefined)?.sessionId;
  if (typeof sessionId !== "string" || !SESSION_ID_REGEX.test(sessionId)) {
    throw new EvalAnnotationError(
      `sample ${input.sampleId} has no usable sessionId in meta.json — a feedback record must key back to a real session`,
    );
  }
  const ts = now().toISOString();
  const harnessRoot = harnessRootForEvals(evalRoot);
  // The sandbox boundary for this one widened write-path (see
  // `harnessRootForEvals`): resolve() both sides so `.`/trailing separators in
  // a configured workspace path cannot make a legitimate root look foreign.
  if (opts.allowedRoots !== undefined) {
    const target = resolve(harnessRoot);
    if (!opts.allowedRoots.some((root) => resolve(root) === target)) {
      throw new EvalAnnotationError(
        `refusing to write annotation sinks to ${target} — outside the allowed harness roots (${opts.allowedRoots.join(", ")})`,
      );
    }
  }

  const comment = input.comment !== undefined ? clipAnnotationText(input.comment) : undefined;
  const correction =
    input.correction !== undefined ? clipAnnotationText(input.correction) : undefined;
  const feedback: StudioFeedbackRecord = {
    schemaVersion: 1,
    // Unique per VOTE (the log keeps every one); the queue is what dedupes.
    id: `fb_${input.runId}_${input.sampleId}_${ts}`.replace(/[^A-Za-z0-9._-]+/g, "_"),
    sessionId,
    runId: input.runId,
    // An eval sample is a single exchange — turn 1 by construction.
    turnNumber: 1,
    modality: "binary",
    rating: { thumbs: input.verdict === "pass" ? "up" : "down" },
    ...(comment !== undefined && comment !== "" ? { comment } : {}),
    ...(correction !== undefined && correction !== "" ? { correction } : {}),
    source: "ui",
    ...(input.rater !== undefined && input.rater !== "" ? { rater: input.rater } : {}),
    ...(input.adjudicate === true ? { adjudication: true } : {}),
    ts,
  };
  const feedbackPath = join(harnessRoot, ".crewhaus", "feedback", "studio.jsonl");
  mkdirSync(dirname(feedbackPath), { recursive: true });
  appendFileSync(feedbackPath, `${JSON.stringify(feedback)}\n`, { mode: 0o600 });

  const review: StudioReviewQueueEntry = {
    schemaVersion: 1,
    id: reviewEntryIdFor(input.runId, input.sampleId),
    kind: "needs_review",
    sourceRef: { runId: input.runId, sampleId: input.sampleId },
    ts,
    status: "open",
    context: `studio annotation: ${input.verdict}${comment !== undefined && comment !== "" ? ` — ${comment.slice(0, 160)}` : ""}`,
  };
  const reviewPath = join(harnessRoot, ".crewhaus", "review", "queue.jsonl");
  const alreadyQueued = existsSync(reviewPath)
    ? readFileSync(reviewPath, "utf8")
        .split("\n")
        .some((line) => {
          const t = line.trim();
          if (t === "") return false;
          try {
            return (JSON.parse(t) as { id?: unknown }).id === review.id;
          } catch {
            return false;
          }
        })
    : false;
  if (!alreadyQueued) {
    mkdirSync(dirname(reviewPath), { recursive: true });
    appendFileSync(reviewPath, `${JSON.stringify(review)}\n`, { mode: 0o600 });
  }
  return { feedback, review, feedbackPath, reviewPath, reviewAdded: !alreadyQueued };
}
