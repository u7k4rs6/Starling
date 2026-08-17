import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

/**
 * An append-only log with a cursor. That is the entire design (ARCH §5).
 * This file never parses, validates the meaning of, or merges the bytes
 * it stores — it appends opaque bytes and hands back bytes from an
 * offset. It does not know what a CRDT is.
 */

// Caps sized so the pathological worst case fits the free host's 512 MB of
// RAM, not just typical use (a demo doc is a few KB). Worst case is every
// resident doc frozen at its max: MAX_DOCS * MAX_LOG_BYTES_PER_DOC = 128 * 2 MB
// = 256 MB of log bytes. A read copies one doc's log via Buffer.concat (a
// transient up to 2 MB per concurrent read, tens of MB under load), and Node
// itself wants ~100-150 MB, so the total lands near 420 MB with headroom under
// 512. See DECISIONS #0032 for the full arithmetic and the doc-count reasoning.
export const MAX_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MB per append (SECURITY §2.1); big enough that a paste never wedges a client
export const MAX_LOG_BYTES_PER_DOC = 2 * 1024 * 1024; // 2 MB per doc: ~200k characters, far past any demo document
export const MAX_DOCS = 128; // resident-doc ceiling; the LRU drops the coldest beyond this

// Document ids are capabilities (SECURITY §1): a CSPRNG UUID, never
// sequential, never derived from anything guessable. This regex is the
// *only* thing standing between a request and the filesystem — applied
// before any path is constructed, never after (SECURITY §2.2: "reject, do
// not sanitise").
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidDocId(id: string): boolean {
  return UUID_RE.test(id);
}

export type AppendResult = { ok: true; offset: number } | { ok: false; error: string };
export type ReadResult = { ok: true; bytes: Buffer } | { ok: false; error: string };

type DocLog = {
  chunks: Buffer[];
  totalBytes: number;
  frozen: boolean;
  /**
   * A token identifying this log instance, fresh every time the log is created:
   * a first append, a re-hydration from disk, or a boot replay. It is per
   * document, not per process, on purpose. A client detects that the log it was
   * reading has been replaced by watching this change, and the replacement that
   * has to be caught is not only a full restart but an LRU eviction and later
   * recreation, which happens while the process keeps running and so shares the
   * boot token. Per-document is the only token that changes in that case. See
   * DECISIONS #0031.
   */
  generation: string;
};

/**
 * In-memory log plus append-to-disk (ARCH §5: "no database, replay on
 * boot"). LRU eviction over `docs` relies on `Map` iteration order being
 * insertion order — `touch()` re-inserts a key to move it to the
 * most-recently-used end, so the first key is always the least recently
 * used one.
 *
 * When `dataDir` is set, the map is a *cache over durable disk*, not the
 * source of truth: an eviction only drops the in-memory copy, never the
 * `.log` file. A read or append that misses the cache re-hydrates from disk
 * (`hydrate`) so an evicted-but-persisted doc is served its real history
 * instead of an empty log, and a post-eviction append resumes at the log's
 * true on-disk length instead of restarting at offset 0 and desynchronising
 * memory from disk (F-4). With no `dataDir` there is nothing to recover
 * from, so eviction genuinely drops history — the documented in-memory
 * contract (`store.test.ts`).
 */
export class LogStore {
  private readonly docs = new Map<string, DocLog>();
  private readonly dataDir: string | null;
  private readonly maxDocs: number;
  private readonly maxLogBytes: number;

  constructor(options: { dataDir?: string; maxDocs?: number; maxLogBytesPerDoc?: number } = {}) {
    this.dataDir = options.dataDir ?? null;
    this.maxDocs = options.maxDocs ?? MAX_DOCS;
    this.maxLogBytes = options.maxLogBytesPerDoc ?? MAX_LOG_BYTES_PER_DOC;
    if (this.dataDir) mkdirSync(this.dataDir, { recursive: true });
  }

