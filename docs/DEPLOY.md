# Deploying Starling (Steps 16-17)

Three independently-hosted or -published pieces, none of them handled
automatically by this repository, all for the same reason: each needs
either a hosting account this environment doesn't have credentials for,
or a repository-settings/secret change only a human with admin access
can make. `packages/relay` (a stateful Node HTTP server — needs a host
that keeps a process running), `packages/demo` (a static build — needs
only a static file host), and `starling-crdt` itself (an npm publish —
needs an npm account with publish rights).

## 1. Host the relay

`packages/relay` has zero runtime dependencies (`package.json`'s own
`"dependencies"` is `{}` — the "relay ignorance" boundary, DECISIONS
#0019, means it doesn't even import the crdt package), so any host that
runs a Node process works: Fly.io, Render, Railway, a bare VM, or the
provided `packages/relay/Dockerfile` on any container platform.

Required environment variables (`packages/relay/scripts/serve.mjs`):

- `RELAY_ALLOWED_ORIGIN` — the exact origin (scheme + host, no path) the
  deployed demo is served from, e.g. `https://<owner>.github.io`. The
  relay's CORS check (SECURITY §2.3) rejects every other origin; this
  has no default in production on purpose (`serve.mjs` refuses to start
  without it) — a relay that silently allowed an unset origin would
  defeat the check.
- `PORT` — defaults to `8787`.
- `RELAY_DATA_DIR` — optional; set it to a persistent volume/disk path
  if the host's filesystem doesn't survive restarts, so the op log
  survives a redeploy. Omit it and the relay still works, just with an
  empty log after every restart. A restart with an empty log is no longer
  a hazard: the relay stamps every response with a per-boot generation
  token, and a client that sees it change reconciles against the fresh
  log and re-pushes its history (DECISIONS #0031). So on a host with no
  persistent disk you can leave this unset.
- `RELAY_TRUSTED_PROXY_DEPTH` — how many trusted proxies front the
  process, default `0`. Behind a platform that terminates TLS and load-
  balances (Render, a CDN), set it to the real hop count or the per-IP
  append limit collapses to the proxy's single address and every visitor
  shares one budget (DECISIONS #0032). On Render, set it to `1`.

The relay also serves `GET /health` (200 with a small JSON body). Use it
for a manual liveness check. Do NOT wire an uptime monitor to ping it on
a free host: a scheduled ping is inbound traffic that resets the 15-minute
spin-down timer and keeps the instance awake around the clock, burning the
750 instance-hours the demo's wake-on-intent design protects.

### On Render (the free tier this demo targets)

`render.yaml` at the repo root is a Blueprint for exactly this: a free
Docker web service built from `packages/relay/Dockerfile`, with
`RELAY_TRUSTED_PROXY_DEPTH=1` already set and `RELAY_ALLOWED_ORIGIN` left
for you to fill in. New → Blueprint, point Render at the repo, then set
`RELAY_ALLOWED_ORIGIN` to `https://<owner>.github.io` in the dashboard.
The Blueprint sets no `healthCheckPath`, on purpose (see the file's
comment): a free service sleeps after 15 minutes idle and wakes in about
a minute on the next request, which the local-first demo hides by never
depending on the relay until a visitor shares.

Example, any other container host:

```
docker build -f packages/relay/Dockerfile -t starling-relay .
docker run -p 8787:8787 \
  -e RELAY_ALLOWED_ORIGIN=https://<owner>.github.io \
  -e RELAY_TRUSTED_PROXY_DEPTH=1 \
  starling-relay
```

Once it's up, note its public URL (e.g. `https://starling-relay.onrender.com`)
— the demo needs it next.

## 2. Enable GitHub Pages (one-time, repo admin only)

Repo Settings → Pages → Source → **GitHub Actions**. This can't be done
by any tool available to this session (no repository-settings API was
exposed to it) — a human with admin access to the repo has to click it
once. `.github/workflows/deploy-demo.yml` is ready to run the moment
this is set.

## 3. Point the demo at the hosted relay

Repo Settings → Secrets and variables → Actions → Variables → New
repository variable: `VITE_RELAY_URL` = the relay's public URL from
step 1. `packages/demo/src/config.ts` reads this at build time; without
it, the built demo falls back to `http://127.0.0.1:8787` (the local-dev
default) and won't reach anything once deployed.

**`VITE_RELAY_URL` is baked into the bundle at build time, not read at
runtime.** Changing the relay's URL later (a new Render service, a custom
domain) is not a settings change the live page picks up: you must update
the variable and re-run the Deploy workflow (step 4) to rebuild. The same
is true of the relay's `RELAY_ALLOWED_ORIGIN`, which must equal the Pages
origin exactly, `https://<owner>.github.io`, with the scheme and no
trailing slash and no `/Starling` path (an origin is scheme + host only).
A mismatch there fails silently in the browser: the relay rejects the
write server-side and the fetch is a CORS error, so plan to set it to the
exact origin, not the URL.

## 4. Deploy

Actions tab → "Deploy demo" workflow → Run workflow. Manual dispatch
only, deliberately (see the workflow file's own comment) — not on every
push to `main`, since a redeploy is a visible action against a URL a
real person might be using. The demo will be live at
`https://<owner>.github.io/Starling/` once the run finishes.

## 5. Verify against the live URL (the checks that only the deployment can run)

Everything below was verified locally against a relay rigged to be slow
or lossy, but the real sleeping-instance behaviour and a real device can
only be checked once the URL above is live. Run these after step 4.

- **Cold start.** Leave the relay untouched for 20+ minutes so Render
  spins it down. Open the live URL, type (it works, local-first), then
  click Share. Expected, and verified locally against a delayed relay:
  the editor stays usable throughout, a "Waking the relay" indicator
  shows the wait, both panes keep converging locally, and the upgrade to
  the relay is silent when the wake completes. Record the actual wake
  time; Render's own docs put it near 50 to 60 seconds.
- **Bare visit touches the relay zero times.** Open the live URL with no
  `#room=` fragment, edit, and work the break-it panel. Confirm in
  Render's metrics that the instance never woke. Locally, a bare visit
  issued zero requests to the relay; this confirms it against the real
  service, which is the whole instance-hour budget.
- **`X-Relay-Generation` reaches the browser cross-origin.** In devtools,
  a `GET` to the relay's `/doc/:id` must show `X-Relay-Generation` as a
  readable response header. It is exposed via `Access-Control-Expose-Headers`
  (SECURITY-side, tested in `server.test.ts`), but the exposure is easy to
  have right in code and wrong in deployment; if the browser cannot read
  it, restart reconciliation silently stops working.
- **The room fragment survives the `/Starling/` base path.** Share, copy
  the link (it should read `https://<owner>.github.io/Starling/#room=...`),
  open it fresh, and confirm it starts in relay mode. Verified locally
  against the Pages-base build.
- **Real device over cellular.** Load the live URL on an actual phone on
  a cellular connection, not an emulated viewport on wifi, and confirm the
  poll cadence and the cold start behave. Report anything that differs
  from desktop.

## 6. Publish `starling-crdt` to npm (Step 17, S12)

`packages/crdt` is publish-ready at v0.1.0 — `npm publish --dry-run`
(run from `packages/crdt`) passes and shows exactly the intended file
list (`dist/`, `README.md`, `LICENSE`, `package.json` — 43 files, ~33
kB); no npm account was available to this session to run the real
publish (`npm whoami` fails with `ENEEDAUTH`, and no `NPM_TOKEN` or
equivalent exists anywhere in this container). Two ways to finish it:

**Locally, with your own npm login:**

```
cd packages/crdt
npm publish --dry-run   # confirm the file list first, SECURITY §3
npm login
npm publish --provenance --access public
```

(`--provenance` needs npm to be running inside a supported CI OIDC
context to actually attach an attestation — running it from a local
`npm login` session publishes fine, just without the provenance badge on
the npm page. Use the GitHub Actions workflow below to get provenance.)

**Via CI, with provenance (SECURITY §3's own recommendation):**
Repo Settings → Secrets and variables → Actions → Secrets → New
repository secret: `NPM_TOKEN` = an npm
[automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
with publish rights on `starling-crdt` (2FA on the npm account is
required for publish — SECURITY §3, not optional). Then:

```
git tag crdt-v0.1.0
git push origin crdt-v0.1.0
```

`.github/workflows/publish-crdt.yml` runs on that tag push: rebuilds,
runs `packages/crdt`'s own tests, runs the core-isolation gate, dry-runs
first (fails the job before anything irreversible if the file list looks
wrong — the exact discipline SECURITY §3 asks for), then publishes with
`--provenance`.

**After it's live**, S12's actual check is `npm install starling-crdt`
somewhere and confirming `import { Doc } from "starling-crdt"` works —
that specific command has not been run against a real published package
by this session, since none is published yet.

## What this repository does NOT do for you

It does not create a relay hosting account, does not set
`RELAY_ALLOWED_ORIGIN`/`VITE_RELAY_URL`, does not flip the Pages
source toggle, and does not hold npm publish credentials — all four need
a human with the relevant account access, which this repository (and
any automation running against it) does not have. Steps 1-3 and 5 above
are one-time; step 4 (demo redeploy) and re-tagging (npm republish) are
the only ones that repeat.
