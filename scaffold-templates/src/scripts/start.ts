/**
 * `bun run start` entry point for `@crewhaus/scaffold-templates`.
 *
 *   bun run start                     # print catalog table
 *   bun run start <template-id>       # print full YAML for one template
 *
 * Pure-data demo — exercises `listTemplates()` and `getTemplate(id)`.
 */
import { type TemplateId, getTemplate, listTemplates } from "../index";

const arg = process.argv[2];

if (arg === undefined || arg === "") {
  const summaries = listTemplates();
  process.stdout.write(
    `${"ID".padEnd(24)}${"TARGET".padEnd(12)}TITLE\n${"-".repeat(60)}\n`,
  );
  for (const t of summaries) {
    process.stdout.write(`${t.id.padEnd(24)}${t.target.padEnd(12)}${t.title}\n`);
  }
  process.stdout.write(`\n${summaries.length} templates.\n`);
  process.stdout.write(`Usage: bun run start <id>   # print full yaml for one template\n`);
} else {
  const t = getTemplate(arg as TemplateId);
  if (t === undefined) {
    process.stderr.write(`Template "${arg}" not found.\n`);
    process.stderr.write(`Available: ${listTemplates().map((x) => x.id).join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write(`# ${t.title} (${t.target})\n# ${t.description}\n\n${t.yaml}`);
}
