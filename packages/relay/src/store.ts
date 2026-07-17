import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * An append-only log with a cursor. That is the entire design (ARCH §5).
 * This file never parses, validates the meaning of, or merges the bytes
 * it stores — it appends opaque bytes and hands back bytes from an
 * offset. It does not know what a CRDT is.
 */

export const MAX_MESSAGE_BYTES = 1 * 1024 * 1024; // 1 MB (SECURITY §2.1)
export const MAX_LOG_BYTES_PER_DOC = 50 * 1024 * 1024; // 50 MB
export const MAX_DOCS = 10_000;

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
};

/**
 * In-memory log plus append-to-disk (ARCH §5: "no database, replay on
 * boot"). LRU eviction over `docs` relies on `Map` iteration order being
 * insertion order — `touch()` re-inserts a key to move it to the
 * most-recently-used end, so the first key is always the least recently
 * used one.
 */
export class LogStore {
  private readonly docs = new Map<string, DocLog>();
  private readonly dataDir: string | null;

  constructor(options: { dataDir?: string } = {}) {
    this.dataDir = options.dataDir ?? null;
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
      const doc: DocLog = { chunks: [bytes], totalBytes: bytes.length, frozen: bytes.length >= MAX_LOG_BYTES_PER_DOC };
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
    if (this.docs.size < MAX_DOCS) return;
    const oldest = this.docs.keys().next().value;
    if (oldest !== undefined) this.docs.delete(oldest);
  }

  private diskPath(docId: string): string {
    // Only ever called with an already-UUID-validated docId.
    return path.join(this.dataDir!, `${docId}.log`);
  }

  append(docId: string, bytes: Buffer): AppendResult {
    if (!isValidDocId(docId)) return { ok: false, error: "invalid document id" };
    if (bytes.length > MAX_MESSAGE_BYTES) return { ok: false, error: "message too large" };

    let doc = this.docs.get(docId);
    if (!doc) {
      this.evictOldestIfFull();
      doc = { chunks: [], totalBytes: 0, frozen: false };
      this.docs.set(docId, doc);
    }
    if (doc.frozen) return { ok: false, error: "log frozen: maximum size reached" };
    if (doc.totalBytes + bytes.length > MAX_LOG_BYTES_PER_DOC) {
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

    const doc = this.docs.get(docId);
    if (!doc) {
      // A doc nobody has written to yet is an empty log, not an error —
      // from=0 on it is valid and returns nothing.
      return from === 0 ? { ok: true, bytes: Buffer.alloc(0) } : { ok: false, error: "offset out of range" };
    }
    if (from > doc.totalBytes) return { ok: false, error: "offset out of range" };
    this.touch(docId);
    return { ok: true, bytes: Buffer.concat(doc.chunks).subarray(from) };
  }

  /** For tests and diagnostics only — not part of the wire protocol. */
  docCount(): number {
    return this.docs.size;
  }
}
