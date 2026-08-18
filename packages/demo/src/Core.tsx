import type { CSSProperties } from "react";
import { Star } from "./Star.js";
import type { Status } from "./status.js";

const HEX_PATH = "M24 1.5L46.5 14.75V40.25L24 53L1.5 40.25V14.75Z";

function beam(side: "left" | "right", broken: boolean, latency: number): CSSProperties {
  const base: CSSProperties = { position: "absolute", top: "50%", height: "2px", marginTop: "-1px", zIndex: 1 };
  const span: CSSProperties =
    side === "left"
      ? { left: "48px", right: broken ? "calc(50% + 42px)" : "calc(50% + 14px)" }
      : { left: broken ? "calc(50% + 42px)" : "calc(50% + 14px)", right: "48px" };
  if (broken) return { ...base, ...span, background: "var(--pink)", opacity: 0.8 };
  return {
    ...base,
    ...span,
    background: "repeating-linear-gradient(90deg,var(--gold) 0 14px,var(--gold-dim) 14px 22px)",
    backgroundSize: "22px 2px",
    animation: `st-flow ${(2.4 - latency * 1.2).toFixed(2)}s linear infinite`,
  };
}

function Hex({ site, isCut, onClick }: { site: "A" | "B"; isCut: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-hex={site}
      onClick={onClick}
      aria-label={`cut or restore replica ${site}'s link`}
      style={{
        position: "relative",
        zIndex: 3,
        width: "48px",
        height: "54px",
        flex: "none",
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "var(--t4)",
        letterSpacing: ".08em",
        border: 0,
        background: "transparent",
        color: isCut ? "#14120e" : "var(--fg)",
        animation: isCut ? "st-jitter 2.4s ease-in-out infinite" : "none",
      }}
    >
      <svg viewBox="0 0 48 54" style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}>
        <path d={HEX_PATH} fill={isCut ? "var(--pink)" : "var(--panel-2)"} stroke={isCut ? "var(--pink)" : "var(--gold)"} strokeWidth={1.5} />
      </svg>
      <span style={{ position: "relative" }}>{site}</span>
    </button>
  );
}

export function Core({ status, onCutA, onCutB }: { status: Status; onCutA: () => void; onCutB: () => void }) {
  const { cutA, cutB, cut, frozen, dead, converged, phase, latency } = status;
  const coreTitle = frozen ? "FROZEN" : cut ? "PARTITION" : phase === "shared" ? "RELAY" : "LOCAL HUB";
  const coreNote = frozen
    ? "room full, local only"
    : cut
      ? "ops queue at the cut"
      : phase === "shared"
        ? "bi-directional, through the room"
        : phase === "waking"
          ? "relay waking, local for now"
          : "in this browser, no server";
  const starSize = dead ? 26 : converged ? 40 : 34;

  return (
    <div
      style={{
        flex: "0 0 248px",
        minWidth: "236px",
        border: "1px solid var(--line)",
        borderRadius: "var(--r)",
        background: "var(--panel)",
        boxShadow: "var(--glow)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--s3)",
        padding: "var(--s5) var(--s4)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div style={{ position: "relative", textAlign: "center" }}>
        <div style={{ fontSize: "var(--t1)", letterSpacing: ".2em", color: "var(--gold)" }}>{coreTitle}</div>
        <div style={{ fontSize: "var(--t0)", letterSpacing: ".1em", lineHeight: 1.6, color: "var(--fg-2)", marginTop: "6px" }}>{coreNote}</div>
      </div>
      <div style={{ position: "relative", width: "100%", height: "88px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={beam("left", cutA || frozen, latency)} />
        <div style={beam("right", cutB || frozen, latency)} />
        <Hex site="A" isCut={cutA} onClick={onCutA} />
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            zIndex: 3,
            width: `${starSize}px`,
            height: `${starSize}px`,
            color: dead ? "var(--gold-dim)" : "var(--gold)",
            opacity: dead ? 0.35 : 1,
            transform: "translate(-50%,-50%)",
            transition: "width .3s ease, height .3s ease, opacity .3s ease",
            animation: `st-breathe ${dead ? "2.6s" : converged ? "3.4s" : "1.8s"} ease-in-out infinite`,
          }}
        >
          <Star style={{ width: "100%", height: "100%" }} />
        </div>
        <Hex site="B" isCut={cutB} onClick={onCutB} />
      </div>
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--s2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", padding: "5px 10px", borderRadius: "var(--r)", border: "1px solid var(--line)", background: "var(--panel-2)" }}>
          <Star style={{ width: "10px", height: "10px", color: "var(--gold)" }} />
          <span style={{ fontSize: "var(--t0)", letterSpacing: ".14em", color: "var(--fg)" }}>0 CONFLICTS</span>
        </div>
        <span style={{ fontSize: "var(--t0)", letterSpacing: ".1em", color: "var(--fg-3)", textAlign: "center" }}>{cut ? "TAP A OR B TO RESTORE" : "TAP A OR B TO CUT"}</span>
      </div>
    </div>
  );
}
