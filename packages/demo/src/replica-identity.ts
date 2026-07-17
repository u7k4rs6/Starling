/**
 * A replica's id (used inside every CRDT op it creates) is unrelated to
 * where its local state is persisted — `IndexedDbPersistence` is keyed by
 * a plain string the caller chooses (`persistence.ts`, `packages/provider`).
 * This demo runs two (or three, via "open in a new tab") independent
 * replicas inside *one* browser, each meant to behave like its own
 * separate device — so each pane needs its own persistence namespace
 * (`${DOC_ID}:${paneId}`, never shared) even though the underlying
 * `IndexedDbPersistence` class has no notion of "panes" at all.
 *
 * The replica id itself is random, generated once and kept in
 * `localStorage` — a *stable* identity across reloads, which is what
 * makes "reload while offline" (S9) resume the same replica's pending
 * ops rather than starting a fresh one that has never pushed anything.
 */
export function replicaIdForPane(paneId: string): string {
  const key = `starling-demo:replica-id:${paneId}`;
  const existing = localStorage.getItem(key);
  if (existing !== null) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem(key, fresh);
  return fresh;
}

export function persistenceKeyForPane(docId: string, paneId: string): string {
  return `${docId}:${paneId}`;
}
