/**
 * Catalog F4 `studio-server` — Section 26 Studio.
 *
 * Bun.serve daemon. v0 endpoints:
 *
 *   GET  /healthz                       → 200 OK
 *   GET  /api/templates                 → list scaffold-templates
 *   GET  /api/templates/:id             → single template (yaml body)
 *   GET  /api/specs                     → list specs in workspace
 *   POST /api/specs                     → create spec; body { name, yaml }
 *   GET  /api/specs/:name               → single spec yaml + parsed
 *   PUT  /api/specs/:name               → overwrite spec yaml
 *   DELETE /api/specs/:name             → remove spec
 *   POST /api/wizard/start              → → wizard state
 *   POST /api/wizard/step               → state + answer → state
 *   POST /api/wizard/compile            → state → { yaml, envExample }
 *   POST /api/grader-wizard/start       → → grader-builder state
 *   POST /api/grader-wizard/step        → state + answer → state (400 + message on invalid answer)
 *   POST /api/grader-wizard/compile     → state → { grader, yamlEntry, yamlBlock }
 *   POST /api/specs/:name/graders       → { state } → append compiled grader to the eval spec
 *   POST /api/dataset-wizard/start      → → dataset-builder state
 *   POST /api/dataset-wizard/step       → state + answer → state (400 + message on invalid answer)
 *   POST /api/dataset-wizard/compile    → state → { dataset, cases, yamlBlock, jsonl, path }
 *   GET  /api/datasets                  → list dataset coordinates under <workspace>/datasets/
 *   GET  /api/datasets/:name/:version/:split → stored cases (422 when the file is invalid)
 *   POST /api/datasets                  → { state } → write datasets/<n>/<v>/<s>.jsonl (409 on conflicting content)
 *   POST /api/specs/:name/dataset       → { state, create? } → set the eval spec's dataset: block + write
 *                                         the JSONL sidecar; with create:{model,instructions} a missing
 *                                         spec is created as a starter eval spec around the dataset
 *   POST /api/runs                      → { specName, prompt } → { runId }
 *   GET  /api/runs/:runId/events        → SSE stream of TraceEvent JSON lines
 *   GET  /api/graph-layout/:specName    → if target===graph, return layoutGraph result
 *   GET  /api/plugins                   → list discovered plugins
 *
 * Auth: HS256 JWT bearer alongside the Section-20 gateway-server's
 * scheme. v0 ships an OPEN mode (no auth) when STUDIO_DEV=1 is set,
 * mainly for the smoke. Production deployments would wrap this with
 * the same gateway-server auth surface.
 *
 * SSE for runs: when a run is created we synthesize a fake/canned
 * event stream for the smoke (the harness asserts on the events). A
 * follow-up PR threads in real `runChatLoop` invocation; today we
 * emit `run_start | trace | run_done` stubs to prove the SSE path
 * works.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  type DatasetAnswer,
  type DatasetBuilderState,
  DatasetBuilderError,
  type DatasetSplit,
  answerDataset,
  buildEvalSpecStarterYaml,
  compileDataset,
  isDatasetNameSafe,
  isDatasetVersionSafe,
  nextQuestion as nextDatasetQuestion,
  parseDatasetJsonl,
  setDatasetInSpecYaml,
  startDatasetBuilder,
} from "@crewhaus/dataset-builder";
import { CrewhausError } from "@crewhaus/errors";
import { layoutGraph, renderSvg } from "@crewhaus/graph-visualizer";
import type { IrGraphV0 } from "@crewhaus/ir";
import {
  type GraderAnswer,
  type GraderBuilderState,
  GraderBuilderError,
  answerGrader,
  appendGraderToSpecYaml,
  compileGrader,
  nextQuestion as nextGraderQuestion,
  startGraderBuilder,
} from "@crewhaus/grader-builder";
import { type StudioPluginDefinition, assertPluginPathsStaySandboxed } from "@crewhaus/studio-plugin-sdk";
import { type TemplateId, getTemplate, listTemplates } from "@crewhaus/scaffold-templates";
import { parseSpec } from "@crewhaus/spec";
import {
  type WizardAnswer,
  type WizardState,
  answerWizard,
  compileWizard,
  nextQuestion,
  startWizard,
} from "@crewhaus/wizard";
import { parse as parseYaml } from "yaml";

export class StudioServerError extends CrewhausError {
  override readonly name = "StudioServerError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Section 31 — RunDispatcher injection. v0 ships with a canned-event
 * emitter; v1 callers can inject a real dispatcher that spawns
 * `runChatLoop` (or any equivalent agent runtime). The dispatcher
 * receives a fresh `runId` + the spec name + prompt and pushes events
 * into the same run-event queue the SSE subscribers consume.
 */
