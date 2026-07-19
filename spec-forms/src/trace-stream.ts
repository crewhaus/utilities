// SSE consumer for structured trace events from a deployed harness Worker.
//
// Contract: a harness Worker's `/chat` SSE stream interleaves CrewHaus
// TraceEvent-vocabulary JSON objects — sent as SSE `trace` events — with the
// `text` / `done` / `error` events the chat endpoint has always emitted (which
// ./chat.ts consumes). This module is the SUPERSET consumer: it mirrors
// chat.ts's SSE frame parsing exactly and additionally surfaces each `trace`
// event's payload verbatim as `{ kind: "trace", event }` for a downstream
// consumer to interpret — the vendored `public/ui-shared/events.js`
// CH.events.render (a card feed) or ./run-model.ts's reducer (run state).
//
// The Batch-C cf-worker targets emit their per-turn/per-step trace frames this
// way: `emit("trace", event)` on the wire, where `event` is a TraceEvent keyed
// on `.kind` — model_response {usage,stopReason,durationMs}, cost_accrual, the
// workflow step_start {name,step,total} / step_end {name,step,durationMs}, the
// graph node_start / node_end, and approval_requested {approvalId,toolName,
// surface}. This module does NOT interpret that vocabulary (that is the
// consumer's job); every JSON-object `trace` payload — known kind or not —
// passes through as `{ kind: "trace", event }`. So a NEWER trace kind needs no
// change here, and a PRE-Batch-C worker (which emits no trace frames at all)
// degrades gracefully to exactly chat.ts's text/done/error stream.
//
// Parsing is defensive throughout: malformed JSON, non-object trace payloads,
// and unknown SSE event names are skipped, never thrown.
//
// Discipline (mirrors fleet.ts / github-spec-store.ts / share.ts): this file
// imports NOTHING from ./compiler or ./cloudflare — those pull in the
// `__COMPILER_URL__` vite define, which is undefined under `bun test` and
// would break the suite. The URL is an argument and `fetchImpl` is an
// injectable fetch seam (same pattern as SpecFetch / FleetFetch), so the unit
// tests run fully offline. It touches NO DOM — pages own all rendering.

/**
 * One chat turn — inlined here (rather than importing studio-pwa's ./chat) so
 * `@crewhaus/spec-forms` stays free of the chat-transport module; the shape is
 * structurally identical, so a consumer's own ChatMessage still fits.
 */
export type ChatMessage = { readonly role: "user" | "assistant"; readonly content: string };

/** Injectable fetch seam, mirroring SpecFetch / FleetFetch. */
export type TraceFetch = typeof fetch;

/**
 * One event from the stream. `trace` carries the raw TraceEvent object
 * verbatim (this module does not interpret the TraceEvent vocabulary — that's
 * the renderer's job); the other kinds mirror ./chat.ts's ChatEvent.
 */
export type TraceStreamEvent =
  | { readonly kind: "trace"; readonly event: Record<string, unknown> }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "done"; readonly text: string; readonly stopReason: string }
  | { readonly kind: "error"; readonly message: string };

/** A parsed SSE `data:` payload usable as an event body (JSON object). */
function isJsonObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * POST `body` (JSON) to `url` and consume the SSE response, yielding one
 * TraceStreamEvent per recognized frame. Network failures and non-ok
 * responses yield a single `error` event and return (never throw), so a
 * caller can `for await` without a try/catch — same posture as chat.ts's
 * HTTP-error path, extended to cover a rejected fetch too.
 */
export async function* streamTraceEvents(
  url: string,
  body: unknown,
  fetchImpl: TraceFetch = fetch,
): AsyncGenerator<TraceStreamEvent> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: { message?: string } };
      if (parsed.error?.message) msg = parsed.error.message;
    } catch {
      // fall through with the status code
    }
    yield { kind: "error", message: msg };
    return;
  }

  // Frame parsing below mirrors ./chat.ts streamChat EXACTLY (same "\n\n"
  // frame split, same "event: "/"data: " prefixes, same multi-`data:` line
  // concatenation) — only the per-event dispatch is extended with `trace`.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let eventName = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (eventName === "trace") {
          // A TraceEvent is always a JSON object; anything else (number,
          // string, array, null) is a malformed frame — skip, don't throw.
          if (isJsonObject(parsed)) yield { kind: "trace", event: parsed };
        } else if (!isJsonObject(parsed)) {
          // text/done/error bodies are objects too; skip other malformed data.
        } else if (eventName === "text" && typeof parsed["text"] === "string") {
          yield { kind: "text", text: parsed["text"] };
        } else if (eventName === "done") {
          yield {
            kind: "done",
            text: typeof parsed["text"] === "string" ? parsed["text"] : "",
            stopReason:
              typeof parsed["stopReason"] === "string" ? parsed["stopReason"] : "end_turn",
          };
        } else if (eventName === "error") {
          yield {
            kind: "error",
            message:
              typeof parsed["message"] === "string" ? parsed["message"] : "unknown error",
          };
        }
      } catch {
        // Skip malformed events
      }
    }
  }
}

/**
 * Convenience wrapper that speaks ./chat.ts's `streamChat(workerUrl, messages)`
 * request shape but yields the MERGED trace-aware stream — the text/done/error
 * frames chat.ts surfaces PLUS every `{ kind: "trace", event }` frame — and
 * takes an injectable fetch (streamChat uses the global `fetch`; this seam lets
 * the tests run offline). It builds the `<workerUrl>/chat` URL and the
 * `{ messages }` body chat.ts POSTs, then delegates to {@link streamTraceEvents}.
 *
 * Trailing slashes on `workerUrl` are trimmed so `https://w.dev/` and
 * `https://w.dev` both hit `.../chat` (same discipline as loop-model's
 * loadLoopProjection `/loop`). Returns the delegate generator directly — a thin
 * wrapper, no extra buffering — so all of streamTraceEvents's guarantees
 * (never-throw on a rejected fetch or non-ok response, defensive frame parsing)
 * carry through unchanged.
 */
export function streamChatTrace(
  workerUrl: string,
  messages: readonly ChatMessage[],
  fetchImpl: TraceFetch = fetch,
): AsyncGenerator<TraceStreamEvent> {
  const base = workerUrl.replace(/\/+$/, "");
  return streamTraceEvents(`${base}/chat`, { messages }, fetchImpl);
}
