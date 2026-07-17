# Deploying Starling (Step 16)

Two independently-hosted pieces: `packages/relay` (a stateful Node HTTP
server — needs a host that keeps a process running) and `packages/demo`
(a static build — needs only a static file host). Neither piece is
deployed automatically by this repository; both require an account on
some hosting provider and a one-time manual setup step this repo cannot
perform on its own (no hosting credentials are — or should be — checked
into a public repository, and enabling GitHub Pages is a repository-
settings change only an admin of the repo can make, not something the
GitHub API exposes to a normal push/PR).

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
  empty log after every restart.

Example, any container host:

```
docker build -f packages/relay/Dockerfile -t starling-relay .
docker run -p 8787:8787 -e RELAY_ALLOWED_ORIGIN=https://<owner>.github.io starling-relay
```

Once it's up, note its public URL (e.g. `https://starling-relay.fly.dev`)
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

## 4. Deploy

Actions tab → "Deploy demo" workflow → Run workflow. Manual dispatch
only, deliberately (see the workflow file's own comment) — not on every
push to `main`, since a redeploy is a visible action against a URL a
real person might be using. The demo will be live at
`https://<owner>.github.io/Starling/` once the run finishes.

## What this repository does NOT do for you

It does not create a relay hosting account, does not set
`RELAY_ALLOWED_ORIGIN`/`VITE_RELAY_URL`, and does not flip the Pages
source toggle — all three need a human with the relevant account access,
which this repository (and any automation running against it) does not
have. Steps 1-3 above are one-time; step 4 is the only one that repeats
per deploy.
