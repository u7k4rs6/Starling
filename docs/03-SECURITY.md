# Starling: Security & Access

**Companion to:** `01-PRD.md`, `02-ARCHITECTURE.md`

---

## 0. Scope discipline

This is a portfolio project with a public demo and a published npm package. It is not a SaaS. The security document for a SaaS would specify auth, RBAC, tenancy, audit logs, and key management, and **writing that here would be theatre**: nothing would implement it, and a reader who checked would find a 200-line doc describing controls that do not exist.

So this document covers exactly three things that are real:

1. What the trust model actually is, stated honestly, including what it does not defend
2. The abuse surface of a public relay that anyone can POST to
3. Supply-chain hygiene for the npm publish

Anything not in this document is out of scope **by decision**, not by oversight. §4 lists the exclusions explicitly so the omission is legible.

---

## 1. Trust model

**The relay is untrusted and powerless, by construction.**

This is the interesting security property of the whole system and it is worth stating precisely. §5 of `02-ARCHITECTURE.md` requires that the relay be an append-only byte log with a cursor and zero CRDT code, CI-enforced. The consequences:

- The relay **cannot corrupt a merge**, because it does not merge. It cannot resolve a conflict in its favour because it does not resolve conflicts.
- The relay **cannot silently alter document content** in a way that survives, because every replica computes state from the op log itself. Altered bytes either fail to decode (rejected) or decode to ops that every replica applies identically. There is no server-authoritative state to poison.
- The relay **can** drop ops, withhold ops, reorder delivery, and lie about its cursor. That is: it can cause **liveness** failures and stale views. It cannot cause **safety** failures.
- The relay **can** read everything. There is no end-to-end encryption in v1 (§4).

The honest one-line version, for the README: *the server can refuse to help, but it cannot lie about what you wrote.*

**Peers are trusted.** Anyone who can reach a document can append arbitrary ops to it, including ops that delete everything. This is the same trust model as a Google Doc link-share, and Starling makes no attempt to do better. A malicious peer is out of scope (§4).

**What a URL is.** Document ids are the entire access control system. An id is a capability: whoever has it can read and write. Therefore:

- Document ids **must** be generated with a CSPRNG (`crypto.randomUUID()` or 128 bits from `crypto.getRandomValues`), never sequential, never a slug, never derived from a title.
- Ids must never appear in a `Referer` header to a third party. The demo loads no third-party scripts, no analytics, no fonts from a CDN. This is a one-line requirement with a real consequence: **self-host the fonts.**
- The demo must not put the document id in a query parameter where it lands in server access logs. Use a fragment (`#docId`) so it never leaves the browser, or accept the logging and say so.

---

## 2. Relay abuse surface

The relay is a public endpoint that accepts unauthenticated appends. This is a deliberate choice for a demo and it needs three controls, none of which are optional if it is going to sit on the internet.

### 2.1 Resource bounds

| Control | Value | Why |
|---|---|---|
| Max message size | 1 MB | A single op batch is kilobytes. 1 MB is generous and stops a trivial OOM. |
| Max log size per doc | 50 MB | Then the doc is frozen, read-only, with an explicit error. Not an eviction, a wall. |
| Max docs | 10,000 | LRU-evict the oldest beyond this. It is a demo. |
| Max connections per IP | 20 | Blunt, but stops the laziest exhaustion. |
| Append rate limit per IP | 100/sec | Well above a human typist, well below a script. |
| Idle connection timeout | 5 min | Reclaim sockets. |

These are **hard limits with explicit errors**, not soft warnings. A limit that logs and continues is not a limit.

### 2.2 Input handling

The relay does not parse ops (§5 of ARCH), which is a security property, not just an architectural one: **it has no parser, so it has no parser bugs.** This is one of the few places where "the server is dumb" is directly a hardening argument, and the README should say so.

What the relay does validate, being the only things it can validate without understanding ops:

- The document id matches the expected format (UUID). Reject otherwise.
- The byte length is within the §2.1 bound.
- The offset in a `GET ?from=N` is a non-negative integer within the log. Reject otherwise, do not clamp silently.

