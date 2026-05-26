import { describe, expect, test } from "bun:test";
import {
  CURATED_MCP_SERVERS,
  getStudioJs,
  renderMcpConnectorsPanel,
  renderMultiSpecDashboard,
  renderStudioHtml,
} from "./index.js";

describe("studio-ui (T1)", () => {
  test("renderStudioHtml emits a complete HTML document with the three nav tabs", () => {
    const html = renderStudioHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>CrewHaus Studio</title>");
    expect(html).toContain('id="tab-specs"');
    expect(html).toContain('id="tab-wizard"');
    expect(html).toContain('id="tab-plugins"');
  });

  test("renderStudioHtml supports a custom title", () => {
    const html = renderStudioHtml({ title: "Custom Title" });
    expect(html).toContain("<title>Custom Title</title>");
  });

  test("getStudioJs is callable + non-empty + references all three views", () => {
    const js = getStudioJs();
    expect(js.length).toBeGreaterThan(500);
    expect(js).toContain("renderSpecs");
    expect(js).toContain("renderWizard");
    expect(js).toContain("renderPlugins");
    expect(js).toContain("/api/specs");
    expect(js).toContain("/api/wizard/start");
    expect(js).toContain("/api/plugins");
  });
});

describe("studio-ui v1 — Section 31 multi-spec dashboard", () => {
  test("empty rows → empty-state message", () => {
    const html = renderMultiSpecDashboard([]);
    expect(html).toContain("No specs registered");
  });

  test("dashboard sorts rows alphabetically by spec name", () => {
    const html = renderMultiSpecDashboard([
      { specName: "z-spec", costUsdMicros: 1000, runCount: 1 },
      { specName: "a-spec", costUsdMicros: 500, runCount: 1 },
    ]);
    const aIdx = html.indexOf("a-spec");
    const zIdx = html.indexOf("z-spec");
    expect(aIdx).toBeLessThan(zIdx);
  });

  test("dashboard renders cost in dollars with 4 decimals", () => {
    const html = renderMultiSpecDashboard([{ specName: "x", costUsdMicros: 12_345, runCount: 3 }]);
    expect(html).toContain("$0.0123");
  });

  test("dashboard renders pass-rate as percentage when present", () => {
    const html = renderMultiSpecDashboard([
      { specName: "x", costUsdMicros: 0, passRate: 0.95, runCount: 1 },
    ]);
    expect(html).toContain("95.0%");
  });

  test("dashboard renders em-dash for missing eval data", () => {
    const html = renderMultiSpecDashboard([{ specName: "x", costUsdMicros: 0, runCount: 0 }]);
    expect(html).toContain("—");
  });

  test("dashboard escapes spec name HTML special chars", () => {
    const html = renderMultiSpecDashboard([
      { specName: "evil<script>", costUsdMicros: 0, runCount: 0 },
    ]);
    expect(html).toContain("evil&lt;script&gt;");
    expect(html).not.toContain("evil<script>");
  });
});

describe("renderMcpConnectorsPanel (M5.2)", () => {
  test("lists curated connectors: github + filesystem + postgres + fetch + memory + slack", () => {
    const html = renderMcpConnectorsPanel({});
    expect(html).toContain("GitHub");
    expect(html).toContain("Filesystem");
    expect(html).toContain("Postgres");
    expect(html).toContain("Fetch");
    expect(html).toContain("MCP reference");
    expect(html).toContain("Slack");
  });

  test("CURATED_MCP_SERVERS has at least 6 entries", () => {
    expect(CURATED_MCP_SERVERS.length).toBeGreaterThanOrEqual(6);
  });

  test("each card has an Add button bound to the connector id", () => {
    const html = renderMcpConnectorsPanel({});
    expect(html).toContain('data-id="github"');
    expect(html).toContain('data-id="filesystem"');
    expect(html).toContain('class="connector-add"');
  });

  test("currentSpecName personalizes the Add button label", () => {
    const html = renderMcpConnectorsPanel({ currentSpecName: "my-bot" });
    expect(html).toContain("my-bot");
  });

  test("env-var requirements are surfaced as a hint", () => {
    const html = renderMcpConnectorsPanel({});
    expect(html).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(html).toContain("SLACK_BOT_TOKEN");
    expect(html).toContain("SLACK_TEAM_ID");
  });

  test("custom catalog override displaces the default list", () => {
    const html = renderMcpConnectorsPanel({
      catalog: [
        {
          id: "custom",
          displayName: "Custom",
          description: "A test entry.",
          transport: "stdio",
          stdio: { command: "echo", args: ["hi"] },
        },
      ],
    });
    expect(html).toContain("Custom");
    expect(html).not.toContain("GitHub");
  });

  test("escapes HTML in spec name + connector display fields", () => {
    const html = renderMcpConnectorsPanel({
      currentSpecName: "evil<script>",
      catalog: [
        {
          id: "x",
          displayName: "<a>",
          description: "<b>",
          transport: "stdio",
          stdio: { command: "rm", args: ["-rf", "/"] },
        },
      ],
    });
    expect(html).toContain("evil&lt;script&gt;");
    expect(html).toContain("&lt;a&gt;");
    expect(html).not.toContain("<script>");
    // Note: <a> appears nowhere because we escape it; ensure no unescaped <b> either
    expect(html.indexOf("<b>")).toBe(-1);
  });
});
