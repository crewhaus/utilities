# `@crewhaus/crewhaus-playground`

Browser-based REPL for the CrewHaus meta-harness — Monaco editor + live trace timeline + per-session quota + cross-tenant isolation. Local dev runs against a stubbed gateway; production mounts behind §20 gateway-server with mTLS + JWT.

## Run it

```bash
cd utilities/crewhaus-playground
PORT=3001 CREWHAUS_STUDIO_URL=http://localhost:4242 bun run play:server
# → [playground] listening on http://localhost:3001
```

The CLI entry ([src/cli.ts](./src/cli.ts)) stands up a Bun.serve listener with a stubbed `GatewayClient` that returns `{ runId: "stub-…", status: "queued", traceUrl: "/trace/<tier>" }` for every spec submission. Swap the stub for a real client by importing `createPlayground` directly.

## Programmatic use

```typescript
import { createPlayground } from "@crewhaus/crewhaus-playground";

const playground = createPlayground({
  studioUrl: "http://localhost:4242",
  gatewayClient: {
    async startRun({ spec, tier }) {
      // → call §20 gateway-server here
      return { runId: "...", status: "queued", traceUrl: "..." };
    },
  },
});

// Mount inside any Bun.serve / Hono / Express handler:
Bun.serve({ port: 3001, fetch: (req) => playground.fetch(req) });
```

## HTTP API

| Method | Path | Body / params | Returns |
|---|---|---|---|
| `GET` | `/` | — | SPA shell (Monaco editor + trace timeline) |
| `GET` | `/api/templates` | — | JSON list from [scaffold-templates](../scaffold-templates/) |
| `POST` | `/api/run` | `{ spec }` | `{ scopedRunId, status }` — quota-gated; `429` + `Retry-After` when over |
| `GET` | `/api/runs/:id` | — | `{ spec, status, traceUrl }` scoped to the calling session (404 on mismatch) |

Per-session quota is tracked via a `sid` cookie (auto-generated for anonymous browsers). OAuth-signed-in users get a larger tier.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | listener port |
| `CREWHAUS_STUDIO_URL` | `http://localhost:4242` | studio-server URL the SPA links trace bars to |

## API surface

| Export | Kind | Summary |
|---|---|---|
| `createPlayground(config)` | function | returns `{ fetch, quotaFor, runStore }` |
| `playgroundIndexHtml(opts)` | function | SPA shell HTML |
| `enforceQuota({ sessionId, tier, used })` | function | pure quota decision; returns `{ allowed, remaining, retryAfterMs? }` |
| `DEFAULT_QUOTA` | constant | per-tier limits |
| `templateMenuEntries()` | function | template summaries for the "new spec" picker |
| `scopeRunId`, `parseRunIdScope`, `isolatedRunStore` | functions | tenant-isolation helpers |
| `GatewayClient`, `PlaygroundConfig`, `PlaygroundServer`, `Tier`, `QuotaState`, `SessionScope` | types | — |

## Requires

- a running [studio-server](../studio-server/) at `CREWHAUS_STUDIO_URL` for trace links to resolve
- for production: §20 gateway-server (mTLS + JWT) wired as the `gatewayClient`

## Related

- Source: [src/index.ts](./src/index.ts), [src/server.ts](./src/server.ts), [src/cli.ts](./src/cli.ts)
