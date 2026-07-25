import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isValidDocId, LogStore, MAX_DOCS, MAX_LOG_BYTES_PER_DOC, MAX_MESSAGE_BYTES } from "./store.js";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const DOC_C = "33333333-3333-4333-8333-333333333333";

function makeUuid(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

describe("isValidDocId", () => {
  it("accepts a well-formed UUID", () => {
    expect(isValidDocId(DOC_A)).toBe(true);
  });

  it("rejects a sequential id, a slug, and a title-derived string", () => {
    expect(isValidDocId("1")).toBe(false);
    expect(isValidDocId("my-document")).toBe(false);
    expect(isValidDocId("My Document Title")).toBe(false);
  });

  it("rejects path traversal attempts outright — SECURITY §2.2, reject don't sanitise", () => {
    expect(isValidDocId("../../etc/passwd")).toBe(false);
    expect(isValidDocId("..%2f..%2fetc%2fpasswd")).toBe(false);
    expect(isValidDocId(`${DOC_A}/../../../etc/passwd`)).toBe(false);
  });

  it("rejects a near-miss UUID (wrong length, wrong separators)", () => {
    expect(isValidDocId("11111111-1111-4111-8111-11111111111")).toBe(false); // one char short
    expect(isValidDocId("111111111111411181111111111111")).toBe(false); // no dashes
  });
});

describe("LogStore: append and read", () => {
  it("append returns sequential offsets; read from 0 returns everything written", () => {
    const store = new LogStore();
    const r1 = store.append(DOC_A, Buffer.from("hello "));
    const r2 = store.append(DOC_A, Buffer.from("world"));
    expect(r1).toEqual({ ok: true, offset: 0 });
    expect(r2).toEqual({ ok: true, offset: 6 });

    const read = store.read(DOC_A, 0);
    expect(read).toEqual({ ok: true, bytes: Buffer.from("hello world") });
  });

  it("read from a non-zero offset returns only the bytes from that point", () => {
    const store = new LogStore();
    store.append(DOC_A, Buffer.from("hello world"));
    const read = store.read(DOC_A, 6);
    expect(read).toEqual({ ok: true, bytes: Buffer.from("world") });
  });

  it("reading an untouched doc at offset 0 returns an empty log, not an error", () => {
    const store = new LogStore();
    const read = store.read(DOC_A, 0);
    expect(read).toEqual({ ok: true, bytes: Buffer.alloc(0) });
  });

  it("rejects an invalid doc id on both append and read", () => {
    const store = new LogStore();
    expect(store.append("not-a-uuid", Buffer.from("x"))).toEqual({
      ok: false,
      error: "invalid document id",
    });
    expect(store.read("not-a-uuid", 0)).toEqual({ ok: false, error: "invalid document id" });
  });

  it("rejects (does not clamp) an offset beyond the log's current length", () => {
    const store = new LogStore();
    store.append(DOC_A, Buffer.from("hi"));
    const read = store.read(DOC_A, 100);
    expect(read).toEqual({ ok: false, error: "offset out of range" });
  });

  it("rejects a negative or non-integer offset", () => {
    const store = new LogStore();
    store.append(DOC_A, Buffer.from("hi"));
    expect(store.read(DOC_A, -1)).toEqual({ ok: false, error: "invalid offset" });
    expect(store.read(DOC_A, 1.5)).toEqual({ ok: false, error: "invalid offset" });
  });

  it("two docs are independent logs", () => {
    const store = new LogStore();
    store.append(DOC_A, Buffer.from("a"));
    store.append(DOC_B, Buffer.from("b"));
    expect(store.read(DOC_A, 0)).toEqual({ ok: true, bytes: Buffer.from("a") });
    expect(store.read(DOC_B, 0)).toEqual({ ok: true, bytes: Buffer.from("b") });
  });
});

describe("LogStore: resource bounds (SECURITY §2.1)", () => {
  it("rejects a single message over the max size, as a hard error not a truncation", () => {
    const store = new LogStore();
    const tooBig = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
    const result = store.append(DOC_A, tooBig);
    expect(result).toEqual({ ok: false, error: "message too large" });
    expect(store.read(DOC_A, 0)).toEqual({ ok: true, bytes: Buffer.alloc(0) }); // nothing was written
  });

  it("accepts a message exactly at the max size", () => {
    const store = new LogStore();
    const exact = Buffer.alloc(MAX_MESSAGE_BYTES);
    expect(store.append(DOC_A, exact)).toEqual({ ok: true, offset: 0 });
  });

  it("freezes a doc's log once it would exceed the max total size — a wall, not an eviction", () => {
    const store = new LogStore();
    // Fill to just under the cap, then push it over.
    const chunk = Buffer.alloc(1024 * 1024); // 1 MB, within MAX_MESSAGE_BYTES
    const chunksNeeded = Math.floor(MAX_LOG_BYTES_PER_DOC / chunk.length);
    for (let i = 0; i < chunksNeeded; i += 1) {
      const r = store.append(DOC_A, chunk);
      expect(r.ok).toBe(true);
    }
    const overflow = store.append(DOC_A, Buffer.from("one more byte"));
    expect(overflow).toEqual({ ok: false, error: "log frozen: maximum size reached" });
    // Frozen means frozen — even a tiny message is rejected now, not just ones that would overflow.
    const tiny = store.append(DOC_A, Buffer.from("x"));
    expect(tiny).toEqual({ ok: false, error: "log frozen: maximum size reached" });
  }, 20_000);

  it("evicts the least-recently-used doc once max doc count is reached, sparing a touched one", () => {
    const store = new LogStore();
    for (let i = 0; i < MAX_DOCS; i += 1) {
      store.append(makeUuid(i), Buffer.from("x"));
    }
    expect(store.docCount()).toBe(MAX_DOCS);

    // Touch doc 0 (read it) so it's no longer the least-recently-used —
    // everything else was written in order, so doc 1 is now the oldest.
    store.read(makeUuid(0), 0);

    // One more new doc should evict the LRU one (doc 1, not doc 0).
    store.append(makeUuid(MAX_DOCS), Buffer.from("x"));
    expect(store.docCount()).toBe(MAX_DOCS); // still capped

    // doc 0 survived (it was touched): its content is still there.
    expect(store.read(makeUuid(0), 0)).toEqual({ ok: true, bytes: Buffer.from("x") });
    // doc 1 was evicted: its content is gone, indistinguishable from a
    // doc that was never written to (an empty log, not an error) —
    // eviction drops history, it doesn't invalidate the id.
    expect(store.read(makeUuid(1), 0)).toEqual({ ok: true, bytes: Buffer.alloc(0) });
  }, 10_000);
});

describe("LogStore: disk persistence and replay (ARCH §5)", () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("persists appended bytes to disk under the doc's own filename", () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "starling-relay-"));
    const store = new LogStore({ dataDir });
    store.append(DOC_A, Buffer.from("persisted"));
    const onDisk = readFileSync(path.join(dataDir, `${DOC_A}.log`));
    expect(onDisk.toString()).toBe("persisted");
  });

  it("replayFromDisk rebuilds in-memory state after a restart", () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "starling-relay-"));
    const first = new LogStore({ dataDir });
    first.append(DOC_A, Buffer.from("hello "));
    first.append(DOC_A, Buffer.from("world"));

    const second = new LogStore({ dataDir });
    second.replayFromDisk();
    const read = second.read(DOC_A, 0);
    expect(read).toEqual({ ok: true, bytes: Buffer.from("hello world") });
  });

  it("replay ignores any file whose name isn't a valid doc id", () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "starling-relay-"));
    const store = new LogStore({ dataDir });
    // A file that didn't come from a validated append call — replay must
    // not trust filenames any more than it trusts request paths.
    writeFileSync(path.join(dataDir, "not-a-uuid.log"), "should be ignored");
    expect(existsSync(path.join(dataDir, "not-a-uuid.log"))).toBe(true);
    store.replayFromDisk();
    expect(store.read("not-a-uuid", 0)).toEqual({ ok: false, error: "invalid document id" });
  });

  // F-4: when a doc is persisted, the in-memory map is a cache over disk, so
  // eviction must not lose or corrupt its log. `maxDocs` keeps the cap small
  // enough to force eviction without writing MAX_DOCS docs to disk.
  it("F-4: re-hydrates an evicted-but-persisted doc from disk instead of serving it as empty", () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "starling-relay-"));
    const store = new LogStore({ dataDir, maxDocs: 2 });
    store.append(DOC_A, Buffer.from("important history"));
    // Two more docs push DOC_A out of the 2-slot cache (it is the LRU).
    store.append(DOC_B, Buffer.from("b"));
    store.append(DOC_C, Buffer.from("c"));

    // Before the fix this returned an empty log (DOC_A was gone from memory
    // and read never consulted disk). It must now return the real history.
    expect(store.read(DOC_A, 0)).toEqual({ ok: true, bytes: Buffer.from("important history") });
  });

  it("F-4: an append after eviction resumes at the on-disk length, not offset 0, and disk stays coherent", () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "starling-relay-"));
    const store = new LogStore({ dataDir, maxDocs: 2 });
    store.append(DOC_A, Buffer.from("hello ")); // 6 bytes on disk
    store.append(DOC_B, Buffer.from("b"));
    store.append(DOC_C, Buffer.from("c")); // evicts DOC_A from the cache

    // Before the fix: a fresh in-memory log reported offset 0 while
    // appendFileSync appended "world" at disk byte 6 — memory and disk
    // desynchronised, corrupting every offset after a restart.
    const resumed = store.append(DOC_A, Buffer.from("world"));
    expect(resumed).toEqual({ ok: true, offset: 6 });

    // Reads are consistent, and the on-disk file is one coherent log.
    expect(store.read(DOC_A, 0)).toEqual({ ok: true, bytes: Buffer.from("hello world") });
    expect(readFileSync(path.join(dataDir, `${DOC_A}.log`)).toString()).toBe("hello world");
  });

  it("F-4: a truly-unknown doc id (no memory, no disk) still reads as an empty log at offset 0", () => {
    // The re-hydration path must not turn a never-written doc into an error:
    // hydrate() returns undefined when no .log file exists, preserving the
    // "empty log, not an error" contract for from=0.
    dataDir = mkdtempSync(path.join(tmpdir(), "starling-relay-"));
    const store = new LogStore({ dataDir, maxDocs: 2 });
    expect(store.read(DOC_A, 0)).toEqual({ ok: true, bytes: Buffer.alloc(0) });
    expect(store.read(DOC_A, 5)).toEqual({ ok: false, error: "offset out of range" });
  });
});
