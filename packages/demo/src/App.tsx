import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControllableTransport,
  HttpRelayTransport,
  InMemoryPersistence,
  LocalRelayHub,
  Provider,
  generateRoomId,
  roomFragment,
  roomIdFromFragment,
} from "@starling/provider";
import { EditorPane, type PaneState } from "./EditorPane.js";
import { Core } from "./Core.js";
import { BreakIt, type Controls } from "./BreakIt.js";
import { Health } from "./Health.js";
import { ActivityMetrics, type LogEntry, type Metrics } from "./ActivityMetrics.js";
import { Header } from "./Header.js";
import { ShareBlock, WakingBlock, SharedBlock, FrozenBlock, Footer } from "./StateBlocks.js";
import { computeStatus, type Phase } from "./status.js";
import { applyTheme, initialTheme, type Theme } from "./theme.js";
import { RELAY_URL } from "./config.js";
import type { TextEdit } from "./text-binding.js";

function nowStamp(): string {
  const d = new Date();
  const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return `${hms}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * The whole demo on one screen, in the Starling v8 design. Two replicas of one
 * document sit either side of a CORE cut-control; break-it sliders degrade their
 * links; a connection-health strip and a live log read the real convergence
 * state. Everything is wired to the real engine: two Providers over a shared
 * in-browser hub by default, handed to the hosted relay on share.
 */
export function App() {
  const setup = useMemo(() => {
    const fromUrl = roomIdFromFragment(window.location.hash);
    const roomId = fromUrl ?? generateRoomId();
    const startInRelay = fromUrl !== null;
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(`starling-local-${roomId}`) : null;
    const hub = new LocalRelayHub(channel);
    const base = () => (startInRelay ? new HttpRelayTransport(RELAY_URL, roomId) : hub.transport(roomId));
    return {
      roomId,
      startInRelay,
      linkA: new ControllableTransport(base()),
      linkB: new ControllableTransport(base()),
      persistenceA: new InMemoryPersistence(),
      persistenceB: new InMemoryPersistence(),
    };
  }, []);

  const activeLinkA = useRef(setup.linkA);
  const activeLinkB = useRef(setup.linkB);
  const providerA = useRef<Provider | null>(null);
  const providerB = useRef<Provider | null>(null);
  const wakeTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const wakeCancelled = useRef(false);
  const divergedSince = useRef<number | null>(null);
  const logSeq = useRef(0);

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [control, setControl] = useState<Controls & { cutA: boolean; cutB: boolean }>({ cutA: false, cutB: false, latency: 0.2, loss: 0, reorder: 0 });
  const [shared, setShared] = useState(setup.startInRelay);
  const [waking, setWaking] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [wakeElapsed, setWakeElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [textA, setTextA] = useState("");
  const [textB, setTextB] = useState("");
  const [pendingA, setPendingA] = useState(0);
  const [pendingB, setPendingB] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [opsTotal, setOpsTotal] = useState(0);
  const [recent, setRecent] = useState<{ t: number; n: number }[]>([]);
  const [conv, setConv] = useState({ sum: 0, count: 0 });

  const pushLog = useCallback((site: string, type: string, payload: string, dest: string, tone: LogEntry["tone"]) => {
    setLog((prev) => prev.concat([{ id: (logSeq.current += 1), time: nowStamp(), site, type, payload, dest, tone }]).slice(-8));
  }, []);

  // Apply the current controls to whichever links are active (they are replaced
  // on share, so this must read the refs, not the initial links).
  useEffect(() => {
    const shape = { latencyMs: control.latency * 1500, dropRate: control.loss, reorderRate: control.reorder };
    activeLinkA.current.setState({ ...shape, connected: !control.cutA });
    activeLinkB.current.setState({ ...shape, connected: !control.cutB });
  }, [control]);

  // Prune the 60-second metrics window each second.
  useEffect(() => {
    const id = setInterval(() => setRecent((r) => r.filter((x) => x.t >= Date.now() - 60000)), 2000);
    return () => clearInterval(id);
  }, []);

  // Convergence timing: measure how long the two documents stay different, and
  // log the moment they agree again.
  useEffect(() => {
    if (textA === textB) {
      if (divergedSince.current != null) {
        const dt = Date.now() - divergedSince.current;
        divergedSince.current = null;
        setConv((c) => ({ sum: c.sum + dt, count: c.count + 1 }));
        if (!control.cutA && !control.cutB && !frozen) pushLog("✦", "SYNC", "all operations applied", "converged", "ack");
      }
    } else if (divergedSince.current == null) {
      divergedSince.current = Date.now();
    }
  }, [textA, textB, control.cutA, control.cutB, frozen, pushLog]);

  const onReadyA = useCallback((p: Provider) => {
    providerA.current = p;
  }, []);
  const onReadyB = useCallback((p: Provider) => {
    providerB.current = p;
  }, []);
  const onState = useCallback((site: "A" | "B", state: PaneState) => {
    if (site === "A") {
      setTextA(state.text);
      setPendingA(state.pending);
    } else {
      setTextB(state.text);
      setPendingB(state.pending);
    }
  }, []);
  const onEdit = useCallback(
    (site: "A" | "B", edit: TextEdit) => {
      const n = edit.inserted.length + edit.removed;
      setOpsTotal((v) => v + n);
      setRecent((r) => r.concat([{ t: Date.now(), n }]));
      const other = site === "A" ? "B" : "A";
      if (edit.inserted.length > 0) {
        const snip = edit.inserted.replace(/\n/g, "⏎");
        pushLog(site, "INSERT", `"${snip.length > 18 ? `${snip.slice(0, 18)}…` : snip}"`, `→ ${other}`, "flight");
      } else if (edit.removed > 0) {
        pushLog(site, "DELETE", `${edit.removed} ${edit.removed === 1 ? "char" : "chars"}`, `→ ${other}`, "flight");
      }
    },
    [pushLog]
  );
  const onBlocked = useCallback(() => {
    setFrozen(true);
    pushLog("✦", "FROZEN", "room full, sync stopped", "local only", "drop");
  }, [pushLog]);

  const onTheme = useCallback((t: Theme) => {
    applyTheme(t);
    setTheme(t);
  }, []);

  const toggleCut = useCallback(
    (site: "A" | "B") => {
      setControl((c) => {
        const key = site === "A" ? "cutA" : "cutB";
        const next = !c[key];
        pushLog(site, next ? "CUT" : "JOIN", next ? "link severed" : "link restored", next ? "offline" : "online", next ? "drop" : "ack");
        if (!next) {
          setReconciling(true);
          setTimeout(() => setReconciling(false), 1400);
        }
        return { ...c, [key]: next };
      });
    },
    [pushLog]
  );
  const onToggleAll = useCallback(() => {
    setControl((c) => {
      const on = c.cutA || c.cutB;
      pushLog("✦", on ? "JOIN" : "CUT", on ? "both links restored" : "both links severed", on ? "online" : "offline", on ? "ack" : "drop");
      if (on) {
        setReconciling(true);
        setTimeout(() => setReconciling(false), 1400);
      }
      return { ...c, cutA: !on, cutB: !on };
    });
  }, [pushLog]);

  const shareUrl = `${window.location.origin}${window.location.pathname}${roomFragment(setup.roomId)}`;

  const onShare = useCallback(async () => {
    if (shared || waking) return;
    window.history.replaceState(null, "", roomFragment(setup.roomId));
    wakeCancelled.current = false;
    setWaking(true);
    setWakeElapsed(0);
    pushLog("✦", "WAKE", "relay asleep, starting up", "waking", "drop");
    wakeTimer.current = setInterval(() => setWakeElapsed((e) => e + 1), 1000);
    // Wake the relay while both panes stay on the local hub, so the demo keeps
    // converging locally and the wait is shown, not hung. The GET resolves once
    // the free instance is up.
    try {
      await fetch(`${RELAY_URL}/health`, { cache: "no-store" });
    } catch {
      // Probe blocked or unreachable; try the handover anyway, the local hub is
      // the never-broken floor.
    }
    clearInterval(wakeTimer.current);
    if (wakeCancelled.current) return;
    const newA = new ControllableTransport(new HttpRelayTransport(RELAY_URL, setup.roomId), activeLinkA.current.state);
    const newB = new ControllableTransport(new HttpRelayTransport(RELAY_URL, setup.roomId), activeLinkB.current.state);
    activeLinkA.current = newA;
    activeLinkB.current = newB;
    await Promise.all([providerA.current?.switchTransport(newA), providerB.current?.switchTransport(newB)]);
    setWaking(false);
    setShared(true);
    pushLog("✦", "ROOM", "relay awake, room open", "shared", "ack");
  }, [shared, waking, setup.roomId, pushLog]);

  const onCancelWake = useCallback(() => {
    wakeCancelled.current = true;
    clearInterval(wakeTimer.current);
    setWaking(false);
    setWakeElapsed(0);
  }, []);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [shareUrl]);

  const onFreshRoom = useCallback(() => {
    window.location.href = window.location.pathname;
  }, []);

  const phase: Phase = frozen ? "frozen" : waking ? "waking" : shared ? "shared" : "local";
  const status = computeStatus({ cutA: control.cutA, cutB: control.cutB, phase, reconciling, latency: control.latency, textA, textB, pendingA, pendingB });
  const metrics: Metrics = {
    opsTotal,
    opsReplicated: recent.reduce((sum, r) => sum + r.n, 0),
    avgMs: conv.count ? Math.round(conv.sum / conv.count) : 0,
  };
  const role = shared ? "RELAY" : "LOCAL";

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "var(--s4) var(--s4) var(--s7)" }}>
      <div style={{ maxWidth: "1320px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
        <Header status={status} theme={theme} onTheme={onTheme} />

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s3)", alignItems: "stretch" }}>
          <EditorPane site="A" role={role} isCut={control.cutA} dead={status.dead} persistence={setup.persistenceA} link={setup.linkA} onReady={onReadyA} onState={onState} onEdit={onEdit} onBlocked={onBlocked} />
          <Core status={status} onCutA={() => toggleCut("A")} onCutB={() => toggleCut("B")} />
          <EditorPane site="B" role={role} isCut={control.cutB} dead={status.dead} persistence={setup.persistenceB} link={setup.linkB} onReady={onReadyB} onState={onState} onEdit={onEdit} onBlocked={onBlocked} />
        </div>

        <BreakIt controls={control} cut={status.cut} onControl={(patch) => setControl((c) => ({ ...c, ...patch }))} onToggleAll={onToggleAll} />

        <Health status={status} />

        <ActivityMetrics log={log} metrics={metrics} />

        {phase === "local" && <ShareBlock onShare={() => void onShare()} />}
        {phase === "waking" && <WakingBlock elapsed={wakeElapsed} onCancel={onCancelWake} />}
        {phase === "shared" && <SharedBlock roomLink={shareUrl} copied={copied} onCopy={onCopy} />}
        {phase === "frozen" && <FrozenBlock onFreshRoom={onFreshRoom} />}

        <Footer />
      </div>
    </div>
  );
}
