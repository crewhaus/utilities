# `@crewhaus/trace-viewer`

Pure-logic Gantt-layout helper for `TraceEvent[]` corpora. Pairs `*_start` and `*_end` events on `spanId`, returns a flat `TimelineSpan[]` with absolute t0/t1 plus parent links — renderer-agnostic so studio-ui can draw Gantt bars and eval-report can embed inline drilldowns.

## Install

```bash
bun add @crewhaus/trace-viewer
```

## Quick start

```typescript
import { buildTimeline, replay, drilldownSpan } from "@crewhaus/trace-viewer";
import type { TraceEvent } from "@crewhaus/trace-event-bus";

const events: TraceEvent[] = /* from SSE, event-log, or fixtures */;

const timeline = buildTimeline(events);
// → { t0, t1, spans: TimelineSpan[] }
// spans are sorted by t0 ascending; depth is computed via parentSpanId chains

// Replay events in real-ish time (1× / 2× / 4× / "raw")
for await (const ev of replay(events, { speed: 2 })) {
  // each ev fires with gapMs/speed delay between consecutive events,
  // capped at 5000ms per gap
}

// Surface the event payload for a clicked span
const detail = drilldownSpan(timeline, events, "span_42");
// → { spanId, span, events: TraceEvent[] }  (events match spanId OR parentSpanId)
```

## Event pairing

Each `TimelineSpan` is built from either a start/end pair or a single point event:

| Span kind | Start event | End event |
|---|---|---|
| `turn` | `turn_start` | `turn_end` |
| `model` | `model_request` | `model_response` |
| `tool` | `tool_call_start` | `tool_call_end` |
| `mcp` | `mcp_call_start` | `mcp_call_end` |
| `sub_agent` | `sub_agent_start` | `sub_agent_end` |
| `role` | `role_start` | `role_end` |
| `hook` | `hook_fired` (point) | — |
| `compaction` | `compaction_fired` (point) | — |
| `permission` | `permission_decision` (point) | — |
| `recovery` | `error_recovered` (point) | — |
| `handoff` | `handoff` (point) | — |
| `a2a_message` | `a2a_message` (point) | — |
| `crew` | `crew_done` (point) | — |

For point events, `t1 === t0`. Unpaired start events get `t1 === t0` until the matching end arrives.

## API surface

| Export | Kind | Summary |
|---|---|---|
| `buildTimeline(events)` | function | flat `Timeline` sorted by t0, with computed depths |
| `replay(events, { speed, setTimeoutImpl? })` | async generator | yields events at 1×/2×/4× / immediate (`"raw"`); accepts a `setTimeoutImpl` for deterministic tests |
| `drilldownSpan(timeline, events, spanId)` | function | matching span + the events that share its `spanId` or `parentSpanId` |
| `Timeline` | type | `{ t0, t1, spans: TimelineSpan[] }` |
| `TimelineSpan` | type | `{ spanId, parentSpanId?, kind, label, t0, t1, depth, meta }` |
| `SpanKind` | type | the 14 span-kind literals above |
| `ReplayOptions` | type | `{ speed: 1 \| 2 \| 4 \| "raw", setTimeoutImpl? }` |
| `SpanDrilldown` | type | `{ spanId, span, events }` |

## Determinism

`buildTimeline` is pure — given the same `events` array it returns the same `spans` ±0 px. T1 snapshot tests depend on this. `replay` accepts a `setTimeoutImpl` override so tests can drive the scheduler synchronously.

## Pairs with

- [studio-server](../studio-server/) — `/api/runs/:runId/events` and `/api/runs/:runId/replay` stream the `TraceEvent[]` this package consumes
- [studio-ui](../studio-ui/) — renders the `TimelineSpan[]` as Gantt bars (renderer is the UI's responsibility)
- [graph-visualizer](../graph-visualizer/) — sibling layout package for `IrGraphV0` graphs

## Related

- Source: [src/index.ts](./src/index.ts)