**Path traversal.** Document ids reach the filesystem if the log is disk-backed. The UUID format check is the defence, and it must be applied before any path is constructed, not after. Reject, do not sanitise. Sanitising is how you end up serving `/etc/passwd` to someone who was clever about it.

### 2.3 Transport and browser surface

- **TLS only.** No plaintext WebSocket. Reject `ws://`, use `wss://`.
- **CORS**: the relay allows exactly the demo origin. Not `*`. A wildcard here means any page on the internet can drive a user's browser into appending to documents.
- **CSP on the demo**: `default-src 'self'`, no `unsafe-inline`, no `unsafe-eval`. This falls out of the no-third-party-scripts rule in §1 and is cheap to hold if held from step 0. It is miserable to retrofit at step 16.
- **The document content is untrusted text.** ProseMirror renders through its own model, which is not `innerHTML`, so the default path is safe. The demo must not add an HTML-rendering feature. If a preview pane ever gets built, it sanitises.

---

## 3. Supply chain (the npm publish)

Starling ships `starling-crdt` to a public registry. That makes it a supply-chain participant, which is a thing worth taking seriously given that Tessera is a supply-chain-integrity project. It would be embarrassing to publish carelessly.

- **Zero runtime dependencies** in `packages/crdt`, CI-enforced (§1 of ARCH). This is already a requirement for testability, and it happens to also mean the package has no transitive attack surface. Say so in the README.
- **Publish with provenance.** Use npm's provenance flag from a GitHub Actions workflow (`npm publish --provenance`), so the package carries a signed attestation linking it to the exact commit and workflow that built it. This is free, it takes one CI flag, and given Tessera it would be strange not to.
- **`"files": ["dist"]`** in package.json. Ship build output only. Do not publish tests, source maps to nowhere, `.env` files, or the `bench/` fixtures.
- **Run `npm publish --dry-run` and read the file list** before the real publish. Every accidental credential leak in npm history was preceded by not doing this.
- **2FA on the npm account**, required for publish. Not optional.
- **No install scripts.** `postinstall` in a CRDT library is a red flag and there is no reason to have one.
- **Lockfile committed**, CI runs `pnpm install --frozen-lockfile`.

Note the Cotangent precedent: v0.1.0 shipped with a blank package page because the readme field was missing from the manifest, and v0.1.1 existed only to fix that. **Check the rendered page on a dry-run before tagging v0.1.0.**

---

## 4. Explicitly out of scope

Named so that their absence is a decision rather than a gap. If asked about any of these in an interview, the correct answer is "deliberately not, here is why," and that is a better answer than a half-built version would be.

| Excluded | Why |
|---|---|
| **Authentication / accounts** | The document id is the capability. Adding auth would mean adding a user store, which is a product, not a demo. |
| **Authorization / read-only sharing** | Cannot be enforced by a relay that does not understand ops. Enforcing it would require making the relay smart, which would destroy the property in §1. This tradeoff is worth explaining out loud; it is a genuinely interesting consequence of the architecture. |
| **End-to-end encryption** | Tractable (encrypt op payloads with a key in the URL fragment, relay never sees it) and genuinely tempting, since the relay is already blind to structure. Out of scope for v1 because key rotation and access revocation are their own project. **Note it in the README as the obvious next step**, because a reader will think of it and it is better to have already thought of it. |
| **Malicious peer / vandalism** | Anyone with the link can delete everything. Same as any link-shared doc. Mitigating this needs identity, which needs auth. |
| **Denial of service beyond §2.1** | The limits stop casual abuse. A determined attacker takes the demo down. It is a demo. |
| **Byzantine replicas forging ops** | No signatures on ops in v1. A peer can claim any `ReplicaId`. Out of scope for the same reason as auth. |
| **Compromised client** | Universal exclusion. Nothing to be done from inside the page. |

---

## 5. The one gate that matters

Everything in §1 rests on a single structural claim: the relay contains no CRDT code. That claim is checked by CI (gate 2, §1 of ARCH) and it is checked because **it is the kind of property that erodes silently.** Someone adds a validation to reject malformed ops, which requires a parser, which requires understanding ops, and now the server is an authority and the security model in §1 is false while the README still says it is true.

If that gate is ever removed or weakened, this document is void and needs rewriting. Treat it as load-bearing.
