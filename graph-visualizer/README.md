# `@crewhaus/graph-visualizer`

Deterministic 2D layout for `IrGraphV0`. Layered BFS positioning (entry on the left, columns to the right, rows sorted by IR insertion order) — same graph → same positions ±0 px. No D3 runtime dep; the UI's force simulation can refine these positions if it wants.

## Install

```bash
bun add @crewhaus/graph-visualizer
```

## Quick start

```typescript
import {
  layoutGraph,
  renderSvg,
  renderLiveSvg,
  initialLiveState,
  applyEvent,
} from "@crewhaus/graph-visualizer";
import type { IrGraphV0 } from "@crewhaus/ir";

const ir: IrGraphV0 = /* compiled graph spec */;

// Layout
const layout = layoutGraph(ir, { columnGap: 180, rowGap: 80, margin: 40 });
// → { width, height, nodes: NodePosition[], edges: EdgeView[] }

// Static SVG (smoke artefact, first-paint)
const svg = renderSvg(layout);

// Live mode — track per-node state from SSE events
let live = initialLiveState(layout); // all nodes "idle"
live = applyEvent(live, { kind: "node_start", node: "plan",     ts: "2026-05-25T12:00:00Z" });
live = applyEvent(live, { kind: "node_end",   node: "plan",     ts: "2026-05-25T12:00:01Z" });
live = applyEvent(live, { kind: "hitl_pause", node: "execute",  prompt: "Approve?", ts: "..." });

const liveSvg = renderLiveSvg(layout, live);
// each <g class="node"> gets data-state="idle|running|done|paused-hitl|errored"
// → CSS can target [data-state="running"] etc. for live coloring
```

## Layout algorithm

1. Compute each node's column = shortest-path distance from `ir.entry` via BFS over outgoing edges. Unreachable nodes are placed in `max-reachable-column + 1` (incremented per unreachable).
2. Within a column, sort nodes by their original IR insertion order so generated bundles diff cleanly.
3. Position: `x = margin + col * columnGap`, `y = margin + row * rowGap`.

Defaults: `columnGap = 180`, `rowGap = 80`, `margin = 40`.

## Live state machine

`applyEvent` transitions one node at a time:

| Event | Next state | Side effect |
|---|---|---|
| `node_start` | `running` | — |
| `node_end` | `done` | — |
| `hitl_pause` | `paused-hitl` | `reasons[node] = prompt` |
| `hitl_decision` (`approve`) | `running` | `reasons[node] = "decision: approve"` |
| `hitl_decision` (`reject`) | `errored` | `reasons[node] = "decision: reject"` |
| `node_error` | `errored` | `reasons[node] = message` |

History is capped at 1000 entries (oldest dropped).

## API surface

| Export | Kind | Summary |
|---|---|---|
| `layoutGraph(ir, opts?)` | function | returns `Layout` with `{ width, height, nodes, edges }` |
| `renderSvg(layout)` | function | static SVG with circle + label per node |
| `renderLiveSvg(layout, state)` | function | same SVG with `data-state` on each `<g class="node">` |
| `initialLiveState(layout)` | function | `LiveGraphState` with every node `"idle"` |
| `applyEvent(state, event)` | function | pure state transition; returns a new frozen `LiveGraphState` |
| `Layout` | type | `{ width, height, nodes: NodePosition[], edges: EdgeView[] }` |
| `NodePosition`, `EdgeView` | types | `{ id, x, y }` and `{ from, to, fromXY, toXY }` |
| `LayoutOptions` | type | `{ columnGap?, rowGap?, margin? }` |
| `NodeState` | type | `"idle" \| "running" \| "done" \| "paused-hitl" \| "errored"` |
| `LiveGraphState` | type | `{ states, reasons, history }` (all frozen) |
| `LiveGraphEvent` | type | discriminated union of the 5 event kinds above |

## Pairs with

- [studio-server](../studio-server/) — `GET /api/graph-layout/:specName` returns this layout (JSON or SVG via `Accept: image/svg`)
- [studio-ui](../studio-ui/) — embeds the SVG and updates `data-state` from SSE
- [trace-viewer](../trace-viewer/) — sibling layout package for `TraceEvent[]`

## Related

- Source: [src/index.ts](./src/index.ts)
