import { opToStep, pmDocFromDoc, pmPosToAnchor, anchorToPmPos, transactionToOps, UndoManager } from "@starling/editor";
import { ControllableTransport, nextSyncDecision, Provider, type Persistence, type SyncTimingOverrides } from "@starling/provider";
import { useEffect, useRef, useState } from "react";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";

// Optional overrides for the hidden-tab timings, so the e2e can force the stop
// in seconds. Unset in production, where the real 2-minute grace applies.
const SYNC_TIMING: SyncTimingOverrides = {
  hiddenStopMs: import.meta.env.VITE_HIDDEN_POLL_STOP_MS ? Number(import.meta.env.VITE_HIDDEN_POLL_STOP_MS) : undefined,
  hiddenIntervalMs: import.meta.env.VITE_SYNC_HIDDEN_MS ? Number(import.meta.env.VITE_SYNC_HIDDEN_MS) : undefined,
};

export type PaneReady = { provider: Provider; link: ControllableTransport };

type EditorPaneProps = {
  label: string;
  color: string;
  replicaId: string;
  /** Where this replica's Doc is persisted. Its own namespace, never shared. */
  persistence: Persistence;
  /** The link this pane syncs through. The visitor's controls mutate its state. */
  link: ControllableTransport;
  /** Called once the provider exists, so the app can drive share and status. */
  onReady: (ready: PaneReady) => void;
  /** Called with the pane's current text whenever it changes, for the status strip. */
  onText: (text: string) => void;
  /** Called if the relay permanently refuses this pane's pushes (the room's log
   * froze). The pane stops syncing; the app surfaces the terminal state. */
  onBlocked: () => void;
};

/**
 * One replica: its own Doc, Provider, and ProseMirror view, syncing through the
 * link it is handed. The link is a local in-browser log by default, so the pane
 * works with no relay; the app swaps it for the hosted relay on share.
 *
 * The sync loop is adaptive and partition-tolerant. It reschedules itself from
 * nextSyncDecision (fast while typing, slow when idle, stopped when hidden long
 * enough), catches the errors a partitioned or lossy link throws, and resumes a
 * stopped loop on visibilitychange.
 */
export function EditorPane({ label, color, replicaId, persistence, link, onReady, onText, onBlocked }: EditorPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false; // true once the loop hard-stops; onVisibility resumes it
    let lastChangeAt = Date.now();
    let hiddenSince = document.visibilityState === "hidden" ? Date.now() : 0;
    const undo = new UndoManager();
    let undoBuffer: ReturnType<typeof transactionToOps> = [];
    let undoTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanup: () => void = () => {};

    void (async () => {
      const provider = await Provider.create(replicaId, persistence, link);
      if (cancelled) return;
      onReady({ provider, link });

      const report = (): void => {
        if (cancelled) return;
        setPending(provider.pendingCount());
        onText(provider.text);
      };

      const flushUndo = (): void => {
        if (undoTimer !== undefined) {
          clearTimeout(undoTimer);
          undoTimer = undefined;
        }
        if (undoBuffer.length > 0) {
          undo.record(undoBuffer, provider.doc);
          undoBuffer = [];
        }
      };

      function dispatch(tr: Transaction): void {
        const view = viewRef.current;
        if (!view) return;
        view.updateState(view.state.apply(tr));
        if (tr.docChanged) {
          undoBuffer.push(...transactionToOps(tr, provider.doc));
          if (undoTimer !== undefined) clearTimeout(undoTimer);
          undoTimer = setTimeout(flushUndo, 500);
          lastChangeAt = Date.now();
          void provider.persistNow();
          report();
        }
      }

      function runUndo(): boolean {
        const view = viewRef.current;
        flushUndo();
        if (!view || !undo.canUndo()) return false;
        undo.undo(provider.doc, (op) => {
          const step = opToStep(op, provider.doc);
          const result = step.apply(view.state.doc);
          if (!result.doc) return;
          view.updateState(EditorState.create({ doc: result.doc, plugins: view.state.plugins }));
        });
        lastChangeAt = Date.now();
        void provider.persistNow();
        report();
        return true;
      }

      const view = new EditorView(containerRef.current!, {
        state: EditorState.create({
          doc: pmDocFromDoc(provider.doc),
          plugins: [keymap({ Enter: () => true, "Mod-z": runUndo })],
        }),
        dispatchTransaction: dispatch,
      });
      viewRef.current = view;
      report();

      async function tick(): Promise<void> {
        if (cancelled) return;
        const view = viewRef.current;
        if (view) {
          const before = provider.text;
          const anchor = pmPosToAnchor(provider.doc, view.state.selection.head);
          try {
            await provider.sync();
          } catch {
            // A partitioned or lossy link throws; that is expected while a
            // control is engaged. The state vector re-offers anything unsent
            // on the next tick, so nothing is lost. Just try again later.
          }
          if (cancelled) return;
          if (provider.text !== before) {
            lastChangeAt = Date.now();
            const doc = pmDocFromDoc(provider.doc);
            const pos = Math.max(0, Math.min(anchorToPmPos(provider.doc, anchor), doc.content.size - 1));
            view.updateState(EditorState.create({ doc, selection: TextSelection.create(doc, pos), plugins: view.state.plugins }));
          }
          report();
          if (provider.isSyncBlocked()) {
            // The room's log is frozen: pushes will never land again. Stop the
            // loop (no more requests, so a free relay can spin down) and let the
            // app surface it. The editor stays fully usable locally.
            onBlocked();
            return;
          }
        }
        schedule();
      }

      function schedule(): void {
        if (cancelled) return;
        const visible = document.visibilityState === "visible";
        const decision = nextSyncDecision(
          {
            visible,
            msSinceChange: Date.now() - lastChangeAt,
            msHidden: visible ? 0 : Date.now() - (hiddenSince || Date.now()),
          },
          SYNC_TIMING
        );
        if (decision.poll) {
          stopped = false;
          timer = setTimeout(() => void tick(), decision.delayMs);
        } else {
          // Hard stop: the tab has been hidden and idle long enough. Record the
          // stop explicitly. `timer` alone cannot mark this, because it still
          // holds the id of the timer that just fired, so it is never undefined
          // here; using it as the resume signal was the bug that stranded a
          // backgrounded tab permanently.
          stopped = true;
        }
      }

      function onVisibility(): void {
        if (document.visibilityState === "hidden") {
          hiddenSince = Date.now();
          return;
        }
        hiddenSince = 0;
        // Becoming visible: restart the loop only if it had hard-stopped. When
        // stopped there is no pending or in-flight tick, so this cannot double
        // up. A still-running loop is left alone (its next tick re-adopts the
        // visible cadence), which avoids firing a second concurrent tick over
        // one that is mid-await.
        if (stopped) {
          stopped = false;
          void tick();
        }
      }
      document.addEventListener("visibilitychange", onVisibility);

      void tick();

      cleanup = () => {
        document.removeEventListener("visibilitychange", onVisibility);
        if (undoTimer !== undefined) clearTimeout(undoTimer);
      };
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      cleanup();
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [replicaId, persistence, link, onReady, onText, onBlocked]);

  return (
    <section className="pane" style={{ ["--replica" as string]: color }}>
      <header className="pane-head">
        <span className="pane-dot" />
        <span className="pane-label">replica {label}</span>
        <span className="pane-pending">{pending === 0 ? "in sync" : `${pending} pending`}</span>
      </header>
      <div className="pane-surface" ref={containerRef} />
    </section>
  );
}
