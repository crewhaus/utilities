/**
 * `bun run start` entry point for `@crewhaus/grader-builder`.
 *
 * Drives the guided grader builder interactively on stdin/stdout and
 * prints the resulting grader YAML to stdout.
 *
 * Reads one line at a time from stdin. Works both with a real TTY
 * and when stdin is piped (the demo verifier in CI uses `printf |
 * bun run start`). Multi-line values are entered on one line in v0 —
 * literal `\n` sequences become real newlines; the five rubric
 * anchors are entered `|`-separated.
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
        process.stdout.write(`  - ${c.value.padEnd(20)} ${c.description}\n`);
      }
      const raw = await readLine("kind> ");
      // answerGrader rejects unknown kinds with the full menu.
      answer = { question: "kind", value: raw } as GraderAnswer;
    } else if (q.id === "trim" || q.id === "caseInsensitive") {
      const def = q.defaultValue ? "Y/n" : "y/N";
      const raw = await readLine(`\n${q.prompt} [${def}]\n${q.id}> `);
      answer = { question: q.id, value: parseBool(raw, q.defaultValue) };
    } else if (q.id === "sequenceMode") {
      process.stdout.write(`\n${q.prompt} (empty = ${q.defaultValue})\n`);
      for (const c of q.choices) process.stdout.write(`  - ${c.label}\n`);
      const raw = await readLine("mode> ");
      answer = {
        question: "sequenceMode",
        value: raw === "" ? undefined : (raw as "exact" | "subseq" | "set"),
      };
    } else if (q.id === "judgeModel") {
      process.stdout.write(`\n${q.prompt}\n`);
      for (const s of q.suggested) process.stdout.write(`  - ${s}\n`);
      const raw = (await readLine("model> ")) || (q.suggested[0] as string);
      answer = { question: "judgeModel", value: raw };
    } else if (q.id === "toolCalls") {
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint} (comma-separated)\ntools> `);
      answer = {
        question: "toolCalls",
        value: raw
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t !== ""),
      };
    } else if (q.id === "anchors") {
      const raw = await readLine(
        `\n${q.prompt}\n  ${q.hint} (enter five descriptions separated by "|", or leave empty)\nanchors> `,
      );
      answer = {
        question: "anchors",
        value: raw === "" ? undefined : raw.split("|").map((a) => a.trim()),
      };
    } else if (q.id === "passingScore" || q.id === "judgeWeight") {
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\n${q.id}> `);
      answer = {
        question: q.id,
        value: raw === "" ? undefined : parseNumber(raw, q.id),
      };
    } else if (q.id === "flags" || q.id === "expectedJson") {
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\n${q.id}> `);
      answer = { question: q.id, value: raw === "" ? undefined : raw };
    } else if (q.id === "criterionDescription") {
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\ndescription> `);
      answer = { question: "criterionDescription", value: raw.replaceAll("\\n", "\n") };
    } else {
      // substring / pattern / path / criterionName — free text.
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
