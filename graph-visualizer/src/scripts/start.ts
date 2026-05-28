/**
 * `bun run start` entry point for `@crewhaus/graph-visualizer`.
 *
 * Lays out a 4-node sample graph (plan → execute → review → publish)
 * via `layoutGraph`, renders to SVG via `renderSvg`, writes the
 * result to `graph.svg`, and prints the layout summary.
 */
import type { IrGraphV0 } from "@crewhaus/ir";
import { layoutGraph, renderSvg } from "../index";

const ir: IrGraphV0 = {
  version: 0,
  name: "demo-graph",
  target: "graph",
  entry: "plan",
  nodes: [
    { name: "plan", instructions: "Plan the work", model: "claude-sonnet-4-6", tools: [], toolConfigs: Object.freeze({}) },
    { name: "execute", instructions: "Execute the plan", model: "claude-sonnet-4-6", tools: [], toolConfigs: Object.freeze({}) },
    { name: "review", instructions: "Review the output", model: "claude-sonnet-4-6", tools: [], toolConfigs: Object.freeze({}) },
    { name: "publish", instructions: "Publish the result", model: "claude-sonnet-4-6", tools: [], toolConfigs: Object.freeze({}) },
  ],
  edges: [
    { from: "plan", to: "execute" },
    { from: "execute", to: "review" },
    { from: "review", to: "publish" },
  ],
  permissions: { rules: [] },
  compaction: {},
};

const layout = layoutGraph(ir);
const svg = renderSvg(layout);
const outPath = `${process.cwd()}/graph.svg`;
await Bun.write(outPath, svg);

process.stdout.write(`✓ Wrote ${outPath}\n`);
process.stdout.write(`  nodes: ${layout.nodes.length}\n`);
process.stdout.write(`  edges: ${layout.edges.length}\n`);
process.stdout.write(`  size:  ${layout.width} × ${layout.height} px\n`);
process.stdout.write(`\n`);
for (const n of layout.nodes) {
  process.stdout.write(`  ${n.id.padEnd(10)} at (${n.x}, ${n.y})\n`);
}
process.stdout.write(`\nOpen with: open graph.svg\n`);
