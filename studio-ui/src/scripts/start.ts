/**
 * `bun run start` entry point for `@crewhaus/studio-ui`.
 *
 * Boots the full studio experience: spawns the studio-server daemon
 * in-process on `STUDIO_PORT` (default 4242), then stands up a UI
 * listener on `PORT` (default 4243) that serves `renderStudioHtml`
 * at `/` and proxies every other path to the backend.
 *
 * The result: visit http://localhost:4243/ and see the full SPA
 * talking to a live API.
 */
import { startStudioServer } from "@crewhaus/studio-server";
import { renderStudioHtml } from "../index";

const port = Number(process.env["PORT"] ?? 4243);
const backendPort = Number(process.env["STUDIO_PORT"] ?? 4242);

const backend = await startStudioServer({ port: backendPort });

const ui = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(renderStudioHtml({}), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // Proxy everything else (API, healthz, etc.) to the backend.
    const target = `http://localhost:${backend.port}${url.pathname}${url.search}`;
    return fetch(target, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
  },
});

process.stdout.write(`studio + UI on http://localhost:${ui.port}\n`);
process.stdout.write(`(backend on http://localhost:${backend.port})\n`);
process.stdout.write(`Ctrl-C to stop\n`);

const shutdown = async (signal: string): Promise<void> => {
  process.stdout.write(`\n[${signal}] stopping...\n`);
  ui.stop(true);
  await backend.stop();
  process.exit(0);
};
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