export type RunDispatcher = (req: {
  readonly runId: string;
  readonly specName: string;
  readonly prompt: string;
  /** Push an event into the run's SSE queue. */
  readonly publish: (event: { kind: string; [k: string]: unknown }) => void;
  /** Mark the run as done; the SSE consumer will close. */
  readonly finish: (finalText: string) => void;
  /** Abort signal that fires on `/api/runs/:runId/cancel`. */
  readonly signal: AbortSignal;
}) => Promise<void> | void;

/**
 * Section 31 — replay source. v1 callers wire this to §10 event-log so
 * `/api/runs/:runId/replay` re-emits a prior run's events. v0 default
 * returns the in-memory event buffer.
 */
export type ReplaySource = (
  runId: string,
) => Promise<ReadonlyArray<{ kind: string; [k: string]: unknown }> | undefined>;

/**
 * Section 31 — cost summary source. Wired to §27 cost-tracker
 * aggregations. Returns total + per-provider micros.
 */
export type CostSummarySource = (query: {
  readonly tenantId?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
}) => Promise<{
  readonly totalUsdMicros: number;
  readonly byProvider: Readonly<Record<string, number>>;
}>;

export type StudioServerOptions = {
  readonly port?: number;
  /** Spec workspace root; defaults to CWD/specs. */
  readonly workspaceDir?: string;
  /** Plugin root; defaults to ~/.crewhaus/plugins/. */
  readonly pluginRoot?: string;
  /** Dev mode disables auth. v0 default: true. */
  readonly devMode?: boolean;
  /** Section 31 — inject a real dispatcher to replace canned events. */
  readonly runDispatcher?: RunDispatcher;
  /** Section 31 — replay source for /api/runs/:runId/replay. */
  readonly replaySource?: ReplaySource;
  /** Section 31 — cost summary source for /api/cost-summary. */
  readonly costSummarySource?: CostSummarySource;
  /** Section 31 — JWT verifier for production auth. Default: dev-mode pass-through. */
  readonly verifyJwt?: (token: string) => Promise<{ readonly tenantId?: string }>;
};

export type StudioServerHandle = {
  readonly port: number;
  stop(): Promise<void>;
};

// Allow single-char names; multi-char must start + end alnum (no
// leading/trailing hyphen). Pattern matches a single alnum OR alnum-…-alnum.
const SAFE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function safeName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text: string, status = 200, contentType = "text/plain"): Response {
  return new Response(text, { status, headers: { "content-type": contentType } });
}

