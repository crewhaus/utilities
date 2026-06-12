/**
 * Hand-rolled JSON Schema mirror of @crewhaus/spec's Zod discriminated
 * union, scoped to autocomplete / lint surface VS Code consumes.
 * Drift-tested in spec-schema.test.ts against TARGET_SHAPES.
 */

const permissionRule = {
  type: "object",
  required: ["type", "pattern"],
  properties: {
    type: { enum: ["alwaysAllow", "alwaysDeny", "alwaysAsk"] },
    pattern: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

const permissions = {
  type: "object",
  properties: {
    mode: { enum: ["default", "plan", "auto"] },
    rules: { type: "array", items: permissionRule },
  },
  additionalProperties: false,
} as const;

const channelsBlock = {
  type: "object",
  properties: {
    slack: {
      type: "object",
      required: ["botToken", "signingSecret"],
      properties: {
        botToken: { type: "string", minLength: 1 },
        signingSecret: { type: "string", minLength: 1 },
        appToken: { type: "string", minLength: 1 },
      },
    },
    telegram: {
      type: "object",
      required: ["botToken", "secretToken"],
      properties: {
        botToken: { type: "string", minLength: 1 },
        secretToken: { type: "string", minLength: 1 },
      },
    },
    discord: {
      type: "object",
      required: ["applicationId", "botToken", "publicKeyHex"],
      properties: {
        applicationId: { type: "string", minLength: 1 },
        botToken: { type: "string", minLength: 1 },
        publicKeyHex: { type: "string", minLength: 1 },
      },
    },
    whatsapp: {
      type: "object",
      required: ["phoneNumberId", "accessToken", "appSecret"],
      properties: {
        phoneNumberId: { type: "string", minLength: 1 },
        accessToken: { type: "string", minLength: 1 },
        appSecret: { type: "string", minLength: 1 },
      },
    },
    imessage: {
      type: "object",
      properties: {
        chatDbPath: { type: "string" },
        cursorPath: { type: "string" },
      },
    },
  },
} as const;

const cliShape = {
  type: "object",
  required: ["name", "target", "agent"],
  properties: {
    name: { type: "string", minLength: 1 },
    target: { const: "cli" },
    agent: {
      type: "object",
      required: ["model", "instructions"],
      properties: {
        model: { type: "string", minLength: 1 },
        instructions: { type: "string", minLength: 1 },
      },
    },
    tools: { type: "array", items: { type: "string" } },
    permissions,
    mcp_servers: { type: "object" },
  },
  additionalProperties: false,
} as const;

const workflowShape = {
  type: "object",
  required: ["name", "target", "model", "steps"],
  properties: {
    name: { type: "string", minLength: 1 },
    target: { const: "workflow" },
    model: { type: "string", minLength: 1 },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "instructions"],
        properties: {
          name: { type: "string", minLength: 1 },
          instructions: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          tools: { type: "array", items: { type: "string" } },
        },
      },
    },
    permissions,
  },
} as const;

const channelShape = {
  type: "object",
  required: ["name", "target", "agent", "channels", "routing"],
  properties: {
    name: { type: "string", minLength: 1 },
    target: { const: "channel" },
    agent: {
      type: "object",
      required: ["model", "instructions"],
      properties: {
        model: { type: "string", minLength: 1 },
        instructions: { type: "string", minLength: 1 },
        tools: { type: "array", items: { type: "string" } },
      },
    },
    channels: channelsBlock,
    routing: {
      type: "object",
      required: ["sessionKey"],
      properties: { sessionKey: { enum: ["thread", "user", "channel"] } },
    },
    permissions,
  },
} as const;

function shapeWithTarget(
  target: string,
  extra: Record<string, unknown> = {},
  opts: { permissions?: boolean } = {},
) {
  return {
    type: "object",
    required: ["name", "target"],
    properties: {
      name: { type: "string", minLength: 1 },
      target: { const: target },
      ...(opts.permissions === false ? {} : { permissions }),
      ...extra,
    },
  } as const;
}

export const specSchemaJson = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://crewhaus.ai/schemas/spec.json",
  title: "CrewHaus Spec",
  description: "v0 spec discriminated on `target`. Mirrors @crewhaus/spec.",
  oneOf: [
    cliShape,
    workflowShape,
    channelShape,
    shapeWithTarget("graph", {
      entry: { type: "string", minLength: 1 },
      nodes: { type: "object" },
      edges: { type: "array" },
    }),
    shapeWithTarget("managed", {
      tenants: { type: "object" },
    }),
    shapeWithTarget("pipeline", {
      stages: { type: "array" },
    }),
    shapeWithTarget("crew", {
      roles: { type: "object" },
    }),
    shapeWithTarget("research", {
      retrieve: { type: "object" },
    }),
    shapeWithTarget("batch", {
      worker: { type: "object" },
    }),
    shapeWithTarget("voice", {
      voice: { type: "object" },
    }),
    shapeWithTarget("browser", {
      driver: { type: "object" },
    }),
    // Note the third arg: the published evalSchema is .strict() and has NO
    // permissions key (eval is the leanest target — only failure_taxonomy
    // among the cross-cutting blocks), so offering `permissions:` here
    // would autocomplete a block parseSpec rejects wholesale.
    shapeWithTarget("eval", {
      agent: { type: "object" },
      // The dataset is a registry coordinate, exactly as @crewhaus/spec's
      // eval target parses it — name + version resolve a JSONL case file
      // (the studio-server stores them under <workspace>/datasets/);
      // split defaults to "dev" when omitted. Strict like the parser, so
      // the IDE flags inline `cases:` keys @crewhaus/spec would reject.
      dataset: {
        type: "object",
        required: ["name", "version"],
        properties: {
          name: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          split: { enum: ["train", "dev", "test"] },
        },
        additionalProperties: false,
      },
      // Grader items are the strict `{ name, opts? }` entries
      // @crewhaus/spec's eval target parses — `name` is one of the six
      // grader types @crewhaus/eval-grader consumes. opts is kept
      // permissive (no per-name oneOf) — the value is autocomplete.
      graders: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              enum: [
                "exact_match",
                "contains",
                "regex",
                "json_path",
                "tool_call_sequence",
                "llm_judge",
              ],
            },
            opts: {
              type: "object",
              properties: {
                trim: { type: "boolean" },
                case_insensitive: { type: "boolean" },
                substring: { type: "string", minLength: 1 },
                pattern: { type: "string", minLength: 1 },
                flags: { type: "string" },
                expected: {},
                path: { type: "string", minLength: 1 },
                mode: { enum: ["exact", "subseq", "set"] },
                rubric: { type: "object" },
                model: { type: "string", minLength: 1 },
                weight: { type: "number", exclusiveMinimum: 0 },
              },
            },
          },
          additionalProperties: false,
        },
      },
    }, { permissions: false }),
  ],
} as const;
