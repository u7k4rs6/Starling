import { ControllableTransport, nextSyncDecision, Provider, type Persistence, type SyncTimingOverrides } from "@starling/provider";
import { useEffect, useRef, useState } from "react";
import { Star } from "./Star.js";
import { applyTextEdit, type TextEdit } from "./text-binding.js";

// Optional overrides for the hidden-tab timings, so the e2e can force the stop
// in seconds. Unset in production, where the real 2-minute grace applies.
const SYNC_TIMING: SyncTimingOverrides = {
  hiddenStopMs: import.meta.env.VITE_HIDDEN_POLL_STOP_MS ? Number(import.meta.env.VITE_HIDDEN_POLL_STOP_MS) : undefined,
  hiddenIntervalMs: import.meta.env.VITE_SYNC_HIDDEN_MS ? Number(import.meta.env.VITE_SYNC_HIDDEN_MS) : undefined,
};

export type PaneState = { text: string; pending: number };

type EditorPaneProps = {
  site: "A" | "B";
  /** LOCAL before sharing, RELAY once the room is open. */
  role: string;
  /** This replica's link is cut (frame turns pink, pane nudges aside). */
  isCut: boolean;
  /** Any link is cut or the room is frozen (drives the drift nudge). */
  dead: boolean;
  persistence: Persistence;
  link: ControllableTransport;
  onReady: (provider: Provider) => void;
  onState: (site: "A" | "B", state: PaneState) => void;
  onEdit: (site: "A" | "B", edit: TextEdit) => void;
  onBlocked: () => void;
};

/**
 * One replica: its own Doc, Provider, and a plain textarea bound to that Doc
 * through a character diff. The link is an in-browser log by default, so the
 * pane is live with no relay; the app swaps it for the hosted relay on share.
 * The sync loop is adaptive, partition-tolerant, and stops a hidden tab (with an
 * explicit `stopped` flag so it can resume).
 */
