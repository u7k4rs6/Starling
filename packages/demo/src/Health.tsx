import type { CSSProperties } from "react";
import { Star } from "./Star.js";
import type { Status } from "./status.js";

function ekgStyle(dead: boolean, flip: boolean): CSSProperties {
  return {
    width: "48px",
    height: "26px",
    flex: "none",
    color: dead ? "var(--pink)" : "var(--gold)",
    opacity: dead ? 0.6 : 1,
    transform: flip ? "scaleX(-1)" : undefined,
  };
}

export function Health({ status }: { status: Status }) {
  const { dead, cut, frozen, converged, drifting, reconciling, latency, pendingA, pendingB } = status;
  const ekgPath = dead ? "M0 13h48" : "M0 13h7l3-10 4 20 4-14 3 8 3-4h21";
  const flowSecs = (2.4 - latency * 1.2).toFixed(2);
  const healthWord = frozen ? "SYNC STOPPED" : cut ? "FLATLINE" : "HEALTHY";
  const verdictTitle = frozen
    ? "ROOM FROZEN"
    : reconciling
      ? "RECONCILING"
      : drifting
        ? "DIVERGED"
        : cut
          ? "PARTITIONED"
          : converged
            ? "FULLY CONVERGED"
            : "REPLICATING";
  const verdictNote = frozen
    ? "new edits stay on this device"
    : reconciling
      ? "queued operations are on their way"
      : drifting
        ? "the two documents differ, they will reconcile on reconnect"
        : cut
          ? "operations queue at the severed end"
          : converged
            ? "document state is identical"
            : "operations in flight";

  // Idle twinkle stars along the wire while it is live.
  const idle = dead ? [] : [11, 27, 50, 73, 89].map((p, i) => ({ p, i, size: i === 2 ? 0 : 9 }));
  // Operations still travelling: one sweeping star per pending op (capped),
  // driven by the real pending counts, gone the moment it converges.
  const flying = dead ? 0 : Math.min(6, pendingA + pendingB);
  // When a link is cut, ops pile up as hollow pink stars at the severed end.
  const queued: { key: string; side: number; i: number }[] = [];
  if (status.cutA) for (let i = 0; i < Math.min(6, pendingB); i += 1) queued.push({ key: `qa${i}`, side: 1, i });
  if (status.cutB) for (let i = 0; i < Math.min(6, pendingA); i += 1) queued.push({ key: `qb${i}`, side: 99, i });

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--panel)", boxShadow: "var(--glow)", padding: "var(--s5) var(--s4) var(--s4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
        <span style={{ fontSize: "var(--t0)", letterSpacing: ".16em", color: "var(--fg-3)", width: "82px", flex: "none", lineHeight: 1.7 }}>
          CONNECTION
          <br />
          HEALTH
        </span>
        <svg viewBox="0 0 48 26" style={ekgStyle(dead, false)} fill="none" stroke="currentColor" strokeWidth={1.3}>
          <path d={ekgPath} />
        </svg>
        <div style={{ flex: 1, position: "relative", minWidth: 0, height: "48px" }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: "50%",
              height: "1px",
              background: dead ? "var(--pink)" : "repeating-linear-gradient(90deg,var(--gold) 0 14px,var(--gold-faint) 14px 22px)",
              backgroundSize: dead ? "auto" : "22px 1px",
              opacity: dead ? 0.7 : 1,
              animation: dead ? "none" : `st-flow ${flowSecs}s linear infinite`,
            }}
          />
          {idle.map(({ p, i, size }) => (
            <div
              key={`idle${i}`}
              style={{
                position: "absolute",
                left: `${p}%`,
                top: "50%",
                width: `${size}px`,
                height: `${size}px`,
                marginLeft: `${-size / 2}px`,
                marginTop: `${-size / 2}px`,
                color: "var(--gold)",
                opacity: 0.45,
                animation: `st-twinkle ${4.2 + i * 0.5}s ease-in-out ${(i * 0.3).toFixed(2)}s infinite`,
              }}
            >
              <Star style={{ width: "100%", height: "100%" }} />
            </div>
          ))}
          {Array.from({ length: flying }, (_, i) => (
            <div
              key={`fly${i}`}
              style={{
                position: "absolute",
                top: "50%",
                width: "13px",
                height: "13px",
                marginTop: "-6.5px",
                color: "var(--gold)",
                animation: `st-sweep ${(1.2 + latency * 1.4).toFixed(2)}s linear ${(i * -0.35).toFixed(2)}s infinite`,
              }}
            >
              <Star style={{ width: "100%", height: "100%" }} />
            </div>
          ))}
          {queued.map((q) => (
            <div
              key={q.key}
              style={{
                position: "absolute",
                left: `${q.side}%`,
                top: "50%",
                width: "10px",
                height: "10px",
                marginLeft: "-5px",
                marginTop: `${(q.i % 3) * 13 - 13 - 5}px`,
                color: "var(--pink)",
                animation: `st-twinkle 2.2s ease-in-out ${(q.i * 0.14).toFixed(2)}s infinite`,
              }}
            >
              <Star style={{ width: "100%", height: "100%" }} fill="none" stroke="currentColor" />
            </div>
          ))}
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: `${converged ? 26 : 20}px`,
              height: `${converged ? 26 : 20}px`,
              color: dead ? "var(--pink)" : "var(--gold)",
              opacity: dead ? 0.45 : 1,
              transform: "translate(-50%,-50%)",
              animation: `st-breathe ${dead ? "2.6s" : converged ? "3.4s" : "1.8s"} ease-in-out infinite`,
            }}
          >
            <Star style={{ width: "100%", height: "100%" }} />
          </div>
        </div>
        <svg viewBox="0 0 48 26" style={ekgStyle(dead, true)} fill="none" stroke="currentColor" strokeWidth={1.3}>
          <path d={ekgPath} />
        </svg>
        <span style={{ fontSize: "var(--t0)", letterSpacing: ".16em", color: "var(--fg-3)", width: "82px", flex: "none", textAlign: "right", lineHeight: 1.7 }}>
          {healthWord}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "3px", paddingTop: "var(--s3)" }}>
        <span data-verdict style={{ fontSize: "var(--t6)", fontWeight: 500, letterSpacing: ".18em", color: converged ? "var(--fg)" : "var(--pink)" }}>
          {verdictTitle}
        </span>
        <span style={{ fontSize: "var(--t2)", letterSpacing: ".06em", color: "var(--fg-2)", textAlign: "center" }}>{verdictNote}</span>
      </div>
    </div>
  );
}
