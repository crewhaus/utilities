import { describe, expect, test } from "bun:test";
import {
  deletePath,
  detectTargetFromModel,
  getPath,
  parseSpecModel,
  serializeSpecModel,
  setPath,
  type SpecPath,
} from "./spec-model";
import { detectTarget, TEMPLATE_IDS, TEMPLATES } from "./templates";

// --- fixtures ---------------------------------------------------------------
// Written in the yaml stringifier's canonical style (2-space indent, indented
// sequences, padded flow collections) so byte-identical round-trips are a fair
// assertion. The SEMANTIC guarantees (comments/anchors/unknown keys survive)
// are additionally asserted content-wise, so a future stringifier tweak that
// only moves whitespace would fail loudly here rather than silently.

// NOTE the blank line before the trailing file comment: the yaml stringifier
// always separates a document-trailing comment with one, so the canonical
// form includes it (see the dedicated "gains a blank line" test below).
const COMMENTED = `# Deploys as a Cloudflare Worker from the studio.
name: commented # inline: keep me
# The shape this spec compiles to.
target: cli
agent:
  model: claude-haiku-4-5-20251001
  # multi-line
  # leading comment
  instructions: |
    Be concise and warm.
    Stay friendly.

# trailing file comment
`;

const ANCHORED = `defaults: &base
  model: claude-sonnet-4-6
  max_tokens: 8192
agent:
  <<: *base
  instructions: hi
alias_check: *base
`;

const UNKNOWN_KEYS = `name: mystery
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: hi
totally_unknown_block:
  keep: me
  even:
    - when
    - nested
x-vendor-extension: true
`;

const DEEP = `name: deep
target: workflow
model: claude-sonnet-4-6
steps:
  - name: one
    instructions: alpha
    meta:
      tags:
        - a
        - b
      nested:
        further:
          deepest:
            - leaf: 1
              twin: 2
            - leaf: 3
  - name: two
    instructions: beta
`;

const LONG_LINE = `name: long
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: This single flow line is intentionally much longer than eighty characters so that any default line folding by the serializer would rewrap it and break byte fidelity.
`;

const FIXTURES: Record<string, string> = {
  COMMENTED,
  ANCHORED,
  UNKNOWN_KEYS,
  DEEP,
  LONG_LINE,
};

/** parse + assert validity, returning the non-null doc for edit tests. */
function parseValid(text: string) {
  const parsed = parseSpecModel(text);
  expect(parsed.errors).toEqual([]);
  expect(parsed.doc).not.toBeNull();
  if (parsed.doc === null) throw new Error("unreachable: doc is null after assertion");
  return { doc: parsed.doc, model: parsed.model };
}

// --- round-trip: every shipped template --------------------------------------

describe("round-trip over TEMPLATES", () => {
  for (const id of TEMPLATE_IDS) {
    test(`template "${id}" parses cleanly and serializes byte-identical`, () => {
      const yaml = TEMPLATES[id].yaml;
      const { doc, model } = parseValid(yaml);
      expect(serializeSpecModel(doc)).toBe(yaml);
      // The plain model mirrors the YAML: name/target are readable strings.
      expect(typeof model).toBe("object");
      expect(getPath(doc, ["name"])).toBe(TEMPLATES[id].yaml.match(/^name: (.+)$/m)?.[1] ?? "");
    });

    test(`template "${id}" round-trip is idempotent (serialize∘parse twice is stable)`, () => {
      const once = serializeSpecModel(parseValid(TEMPLATES[id].yaml).doc);
      const twice = serializeSpecModel(parseValid(once).doc);
      expect(twice).toBe(once);
    });
  }
});

// --- round-trip: hostile-formatting fixtures ----------------------------------

