// Local-development relay for `packages/demo`. Not shipped: this is
// Node-only tooling (packages/relay depends on node:http), never imported
// by src/ (the browser bundle) — a devDependency, same reasoning as
// packages/provider's Step 10 integration test reaching into relay.
// Step 16 (deploy) is where a real hosted relay replaces this default.
import { createRelayServer } from "@starling/relay";

const port = Number(process.env.RELAY_PORT ?? 8787);
// RELAY_MAX_LOG_BYTES lets the e2e suite shrink the per-doc freeze cap so a
// frozen room can be reached with a small amount of typing instead of 2 MB of
// it; unset in normal dev, where the real default applies.
const maxLogBytesPerDoc = process.env.RELAY_MAX_LOG_BYTES ? Number(process.env.RELAY_MAX_LOG_BYTES) : undefined;
const server = createRelayServer({
  allowedOrigin: process.env.RELAY_ALLOWED_ORIGIN ?? "http://localhost:5173",
  maxLogBytesPerDoc,
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dev relay listening on http://127.0.0.1:${port}`);
});
