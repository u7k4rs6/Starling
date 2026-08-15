// Production entrypoint (Step 16: "relay hosted"). Not a workspace
// package script run by `pnpm test`/CI — this is what an actual host
// (any container platform, or plain `node` on a VM) runs to serve
// traffic. `packages/demo/scripts/dev-relay.mjs` is this file's local-
// development counterpart: same `createRelayServer` call, different
// defaults (binds to every interface here, not just loopback; requires
// `RELAY_ALLOWED_ORIGIN` explicitly rather than defaulting to
// `localhost` — a production relay that silently allowed an unset
// origin would defeat SECURITY §2.3's CORS check entirely).
// Relative, not `@starling/relay` by package name: this script ships
// alongside `dist/` in the production container image (see the
// Dockerfile), with no `node_modules` present to resolve a package name
// through — it's part of the package, not a consumer of it.
import { createRelayServer } from "../dist/index.js";

const allowedOrigin = process.env.RELAY_ALLOWED_ORIGIN;
if (!allowedOrigin) {
  console.error("RELAY_ALLOWED_ORIGIN must be set — the exact origin (scheme+host+port) the deployed demo is served from.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);

// How many trusted proxies front this process. It MUST match the platform, or
// the per-IP append limit misfires: left at 0 behind a proxy (Render, a CDN),
// every visitor's request arrives from the proxy's single socket address and
// they all share one rate-limit budget; set too high, a client could forge
// X-Forwarded-For to get a fresh budget. Render terminates TLS at one edge and
// appends the real client IP to X-Forwarded-For, so set RELAY_TRUSTED_PROXY_DEPTH=1
// there. Default 0 keeps local and no-proxy runs safe.
const trustedProxyDepth = Number(process.env.RELAY_TRUSTED_PROXY_DEPTH ?? 0);

const server = createRelayServer({
  allowedOrigin,
  dataDir: process.env.RELAY_DATA_DIR,
  trustedProxyDepth,
});

server.listen(port, "0.0.0.0", () => {
  console.log(`relay listening on 0.0.0.0:${port}, allowed origin ${allowedOrigin}`);
});

// Most container platforms send SIGTERM on deploy/scale-down and expect
// the process to actually exit, not linger until a hard kill — a plain
// `server.listen()` with no signal handling leaves connections (and the
// process) open indefinitely.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