/**
 * Key-order-independent JSON form, for comparing a compiled grader
 * against the entries already in a spec's `graders:` array.
 */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export async function startStudioServer(
  opts: StudioServerOptions = {},
): Promise<StudioServerHandle> {
  const port = opts.port ?? 0;
  const cwd = process.cwd();
  const workspaceDir = resolvePath(opts.workspaceDir ?? join(cwd, "specs"));
  const pluginRoot = opts.pluginRoot ?? join(process.env["HOME"] ?? "", ".crewhaus", "plugins");
  const dev = opts.devMode ?? true;

  mkdirSync(workspaceDir, { recursive: true });

  // In-memory run registry. Each run owns a queue of SSE events that
  // open subscribers consume. v0 emits canned events; a follow-up PR
  // wires in real runChatLoop dispatch.
  type RunEvent = { kind: string; [k: string]: unknown };
  const runs = new Map<
    string,
    {
      events: RunEvent[];
      done: boolean;
      subscribers: Set<(ev: RunEvent | "DONE") => void>;
      finalText: string;
    }
  >();
  // Section 31 — per-run AbortController for /api/runs/:runId/cancel
  const runAborts = new Map<string, AbortController>();

  function pushRunEvent(runId: string, ev: RunEvent): void {
    const r = runs.get(runId);
    if (r === undefined) return;
    r.events.push(ev);
    for (const cb of r.subscribers) cb(ev);
  }

  function finishRun(runId: string, finalText: string): void {
    const r = runs.get(runId);
    if (r === undefined) return;
    r.done = true;
    r.finalText = finalText;
    for (const cb of r.subscribers) cb("DONE");
  }

  // -------------------------------------------------------------------------
  // Plugins — scan pluginRoot, lazy-load via dynamic import.
  // -------------------------------------------------------------------------
  async function discoverPlugins(): Promise<StudioPluginDefinition[]> {
    if (!existsSync(pluginRoot)) return [];
    const out: StudioPluginDefinition[] = [];
    for (const dirent of readdirSync(pluginRoot)) {
      const dir = join(pluginRoot, dirent);
      if (!statSync(dir).isDirectory()) continue;
      const entry = join(dir, "index.ts");
      if (!existsSync(entry)) continue;
      try {
        const mod = (await import(entry)) as { default?: StudioPluginDefinition };
        if (mod.default !== undefined) {
          assertPluginPathsStaySandboxed(mod.default, dir);
          out.push(mod.default);
        }
      } catch (err) {
        process.stderr.write(`[studio] plugin load failed ${entry}: ${(err as Error).message}\n`);
      }
    }
    return out;
  }

  function specPath(name: string): string {
    if (!safeName(name)) {
      throw new StudioServerError(`unsafe spec name: ${name}`);
    }
    return join(workspaceDir, `${name}.yaml`);
  }

  function listSpecs(): Array<{ name: string; target: string }> {
    if (!existsSync(workspaceDir)) return [];
    const out: Array<{ name: string; target: string }> = [];
    for (const f of readdirSync(workspaceDir)) {
      if (!f.endsWith(".yaml")) continue;
      const name = f.replace(/\.yaml$/, "");
      try {
        const yaml = readFileSync(join(workspaceDir, f), "utf8");
        const spec = parseSpec(yaml);
        out.push({ name, target: spec.target });
      } catch {
        // skip malformed
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Dataset sidecar files live in the workspace next to the specs they
  // feed: <workspaceDir>/datasets/<name>/<version>/<split>.jsonl — the
  // registry layout the eval target's dataset coordinate resolves to.
  const SPLITS: ReadonlyArray<DatasetSplit> = ["train", "dev", "test"];

  function datasetFilePath(name: string, version: string, split: DatasetSplit): string {
    if (!isDatasetNameSafe(name) || !isDatasetVersionSafe(version)) {
      throw new StudioServerError(`unsafe dataset coordinate: ${name}/${version}`);
    }
    return join(workspaceDir, "datasets", name, version, `${split}.jsonl`);
  }

  function listDatasets(): Array<{
    name: string;
    version: string;
    split: string;
    cases: number | null;
  }> {
    const root = join(workspaceDir, "datasets");
    if (!existsSync(root)) return [];
    const out: Array<{ name: string; version: string; split: string; cases: number | null }> = [];
    for (const name of readdirSync(root)) {
      const nameDir = join(root, name);
      if (!isDatasetNameSafe(name) || !statSync(nameDir).isDirectory()) continue;
      for (const version of readdirSync(nameDir)) {
        const versionDir = join(nameDir, version);
        if (!isDatasetVersionSafe(version) || !statSync(versionDir).isDirectory()) continue;
        for (const f of readdirSync(versionDir)) {
          if (!f.endsWith(".jsonl")) continue;
          const split = f.replace(/\.jsonl$/, "");
          if (!SPLITS.includes(split as DatasetSplit)) continue;
          let cases: number | null = null;
          try {
            cases = parseDatasetJsonl(readFileSync(join(versionDir, f), "utf8")).length;
          } catch {
            // hand-edited into invalidity — listed with cases: null so the UI can flag it
          }
          out.push({ name, version, split, cases });
        }
      }
    }
    return out.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.version.localeCompare(b.version) ||
        a.split.localeCompare(b.split),
    );
  }

  // -------------------------------------------------------------------------
  // HTTP fetch handler.
  // -------------------------------------------------------------------------
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    void dev; // auth disabled in v0; reserved for follow-up

    if (p === "/healthz") return textResponse("ok");

    // Root index — minimal HTML for the smoke probe.
    if (p === "/" && m === "GET") {
      return textResponse(
        "<!doctype html><html><head><title>Studio</title></head><body><h1>CrewHaus Studio</h1><p>API root: <code>/api</code></p></body></html>",
        200,
        "text/html",
      );
    }

    // ---- templates ------------------------------------------------------
    if (p === "/api/templates" && m === "GET") {
      return jsonResponse({ templates: listTemplates() });
    }
    const mt = /^\/api\/templates\/([a-z0-9-]+)$/.exec(p);
    if (mt && m === "GET") {
      const t = getTemplate(mt[1] as TemplateId);
      if (!t) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse(t);
    }

    // ---- specs ----------------------------------------------------------
    if (p === "/api/specs" && m === "GET") return jsonResponse({ specs: listSpecs() });
    if (p === "/api/specs" && m === "POST") {
      const body = (await req.json()) as { name?: string; yaml?: string };
      if (typeof body.name !== "string" || typeof body.yaml !== "string") {
        return jsonResponse({ error: "name + yaml required" }, 400);
      }
      try {
        parseSpec(body.yaml); // validate
      } catch (err) {
        return jsonResponse({ error: "invalid spec", detail: (err as Error).message }, 400);
      }
      try {
        writeFileSync(specPath(body.name), body.yaml, { mode: 0o600 });
      } catch (err) {
        return jsonResponse({ error: "write failed", detail: (err as Error).message }, 400);
      }
      return jsonResponse({ name: body.name }, 201);
    }
    const ms = /^\/api\/specs\/([a-z0-9-]+)$/i.exec(p);
    if (ms) {
      const name = ms[1] as string;
      if (!safeName(name)) return jsonResponse({ error: "unsafe name" }, 400);
      const fp = specPath(name);
      if (m === "GET") {
        if (!existsSync(fp)) return jsonResponse({ error: "not found" }, 404);
        const yaml = readFileSync(fp, "utf8");
        let parsed: unknown;
        try {
          parsed = parseSpec(yaml);
        } catch (err) {
          return jsonResponse({ error: "spec invalid", detail: (err as Error).message }, 422);
        }
        return jsonResponse({ name, yaml, parsed });
      }
      if (m === "PUT") {
        const body = (await req.json()) as { yaml?: string };
        if (typeof body.yaml !== "string") return jsonResponse({ error: "yaml required" }, 400);
        try {
          parseSpec(body.yaml);
        } catch (err) {
          return jsonResponse({ error: "invalid", detail: (err as Error).message }, 400);
        }
        writeFileSync(fp, body.yaml, { mode: 0o600 });
        return jsonResponse({ name });
      }
      if (m === "DELETE") {
        if (existsSync(fp)) rmSync(fp);
        return jsonResponse({ deleted: name });
      }
    }

    // ---- wizard ---------------------------------------------------------
    if (p === "/api/wizard/start" && m === "POST") {
      const state = startWizard();
      return jsonResponse({ state, nextQuestion: nextQuestion(state) ?? null });
    }
    if (p === "/api/wizard/step" && m === "POST") {
      const body = (await req.json()) as { state?: WizardState; answer?: WizardAnswer };
      if (!body.state || !body.answer) return jsonResponse({ error: "state+answer required" }, 400);
      const next = answerWizard(body.state, body.answer);
      return jsonResponse({ state: next, nextQuestion: nextQuestion(next) ?? null });
    }
    if (p === "/api/wizard/compile" && m === "POST") {
      const body = (await req.json()) as { state?: WizardState };
      if (!body.state) return jsonResponse({ error: "state required" }, 400);
      try {
        const result = compileWizard(body.state);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
    }

    // ---- grader builder ---------------------------------------------------
    // Same start/step/compile envelope as the wizard; validation errors
    // from answerGrader surface as 400 + message so the Graders tab can
    // render them inline next to the offending field.
    //
    // Clients send `state` back verbatim, but it is never trusted: every
    // endpoint replays the answers through the state machine, so a
    // hand-crafted state (wrong types, skipped validation) is a 400, not
    // a persisted spec.
    function replayGraderState(state: GraderBuilderState): GraderBuilderState {
      let replayed = startGraderBuilder();
      for (const answer of state.answers ?? []) replayed = answerGrader(replayed, answer);
      return replayed;
    }
    if (p === "/api/grader-wizard/start" && m === "POST") {
      const state = startGraderBuilder();
      return jsonResponse({ state, nextQuestion: nextGraderQuestion(state) ?? null });
    }
    if (p === "/api/grader-wizard/step" && m === "POST") {
      const body = (await req.json()) as { state?: GraderBuilderState; answer?: GraderAnswer };
      if (!body.state || !body.answer) return jsonResponse({ error: "state+answer required" }, 400);
      try {
        const next = answerGrader(replayGraderState(body.state), body.answer);
        return jsonResponse({ state: next, nextQuestion: nextGraderQuestion(next) ?? null });
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
    }
    if (p === "/api/grader-wizard/compile" && m === "POST") {
      const body = (await req.json()) as { state?: GraderBuilderState };
      if (!body.state) return jsonResponse({ error: "state required" }, 400);
      try {
        return jsonResponse(compileGrader(replayGraderState(body.state)));
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
    }
    const mgr = /^\/api\/specs\/([a-z0-9-]+)\/graders$/i.exec(p);
    if (mgr && m === "POST") {
      const name = mgr[1] as string;
      if (!safeName(name)) return jsonResponse({ error: "unsafe name" }, 400);
      const fp = specPath(name);
      // Drain + compile the request BEFORE touching the file: reading the
      // spec while the client still streams the body would hold a stale
      // copy for as long as the client likes, silently reverting any
      // concurrent PUT when written back.
      const body = (await req.json()) as { state?: GraderBuilderState };
      if (!body.state) return jsonResponse({ error: "state required" }, 400);
      // Compile server-side from the replayed state — the state machine
      // stays the single source of truth; clients never send raw YAML.
      let result: ReturnType<typeof compileGrader>;
      try {
        result = compileGrader(replayGraderState(body.state));
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
      if (!existsSync(fp)) return jsonResponse({ error: "spec not found" }, 404);
      const yaml = readFileSync(fp, "utf8");
      // Pre-check with a LOOSE parse: a draft eval spec without graders is
      // not yet valid under @crewhaus/spec (graders has min 1), but appending
      // its first grader is exactly what makes it valid. The strict parse
      // below remains the persistence gate.
      let parsed: { target?: unknown; graders?: unknown };
      try {
        parsed = parseYaml(yaml) as typeof parsed;
      } catch (err) {
        return jsonResponse({ error: "spec invalid", detail: (err as Error).message }, 422);
      }
      if (parsed === null || typeof parsed !== "object" || parsed.target !== "eval") {
        return jsonResponse(
          { error: "spec is not an eval target", target: parsed?.target ?? null },
          400,
        );
      }
      const existing = Array.isArray(parsed.graders) ? parsed.graders : [];
      if (existing.some((g) => canonicalJson(g) === canonicalJson(result.grader))) {
        return jsonResponse(
          { error: "identical grader already in spec", graderName: result.grader.name },
          409,
        );
      }
      let next: string;
      try {
        next = appendGraderToSpecYaml(yaml, result.yamlEntry);
        parseSpec(next); // defensive: never persist a spec the parser rejects
      } catch (err) {
        const status = err instanceof GraderBuilderError ? 400 : 422;
        return jsonResponse({ error: "append failed", detail: (err as Error).message }, status);
      }
      writeFileSync(fp, next, { mode: 0o600 });
      return jsonResponse({ name, graderName: result.grader.name, yaml: next });
    }

    // ---- dataset builder ---------------------------------------------------
    // Same replay-don't-trust envelope as the grader builder. A compiled
    // dataset is two artifacts written together: the spec's `dataset:`
    // coordinate block and the JSONL case file under <workspace>/datasets/.
    function replayDatasetState(state: DatasetBuilderState): DatasetBuilderState {
      let replayed = startDatasetBuilder();
      for (const answer of state.answers ?? []) replayed = answerDataset(replayed, answer);
      return replayed;
    }
    // A coordinate is immutable once written: storing different cases at an
    // existing {name, version, split} is a 409 (bump the version instead);
    // identical content is idempotent. Returns the error Response, or null
    // when the write may proceed.
    function datasetConflict(
      fp: string,
      result: ReturnType<typeof compileDataset>,
    ): Response | null {
      if (!existsSync(fp)) return null;
      let existing: ReturnType<typeof parseDatasetJsonl>;
      try {
        existing = parseDatasetJsonl(readFileSync(fp, "utf8"));
      } catch (err) {
        return jsonResponse(
          {
            error:
              "a dataset file already exists at this coordinate but is invalid — fix it or bump the version",
            detail: (err as Error).message,
            path: result.path,
          },
          409,
        );
      }
      if (canonicalJson(existing) !== canonicalJson(result.cases)) {
        return jsonResponse(
          {
            error:
              "different cases are already stored at this coordinate — bump the version instead of editing a published dataset",
            path: result.path,
          },
          409,
        );
      }
      return null;
    }
    function writeDatasetFile(fp: string, result: ReturnType<typeof compileDataset>): void {
      if (existsSync(fp)) return; // identical content (conflict-checked) — keep the original file
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, result.jsonl, { mode: 0o600 });
    }
    if (p === "/api/dataset-wizard/start" && m === "POST") {
      const state = startDatasetBuilder();
      return jsonResponse({ state, nextQuestion: nextDatasetQuestion(state) ?? null });
    }
    if (p === "/api/dataset-wizard/step" && m === "POST") {
      const body = (await req.json()) as { state?: DatasetBuilderState; answer?: DatasetAnswer };
      if (!body.state || !body.answer) return jsonResponse({ error: "state+answer required" }, 400);
      try {
        const next = answerDataset(replayDatasetState(body.state), body.answer);
        return jsonResponse({ state: next, nextQuestion: nextDatasetQuestion(next) ?? null });
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
    }
    if (p === "/api/dataset-wizard/compile" && m === "POST") {
      const body = (await req.json()) as { state?: DatasetBuilderState };
      if (!body.state) return jsonResponse({ error: "state required" }, 400);
      try {
        return jsonResponse(compileDataset(replayDatasetState(body.state)));
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
    }
    if (p === "/api/datasets" && m === "GET") {
      return jsonResponse({ datasets: listDatasets() });
    }
    if (p === "/api/datasets" && m === "POST") {
      const body = (await req.json()) as { state?: DatasetBuilderState };
      if (!body.state) return jsonResponse({ error: "state required" }, 400);
      let result: ReturnType<typeof compileDataset>;
      try {
        result = compileDataset(replayDatasetState(body.state));
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
      const fp = datasetFilePath(
        result.dataset.name,
        result.dataset.version,
        result.dataset.split,
      );
      const conflict = datasetConflict(fp, result);
      if (conflict) return conflict;
      const unchanged = existsSync(fp);
      writeDatasetFile(fp, result);
      return jsonResponse(
        {
          dataset: result.dataset,
          path: result.path,
          caseCount: result.cases.length,
          ...(unchanged ? { unchanged: true } : {}),
        },
        unchanged ? 200 : 201,
      );
    }
    const mdg = /^\/api\/datasets\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(train|dev|test)$/.exec(p);
    if (mdg && m === "GET") {
      const dname = mdg[1] as string;
      const dversion = mdg[2] as string;
      const dsplit = mdg[3] as DatasetSplit;
      if (!isDatasetNameSafe(dname) || !isDatasetVersionSafe(dversion)) {
        return jsonResponse({ error: "unsafe dataset coordinate" }, 400);
      }
      const fp = datasetFilePath(dname, dversion, dsplit);
      if (!existsSync(fp)) return jsonResponse({ error: "not found" }, 404);
      try {
        const cases = parseDatasetJsonl(readFileSync(fp, "utf8"));
        return jsonResponse({
          dataset: { name: dname, version: dversion, split: dsplit },
          cases,
          path: `datasets/${dname}/${dversion}/${dsplit}.jsonl`,
        });
      } catch (err) {
        return jsonResponse(
          { error: "dataset file invalid", detail: (err as Error).message },
          422,
        );
      }
    }
    const mds = /^\/api\/specs\/([a-z0-9-]+)\/dataset$/i.exec(p);
    if (mds && m === "POST") {
      const name = mds[1] as string;
      if (!safeName(name)) return jsonResponse({ error: "unsafe name" }, 400);
      const fp = specPath(name);
      // Drain + compile the request BEFORE touching any file — same
      // stale-read discipline as the grader append handler above.
      const body = (await req.json()) as {
        state?: DatasetBuilderState;
        create?: { model?: unknown; instructions?: unknown };
      };
      if (!body.state) return jsonResponse({ error: "state required" }, 400);
      let result: ReturnType<typeof compileDataset>;
      try {
        result = compileDataset(replayDatasetState(body.state));
      } catch (err) {
        return jsonResponse({ error: (err as Error).message }, 400);
      }
      if (
        body.create !== undefined &&
        (body.create === null ||
          typeof body.create !== "object" ||
          typeof body.create.model !== "string" ||
          typeof body.create.instructions !== "string")
      ) {
        return jsonResponse({ error: "create requires { model, instructions } strings" }, 400);
      }
      const dataFp = datasetFilePath(
        result.dataset.name,
        result.dataset.version,
        result.dataset.split,
      );
      const conflict = datasetConflict(dataFp, result);
      if (conflict) return conflict;

      // Missing spec + create → wrap the dataset in a starter eval spec.
      // This is what lets the Studio author an eval end to end: the spec
      // wizard has no eval target, so the Datasets tab births the spec.
      if (!existsSync(fp)) {
        if (!body.create) {
          return jsonResponse(
            {
              error: "spec not found",
              hint: "pass create: { model, instructions } to create a new eval spec around this dataset",
            },
            404,
          );
        }
        let starter: string;
        try {
          starter = buildEvalSpecStarterYaml(result, {
            specName: name,
            model: body.create.model as string,
            instructions: body.create.instructions as string,
          });
          parseSpec(starter); // defensive: never persist a spec the parser rejects
        } catch (err) {
          const status = err instanceof DatasetBuilderError ? 400 : 422;
          return jsonResponse({ error: "create failed", detail: (err as Error).message }, status);
        }
        writeDatasetFile(dataFp, result);
        writeFileSync(fp, starter, { mode: 0o600 });
        return jsonResponse(
          {
            name,
            created: true,
            dataset: result.dataset,
            yaml: starter,
            datasetPath: result.path,
            caseCount: result.cases.length,
          },
          201,
        );
      }

      const yaml = readFileSync(fp, "utf8");
      // LOOSE pre-parse, mirroring the grader append: drafts are allowed,
      // but only an eval target can carry a dataset block. The strict
      // parse below remains the persistence gate.
      let parsed: { target?: unknown };
      try {
        parsed = parseYaml(yaml) as typeof parsed;
      } catch (err) {
        return jsonResponse({ error: "spec invalid", detail: (err as Error).message }, 422);
      }
      if (parsed === null || typeof parsed !== "object" || parsed.target !== "eval") {
        return jsonResponse(
          { error: "spec is not an eval target", target: parsed?.target ?? null },
          400,
        );
      }
      let next: string;
      try {
        next = setDatasetInSpecYaml(yaml, result.yamlBlock);
        parseSpec(next); // defensive: never persist a spec the parser rejects
      } catch (err) {
        const status = err instanceof DatasetBuilderError ? 400 : 422;
        return jsonResponse(
          { error: "set dataset failed", detail: (err as Error).message },
          status,
        );
      }
      writeDatasetFile(dataFp, result);
      writeFileSync(fp, next, { mode: 0o600 });
      return jsonResponse({
        name,
        dataset: result.dataset,
        yaml: next,
        datasetPath: result.path,
        caseCount: result.cases.length,
      });
    }

    // ---- runs -----------------------------------------------------------
    if (p === "/api/runs" && m === "POST") {
      const body = (await req.json()) as { specName?: string; prompt?: string };
      if (typeof body.specName !== "string" || typeof body.prompt !== "string") {
        return jsonResponse({ error: "specName + prompt required" }, 400);
      }
      const fp = specPath(body.specName);
      if (!existsSync(fp)) return jsonResponse({ error: "spec not found" }, 404);
      const runId = `run_${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`;
      const abort = new AbortController();
      runAborts.set(runId, abort);
      runs.set(runId, { events: [], done: false, subscribers: new Set(), finalText: "" });
      // Section 31 — when the caller injects `runDispatcher`, dispatch
      // through it (production wiring spawns runChatLoop). Otherwise
      // fall back to the v0 canned events for backwards compat.
      const fire = async (): Promise<void> => {
        if (opts.runDispatcher) {
          try {
            await opts.runDispatcher({
              runId,
              specName: body.specName as string,
              prompt: body.prompt as string,
              publish: (ev) => pushRunEvent(runId, ev),
              finish: (text) => finishRun(runId, text),
              signal: abort.signal,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            pushRunEvent(runId, { kind: "error", message });
            finishRun(runId, `(dispatcher errored: ${message})`);
          }
          return;
        }
        pushRunEvent(runId, { kind: "run_start", specName: body.specName, prompt: body.prompt });
        await new Promise((r) => setTimeout(r, 5));
        pushRunEvent(runId, { kind: "trace", subkind: "model_request", model: "stub" });
        await new Promise((r) => setTimeout(r, 5));
        pushRunEvent(runId, { kind: "trace", subkind: "tool_call_start", toolName: "stub" });
        await new Promise((r) => setTimeout(r, 5));
        pushRunEvent(runId, { kind: "trace", subkind: "tool_call_end", toolName: "stub" });
        finishRun(runId, "(canned reply for v0; real runChatLoop dispatch lands in a follow-up)");
      };
      void fire();
      return jsonResponse({ runId }, 201);
    }
    // Section 31 — /api/runs/:runId/cancel sends abort signal to dispatcher
    const mc = /^\/api\/runs\/(run_[a-z0-9]+)\/cancel$/.exec(p);
    if (mc && m === "POST") {
      const runId = mc[1] as string;
      const abort = runAborts.get(runId);
      if (!abort) return jsonResponse({ error: "run not found or already finished" }, 404);
      abort.abort();
      finishRun(runId, "(cancelled by user)");
      return jsonResponse({ ok: true });
    }
    // Section 31 — /api/runs/:runId/replay re-emits prior events from
    // the replaySource (typically wired to §10 event-log).
    const mrep = /^\/api\/runs\/(run_[a-z0-9]+)\/replay$/.exec(p);
    if (mrep && m === "GET") {
      const runId = mrep[1] as string;
      const events = opts.replaySource ? await opts.replaySource(runId) : runs.get(runId)?.events;
      if (!events) return jsonResponse({ error: "run not found" }, 404);
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const ev of events) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          }
          controller.enqueue(enc.encode("event: done\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
    // Section 31 — /api/runs/:runId/hitl?nodeId=&decision= — graph HITL approve/reject
    const mhitl = /^\/api\/runs\/(run_[a-z0-9]+)\/hitl$/.exec(p);
    if (mhitl && m === "POST") {
      const runId = mhitl[1] as string;
      const url = new URL(req.url);
      const nodeId = url.searchParams.get("nodeId");
      const decision = url.searchParams.get("decision");
      if (!nodeId || !decision) {
        return jsonResponse({ error: "nodeId + decision required" }, 400);
      }
      pushRunEvent(runId, {
        kind: "hitl_decision",
        nodeId,
        decision,
        ts: new Date().toISOString(),
      });
      return jsonResponse({ ok: true });
    }
    // Section 31 — /api/cost-summary?tenant=&from=&to=
    if (p === "/api/cost-summary" && m === "GET") {
      const url = new URL(req.url);
      const tenantId = url.searchParams.get("tenant") ?? undefined;
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      if (!opts.costSummarySource) {
        return jsonResponse({
          totalUsdMicros: 0,
          byProvider: {},
          note: "no costSummarySource wired (pass via createStudioServerOptions)",
        });
      }
      const summary = await opts.costSummarySource({
        ...(tenantId !== undefined ? { tenantId } : {}),
        ...(from !== null ? { fromMs: Number.parseInt(from, 10) } : {}),
        ...(to !== null ? { toMs: Number.parseInt(to, 10) } : {}),
      });
      return jsonResponse(summary);
    }
    const mr = /^\/api\/runs\/(run_[a-z0-9]+)\/events$/.exec(p);
    if (mr && m === "GET") {
      const runId = mr[1] as string;
      const r = runs.get(runId);
      if (r === undefined) return jsonResponse({ error: "run not found" }, 404);

      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          // Replay any events we already buffered.
          for (const ev of r.events) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          }
          if (r.done) {
            controller.enqueue(
              enc.encode(`event: done\ndata: ${JSON.stringify({ finalText: r.finalText })}\n\n`),
            );
            controller.close();
            return;
          }
          const cb = (ev: RunEvent | "DONE"): void => {
            if (ev === "DONE") {
              controller.enqueue(
                enc.encode(`event: done\ndata: ${JSON.stringify({ finalText: r.finalText })}\n\n`),
              );
              controller.close();
              r.subscribers.delete(cb);
              return;
            }
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          };
          r.subscribers.add(cb);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // ---- graph-layout ---------------------------------------------------
    const mg = /^\/api\/graph-layout\/([a-z0-9-]+)$/.exec(p);
    if (mg && m === "GET") {
      const name = mg[1] as string;
      const fp = specPath(name);
      if (!existsSync(fp)) return jsonResponse({ error: "spec not found" }, 404);
      const yaml = readFileSync(fp, "utf8");
      const spec = parseSpec(yaml);
      if (spec.target !== "graph")
        return jsonResponse({ error: "spec is not a graph target" }, 400);
      // Lower the spec inline (mirrors compiler.lower for graph; we
      // only need the IR, no codegen).
      const ir: IrGraphV0 = {
        version: 0,
        name: spec.name,
        target: "graph",
        entry: spec.entry,
        nodes: Object.entries(spec.nodes).map(([nname, n]) => ({
          name: nname,
          instructions: n.instructions,
          model: n.model ?? spec.model,
          tools: n.tools ?? [],
          toolConfigs: Object.freeze({}),
          ...(n.hitl !== undefined ? { hitlPrompt: n.hitl.prompt } : {}),
        })),
        edges: spec.edges,
        permissions: { rules: [] },
        compaction: {},
      };
      const layout = layoutGraph(ir);
      const accept = req.headers.get("accept") ?? "";
      if (accept.includes("image/svg"))
        return textResponse(renderSvg(layout), 200, "image/svg+xml");
      return jsonResponse(layout);
    }

    // ---- plugins --------------------------------------------------------
    if (p === "/api/plugins" && m === "GET") {
      const plugins = await discoverPlugins();
      return jsonResponse({
        pluginRoot,
        plugins: plugins.map((pl) => ({
          name: pl.name,
          version: pl.version,
          description: pl.description,
          panes: pl.panes?.map((pa) => ({ id: pa.id, title: pa.title })) ?? [],
        })),
      });
    }

    return jsonResponse({ error: "not found", path: p }, 404);
  }

  const server = Bun.serve({
    port,
    fetch: (req) => handle(req),
  });

  return {
    port: server.port ?? port,
    async stop() {
      await server.stop(true);
    },
  };
}