  /** Replay every doc's on-disk log into memory. Call once at startup. */
  replayFromDisk(): void {
    if (!this.dataDir) return;
    for (const entry of readdirSync(this.dataDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
      const docId = entry.name.slice(0, -".log".length);
      if (!isValidDocId(docId)) continue; // never trust filenames beyond the same check as any request
      const bytes = readFileSync(path.join(this.dataDir, entry.name));
      const doc: DocLog = { chunks: [bytes], totalBytes: bytes.length, frozen: bytes.length >= this.maxLogBytes, generation: randomUUID() };
      this.docs.set(docId, doc);
    }
  }

  private touch(docId: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;
    this.docs.delete(docId);
    this.docs.set(docId, doc);
  }

  private evictOldestIfFull(): void {
    if (this.docs.size < this.maxDocs) return;
    const oldest = this.docs.keys().next().value;
    if (oldest !== undefined) this.docs.delete(oldest);
  }

  private diskPath(docId: string): string {
    // Only ever called with an already-UUID-validated docId.
    return path.join(this.dataDir!, `${docId}.log`);
  }

  /**
   * The cached log for `docId`, loading it back from disk first if it was
   * evicted (or never yet paged in) but its `.log` file still exists. The
   * caller must have already validated `docId`. Returns undefined only when
   * the doc has no in-memory and no on-disk state — a genuinely-unknown id.
   * Re-hydration counts against the cache cap like any other insertion, so
   * paging one doc back in may evict a colder one.
   */
  private hydrate(docId: string): DocLog | undefined {
    const cached = this.docs.get(docId);
    if (cached) return cached;
    if (!this.dataDir) return undefined;
    const diskPath = this.diskPath(docId);
    if (!existsSync(diskPath)) return undefined;
    const bytes = readFileSync(diskPath);
    this.evictOldestIfFull();
    const doc: DocLog = {
      chunks: [bytes],
      totalBytes: bytes.length,
      frozen: bytes.length >= this.maxLogBytes,
      generation: randomUUID(),
    };
    this.docs.set(docId, doc);
    return doc;
  }

  append(docId: string, bytes: Buffer): AppendResult {
    if (!isValidDocId(docId)) return { ok: false, error: "invalid document id" };
    if (bytes.length > MAX_MESSAGE_BYTES) return { ok: false, error: "message too large" };

    let doc = this.hydrate(docId);
    if (!doc) {
      this.evictOldestIfFull();
      doc = { chunks: [], totalBytes: 0, frozen: false, generation: randomUUID() };
      this.docs.set(docId, doc);
    }
    if (doc.frozen) return { ok: false, error: "log frozen: maximum size reached" };
    if (doc.totalBytes + bytes.length > this.maxLogBytes) {
      doc.frozen = true;
      return { ok: false, error: "log frozen: maximum size reached" };
    }

    const offset = doc.totalBytes;
    doc.chunks.push(bytes);
    doc.totalBytes += bytes.length;
    this.touch(docId);
    if (this.dataDir) appendFileSync(this.diskPath(docId), bytes);
    return { ok: true, offset };
  }

  read(docId: string, from: number): ReadResult {
    if (!isValidDocId(docId)) return { ok: false, error: "invalid document id" };
    if (!Number.isInteger(from) || from < 0) return { ok: false, error: "invalid offset" };

    const doc = this.hydrate(docId);
    if (!doc) {
      // No in-memory and no on-disk state: either a doc nobody has written
      // to yet, or (with no dataDir) one whose history eviction dropped.
      // from=0 is an empty log, not an error; a non-zero offset into
      // nothing is out of range.
      return from === 0 ? { ok: true, bytes: Buffer.alloc(0) } : { ok: false, error: "offset out of range" };
    }
    if (from > doc.totalBytes) return { ok: false, error: "offset out of range" };
    this.touch(docId);
    return { ok: true, bytes: Buffer.concat(doc.chunks).subarray(from) };
  }

  /**
   * The generation token of the resident log instance for `docId`, or undefined
   * if no instance is resident (never created, or evicted). Resident-only by
   * design: it is read to stamp responses, and a doc that is absent from memory
   * has no live instance, so the caller falls back to the boot token. A client
   * with a stale cursor into a since-replaced instance sees the token change
   * (per-doc when the doc was recreated, boot when it is now absent) and
   * reconciles.
   */
  generationOf(docId: string): string | undefined {
    return this.docs.get(docId)?.generation;
  }

  /** For tests and diagnostics only — not part of the wire protocol. */
  docCount(): number {
    return this.docs.size;
  }
}
