import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer, type RelayOptions } from "./server.js";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const ALLOWED_ORIGIN = "https://demo.example";

let activeServer: ReturnType<typeof createRelayServer> | null = null;

function start(options: Partial<RelayOptions> = {}): Promise<string> {
  const server = createRelayServer({ allowedOrigin: ALLOWED_ORIGIN, ...options });
  activeServer = server;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = null;
  }
});

describe("relay server: POST and GET (ARCH §5)", () => {
  it("POST appends bytes and returns the offset it was written at", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "hello " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ offset: 0 });

    const res2 = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "world" });
    const body2 = (await res2.json()) as { offset: number };
    expect(body2.offset).toBe(6);
  });

  it("GET from offset 0 returns everything written so far", async () => {
    const base = await start();
    await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "hello " });
    await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "world" });

    const res = await fetch(`${base}/doc/${DOC_A}?from=0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("hello world");
  });

  it("GET from a non-zero offset returns only the bytes from that point", async () => {
    const base = await start();
    await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "hello world" });
    const res = await fetch(`${base}/doc/${DOC_A}?from=6`);
    expect(await res.text()).toBe("world");
  });

  it("GET with no from param defaults to 0", async () => {
    const base = await start();
    await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "abc" });
    const res = await fetch(`${base}/doc/${DOC_A}`);
    expect(await res.text()).toBe("abc");
  });

  it("GET on an untouched doc returns an empty body, not an error", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("relay server: input validation (SECURITY §2.2)", () => {
  it("rejects an invalid doc id on POST with 400", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/not-a-uuid`, { method: "POST", body: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid doc id on GET with 400", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it("rejects a negative or malformed offset with 400, not a silent clamp", async () => {
    const base = await start();
    await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "abc" });
    const resNegative = await fetch(`${base}/doc/${DOC_A}?from=-1`);
    expect(resNegative.status).toBe(400);
    const resGarbage = await fetch(`${base}/doc/${DOC_A}?from=abc`);
    expect(resGarbage.status).toBe(400);
  });

  it("returns an empty body (not 416) for an offset beyond the log's length", async () => {
    // A cursor past the end means the log reset under the client (a restart on
    // the free host's in-memory relay). Empty body + the changed generation
    // token lets the client reconcile instead of wedging on a hard error. See
    // DECISIONS #0031.
    const base = await start();
    await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "abc" });
    const res = await fetch(`${base}/doc/${DOC_A}?from=999`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("rejects a message over the size cap with 413", async () => {
    const base = await start();
    const tooBig = "x".repeat(1024 * 1024 + 1);
    const res = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: tooBig });
    expect(res.status).toBe(413);
  });

  it("returns 404 for a path that isn't /doc/:id", async () => {
    const base = await start();
    const res = await fetch(`${base}/something-else`);
    expect(res.status).toBe(404);
  });

  it("returns 405 for an unsupported method on a valid doc path", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});

describe("relay server: CORS (SECURITY §2.3) — exactly the configured origin, never *", () => {
  it("echoes the allowed origin back when it matches", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}`, { headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("does not set an ACAO header for a non-matching origin", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}`, { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("never uses a wildcard, even implicitly", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}`, { headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("handles an OPTIONS preflight", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });
});

describe("relay server: origin enforcement on writes (SECURITY §2.3, F-3)", () => {
  it("rejects a POST from a non-matching origin with 403 and does not append", async () => {
    const base = await start();
    // A cross-origin browser append with no custom headers is a CORS simple
    // request: it reaches the server with no preflight. Setting no ACAO on
    // the response is not enough — the write must be refused outright.
    const res = await fetch(`${base}/doc/${DOC_A}`, {
      method: "POST",
      body: "evil",
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);

    // Nothing was written — the doc is still empty.
    const readBack = await fetch(`${base}/doc/${DOC_A}?from=0`);
    expect(await readBack.text()).toBe("");
  });

  it("allows a POST from the configured demo origin", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}`, {
      method: "POST",
      body: "hi",
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(200);
    const readBack = await fetch(`${base}/doc/${DOC_A}?from=0`);
    expect(await readBack.text()).toBe("hi");
  });

  it("allows a POST with no Origin header — a non-browser client (curl, another server)", async () => {
    const base = await start();
    // Browsers always attach an Origin to a POST; its absence means a
    // non-browser client, which is inside the accepted "peers are trusted"
    // model (SECURITY §1/§4). Origin-checking only ever defends the browser.
    const res = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "ok" });
    expect(res.status).toBe(200);
  });
});

