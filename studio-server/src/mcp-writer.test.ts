import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  appendMcpServerToSpecYaml,
  McpWriterError,
  mcpServerEntryYaml,
  type McpServerConfig,
} from "./mcp-writer";

const github: McpServerConfig = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_PERSONAL_ACCESS_TOKEN" },
};
const fetchSrv: McpServerConfig = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-fetch"],
};

const base = "name: x\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n";

describe("mcpServerEntryYaml", () => {
  test("emits a stdio entry that parses to the config", () => {
    const y = `mcp_servers:\n${mcpServerEntryYaml("github", github).split("\n").map((l) => `  ${l}`).join("\n")}`;
    const parsed = parse(y) as { mcp_servers: Record<string, unknown> };
    expect(parsed.mcp_servers["github"]).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_PERSONAL_ACCESS_TOKEN" },
    });
  });
  test("rejects an unsafe server name", () => {
    expect(() => mcpServerEntryYaml("../evil", github)).toThrow(McpWriterError);
  });
  test("requires command for stdio, url for sse", () => {
    expect(() => mcpServerEntryYaml("x", { transport: "stdio" })).toThrow(/command/);
    expect(() => mcpServerEntryYaml("x", { transport: "sse" })).toThrow(/url/);
  });
});

describe("appendMcpServerToSpecYaml", () => {
  test("creates the block, then extends it, preserving comments", () => {
    const one = appendMcpServerToSpecYaml(`# hi\n${base}`, "github", github);
    const two = appendMcpServerToSpecYaml(one, "fetch", fetchSrv);
    expect(two).toContain("# hi");
    const parsed = parse(two) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(parsed.mcp_servers).sort()).toEqual(["fetch", "github"]);
  });
  test("replaces a same-named entry in place", () => {
    const once = appendMcpServerToSpecYaml(base, "github", github);
    const twice = appendMcpServerToSpecYaml(once, "github", github);
    const parsed = parse(twice) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(parsed.mcp_servers)).toEqual(["github"]);
  });
  test("replaces empty flow map", () => {
    const out = appendMcpServerToSpecYaml(`${base}mcp_servers: {}\n`, "github", github);
    const parsed = parse(out) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(parsed.mcp_servers)).toEqual(["github"]);
  });
  test("throws on inline flow style", () => {
    expect(() => appendMcpServerToSpecYaml(`${base}mcp_servers: {a: 1}\n`, "github", github)).toThrow(
      /inline flow/,
    );
  });
});
