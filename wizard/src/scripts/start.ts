/**
 * `bun run start` entry point for `@crewhaus/wizard`.
 *
 * Drives the 5-question wizard interactively on stdin/stdout and
 * prints the resulting `crewhaus.yaml` + `.env.example` to stdout.
 *
 * Reads one line at a time from stdin. Works both with a real TTY
 * and when stdin is piped (the demo verifier in CI uses `echo | bun
 * run start`).
 */
import {
  type TargetShape,
  type WizardAnswer,
  type WizardState,
  answerWizard,
  compileWizard,
  nextQuestion,
  startWizard,
} from "../index";

const TARGETS: ReadonlyArray<TargetShape> = [
  "cli",
  "channel",
  "graph",
  "managed",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
];
const PERMISSION_MODES = ["default", "plan", "auto"] as const;

function isTarget(value: string): value is TargetShape {
  return (TARGETS as ReadonlyArray<string>).includes(value);
}
function isPermissionMode(value: string): value is (typeof PERMISSION_MODES)[number] {
  return (PERMISSION_MODES as ReadonlyArray<string>).includes(value);
}

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

let state: WizardState = startWizard();
let q = nextQuestion(state);

while (q !== undefined) {
  if (q.id === "target") {
    process.stdout.write(`\n${q.prompt}\n`);
    for (const c of q.choices) process.stdout.write(`  - ${c.value.padEnd(10)} ${c.label}\n`);
    const value = await readLine(`target> `);
    if (!isTarget(value)) {
      process.stderr.write(`Unknown target "${value}". Pick one of: ${TARGETS.join(", ")}\n`);
      continue;
    }
    const ans: WizardAnswer = { question: "target", value };
    state = answerWizard(state, ans);
  } else if (q.id === "name") {
    const value = (await readLine(`\n${q.prompt}\nname> `)) || "my-spec";
    state = answerWizard(state, { question: "name", value });
  } else if (q.id === "model") {
    process.stdout.write(`\n${q.prompt}\n`);
    for (const s of q.suggested) process.stdout.write(`  - ${s}\n`);
    const value = (await readLine(`model> `)) || "claude-sonnet-4-6";
    state = answerWizard(state, { question: "model", value });
  } else if (q.id === "tools") {
    const value = await readLine(
      `\n${q.prompt}${q.applicable ? `\n  suggested: ${q.suggested.join(", ")}` : ""}\ntools> `,
    );
    const list = value === "" ? [] : value.split(",").map((s) => s.trim()).filter(Boolean);
    state = answerWizard(state, { question: "tools", value: list });
  } else if (q.id === "permissionMode") {
    process.stdout.write(`\n${q.prompt}\n`);
    for (const c of q.choices) process.stdout.write(`  - ${c.value.padEnd(10)} ${c.label}\n`);
    const value = (await readLine(`permissionMode> `)) || "default";
    if (!isPermissionMode(value)) {
      process.stderr.write(`Unknown mode "${value}". Pick one of: ${PERMISSION_MODES.join(", ")}\n`);
      continue;
    }
    state = answerWizard(state, { question: "permissionMode", value });
  }
  q = nextQuestion(state);
}

const result = compileWizard(state);
process.stdout.write(`\n--- ${result.name}.crewhaus.yaml ---\n${result.yaml}\n`);
process.stdout.write(`\n--- .env.example ---\n${result.envExample}\n`);
