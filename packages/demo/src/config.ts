/**
 * The hosted relay's base URL, baked in at build time. Step 4 of the deploy
 * (docs/DEPLOY.md) sets VITE_RELAY_URL to the Render service; local dev falls
 * back to the loopback address scripts/dev-relay.mjs binds. Rooms themselves are
 * per session (a generated id in the URL fragment), so there is no fixed
 * document id to configure here.
 */
export const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? "http://127.0.0.1:8787";
