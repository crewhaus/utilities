// Comment/order-preserving write-back for a spec's `mcp_servers:` map — the
// studio-server half of the "MCP connectors picker" parity item.
//
// The studio-ui Connectors tab (and the PWA's /author Connectors tab, which
// carries the same curated catalog in studio-pwa/src/lib/mcp-catalog.ts) POST a
// resolved server config here; this inserts one `<name>: { transport, command,
// args, env }` entry as a pure text edit — creating the block, extending it, or
// replacing a same-named entry in place. Mirrors grader-builder's
// appendGraderToSpecYaml discipline (no full parse → serialize, so comments and
// key order survive). Dependency-free + pure so it unit-tests in isolation.

export type McpServerConfig = {
  readonly transport: "stdio" | "sse";
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
};

export class McpWriterError extends Error {
  override readonly name = "McpWriterError";
  constructor(message: string) {
    super(message);
  }
}

const PLAIN_SCALAR_RE = /^[A-Za-z/_$][A-Za-z0-9 _./$@()[\]:-]*$/;
const AMBIGUOUS = new Set(["true", "false", "yes", "no", "on", "off", "null", "~"]);
const NAME_RE = /^[A-Za-z_][\w-]*$/;
const TOP_LEVEL_KEY_RE = /^[A-Za-z_][\w-]*:/;

function scalar(v: string): string {
  if (PLAIN_SCALAR_RE.test(v) && !AMBIGUOUS.has(v.toLowerCase()) && v === v.trim()) return v;
  return JSON.stringify(v); // double-quoted JSON strings are valid YAML
}

/** The `<name>: {…}` entry as YAML lines, base indent 0. */
export function mcpServerEntryYaml(name: string, cfg: McpServerConfig): string {
  if (!NAME_RE.test(name)) {
    throw new McpWriterError(`mcp server name "${name}" must be a plain identifier`);
  }
  const lines: string[] = [`${name}:`, `  transport: ${cfg.transport}`];
  if (cfg.transport === "stdio") {
    if (!cfg.command) throw new McpWriterError("stdio connector requires a command");
    lines.push(`  command: ${scalar(cfg.command)}`);
    if (cfg.args && cfg.args.length > 0) {
      lines.push("  args:");
      for (const a of cfg.args) lines.push(`    - ${scalar(a)}`);
    }
  } else {
    if (!cfg.url) throw new McpWriterError("sse connector requires a url");
    lines.push(`  url: ${scalar(cfg.url)}`);
  }
  if (cfg.env && Object.keys(cfg.env).length > 0) {
    lines.push("  env:");
    for (const [k, v] of Object.entries(cfg.env)) lines.push(`    ${k}: ${scalar(v)}`);
  }
  return lines.join("\n");
}

/**
 * Insert `name`'s config into the spec's `mcp_servers:` map, preserving
 * comments + key order. Creates the block when absent, replaces the empty flow
 * map `{}`, replaces a same-named entry in place, or appends. Throws on inline
 * flow style (`mcp_servers: {a: 1}`).
 */
export function appendMcpServerToSpecYaml(
  specYaml: string,
  name: string,
  cfg: McpServerConfig,
): string {
  const entry = mcpServerEntryYaml(name, cfg)
    .split("\n")
    .map((l) => (l === "" ? l : `  ${l}`))
    .join("\n");
  const lines = specYaml.split("\n");

  const idx = lines.findIndex((l) => /^mcp_servers:/.test(l));
  if (idx === -1) {
    const base = specYaml.replace(/\n*$/, "\n");
    return `${base}mcp_servers:\n${entry}\n`;
  }
  const line = lines[idx] as string;
  if (/^mcp_servers:\s*\{\s*\}\s*$/.test(line)) {
    lines.splice(idx, 1, "mcp_servers:", ...entry.split("\n"));
    return lines.join("\n");
  }
  if (/^mcp_servers:\s*\{/.test(line)) {
    throw new McpWriterError(
      "the spec's mcp_servers: uses inline flow style — convert it to a block mapping first",
    );
  }

  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (TOP_LEVEL_KEY_RE.test(l) || /^(---|\.\.\.)\s*$/.test(l)) {
      end = i;
      break;
    }
  }
  const keyRe = new RegExp(`^  ${name}:`);
  const existingAt = lines.slice(idx + 1, end).findIndex((l) => keyRe.test(l));
  if (existingAt !== -1) {
    const start = idx + 1 + existingAt;
    let stop = start + 1;
    while (stop < end && /^\s+/.test(lines[stop] as string) && !/^  \S/.test(lines[stop] as string)) {
      stop++;
    }
    lines.splice(start, stop - start, ...entry.split("\n"));
    return lines.join("\n");
  }
  while (end > idx + 1 && (lines[end - 1] as string).trim() === "") end--;
  lines.splice(end, 0, ...entry.split("\n"));
  return lines.join("\n");
}
