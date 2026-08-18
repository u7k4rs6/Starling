import { Star } from "./Star.js";
import type { Theme } from "./theme.js";
import type { Status } from "./status.js";

function hash(i: number, salt: number): number {
  const x = Math.sin((i + 1) * salt) * 10000;
  return x - Math.floor(x);
}

function Bars({ dead, busy }: { dead: boolean; busy: number }) {
  const n = 28;
  const period = (2.9 - busy * 1.2).toFixed(2);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, display: "flex", alignItems: "stretch", justifyContent: "space-between", gap: "2px" }}>
      {Array.from({ length: n }, (_, i) => {
        const env = Math.sin((i / (n - 1)) * Math.PI);
        const sig = 0.45 + 0.55 * hash(i, 24.17);
        const h = dead ? 5 : Math.round((8 + 36 * env * sig) * (0.7 + busy * 0.45));
        const alpha = dead ? 0.3 : 0.22 + 0.55 * env;
        const bar = { background: dead ? "var(--pink)" : "var(--gold)", transition: "height .45s ease, background .3s ease" } as const;
        return (
          <div key={i} style={{ flex: "1 1 0%", minWidth: "2px", alignSelf: "stretch", position: "relative" }}>
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "50%",
                marginBottom: "2px",
                height: `${h}px`,
                opacity: alpha,
                transformOrigin: "bottom",
                animation: dead ? "none" : `st-bar ${period}s ease-in-out ${(i * -0.09).toFixed(2)}s infinite`,
                ...bar,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "50%",
                marginTop: "2px",
                height: `${Math.round(h * 0.42)}px`,
                opacity: alpha * 0.34,
                transformOrigin: "top",
                animation: dead ? "none" : `st-bar ${period}s ease-in-out ${(i * -0.09 - 0.18).toFixed(2)}s infinite`,
                ...bar,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function Header({ status, theme, onTheme }: { status: Status; theme: Theme; onTheme: (t: Theme) => void }) {
  const { dead, cut, frozen, converged, both } = status;
  const busy = Math.min(1, (status.pendingA + status.pendingB) / 6);
  const chipTitle = frozen ? "FROZEN" : cut ? "PARTITIONED" : "CONNECTED";
  const chipNote = frozen
    ? "syncing has stopped"
    : both
      ? "both links severed"
      : cut
        ? "replicas drifting"
        : converged
          ? "all replicas in sync"
          : "operations in flight";

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: "var(--s2)", border: "1px solid var(--line-2)", borderRadius: "var(--r)", padding: "6px var(--s3)" }}>
        <span style={{ fontSize: "var(--t0)", letterSpacing: ".16em", color: "var(--fg-3)" }}>THEME</span>
        {(["dark", "light"] as Theme[]).map((t) => (
          <button
            key={t}
            type="button"
            data-theme-btn={t}
            onClick={() => onTheme(t)}
            style={{
              fontSize: "var(--t0)",
              letterSpacing: ".14em",
              minHeight: "30px",
              padding: "5px 10px",
              borderRadius: "var(--r)",
              border: `1px solid ${theme === t ? "var(--gold-dim)" : "var(--line-2)"}`,
              background: theme === t ? "var(--gold-faint)" : "transparent",
              color: theme === t ? "var(--gold)" : "var(--fg-3)",
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      <div style={{ position: "relative", overflow: "hidden", display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--s4)", padding: "var(--s5) 0 var(--s4)" }}>
        <div
          style={{
            position: "relative",
            flex: "1 1 200px",
            minWidth: "150px",
            maxWidth: "420px",
            alignSelf: "center",
            height: "104px",
            pointerEvents: "none",
            overflow: "hidden",
            order: 2,
            maskImage: "linear-gradient(90deg,transparent 0,#000 14%,#000 86%,transparent 100%)",
            WebkitMaskImage: "linear-gradient(90deg,transparent 0,#000 14%,#000 86%,transparent 100%)",
          }}
        >
          <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: "1px", background: "var(--gold-dim)", opacity: 0.4 }} />
          <Bars dead={dead} busy={busy} />
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: "40%",
              pointerEvents: "none",
              background: `radial-gradient(ellipse 62% 40% at center,${dead ? "var(--pink)" : "var(--gold)"} 0%,transparent 100%)`,
              opacity: dead ? 0.1 : 0.15,
              animation: `st-scan ${dead ? "9s" : "5.4s"} linear infinite`,
            }}
          />
          <div style={{ position: "absolute", top: "50%", marginTop: "-6px", width: "12px", height: "12px", marginLeft: "-6px", color: dead ? "var(--pink)" : "var(--gold)", opacity: dead ? 0.5 : 1, animation: `st-sweep ${dead ? "7s" : "4.2s"} linear infinite` }}>
            <Star style={{ width: "100%", height: "100%" }} />
          </div>
        </div>

        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "var(--s3)", minWidth: "280px", order: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
            <Star style={{ width: "26px", height: "26px", color: "var(--gold)", flex: "none" }} />
            <h1 style={{ margin: 0, fontWeight: 700, fontSize: "var(--t7)", letterSpacing: ".15em", lineHeight: 1 }}>STARLING</h1>
          </div>
          <p style={{ margin: 0, fontSize: "var(--t1)", lineHeight: 2.2, letterSpacing: ".13em", color: "var(--fg-2)" }}>
            ONE DOCUMENT. TWO REPLICAS.
            <br />
            CUT THE LINK. TYPE INTO BOTH. DRIFT.
            <br />
            RECONNECT. CONVERGE. NOTHING LOST.
          </p>
        </div>

        <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "var(--s2)", order: 3 }}>
          <div data-chip style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 16px", borderRadius: "var(--r)", border: `1px solid ${dead ? "var(--pink-dim)" : "var(--gold-dim)"}`, background: "var(--panel)", boxShadow: "var(--glow)" }}>
            <Star style={{ width: "16px", height: "16px", flex: "none", color: dead ? "var(--pink)" : "var(--gold)", animation: `st-twinkle ${dead ? "1.2s" : "3.4s"} ease-in-out infinite` }} />
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ fontSize: "var(--t2)", fontWeight: 500, letterSpacing: ".16em", color: dead ? "var(--pink)" : "var(--fg)" }}>{chipTitle}</span>
              <span style={{ fontSize: "var(--t1)", letterSpacing: ".06em", color: "var(--fg-2)" }}>{chipNote}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
