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
import { EditorPane, type PaneReady } from "./EditorPane.js";
import { Controls, type ControlState } from "./Controls.js";
import { StatusStrip } from "./StatusStrip.js";
import { REPLICA_A_COLOR, REPLICA_B_COLOR } from "./colors.js";
import { RELAY_URL } from "./config.js";
import { replicaIdForPane } from "./replica-identity.js";

/**
 * The whole demo on one screen. Two replicas of one document sit side by side,
 * each syncing through its own controllable link. By default both links are two
 * views of an in-browser log (LocalRelayHub), so the page is fully live with no
 * server at all: this is what a first-time visitor sees, and it never waits on a
 * cold relay. Sharing hands both replicas over to the hosted relay in place.
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
      replicaA: replicaIdForPane("pane-a"),
      replicaB: replicaIdForPane("pane-b"),
    };
  }, []);

  // The links the controls act on. They start as the initial links and are
  // replaced in place when the visitor shares (see onShare), so the controls
  // keep working after the handoff without the panes remounting.
  const activeLinkA = useRef(setup.linkA);
  const activeLinkB = useRef(setup.linkB);
  const providerA = useRef<Provider | null>(null);
  const providerB = useRef<Provider | null>(null);

  const [textA, setTextA] = useState("");
  const [textB, setTextB] = useState("");
  const [shared, setShared] = useState(setup.startInRelay);
  const [copied, setCopied] = useState(false);
  const [control, setControl] = useState<ControlState>({
    connectedA: true,
    connectedB: true,
    latencyMs: 0,
    dropRate: 0,
    reorderRate: 0,
  });

  useEffect(() => {
    const shape = { latencyMs: control.latencyMs, dropRate: control.dropRate, reorderRate: control.reorderRate };
    activeLinkA.current.setState({ ...shape, connected: control.connectedA });
    activeLinkB.current.setState({ ...shape, connected: control.connectedB });
  }, [control]);

  const onReadyA = useCallback((r: PaneReady) => {
    providerA.current = r.provider;
  }, []);
  const onReadyB = useCallback((r: PaneReady) => {
    providerB.current = r.provider;
  }, []);

  const shareUrl = `${window.location.origin}${window.location.pathname}${roomFragment(setup.roomId)}`;

  const onShare = useCallback(async () => {
    if (shared) return;
    const newA = new ControllableTransport(new HttpRelayTransport(RELAY_URL, setup.roomId), activeLinkA.current.state);
    const newB = new ControllableTransport(new HttpRelayTransport(RELAY_URL, setup.roomId), activeLinkB.current.state);
    activeLinkA.current = newA;
    activeLinkB.current = newB;
    window.history.replaceState(null, "", roomFragment(setup.roomId));
    setShared(true);
    // Replay both local histories into the relay and reconcile. The document
    // already holds every keystroke; switchTransport just resets the cursors so
    // they mean something in the relay's log. See Provider.switchTransport.
    await Promise.all([providerA.current?.switchTransport(newA), providerB.current?.switchTransport(newB)]);
  }, [shared, setup.roomId]);

  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [shareUrl]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-name">starling</span>
        </div>
        <p className="tagline">
          One document, two replicas. Type in either. Break the connection between them and watch the text heal itself, with
          no conflict prompt and nothing lost.
        </p>
      </header>

      <main className="stage">
        <div className="panes">
          <EditorPane
            label="A"
            color={REPLICA_A_COLOR}
            replicaId={setup.replicaA}
            link={setup.linkA}
            persistence={setup.persistenceA}
            onReady={onReadyA}
            onText={setTextA}
          />
          <EditorPane
            label="B"
            color={REPLICA_B_COLOR}
            replicaId={setup.replicaB}
            link={setup.linkB}
            persistence={setup.persistenceB}
            onReady={onReadyB}
            onText={setTextB}
          />
        </div>

        <StatusStrip textA={textA} textB={textB} />

        <Controls state={control} onChange={(patch) => setControl((c) => ({ ...c, ...patch }))} />

        <section className="share">
          {shared ? (
            <>
              <div className="share-row">
                <input className="share-url" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="share-copy" onClick={onCopy}>
                  {copied ? "copied" : "copy link"}
                </button>
              </div>
              <p className="share-note">Anyone with this link can read and edit this room. It is a shared secret, not a login.</p>
            </>
          ) : (
            <>
              <button type="button" className="share-button" onClick={() => void onShare()}>
                share over the network
              </button>
              <p className="share-note">
                You are editing locally right now, so nothing here touches a server. Sharing opens a relay room and gives you a
                link others can join.
              </p>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
