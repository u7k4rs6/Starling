# Starling: Security & Access

**Companion to:** [`01-PRD.md`](01-PRD.md), [`02-ARCHITECTURE.md`](02-ARCHITECTURE.md)

---

## 0. Scope

Starling is a portfolio project with a public demo and a published npm package. It is not a SaaS. A security document for a SaaS would specify authentication, RBAC, tenancy, audit logs, and key management — and writing all of that here would be theater, since nothing would implement it and a reader who checked would find a long document describing controls that do not exist.

So this document covers exactly three things that are real:

1. The trust model, stated honestly, including what it does not defend.
2. The abuse surface of a public relay that anyone can POST to.
3. Supply-chain hygiene for the npm publish.

Anything not covered here is out of scope **by decision**, not by oversight; §4 lists the exclusions explicitly so the omissions are legible.

---

## 1. Trust model

**The relay is untrusted and powerless, by construction.** This is the interesting security property of the whole system. [§5 of the architecture doc](02-ARCHITECTURE.md) requires the relay to be an append-only byte log with a cursor and zero CRDT code, enforced by CI. The consequences:

- The relay **cannot corrupt a merge**, because it does not merge. It cannot resolve a conflict in its favor because it does not resolve conflicts.
- The relay **cannot silently alter document content** in a way that survives, because every replica computes state from the op log itself. Altered bytes either fail to decode (rejected) or decode to ops that every replica applies identically. There is no server-authoritative state to poison.
- The relay **can** drop ops, withhold ops, reorder delivery, and lie about its cursor — it can cause **liveness** failures and stale views. It cannot cause **safety** failures.
- The relay **can** read everything. There is no end-to-end encryption in v1 (§4).

The one-line version: *the server can refuse to help, but it cannot lie about what you wrote.*

**Peers are trusted.** Anyone who can reach a document can append arbitrary ops to it, including ops that delete everything. This is the same trust model as a link-shared Google Doc, and Starling makes no attempt to do better; a malicious peer is out of scope (§4).

**A document id is the entire access-control system.** An id is a capability: whoever has it can read and write. Therefore:

- Document ids are generated with a CSPRNG (`crypto.randomUUID()` or 128 bits from `crypto.getRandomValues`) — never sequential, never a slug, never derived from a title.
- Ids never appear in a `Referer` header to a third party. The demo loads no third-party scripts, analytics, or CDN fonts — which is a one-line requirement with a real consequence: the fonts are self-hosted.
- The demo keeps the document id out of query parameters where it would land in server access logs, using a fragment (`#docId`) that never leaves the browser.

---

## 2. Relay abuse surface

The relay is a public endpoint that accepts unauthenticated appends — a deliberate choice for a demo, and one that needs three controls, none optional if it is going to sit on the internet.

### 2.1 Resource bounds

| Control | Value | Why |
|---|---|---|
| Max message size | 1 MB | A single op batch is kilobytes; 1 MB is generous and stops a trivial OOM. |
| Max log size per doc | 50 MB | Then the doc is frozen, read-only, with an explicit error. A wall, not an eviction. |
| Max docs | 10,000 | LRU-evict the oldest beyond this. It is a demo. |
| Max connections per IP | 20 | Blunt, but stops the laziest exhaustion. |
| Append rate limit per IP | 100/sec | Well above a human typist, well below a script. |
| Idle connection timeout | 5 min | Reclaim sockets. |

These are **hard limits with explicit errors**, not soft warnings — a limit that logs and continues is not a limit. Behind a reverse proxy the per-IP rate limit reads the real client address from a trusted `X-Forwarded-For`, opt-in, so it stays per-client rather than collapsing to one shared limit at the proxy's address (finding F-3).

### 2.2 Input handling

The relay does not parse ops, which is a security property and not only an architectural one: **it has no parser, so it has no parser bugs.** What it does validate, being the only things it can validate without understanding ops:

- The document id matches the expected format (a UUID). Reject otherwise.
- The byte length is within the §2.1 bound.
- The offset in a `GET ?from=N` is a non-negative integer within the log. Reject otherwise; do not clamp silently.

**Path traversal.** Document ids reach the filesystem when the log is disk-backed, so the UUID-format check is the defense, and it is applied before any path is constructed, never after. Reject, do not sanitize — sanitizing is how you end up serving `/etc/passwd` to someone who was clever about it.

### 2.3 Transport and browser surface

- **TLS only.** No plaintext transport in production.
- **CORS locked to exactly the demo origin**, never `*` — a wildcard would let any page on the internet drive a user's browser into appending to documents. Because a cross-origin `fetch` of a byte body is a CORS "simple request" that the server would otherwise execute regardless of the response headers, the origin is enforced **server-side on writes**, not only advertised via CORS headers (finding F-3).
- **CSP on the demo:** `default-src 'self'`, no `unsafe-inline`, no `unsafe-eval` — which falls out of the no-third-party-scripts rule in §1.
- **Document content is untrusted text.** ProseMirror renders through its own model, not `innerHTML`, so the default path is safe; the demo adds no HTML-rendering feature, and any future preview pane would sanitize.

---

## 3. Supply chain (the npm publish)

Starling ships `starling-crdt` to a public registry, which makes it a supply-chain participant worth taking seriously:

- **Zero runtime dependencies** in `packages/crdt`, enforced in CI — so the package has no transitive attack surface.
- **Published with provenance** (`npm publish --provenance` from a GitHub Actions workflow), so the package carries a signed attestation linking it to the exact commit and workflow run that built it.
- **`"files": ["dist"]`** — ship build output only, never tests, stray source maps, `.env` files, or `bench/` fixtures.
- **`npm publish --dry-run`, with the file list read**, before any real publish.
- **2FA on the npm account** for publish.
- **No install scripts.** A `postinstall` in a CRDT library is a red flag, and there is no reason to have one.
- **Lockfile committed**, with CI running `pnpm install --frozen-lockfile`.

---

## 4. Explicitly out of scope

Named so that their absence is a decision rather than a gap:

| Excluded | Why |
|---|---|
| **Authentication / accounts** | The document id is the capability. Adding auth would mean a user store, which is a product, not a demo. |
| **Authorization / read-only sharing** | Cannot be enforced by a relay that does not understand ops. Enforcing it would require making the relay smart, which destroys the property in §1 — a genuinely interesting consequence of the architecture. |
| **End-to-end encryption** | Tractable (encrypt op payloads with a key in the URL fragment, relay never sees it) and tempting, since the relay is already blind to structure. Out of scope for v1 because key rotation and access revocation are their own project — noted in the README as the obvious next step. |
| **Malicious peer / vandalism** | Anyone with the link can delete everything, same as any link-shared doc. Mitigating this needs identity, which needs auth. |
| **Denial of service beyond §2.1** | The limits stop casual abuse. A determined attacker takes the demo down. It is a demo. |
| **Byzantine replicas forging ops** | No signatures on ops in v1; a peer can claim any `ReplicaId`. Out of scope for the same reason as auth. |
| **Compromised client** | A universal exclusion. Nothing can be done from inside the page. |

---

## 5. The one gate that matters

Everything in §1 rests on a single structural claim: the relay contains no CRDT code. That claim is checked by CI (the relay-ignorance gate, §1 of the architecture doc), and it is checked because it is the kind of property that erodes silently. Someone adds a validation to reject malformed ops, which requires a parser, which requires understanding ops — and now the server is an authority and the security model in §1 is false while the README still says it is true.

If that gate is ever removed or weakened, this document is void and needs rewriting. It is load-bearing.
