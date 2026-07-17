import type { ReplicaId } from "starling-crdt";

/**
 * ARCH §6: "IndexedDB in the browser, holding the encoded op log plus the
 * last-pushed vector. Reload replays it." `opLogBytes` is a single
 * `encodeOps` blob covering the *entire* doc (built from
 * `doc.missingFrom(new Map())` — an empty vector means "everything"), not
 * raw bytes captured off the wire, so `decodeOps` (single-blob) is enough
 * to read it back; no concatenation framing needed here, that's only a
 * concern for `RelayTransport.read` (see `decodeOpsStream` in
 * starling-crdt).
 */
export type PersistedState = {
  opLogBytes: Uint8Array;
  lastPushedVectorEntries: Array<[ReplicaId, number]>;
  relayReadOffset: number;
};

export interface Persistence {
  load(): Promise<PersistedState | null>;
  save(state: PersistedState): Promise<void>;
}

/** For tests, and for embedding contexts with no browser storage at all.
 * Not a fallback the production provider silently degrades to — callers
 * choose it explicitly. */
export class InMemoryPersistence implements Persistence {
  private state: PersistedState | null = null;

  async load(): Promise<PersistedState | null> {
    return this.state;
  }

  async save(state: PersistedState): Promise<void> {
    this.state = state;
  }
}

const DB_NAME_PREFIX = "starling-provider:";
const STORE_NAME = "state";
const STATE_KEY = "state";
const DB_VERSION = 1;

/**
 * Real browser persistence. One database per document id, one object
 * store holding a single record — there is exactly one thing to persist
 * (ARCH §6's op log + last-pushed vector), so there is no need for a
 * richer schema.
 */
export class IndexedDbPersistence implements Persistence {
  constructor(private readonly docId: string) {}

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`${DB_NAME_PREFIX}${this.docId}`, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async load(): Promise<PersistedState | null> {
    const db = await this.openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(STATE_KEY);
        request.onsuccess = () => resolve((request.result as PersistedState | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async save(state: PersistedState): Promise<void> {
    const db = await this.openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(state, STATE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }
}