describe("round-trip over comment/anchor/unknown-key fixtures", () => {
  for (const [label, yaml] of Object.entries(FIXTURES)) {
    test(`${label} serializes byte-identical`, () => {
      const { doc } = parseValid(yaml);
      expect(serializeSpecModel(doc)).toBe(yaml);
    });

    test(`${label} round-trip is idempotent`, () => {
      const once = serializeSpecModel(parseValid(yaml).doc);
      expect(serializeSpecModel(parseValid(once).doc)).toBe(once);
    });
  }

  test("comments survive with their exact text", () => {
    const out = serializeSpecModel(parseValid(COMMENTED).doc);
    for (const comment of [
      "# Deploys as a Cloudflare Worker from the studio.",
      "# inline: keep me",
      "# The shape this spec compiles to.",
      "# multi-line",
      "# leading comment",
      "# trailing file comment",
    ]) {
      expect(out).toContain(comment);
    }
  });

  test("anchors, aliases, and merge keys survive verbatim", () => {
    const out = serializeSpecModel(parseValid(ANCHORED).doc);
    expect(out).toContain("&base");
    expect(out).toContain("<<: *base");
    expect(out).toContain("alias_check: *base");
  });

  test("merge keys resolve into the plain model while the doc keeps them literal", () => {
    const { model } = parseValid(ANCHORED);
    const agent = (model as Record<string, Record<string, unknown>>)["agent"];
    expect(agent["model"]).toBe("claude-sonnet-4-6");
    expect(agent["max_tokens"]).toBe(8192);
    expect(agent["instructions"]).toBe("hi");
  });

  test("unknown top-level keys survive and appear in the model", () => {
    const { doc, model } = parseValid(UNKNOWN_KEYS);
    const out = serializeSpecModel(doc);
    expect(out).toContain("totally_unknown_block:");
    expect(out).toContain("x-vendor-extension: true");
    const m = model as Record<string, unknown>;
    expect(m["x-vendor-extension"]).toBe(true);
    expect(m["totally_unknown_block"]).toEqual({ keep: "me", even: ["when", "nested"] });
  });

  test("block scalars keep their literal style and content", () => {
    const out = serializeSpecModel(parseValid(COMMENTED).doc);
    expect(out).toContain("instructions: |");
    expect(out).toContain("    Be concise and warm.\n    Stay friendly.\n");
  });

  test("lines longer than 80 chars are not re-folded", () => {
    const out = serializeSpecModel(parseValid(LONG_LINE).doc);
    expect(out).toBe(LONG_LINE);
  });

  test("a doc-trailing comment with no blank line gains one but keeps its text", () => {
    // The one known formatting normalization: the stringifier always emits a
    // blank line before a document-trailing comment. Content survives intact.
    const input = "name: x\n# tail comment\n";
    const { doc } = parseValid(input);
    const out = serializeSpecModel(doc);
    expect(out).toBe("name: x\n\n# tail comment\n");
    // …and the normalized form is the fixed point.
    expect(serializeSpecModel(parseValid(out).doc)).toBe(out);
  });
});

// --- invalid input -------------------------------------------------------------

describe("parseSpecModel on invalid YAML", () => {
  const BAD_INPUTS: Record<string, string> = {
    "unclosed flow sequence": "tools: [bash, edit\nname: x\n",
    "bad indent under flow": "a: [1,\n  - b\n",
    "tab indentation": "agent:\n\tmodel: x\n",
    "multiple documents": "name: a\n---\nname: b\n",
    "unbalanced quotes": 'name: "oops\ntarget: cli\n',
  };

  for (const [label, text] of Object.entries(BAD_INPUTS)) {
    test(`${label}: errors non-empty, doc and model null`, () => {
      const parsed = parseSpecModel(text);
      expect(parsed.errors.length).toBeGreaterThan(0);
      expect(parsed.doc).toBeNull();
      expect(parsed.model).toBeNull();
      for (const err of parsed.errors) {
        expect(err.message.length).toBeGreaterThan(0);
      }
    });
  }

  test("errors carry 1-based line/col positions", () => {
    const parsed = parseSpecModel("name: ok\ntools: [a,\n");
    expect(parsed.errors.length).toBeGreaterThan(0);
    const positioned = parsed.errors.find((e) => e.line !== undefined);
    expect(positioned).toBeDefined();
    expect(positioned?.line).toBeGreaterThanOrEqual(1);
    expect(positioned?.col).toBeGreaterThanOrEqual(1);
  });

  test("empty input is VALID yaml: doc non-null, model null, no errors", () => {
    const parsed = parseSpecModel("");
    expect(parsed.errors).toEqual([]);
    expect(parsed.doc).not.toBeNull();
    expect(parsed.model).toBeNull();
  });
});

// --- path helpers ----------------------------------------------------------------

