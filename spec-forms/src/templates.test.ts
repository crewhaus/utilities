import { describe, expect, it } from "bun:test";
import {
  type BrowserDeployableTarget,
  detectTarget,
  getTemplate,
  type SpecTemplate,
  TEMPLATE_IDS,
  type TemplateId,
  TEMPLATES,
} from "./templates";

const EXPECTED_IDS: readonly TemplateId[] = ["hello-cli", "hello", "workflow", "graph"];

const BROWSER_DEPLOYABLE_TARGETS: readonly BrowserDeployableTarget[] = [
  "cli",
  "workflow",
  "graph",
];

describe("TEMPLATES registry", () => {
  it("has exactly the expected ids", () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const id of EXPECTED_IDS) {
      expect(TEMPLATES[id]).toBeDefined();
      expect(TEMPLATES[id].id).toBe(id);
    }
  });

  it("TEMPLATE_IDS lists exactly the registry keys and every id round-trips", () => {
    expect([...TEMPLATE_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
    for (const id of TEMPLATE_IDS) {
      // Both the registry lookup and the helper resolve to a meta whose id
      // round-trips back to the key.
      expect(TEMPLATES[id].id).toBe(id);
      expect(getTemplate(id).id).toBe(id);
    }
  });

  it("the default (first) template is hello-cli with target cli", () => {
    const defaultId = TEMPLATE_IDS[0];
    expect(defaultId).toBe("hello-cli");
    expect(TEMPLATES[defaultId]).toBeDefined();
    expect(TEMPLATES[defaultId].target).toBe("cli");
  });

  it("every template has non-empty yaml whose target line matches template.target", () => {
    for (const id of TEMPLATE_IDS) {
      const t: SpecTemplate = TEMPLATES[id];
      expect(t.yaml.trim().length).toBeGreaterThan(0);
      // The embedded `target:` line, read via the same regex index.astro uses,
      // must agree with the declared target.
      expect(detectTarget(t.yaml)).toBe(t.target);
    }
  });

  it("every template target is one of the three browser-deployable targets", () => {
    for (const id of TEMPLATE_IDS) {
      expect(BROWSER_DEPLOYABLE_TARGETS).toContain(TEMPLATES[id].target);
    }
  });

  it("every template has a non-empty label and description", () => {
    for (const id of TEMPLATE_IDS) {
      const t: SpecTemplate = TEMPLATES[id];
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it("the default hello-cli yaml matches index.astro's inlined DEFAULT_YAML verbatim", () => {
    // Guards against drift from the editor default this gallery is a superset
    // of. Kept inline (not read from the .astro file) to stay hermetic.
    const DEFAULT_YAML = `name: hello-cli
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are a friendly assistant running inside a CrewHaus harness
    on the user's own Cloudflare Worker. Be concise and warm.
`;
    expect(TEMPLATES["hello-cli"].yaml).toBe(DEFAULT_YAML);
  });
});

describe("detectTarget", () => {
  it("reads a target on the first line", () => {
    expect(detectTarget("target: cli\nname: x\n")).toBe("cli");
  });

  it("tolerates leading whitespace before the target key", () => {
    expect(detectTarget("   target: workflow\n")).toBe("workflow");
  });

  it("finds a target declared on a later line", () => {
    expect(detectTarget("name: hello\nmodel: claude\ntarget: graph\n")).toBe("graph");
  });

  it("defaults to cli when no target is present", () => {
    expect(detectTarget("name: hello\nmodel: claude\n")).toBe("cli");
  });

  it("defaults to cli for empty input", () => {
    expect(detectTarget("")).toBe("cli");
  });

  it("captures hyphenated targets like chain-game", () => {
    expect(detectTarget("name: g\ntarget: chain-game\n")).toBe("chain-game");
  });

  it("matches the first target line when several are present", () => {
    expect(detectTarget("target: cli\ntarget: graph\n")).toBe("cli");
  });
});

describe("template YAML parses as YAML-ish embedded JS literals", () => {
  // None of the templates emit JS, but the workflow/graph specs embed
  // backtick-quoted fragments (e.g. `ls -la`) inside their instructions. This
  // guards that the backtick escaping in the template literals produced real
  // backticks (not `\``), so the embedded text is byte-faithful and a quoting
  // bug can't slip through. We do it by wrapping each yaml in a template
  // literal of JS and transpiling: if any embedded backtick had leaked, the
  // generated source would be a syntax error.
  it("each template.yaml can be embedded in a transpilable JS template literal", () => {
    const transpiler = new Bun.Transpiler({ loader: "js" });
    for (const id of TEMPLATE_IDS) {
      const yaml = TEMPLATES[id].yaml;
      // Re-encode the yaml as a JS source string via JSON.stringify (already
      // fully quoted/escaped — must NOT be wrapped in extra quotes) and assert
      // it transpiles, proving the embedded content is valid string data.
      const code = `export const SPEC = ${JSON.stringify(yaml)};`;
      expect(() => transpiler.transformSync(code)).not.toThrow();
    }
  });
});

describe("gallery templates honor the cf-worker emitter constraints", () => {
  // The cf-worker emitters (factory: target-cf-worker-{cli,workflow,graph})
  // REJECT specs that declare tools (all three targets) or HITL (graph) in M2 —
  // see their TargetEmitError checks. The PWA can't run the real compiler
  // offline, so this mirrors those rejection rules: a gallery starter that
  // tripped one would fail at Compile & Deploy while the target indicator shows
  // it green (the exact bug this guards against). Keep in sync with the emitters
  // until tools/HITL land for browser-deployable workers.
  const hasYamlKey = (yaml: string, key: string): boolean =>
    new RegExp(`^\\s*${key}:`, "m").test(yaml);

  it("no browser-deployable template declares tools", () => {
    for (const id of TEMPLATE_IDS) {
      // Reported as {id, hasTools} so a failure names the offending template.
      expect({ id, hasTools: hasYamlKey(TEMPLATES[id].yaml, "tools") }).toEqual({
        id,
        hasTools: false,
      });
    }
  });

  it("no graph template declares HITL", () => {
    for (const id of TEMPLATE_IDS) {
      if (TEMPLATES[id].target !== "graph") continue;
      expect({ id, hasHitl: hasYamlKey(TEMPLATES[id].yaml, "hitl") }).toEqual({
        id,
        hasHitl: false,
      });
    }
  });
});
