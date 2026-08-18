import type { CSSProperties, PointerEvent } from "react";
import { Star } from "./Star.js";

export type Controls = { latency: number; loss: number; reorder: number };
type Key = keyof Controls;

function hash(i: number, salt: number): number {
  const x = Math.sin((i + 1) * salt) * 10000;
  return x - Math.floor(x);
}

function starBox(x: number, lane: number, size: number, extra: CSSProperties): CSSProperties {
  return {
    position: "absolute",
    left: `${x}%`,
    top: `calc(50% + ${lane}px)`,
    width: `${size}px`,
    height: `${size}px`,
    marginLeft: `${-size / 2}px`,
    marginTop: `${-size / 2}px`,
    pointerEvents: "none",
    ...extra,
  };
}

type Mark = { key: number; fill: string; stroke: string; style: CSSProperties };

/**
 * The star encoding of one slider, ported from the design. Latency thins the
 * field (fewer, larger stars as the gap widens); loss knocks out that fraction
 * of stars, drawn hollow in pink; reordering makes that fraction jump lanes and
 * swap with a neighbour. It reads as the network condition itself, not a fill.
 */
function marks(key: Key, v: number): Mark[] {
  const out: Mark[] = [];
  const n = 14;
  if (key === "latency") {
    const count = Math.max(4, Math.round(4 + 26 * Math.pow(1 - v, 2.5)));
    for (let i = 0; i < count; i += 1) {
      const p = count === 1 ? 50 : (i / (count - 1)) * 100;
      out.push({ key: i, fill: "currentColor", stroke: "none", style: starBox(p, 0, (7 + v * 4), { color: "var(--gold)", opacity: 0.55 + v * 0.35 }) });
    }
  } else if (key === "loss") {
    const ranked = Array.from({ length: n }, (_, i) => ({ i, h: hash(i, 12.9898) })).sort((a, b) => a.h - b.h);
    const dropped: Record<number, boolean> = {};
    ranked.slice(0, Math.round(v * n)).forEach((r) => {
      dropped[r.i] = true;
    });
    for (let i = 0; i < n; i += 1) {
      const p = (i / (n - 1)) * 100;
      const d = !!dropped[i];
      out.push({
        key: i,
        fill: d ? "none" : "currentColor",
        stroke: d ? "currentColor" : "none",
        style: starBox(p, 0, d ? 11 : 9, { color: d ? "var(--pink)" : "var(--gold)", opacity: d ? 1 : 0.7 }),
      });
    }
  } else {
    const pos: number[] = [];
    for (let i = 0; i < n; i += 1) pos.push((i / (n - 1)) * 100);
    const moved = Array.from({ length: n }, (_, i) => hash(i, 78.233) < v);
    for (let i = 0; i < n - 1; i += 1) {
      if (moved[i] && moved[i + 1]) [pos[i], pos[i + 1]] = [pos[i + 1]!, pos[i]!];
      else if (moved[i] && hash(i, 3.71) < 0.6) [pos[i], pos[i + 1]] = [pos[i + 1]!, pos[i]!];
    }
    for (let i = 0; i < n; i += 1) {
      const lane = moved[i] ? (hash(i, 5.13) < 0.5 ? -1 : 1) * (7 + hash(i, 9.7) * 7) : 0;
      out.push({ key: i, fill: "currentColor", stroke: "none", style: starBox(pos[i]!, lane, moved[i] ? 11 : 9, { color: "var(--gold)", opacity: moved[i] ? 1 : 0.6 }) });
    }
  }
  return out;
}

function Slider({ label, value, format, onChange }: { label: string; value: number; format: (v: number) => string; onChange: (v: number) => void }) {
  const key = label === "LATENCY" ? "latency" : label === "PACKET LOSS" ? "loss" : "reorder";
  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const set = (cx: number): void => onChange(Math.max(0, Math.min(1, (cx - rect.left) / rect.width)));
    set(e.clientX);
    const move = (ev: globalThis.PointerEvent): void => {
      ev.preventDefault();
      set(ev.clientX);
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
  };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "92px 1fr 64px", alignItems: "center", gap: "var(--s3)", borderBottom: "1px solid var(--line-2)" }}>
      <span style={{ fontSize: "var(--t0)", letterSpacing: ".16em", color: "var(--fg-2)" }}>{label}</span>
      <div data-slider={key} onPointerDown={onDown} style={{ position: "relative", height: "34px", touchAction: "none", cursor: "pointer" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: "50%", height: "1px", background: "var(--line-2)", opacity: key === "reorder" ? 1 - value * 0.7 : 1 }} />
        {marks(key as Key, value).map((m) => (
          <div key={m.key} style={m.style}>
            <Star style={{ width: "100%", height: "100%" }} fill={m.fill} stroke={m.stroke} />
          </div>
        ))}
      </div>
      <span style={{ fontSize: "var(--t2)", textAlign: "right", color: "var(--fg)" }}>{format(value)}</span>
    </div>
  );
}

export function BreakIt({
  controls,
  cut,
  onControl,
  onToggleAll,
}: {
  controls: Controls;
  cut: boolean;
  onControl: (patch: Partial<Controls>) => void;
  onToggleAll: () => void;
}) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--panel)", boxShadow: "var(--glow)", padding: "var(--s3) var(--s4) var(--s4)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--s4)", paddingBottom: "var(--s3)", borderBottom: "1px solid var(--line-2)" }}>
        <span style={{ fontSize: "var(--t0)", letterSpacing: ".18em", color: "var(--fg-3)" }}>BREAK IT</span>
        <button
          type="button"
          data-toggle-all
          onClick={onToggleAll}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            minHeight: "42px",
            padding: "0 18px",
            fontSize: "var(--t2)",
            letterSpacing: ".14em",
            borderRadius: "var(--r)",
            border: `1px solid ${cut ? "var(--pink)" : "var(--gold-dim)"}`,
            background: cut ? "var(--pink-faint)" : "transparent",
            color: cut ? "var(--pink)" : "var(--fg)",
            transition: "background .15s ease",
          }}
        >
          <span>{cut ? "RECONNECT" : "DISCONNECT"}</span>
          <Star style={{ width: "10px", height: "10px", color: "currentColor" }} />
        </button>
        <span style={{ fontSize: "var(--t0)", letterSpacing: ".1em", color: "var(--fg-3)" }}>DRAG A RUN TO CHANGE IT</span>
      </div>
      <Slider label="LATENCY" value={controls.latency} format={(v) => `${Math.round(v * 1500)} ms`} onChange={(v) => onControl({ latency: v })} />
      <Slider label="PACKET LOSS" value={controls.loss} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onControl({ loss: v })} />
      <Slider label="REORDERING" value={controls.reorder} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onControl({ reorder: v })} />
    </div>
  );
}
