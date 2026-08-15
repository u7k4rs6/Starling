/**
 * The convergence indicator. It compares the two panes' document text, which is
 * their CRDT state, not the transport's log bytes: two replicas can hold the
 * same document while their logs differ in order and length, and that is exactly
 * what should read as "converged". So this is the honest question to ask of a
 * CRDT, and the answer a visitor can check with their own eyes against the two
 * editors above it.
 */
export function StatusStrip({ textA, textB }: { textA: string; textB: string }) {
  const converged = textA === textB;
  return (
    <div className={`status ${converged ? "status-converged" : "status-diverged"}`} role="status" aria-live="polite">
      <span className="status-dot" />
      <span className="status-text">
        {converged ? "converged" : "diverging"}
      </span>
      <span className="status-detail">
        {converged
          ? "both replicas hold the same document"
          : "the replicas differ, and will reconcile once the links are clear"}
      </span>
    </div>
  );
}
