/**
 * `bun run start` entry point for `@crewhaus/studio-server`. Boots the
 * daemon on `PORT` (default 4242), logs the URL, and waits for SIGINT
 * or SIGTERM to call `handle.stop()` for a clean shutdown. Invoked
 * from the workspace root via `bun run studio`.
 */
import { startStudioServer } from "../index";

const port = Number(process.env["PORT"] ?? 4242);
const workspaceDir = process.env["STUDIO_WORKSPACE"];

const handle = await startStudioServer({
  port,
  ...(workspaceDir !== undefined ? { workspaceDir } : {}),
});

process.stdout.write(`studio on http://localhost:${handle.port}\n`);
process.stdout.write(`Ctrl-C to stop\n`);

const shutdown = async (signal: string): Promise<void> => {
  process.stdout.write(`\n[${signal}] stopping...\n`);
  await handle.stop();
  process.exit(0);
};
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