describe("getPath / setPath / deletePath", () => {
  test("getPath reads scalars, nested values, and sequence indexes as plain JS", () => {
    const { doc } = parseValid(DEEP);
    expect(getPath(doc, ["name"])).toBe("deep");
    expect(getPath(doc, ["steps", 0, "name"])).toBe("one");
    expect(getPath(doc, ["steps", 1, "instructions"])).toBe("beta");
    expect(getPath(doc, ["steps", 0, "meta", "tags", 1])).toBe("b");
    // Collections come back as plain data, not yaml Nodes.
    expect(getPath(doc, ["steps", 0, "meta", "tags"])).toEqual(["a", "b"]);
    expect(getPath(doc, ["steps", 0, "meta", "nested"])).toEqual({
      further: { deepest: [{ leaf: 1, twin: 2 }, { leaf: 3 }] },
    });
  });

  test("getPath returns undefined for a missing path", () => {
    const { doc } = parseValid(DEEP);
    expect(getPath(doc, ["nope"])).toBeUndefined();
    expect(getPath(doc, ["steps", 5, "name"])).toBeUndefined();
    expect(getPath(doc, ["steps", 0, "missing", "deeper"])).toBeUndefined();
  });

  test("setPath edits one value and leaves every comment and other key untouched", () => {
    const { doc } = parseValid(COMMENTED);
    setPath(doc, ["agent", "model"], "claude-sonnet-4-6");
    const out = serializeSpecModel(doc);
    expect(out).toBe(COMMENTED.replace("claude-haiku-4-5-20251001", "claude-sonnet-4-6"));
  });

  test("setPath creates intermediate maps for a new nested path", () => {
    const { doc } = parseValid(COMMENTED);
    setPath(doc, ["memory", "scope"], "spec");
    const out = serializeSpecModel(doc);
    expect(out).toContain("memory:\n  scope: spec");
    // Everything that was there before is still there.
    expect(out).toContain("# trailing file comment");
    expect(getPath(doc, ["memory", "scope"])).toBe("spec");
  });

  test("setPath into a sequence index replaces just that element", () => {
    const { doc } = parseValid(DEEP);
    setPath(doc, ["steps", 0, "meta", "tags", 0], "z");
    expect(getPath(doc, ["steps", 0, "meta", "tags"])).toEqual(["z", "b"]);
    expect(getPath(doc, ["steps", 1, "name"])).toBe("two");
  });

  test("setPath elsewhere leaves anchors and merge keys verbatim", () => {
    const { doc } = parseValid(ANCHORED);
    setPath(doc, ["agent", "instructions"], "bye");
    const out = serializeSpecModel(doc);
    expect(out).toContain("&base");
    expect(out).toContain("<<: *base");
    expect(out).toContain("instructions: bye");
  });

  test("deletePath removes exactly one entry and reports a miss as false", () => {
    const { doc } = parseValid(UNKNOWN_KEYS);
    expect(deletePath(doc, ["totally_unknown_block", "even"])).toBe(true);
    const out = serializeSpecModel(doc);
    expect(out).not.toContain("even:");
    expect(out).toContain("keep: me");
    expect(out).toContain("x-vendor-extension: true");
    expect(deletePath(doc, ["totally_unknown_block", "even"])).toBe(false);
    expect(deletePath(doc, ["never", "existed"])).toBe(false);
  });

  test("mutating a template still serializes every untouched line", () => {
    // Property-style check across all templates: after one edit, every
    // original line except the edited one is still present verbatim.
    for (const id of TEMPLATE_IDS) {
      const yaml = TEMPLATES[id].yaml;
      const { doc } = parseValid(yaml);
      setPath(doc, ["name"], "renamed-by-test");
      const out = serializeSpecModel(doc);
      for (const line of yaml.split("\n")) {
        if (line.startsWith("name:")) continue;
        if (line.trim().length === 0) continue;
        expect(out).toContain(line);
      }
      expect(out).toContain("name: renamed-by-test");
    }
  });
});

// --- detectTargetFromModel ---------------------------------------------------------

describe("detectTargetFromModel", () => {
  test("reads the declared target from a parsed model", () => {
    const { model } = parseValid("name: x\ntarget: workflow\n");
    expect(detectTargetFromModel(model)).toBe("workflow");
  });

  test("falls back to cli when target is absent, non-string, or blank", () => {
    expect(detectTargetFromModel({})).toBe("cli");
    expect(detectTargetFromModel({ target: 42 })).toBe("cli");
    expect(detectTargetFromModel({ target: true })).toBe("cli");
    expect(detectTargetFromModel({ target: ["cli"] })).toBe("cli");
    expect(detectTargetFromModel({ target: "   " })).toBe("cli");
    expect(detectTargetFromModel(null)).toBe("cli");
    expect(detectTargetFromModel(undefined)).toBe("cli");
    expect(detectTargetFromModel("target: cli")).toBe("cli");
    expect(detectTargetFromModel([{ target: "graph" }])).toBe("cli");
  });

  test("trims whitespace around a declared target", () => {
    expect(detectTargetFromModel({ target: " graph " })).toBe("graph");
  });

  test("agrees with the regex detectTarget and the declared target on every template", () => {
    for (const id of TEMPLATE_IDS) {
      const { model } = parseValid(TEMPLATES[id].yaml);
      expect(detectTargetFromModel(model)).toBe(TEMPLATES[id].target);
      expect(detectTargetFromModel(model)).toBe(detectTarget(TEMPLATES[id].yaml));
    }
  });

  test("outclasses the regex where regexes false-positive: target inside a block scalar", () => {
    const yaml = `name: tricky
agent:
  model: claude-sonnet-4-6
  instructions: |
    target: graph
`;
    const { model } = parseValid(yaml);
    // The only real target declaration is ABSENT — the model-aware detector
    // falls back to cli even though a "target:" line exists inside a scalar.
    expect(detectTargetFromModel(model)).toBe("cli");
  });
});

// --- SpecPath type sanity -----------------------------------------------------------

describe("SpecPath", () => {
  test("accepts mixed string/number segments", () => {
    const path: SpecPath = ["steps", 0, "meta", "tags", 1];
    const { doc } = parseValid(DEEP);
    expect(getPath(doc, path)).toBe("b");
  });
});