export function EditorPane({ site, role, isCut, dead, persistence, link, onReady, onState, onEdit, onBlocked }: EditorPaneProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [lineCount, setLineCount] = useState(1);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false; // true once the loop hard-stops; onVisibility resumes it
    let lastChangeAt = Date.now();
    let hiddenSince = document.visibilityState === "hidden" ? Date.now() : 0;
    let cleanup: () => void = () => {};

    void (async () => {
      const provider = await Provider.create(`replica-${site}-${crypto.randomUUID()}`, persistence, link);
      if (cancelled) return;
      onReady(provider);

      const report = (): void => {
        if (cancelled) return;
        const p = provider.pendingCount();
        setPending(p);
        setLineCount(Math.max(provider.text.split("\n").length, 7));
        onState(site, { text: provider.text, pending: p });
      };

      const ta = textareaRef.current;
      if (ta) ta.value = provider.text;
      report();

      function onInput(): void {
        const el = textareaRef.current;
        if (!el) return;
        const edit = applyTextEdit(provider, provider.text, el.value);
        if (edit) {
          lastChangeAt = Date.now();
          void provider.persistNow();
          onEdit(site, edit);
          report();
        }
      }

      function onScroll(): void {
        const el = textareaRef.current;
        if (el && gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
      }

      async function tick(): Promise<void> {
        if (cancelled) return;
        const el = textareaRef.current;
        const focused = el !== null && document.activeElement === el;
        const anchor = el ? provider.doc.anchorAt(el.selectionStart) : null;
        const before = provider.text;
        try {
          await provider.sync();
        } catch {
          // A partitioned or lossy link throws; expected while a control is
          // engaged. The state vector re-offers anything unsent next tick.
        }
        if (cancelled) return;
        if (el && provider.text !== before) {
          lastChangeAt = Date.now();
          el.value = provider.text;
          if (focused && anchor) {
            const pos = provider.doc.resolveAnchor(anchor);
            el.selectionStart = el.selectionEnd = pos;
          }
          onScroll();
        }
        report();
        if (provider.isSyncBlocked()) {
          // Room frozen: pushes will never land. Stop the loop (no more requests,
          // so a free relay can spin down) and let the app surface it.
          onBlocked();
          return;
        }
        schedule();
      }

      function schedule(): void {
        if (cancelled) return;
        const visible = document.visibilityState === "visible";
        const decision = nextSyncDecision(
          { visible, msSinceChange: Date.now() - lastChangeAt, msHidden: visible ? 0 : Date.now() - (hiddenSince || Date.now()) },
          SYNC_TIMING
        );
        if (decision.poll) {
          stopped = false;
          timer = setTimeout(() => void tick(), decision.delayMs);
        } else {
          stopped = true; // explicit; a fired timer id must not stand in for this
        }
      }

      function onVisibility(): void {
        if (document.visibilityState === "hidden") {
          hiddenSince = Date.now();
          return;
        }
        hiddenSince = 0;
        if (stopped) {
          stopped = false;
          void tick();
        }
      }

      const el = textareaRef.current;
      el?.addEventListener("input", onInput);
      el?.addEventListener("scroll", onScroll);
      document.addEventListener("visibilitychange", onVisibility);
      void tick();

      cleanup = () => {
        el?.removeEventListener("input", onInput);
        el?.removeEventListener("scroll", onScroll);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      cleanup();
    };
  }, [site, persistence, link, onReady, onState, onEdit, onBlocked]);

  const frameStyle = {
    flex: "1 1 0%",
    minWidth: "300px",
    border: `1px solid ${isCut ? "var(--pink-dim)" : "var(--line)"}`,
    borderRadius: "var(--r)",
    background: "var(--editor)",
    boxShadow: "var(--glow)",
    display: "flex",
    flexDirection: "column" as const,
    minHeight: "292px",
    transform: dead && isCut ? `translateX(${site === "A" ? "-4px" : "4px"})` : "none",
    transition: "transform .5s ease, border-color .3s ease",
  };

  const lines = [];
  for (let i = 1; i <= lineCount; i += 1) lines.push(i);

  return (
    <div style={frameStyle} data-pane={site}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--s3)",
          padding: "10px var(--s4)",
          borderBottom: "1px solid var(--line-2)",
          background: "var(--panel-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          <span style={{ fontSize: "var(--t3)", fontWeight: 500, letterSpacing: ".14em" }}>REPLICA {site}</span>
          <span
            style={{
              fontSize: "var(--t0)",
              letterSpacing: ".14em",
              padding: "3px 7px",
              borderRadius: "var(--r)",
              background: "var(--gold)",
              color: "#0a0a0a",
            }}
          >
            {role}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", flex: "none" }}>
          {pending > 0 && (
            <span
              data-pending
              style={{
                fontSize: "var(--t0)",
                letterSpacing: ".12em",
                padding: "3px 7px",
                borderRadius: "var(--r)",
                border: "1px solid var(--pink)",
                color: "var(--pink)",
                whiteSpace: "nowrap",
                animation: "st-pop .3s ease-out",
              }}
            >
              {pending} PENDING
            </span>
          )}
          <Star
            style={{
              width: "12px",
              height: "12px",
              flex: "none",
              color: pending > 0 ? "var(--pink)" : "var(--gold)",
              animation: pending > 0 ? "st-twinkle 1.3s ease-in-out infinite" : "none",
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "3px", width: "14px" }} aria-hidden="true">
            <span style={{ height: "1px", background: "var(--fg-2)", display: "block" }} />
            <span style={{ height: "1px", background: "var(--fg-2)", display: "block" }} />
            <span style={{ height: "1px", background: "var(--fg-2)", display: "block" }} />
          </div>
        </div>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div ref={gutterRef} style={{ width: "40px", flex: "none", padding: "var(--s4) 0", background: "var(--panel-2)", overflow: "hidden" }}>
          {lines.map((n) => (
            <div key={n} style={{ fontSize: "var(--t2)", lineHeight: "26px", textAlign: "right", paddingRight: "10px", color: "var(--fg-3)" }}>
              {n}
            </div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          spellCheck={false}
          wrap="off"
          placeholder="type here"
          aria-label={`replica ${site} editor`}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: "238px",
            resize: "none",
            border: 0,
            outline: "none",
            background: "transparent",
            color: "var(--fg)",
            fontSize: "var(--t3)",
            lineHeight: "26px",
            whiteSpace: "pre",
            overflowX: "auto",
            padding: "var(--s4)",
          }}
        />
      </div>
    </div>
  );
}
