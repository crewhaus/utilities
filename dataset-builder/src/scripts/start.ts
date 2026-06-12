/**
 * `bun run start` entry point for `@crewhaus/dataset-builder`.
 *
 * Drives the guided dataset builder interactively on stdin/stdout and
 * prints the dataset coordinate YAML + the JSONL case file to stdout.
 *
 * Reads one line at a time from stdin. Works both with a real TTY and
 * when stdin is piped (the demo verifier in CI uses `printf | bun run
 * start`). The cases/jsonl questions read one case per line until an
 * empty line; literal `\n` sequences inside a manual case become real
 * newlines.
 */
import {
  type DatasetAnswer,
  type DatasetBuilderState,
  type DatasetCaseInput,
  type DatasetSplit,
  DatasetBuilderError,
  answerDataset,
  compileDataset,
  nextQuestion,
  startDatasetBuilder,
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
let stdinClosed = false;
async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const next = await lineIter.next();
  if (next.done) {
    stdinClosed = true;
    return "";
  }
  return next.value.trim();
}

/** Read lines until the first empty one (or EOF). */
async function readUntilBlank(prompt: string): Promise<string[]> {
  const out: string[] = [];
  for (;;) {
    const raw = await readLine(out.length === 0 ? prompt : "");
    if (raw === "") return out;
    out.push(raw);
  }
}

/** `input => expected_output` on one line; the arrow + expected are optional. */
function parseManualCase(line: string): DatasetCaseInput {
  const arrow = line.indexOf(" => ");
  const input = (arrow === -1 ? line : line.slice(0, arrow)).replaceAll("\\n", "\n");
  if (arrow === -1) return { input };
  return { input, expected_output: line.slice(arrow + 4).replaceAll("\\n", "\n") };
}

let state: DatasetBuilderState = startDatasetBuilder();
let q = nextQuestion(state);

while (q !== undefined) {
  let answer: DatasetAnswer;
  try {
    if (q.id === "source") {
      process.stdout.write(`\n${q.prompt}\n`);
      for (const c of q.choices) {
        process.stdout.write(`  - ${c.value.padEnd(20)} ${c.description}\n`);
      }
      const raw = await readLine("source> ");
      // answerDataset rejects unknown sources with the full menu.
      answer = { question: "source", value: raw } as DatasetAnswer;
    } else if (q.id === "split") {
      process.stdout.write(`\n${q.prompt} (empty = ${q.defaultValue})\n`);
      for (const c of q.choices) process.stdout.write(`  - ${c.label}\n`);
      const raw = await readLine("split> ");
      answer = {
        question: "split",
        value: raw === "" ? undefined : (raw as DatasetSplit),
      };
    } else if (q.id === "cases") {
      const raw = await readUntilBlank(
        `\n${q.prompt}\n  ${q.hint}\n  (one case per line as "input => expected_output"; finish with an empty line)\ncases> `,
      );
      answer = { question: "cases", value: raw.map(parseManualCase) };
    } else if (q.id === "jsonl") {
      const raw = await readUntilBlank(
        `\n${q.prompt}\n  ${q.hint}\n  (finish with an empty line)\njsonl> `,
      );
      answer = { question: "jsonl", value: raw.join("\n") };
    } else {
      // datasetName / version — free text.
      const raw = await readLine(`\n${q.prompt}\n  ${q.hint}\n${q.id}> `);
      answer = { question: q.id, value: raw };
    }
    state = answerDataset(state, answer);
  } catch (err) {
    if (err instanceof DatasetBuilderError) {
      process.stderr.write(`${err.message}\n`);
      // Re-asking after EOF would loop forever on the same empty answer —
      // truncated piped input exits non-zero instead.
      if (stdinClosed) process.exit(1);
      continue; // re-ask the same question
    }
    throw err;
  }
  q = nextQuestion(state);
}

const result = compileDataset(state);
process.stdout.write(`\n--- dataset block (for the eval spec) ---\n${result.yamlBlock}\n`);
process.stdout.write(`\n--- cases (save as ${result.path}) ---\n${result.jsonl}`);
