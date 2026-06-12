/**
 * `bun run start` entry point for `@crewhaus/grader-builder`.
 *
 * Drives the guided grader builder interactively on stdin/stdout and
 * prints the resulting grader YAML to stdout.
 *
 * Reads one line at a time from stdin. Works both with a real TTY
 * and when stdin is piped (the demo verifier in CI uses `printf |
 * bun run start`). Rubrics are entered on one line in v0 — literal
 * `\n` sequences become real newlines.
 */
import {
  type GraderAnswer,
  type GraderBuilderState,
  GraderBuilderError,
  answerGrader,
  compileGrader,
  nextQuestion,
  startGraderBuilder,
} from "../index";

// Yield one line of stdin at a time. Buffers partial chunks so a
// single read containing "a\nb\n" emits two lines.
async function* lines(): AsyncGenerator<string, void, void> {
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let i = buf.indexOf("\n");
    while (i !== -1) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  }
  if (buf.length > 0) yield buf;
}

const lineIter = lines();
async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const next = await lineIter.next();
  if (next.done) return "";
  return next.value.trim();
}

function parseBool(raw: string, fallback: boolean): boolean {
  if (raw === "") return fallback;
  if (["y", "yes", "true"].includes(raw.toLowerCase())) return true;
  if (["n", "no", "false"].includes(raw.toLowerCase())) return false;
  throw new GraderBuilderError(`answer "y" or "n" (got "${raw}")`);
}

function parseNumber(raw: string, what: string): number {
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n)) {
    throw new GraderBuilderError(`${what} must be a number (got "${raw}")`);
  }
  return n;
}

let state: GraderBuilderState = startGraderBuilder();
let q = nextQuestion(state);

while (q !== undefined) {
  let answer: GraderAnswer;
  try {
    if (q.id === "kind") {
      process.stdout.write(`\n${q.prompt}\n`);
      for (const c of q.choices) {
        process.stdout.write(`  - ${c.value.padEnd(18)} ${c.description}\n`);
      }
      const raw = await readLine("kind> ");
      // answerGrader rejects unknown kinds with the full menu.
      answer = { question: "kind", value: raw } as GraderAnswer;
    } else if (q.id === "caseSensitive" || q.id === "isRegex") {
      const def = q.defaultValue ? "Y/n" : "y/N";
      const raw = await readLine(`\n${q.prompt} [${def}]\n${q.id}> `);
      answer = { question: q.id, value: parseBool(raw, q.defaultValue) };
    } else if (q.id === "toleranceMode") {
      process.stdout.write(`\n${q.prompt}\n`);
      for (const c of q.choices) process.stdout.write(`  - ${c.value.padEnd(10)} ${c.label}\n`);
      const raw = (await readLine("mode> ")) || "absolute";
      answer = { question: "toleranceMode", value: raw as "absolute" | "relative" };
    } else if (q.id === "judgeModel") {
      process.stdout.write(`\n${q.prompt}\n`);
      for (const s of q.suggested) process.stdout.write(`  - ${s}\n`);
      const raw = (await readLine("model> ")) || (q.suggested[0] as string);
      answer = { question: "judgeModel", value: raw };
    } else if (q.id === "threshold") {
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\nthreshold> `);
      answer = {
        question: "threshold",
        value: raw === "" ? q.defaultValue : parseNumber(raw, "threshold"),
      };
    } else if (q.id === "expectedNumber" || q.id === "tolerance") {
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\n${q.id}> `);
      answer = { question: q.id, value: parseNumber(raw, q.id) };
    } else if (q.id === "timeoutMs" || q.id === "weight") {
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\n${q.id}> `);
      answer = {
        question: q.id,
        value: raw === "" ? undefined : parseNumber(raw, q.id),
      };
    } else if (q.id === "rubric") {
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\nrubric> `);
      answer = { question: "rubric", value: raw.replaceAll("\\n", "\n") };
    } else if (q.id === "id") {
      const raw = (await readLine(`\n${q.prompt}\n  ${q.hint}\nid> `)) || "grader-1";
      answer = { question: "id", value: raw };
    } else {
      // expected / pattern / schemaJson / scriptPath — free text.
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\n${q.id}> `);
      answer = { question: q.id, value: raw };
    }
    state = answerGrader(state, answer);
  } catch (err) {
    if (err instanceof GraderBuilderError) {
      process.stderr.write(`${err.message}\n`);
      continue; // re-ask the same question
    }
    throw err;
  }
  q = nextQuestion(state);
}

const result = compileGrader(state);
process.stdout.write(`\n--- grader entry (append under graders:) ---\n${result.yamlEntry}\n`);
process.stdout.write(`\n--- full block ---\n${result.yamlBlock}\n`);