describe("relay server: rate limiting (SECURITY §2.1)", () => {
  it("returns 429 once the configured append rate is exceeded", async () => {
    const base = await start({ appendRatePerSecond: 2 });
    const r1 = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "a" });
    const r2 = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "b" });
    const r3 = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "c" });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  // F-3: with trustedProxyDepth set, the per-IP limit follows the real
  // client from X-Forwarded-For instead of collapsing to one shared limit at
  // the proxy's single socket address (all requests here share 127.0.0.1).
  it("with trustedProxyDepth, rate limits per X-Forwarded-For client, not per socket peer", async () => {
    const base = await start({ appendRatePerSecond: 1, trustedProxyDepth: 1 });
    const post = (clientIp: string) =>
      fetch(`${base}/doc/${DOC_A}`, {
        method: "POST",
        body: "x",
        headers: { "X-Forwarded-For": clientIp },
      });

    // Client 1.1.1.1 spends its single-request budget, then is limited.
    expect((await post("1.1.1.1")).status).toBe(200);
    expect((await post("1.1.1.1")).status).toBe(429);
    // Client 2.2.2.2 has its own budget — it is not affected by 1.1.1.1.
    expect((await post("2.2.2.2")).status).toBe(200);
  });

  it("limits appends per document, independently of the per-IP limit", async () => {
    const base = await start({ appendRatePerSecond: 100, appendRatePerSecondPerDoc: 1 });
    const DOC_B = "22222222-2222-4222-8222-222222222222";
    expect((await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "x" })).status).toBe(200);
    // Second append to the same doc trips the per-doc ceiling even though the
    // per-IP budget (100/s) is nowhere near spent.
    expect((await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "y" })).status).toBe(429);
    // A different doc has its own per-doc budget.
    expect((await fetch(`${base}/doc/${DOC_B}`, { method: "POST", body: "z" })).status).toBe(200);
  });

  it("by default (trustedProxyDepth 0) ignores X-Forwarded-For, so it can't be used to dodge the limit", async () => {
    const base = await start({ appendRatePerSecond: 1 });
    const post = (clientIp: string) =>
      fetch(`${base}/doc/${DOC_A}`, {
        method: "POST",
        body: "x",
        headers: { "X-Forwarded-For": clientIp },
      });

    // Every request shares the same socket peer; a spoofed, ever-changing
    // XFF must not each get a fresh budget.
    expect((await post("1.1.1.1")).status).toBe(200);
    expect((await post("9.9.9.9")).status).toBe(429);
  });
});

describe("relay server: generation token (restart reconciliation)", () => {
  it("returns a generation token on every response, stable within one boot", async () => {
    const base = await start();
    const post = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "x" });
    const get = await fetch(`${base}/doc/${DOC_A}?from=0`);
    const gen = post.headers.get("x-relay-generation");
    expect(gen).toBeTruthy();
    expect(get.headers.get("x-relay-generation")).toBe(gen);
  });

  it("exposes the generation header to cross-origin script", async () => {
    const base = await start();
    const res = await fetch(`${base}/doc/${DOC_A}?from=0`, { headers: { Origin: ALLOWED_ORIGIN } });
    expect(res.headers.get("access-control-expose-headers")).toContain("X-Relay-Generation");
  });

  it("a fresh boot has a different generation, and the empty-body read lets a client notice", async () => {
    const base1 = await start();
    const gen1 = (await fetch(`${base1}/doc/${DOC_A}?from=0`)).headers.get("x-relay-generation");
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = null;

    const base2 = await start();
    // A stale cursor into the previous instance now reads empty against a fresh,
    // empty log, and the generation has changed.
    const res = await fetch(`${base2}/doc/${DOC_A}?from=50`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-relay-generation")).not.toBe(gen1);
  });
});

describe("relay server: health endpoint", () => {
  it("GET /health returns ok, the generation, and a doc count, with no origin needed", async () => {
    const base = await start();
    await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "x" });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; generation: string; docs: number };
    expect(body.ok).toBe(true);
    expect(body.generation).toBeTruthy();
    expect(body.docs).toBe(1);
  });

  it("does not count against the append rate limit", async () => {
    const base = await start({ appendRatePerSecond: 1 });
    await fetch(`${base}/health`);
    await fetch(`${base}/health`);
    // The rate limit is for appends; health checks must never exhaust it.
    const res = await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: "x" });
    expect(res.status).toBe(200);
  });
});

describe("relay server: round-trips opaque bytes without interpreting them (ARCH §5)", () => {
  it("binary content survives a POST/GET round-trip byte-for-byte", async () => {
    const base = await start();
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 253, 10, 13, 0]);
    await fetch(`${base}/doc/${DOC_A}`, { method: "POST", body: bytes });
    const res = await fetch(`${base}/doc/${DOC_A}?from=0`);
    const roundTripped = new Uint8Array(await res.arrayBuffer());
    expect(roundTripped).toEqual(bytes);
  });
});
