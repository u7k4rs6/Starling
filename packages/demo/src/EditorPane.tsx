import {
  anchorToPmPos,
  opToStep,
  pmDocFromDoc,
  pmPosToAnchor,
  transactionToOps,
  UndoManager,
} from "@starling/editor";
import { AwarenessClient, HttpRelayTransport, IndexedDbPersistence, Provider } from "@starling/provider";
import { useEffect, useRef, useState } from "react";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { AWARENESS_ID, AWARENESS_TTL_MS, DOC_ID, RELAY_URL, SYNC_INTERVAL_MS } from "./config.js";
import { persistenceKeyForPane, replicaIdForPane } from "./replica-identity.js";
import { remoteCursorPlugin, setRemoteCursors, type RemoteCursor } from "./remote-cursors.js";

type EditorPaneProps = {
  paneId: string;
  label: string;
  color: string;
};

/**
 * One replica, fully self-contained: its own `Doc`/`Provider`/
 * `AwarenessClient`/ProseMirror `EditorView`, its own connection toggle
 * and pending counter. FRONTEND §2.2: two of these side by side is the
 * whole demo; §2.4's "third replica" button is just a third one of these,
 * mounted standalone (see `SoloPane.tsx`).
 */
export function EditorPane({ paneId, label, color }: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const providerRef = useRef<Provider | null>(null);
  const awarenessRef = useRef<AwarenessClient | null>(null);
  const undoManagerRef = useRef(new UndoManager());
  const onlineRef = useRef(true);

  const [online, setOnlineState] = useState(true);
  const [pendingCount, setPendingCountState] = useState(0);
  const [justConverged, setJustConverged] = useState(false);
  const previousPendingRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    let convergeFlashTimeout: ReturnType<typeof setTimeout> | undefined;
    let persistTimeout: ReturnType<typeof setTimeout> | undefined;
    // UndoManager.record()'s own contract (undo.ts) is "one call, one
    // undo step, matching ordinary editor UX — undo an entire typed
    // burst at once, not one character at a time." Ordinary typing
    // produces one ProseMirror transaction per keystroke, so honoring
    // that contract means buffering consecutive local ops here and
    // committing them as a single batch once typing pauses, rather than
    // calling record() straight from every transaction (which would
    // technically satisfy record()'s literal API but make every Ctrl-Z
    // undo exactly one character — not what "burst" means, and not what
    // F4's own scenario needs).
    let undoBuffer: ReturnType<typeof transactionToOps> = [];
    let undoGroupTimeout: ReturnType<typeof setTimeout> | undefined;

    // FRONTEND §3: "the whole animation budget of this project is spent
    // on the two seconds that matter" — the pending counter draining to
    // exactly 0 from something nonzero, and nothing else.
    function setPendingCount(next: number): void {
      if (previousPendingRef.current > 0 && next === 0) {
        setJustConverged(true);
        if (convergeFlashTimeout !== undefined) clearTimeout(convergeFlashTimeout);
        convergeFlashTimeout = setTimeout(() => setJustConverged(false), 900);
      }
      previousPendingRef.current = next;
      setPendingCountState(next);
    }

    void (async () => {
      const replicaId = replicaIdForPane(paneId);
      const persistence = new IndexedDbPersistence(persistenceKeyForPane(DOC_ID, paneId));
      const contentTransport = new HttpRelayTransport(RELAY_URL, DOC_ID);
      const provider = await Provider.create(replicaId, persistence, contentTransport);
      if (cancelled) return;
      providerRef.current = provider;
      setPendingCount(provider.pendingCount());

      const awarenessTransport = new HttpRelayTransport(RELAY_URL, AWARENESS_ID);
      awarenessRef.current = new AwarenessClient(replicaId, awarenessTransport, AWARENESS_TTL_MS, () => Date.now());

      // Persistence must happen soon after a local edit, not only as a
      // side effect of sync() — sync() is exactly the call an offline
      // replica skips, and "offline edits survive reload" (ARCH §6, S9)
      // needs them in IndexedDB regardless of whether this replica is
      // online right now (DECISIONS #0025). Debounced rather than fired
      // on every keystroke: `IndexedDbPersistence.save()` now serializes
      // concurrent calls into strict call order (also #0025) so firing
      // one per keystroke is *correct*, but a fast typist queues up
      // dozens of full open+transaction+close cycles that can still be
      // draining well after typing stops — a reload right then abandons
      // whatever hadn't committed yet, losing the tail of what was
      // typed. Coalescing into one call ~250ms after the last edit is
      // both the performance fix (one write instead of dozens for one
      // sentence) and what actually closes that window in practice.
      function schedulePersist(): void {
        if (persistTimeout !== undefined) clearTimeout(persistTimeout);
        persistTimeout = setTimeout(() => void provider.persistNow(), 250);
      }

      // Commits whatever's been typed since the last pause as one undo
      // step. Called on a pause timer (below) and immediately before an
      // undo (so a burst still being typed — undoGroupTimeout hasn't
      // fired yet — is included in what Ctrl-Z undoes, not stranded
      // un-recorded because the user undid before the pause window
      // closed).
      function flushUndoGroup(): void {
        if (undoGroupTimeout !== undefined) {
          clearTimeout(undoGroupTimeout);
          undoGroupTimeout = undefined;
        }
        if (undoBuffer.length > 0) {
          undoManagerRef.current.record(undoBuffer, provider.doc);
          undoBuffer = [];
        }
      }

      function dispatchTransaction(tr: Transaction): void {
        const view = viewRef.current;
        if (!view) return;
        const newState = view.state.apply(tr);
        view.updateState(newState);
        if (tr.docChanged) {
          const ops = transactionToOps(tr, provider.doc);
          undoBuffer.push(...ops);
          if (undoGroupTimeout !== undefined) clearTimeout(undoGroupTimeout);
          undoGroupTimeout = setTimeout(flushUndoGroup, 500);
          setPendingCount(provider.pendingCount());
          schedulePersist();
        }
        publishCursor();
      }

      function publishCursor(): void {
        const view = viewRef.current;
        const awareness = awarenessRef.current;
        if (!view || !awareness) return;
        const anchor = pmPosToAnchor(provider.doc, view.state.selection.head);
        void awareness.publish({ anchor, label, color });
      }

      function runUndo(): boolean {
        const view = viewRef.current;
        flushUndoGroup();
        if (!view || !undoManagerRef.current.canUndo()) return false;
        undoManagerRef.current.undo(provider.doc, (op) => {
          const step = opToStep(op, provider.doc);
          const result = step.apply(view.state.doc);
          if (!result.doc) return;
          view.updateState(EditorState.create({ doc: result.doc, plugins: view.state.plugins }));
        });
        setPendingCount(provider.pendingCount());
        schedulePersist(); // same reasoning as dispatchTransaction above — undo is a local edit too
        return true;
      }

      const state = EditorState.create({
        doc: pmDocFromDoc(provider.doc),
        plugins: [
          keymap({
            // schema.ts has no second block-level node — a literal
            // newline character isn't representable either (text nodes
            // hold plain characters), so Enter has nothing correct to
            // do; swallow it rather than let ProseMirror's default
            // handling throw trying to split a paragraph that can't
            // exist twice.
            Enter: () => true,
            // FRONTEND §1.4: never prosemirror-history — this is the
            // only undo binding in the whole app.
            "Mod-z": runUndo,
          }),
          remoteCursorPlugin(),
        ],
      });

      const view = new EditorView(containerRef.current!, { state, dispatchTransaction });
      viewRef.current = view;

      async function tick(): Promise<void> {
        if (!onlineRef.current) return;
        const currentView = viewRef.current;
        if (!currentView) return;

        // Capture the local selection as an anchor *before* syncing, so
        // it can be recomputed against whatever the document looks like
        // after — ARCH §7 / FRONTEND §1.3: the selection is an anchor,
        // not a number, exactly like an undo entry or a remote cursor.
        const selectionAnchor = pmPosToAnchor(provider.doc, currentView.state.selection.head);
        await provider.sync();
        if (cancelled) return;

        const newDoc = pmDocFromDoc(provider.doc);
        const newPos = Math.max(0, Math.min(anchorToPmPos(provider.doc, selectionAnchor), newDoc.content.size - 1));
        currentView.updateState(
          EditorState.create({
            doc: newDoc,
            selection: TextSelection.create(newDoc, newPos),
            plugins: currentView.state.plugins,
          })
        );
        setPendingCount(provider.pendingCount());

        const awareness = awarenessRef.current;
        if (awareness) {
          await awareness.poll();
          const cursors: RemoteCursor[] = [];
          for (const peer of awareness.peerStates()) {
            if (peer.replica === replicaId) continue;
            const data = peer.data as { anchor: Parameters<typeof anchorToPmPos>[1]; label: string; color: string };
            try {
              const pos = anchorToPmPos(provider.doc, data.anchor);
              cursors.push({ replica: peer.replica, pos, color: data.color, label: data.label });
            } catch {
              // The peer's cursor references an id this replica hasn't
              // integrated yet (a pull/publish race) — drop it for this
              // tick rather than crash; the next tick will have it.
            }
          }
          setRemoteCursors(currentView, cursors);
        }
      }

      intervalId = setInterval(() => void tick(), SYNC_INTERVAL_MS);
      void tick();
    })();

    return () => {
      cancelled = true;
      if (intervalId !== undefined) clearInterval(intervalId);
      if (convergeFlashTimeout !== undefined) clearTimeout(convergeFlashTimeout);
      if (persistTimeout !== undefined) {
        clearTimeout(persistTimeout);
        void providerRef.current?.persistNow(); // best-effort flush; a real page navigation won't wait on this
      }
      if (undoGroupTimeout !== undefined) clearTimeout(undoGroupTimeout);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [paneId, label, color]);

  function toggleOnline(): void {
    const next = !online;
    onlineRef.current = next;
    setOnlineState(next);
  }

  return (
    <section className="editor-pane" style={{ ["--replica-color" as string]: color }}>
      <header className="editor-pane-header">
        <span className="replica-label">{label}</span>
        <span className={`connection-dot ${online ? "online" : "offline"}`} />
      </header>
      <div className="editor-surface" ref={containerRef} />
      <footer className="editor-pane-footer">
        <label className="connection-toggle">
          <input type="checkbox" checked={online} onChange={toggleOnline} />
          <span>{online ? "online" : "offline"}</span>
        </label>
        <span className={`pending-counter ${justConverged ? "just-converged" : ""}`}>
          ops pending: {pendingCount}
        </span>
      </footer>
    </section>
  );
}
