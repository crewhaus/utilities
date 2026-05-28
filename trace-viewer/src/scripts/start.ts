/**
 * `bun run start` entry point for `@crewhaus/trace-viewer`.
 *
 * Feeds a hardcoded TraceEvent fixture through `buildTimeline` and
 * renders the resulting spans as an ASCII Gantt chart on stdout.
 * Demonstrates the pure-logic layout helper without any SSE wiring.
 */
import type { TraceEvent, TraceEventEnvelope } from "@crewhaus/trace-event-bus";
import { buildTimeline } from "../index";

function envelope(
  spanId: string,
  parentSpanId: string | undefined,
  ts: string,
): TraceEventEnvelope {
  return {
    runId: "run_demo",
    sessionId: "sess_demo",
    turnNumber: 0,
    traceId: "0".repeat(32),
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    timestamp: ts,
  };
}

const t0 = new Date("2026-05-08T00:00:00.000Z");
const at = (ms: number): string => new Date(t0.getTime() + ms).toISOString();

const events: TraceEvent[] = [
  { ...envelope("turn_1", undefined, at(0)), kind: "turn_start", turnNumber: 1 },

  { ...envelope("model_1", "turn_1", at(50)), kind: "model_request", model: "claude-sonnet-4-6", messageCount: 3, toolCount: 2, streaming: false },
  { ...envelope("model_1", "turn_1", at(1200)), kind: "model_response", model: "claude-sonnet-4-6", stopReason: "tool_use", usage: { input: 100, output: 50 }, durationMs: 1150 },

  { ...envelope("tool_1", "turn_1", at(1250)), kind: "tool_call_start", toolUseId: "tu_1", toolName: "Read", inputBytes: 32 },
  { ...envelope("tool_1", "turn_1", at(1310)), kind: "tool_call_end", toolUseId: "tu_1", toolName: "Read", isError: false, outputBytes: 512, durationMs: 60 },

  { ...envelope("tool_2", "turn_1", at(1320)), kind: "tool_call_start", toolUseId: "tu_2", toolName: "Bash", inputBytes: 40 },
  { ...envelope("tool_2", "turn_1", at(1900)), kind: "tool_call_end", toolUseId: "tu_2", toolName: "Bash", isError: false, outputBytes: 256, durationMs: 580 },

  { ...envelope("model_2", "turn_1", at(1950)), kind: "model_request", model: "claude-sonnet-4-6", messageCount: 5, toolCount: 2, streaming: false },
  { ...envelope("model_2", "turn_1", at(2400)), kind: "model_response", model: "claude-sonnet-4-6", stopReason: "end_turn", usage: { input: 200, output: 80 }, durationMs: 450 },

  { ...envelope("turn_1", undefined, at(2450)), kind: "turn_end", turnNumber: 1 },
];

const timeline = buildTimeline(events);

process.stdout.write(`Timeline: ${timeline.spans.length} spans across ${timeline.t1 - timeline.t0}ms\n`);
process.stdout.write(`${"-".repeat(70)}\n`);

const total = Math.max(1, timeline.t1 - timeline.t0);
const BAR_WIDTH = 40;

for (const s of timeline.spans) {
  const startCol = Math.floor(((s.t0 - timeline.t0) / total) * BAR_WIDTH);
  const widthCol = Math.max(1, Math.round(((s.t1 - s.t0) / total) * BAR_WIDTH));
  const bar = " ".repeat(startCol) + "█".repeat(Math.min(widthCol, BAR_WIDTH - startCol));
  const indent = "  ".repeat(s.depth);
  const label = `${indent}${s.kind}: ${s.label.replace(/^[a-z]+: /, "")}`;
  process.stdout.write(`${label.padEnd(34)}|${bar.padEnd(BAR_WIDTH)}|  ${s.t1 - s.t0}ms\n`);
}
