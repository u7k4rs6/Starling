import { Star } from "./Star.js";

export function ShareBlock({ onShare }: { onShare: () => void }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--panel)", boxShadow: "var(--glow)", padding: "var(--s6) var(--s4)", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--s3)" }}>
      <button
        type="button"
        data-share
        onClick={onShare}
        style={{ fontSize: "var(--t3)", fontWeight: 500, letterSpacing: ".16em", background: "var(--gold)", color: "#0a0a0a", border: 0, borderRadius: "var(--r)", padding: "var(--s4) var(--s6)", minHeight: "50px", width: "100%", maxWidth: "400px" }}
      >
        SHARE OVER THE NETWORK
      </button>
      <p style={{ margin: 0, maxWidth: "60ch", textAlign: "center", fontSize: "var(--t2)", lineHeight: 1.8, letterSpacing: ".05em", color: "var(--fg-2)" }}>
        You are editing locally right now. Nothing here touches a server. Sharing opens a relay room and gives you a link others can join.
      </p>
    </div>
  );
}

export function WakingBlock({ elapsed, onCancel }: { elapsed: number; onCancel: () => void }) {
  const wake = Math.min(60, elapsed);
  const clock = `${Math.floor(wake / 60)}:${String(wake % 60).padStart(2, "0")} OF UP TO 1:00`;
  return (
    <div data-waking style={{ border: "1px solid var(--pink-dim)", borderRadius: "var(--r)", background: "var(--panel)", padding: "var(--s5) var(--s4)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: "var(--s2)" }}>
        <span style={{ fontSize: "var(--t4)", letterSpacing: ".16em", color: "var(--pink)" }}>WAKING THE RELAY</span>
        <span style={{ fontSize: "var(--t1)", letterSpacing: ".1em", color: "var(--fg-2)" }}>{clock}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        {Array.from({ length: 15 }, (_, i) => {
          const on = wake >= (i + 1) * 4;
          return (
            <div key={i} style={{ width: "15px", height: "15px", color: on ? "var(--gold)" : "var(--pink)", opacity: on ? 1 : 0.55, animation: on ? "st-pop .4s ease-out" : `st-twinkle 1.7s ease-in-out ${(i * 0.08).toFixed(2)}s infinite` }}>
              <Star style={{ width: "100%", height: "100%" }} fill={on ? "currentColor" : "none"} stroke={on ? "none" : "currentColor"} />
            </div>
          );
        })}
      </div>
      <p style={{ margin: 0, maxWidth: "74ch", fontSize: "var(--t2)", lineHeight: 1.8, letterSpacing: ".05em", color: "var(--fg-2)" }}>
        The relay runs on a free tier and falls asleep when nobody is in a room. The first connection can take up to a minute while it starts up. Both replicas stay live the whole time, so keep typing. Your edits queue locally and go out the moment the room opens.
      </p>
      <button type="button" onClick={onCancel} style={{ alignSelf: "flex-start", fontSize: "var(--t1)", letterSpacing: ".14em", background: "transparent", color: "var(--fg)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "var(--s3) var(--s4)", minHeight: "44px" }}>
        CANCEL, STAY LOCAL
      </button>
    </div>
  );
}

export function SharedBlock({ roomLink, copied, onCopy }: { roomLink: string; copied: boolean; onCopy: () => void }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--panel)", boxShadow: "var(--glow)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--s3)", padding: "var(--s4)", borderBottom: "1px solid var(--line-2)" }}>
        <span style={{ fontSize: "var(--t0)", letterSpacing: ".18em", color: "var(--fg-3)" }}>ROOM LINK</span>
        <span data-room-link style={{ fontSize: "var(--t3)", flex: 1, minWidth: "200px", wordBreak: "break-all", color: "var(--gold)" }}>{roomLink}</span>
        <button type="button" data-copy onClick={onCopy} style={{ fontSize: "var(--t1)", fontWeight: 500, letterSpacing: ".14em", minHeight: "42px", padding: "0 16px", border: 0, borderRadius: "var(--r)", background: copied ? "var(--gold-2)" : "var(--gold)", color: "#0a0a0a", animation: copied ? "st-pop .3s ease-out" : "none" }}>
          {copied ? "COPIED" : "COPY LINK"}
        </button>
      </div>
      <div style={{ display: "flex", gap: "var(--s3)", padding: "var(--s4)", background: "var(--pink-faint)" }}>
        <Star style={{ width: "13px", height: "13px", flex: "none", marginTop: "3px", color: "var(--pink)" }} />
        <p style={{ margin: 0, maxWidth: "74ch", fontSize: "var(--t2)", lineHeight: 1.8, letterSpacing: ".05em", color: "var(--fg-2)" }}>
          Anyone with this link can read and edit the document. It is a shared secret, not a login, so send it only to people you would hand the document to.
        </p>
      </div>
    </div>
  );
}

export function FrozenBlock({ onFreshRoom }: { onFreshRoom: () => void }) {
  return (
    <div data-frozen style={{ border: "1px solid var(--pink)", borderRadius: "var(--r)", background: "var(--panel)", padding: "var(--s5) var(--s4)", display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
        <svg viewBox="0 0 24 24" style={{ width: "20px", height: "20px", color: "var(--pink)", animation: "st-jitter 2.4s ease-in-out infinite" }}>
          <path d="M2 6L9 12L2 18" stroke="currentColor" strokeWidth={2.4} fill="none" />
          <path d="M22 6L15 12L22 18" stroke="currentColor" strokeWidth={2.4} fill="none" />
        </svg>
        <span style={{ fontSize: "var(--t4)", letterSpacing: ".14em", color: "var(--pink)" }}>THIS ROOM IS FULL, SYNCING HAS STOPPED</span>
      </div>
      <p style={{ margin: 0, maxWidth: "74ch", fontSize: "var(--t2)", lineHeight: 1.8, letterSpacing: ".05em", color: "var(--fg-2)" }}>
        New edits stay on this device. Nothing is lost here, it just will not reach anyone else until you open a fresh room.
      </p>
      <button type="button" data-fresh-room onClick={onFreshRoom} style={{ alignSelf: "flex-start", fontSize: "var(--t2)", fontWeight: 500, letterSpacing: ".14em", background: "var(--gold)", color: "#0a0a0a", border: 0, borderRadius: "var(--r)", padding: "var(--s3) var(--s5)", minHeight: "46px" }}>
        START A FRESH ROOM
      </button>
    </div>
  );
}

export function Footer() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--s3)", borderTop: "1px solid var(--line-2)", paddingTop: "var(--s3)", fontSize: "var(--t0)", letterSpacing: ".16em", color: "var(--fg-3)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--s3)" }}>
        <span style={{ color: "var(--fg)" }}>STARLING</span>
        <span style={{ color: "var(--line)" }}>|</span>
        <span>DISTRIBUTED DOCUMENTS, BY DESIGN</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--s3)" }}>
        <span>CONFLICT-FREE</span>
        <span style={{ color: "var(--gold)" }}>&bull;</span>
        <span>OFFLINE-CAPABLE</span>
        <span style={{ color: "var(--gold)" }}>&bull;</span>
        <span>CONVERGENT</span>
      </div>
    </div>
  );
}
