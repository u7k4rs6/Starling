import type { ReactNode } from "react";
import { Star } from "./Star.js";

export type LogTone = "flight" | "ack" | "drop";
export type LogEntry = { id: number; time: string; site: string; type: string; payload: string; dest: string; tone: LogTone };
export type Metrics = { opsTotal: number; opsReplicated: number; avgMs: number };

const ICON_REPLICAS = "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18";
const ICON_OPS = "M13 2L4 14h6l-1 8 9-12h-6l1-8z";
const ICON_SHIELD = "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z";
const ICON_CLOCK = "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l4 2";

function Panel({ children }: { children: ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--r)", background: "var(--panel)", boxShadow: "var(--glow)", display: "flex", flexDirection: "column" }}>
      {children}
    </div>
  );
}

export function ActivityMetrics({ log, metrics }: { log: LogEntry[]; metrics: Metrics }) {
  const rows = log.slice().reverse();
  const metricCells = [
    { value: "2", unit: "", label: "REPLICAS ONLINE", icon: ICON_REPLICAS },
    { value: String(metrics.opsReplicated), unit: "", label: "OPERATIONS REPLICATED", icon: ICON_OPS },
    { value: "0", unit: "", label: "CONFLICTS DETECTED", icon: ICON_SHIELD },
    { value: String(metrics.avgMs), unit: "ms", label: "AVG CONVERGENCE TIME", icon: ICON_CLOCK },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: "var(--s3)" }}>
      <Panel>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--line-2)" }}>
          <Star style={{ width: "11px", height: "11px", color: "var(--gold)" }} />
          <span style={{ fontSize: "var(--t2)", letterSpacing: ".16em" }}>SYNC ACTIVITY</span>
        </div>
        <div style={{ padding: "var(--s2) var(--s4)", flex: 1, minHeight: "216px" }}>
          {rows.length === 0 && <span style={{ fontSize: "var(--t2)", letterSpacing: ".06em", color: "var(--fg-3)" }}>NO OPERATIONS YET. TYPE IN EITHER REPLICA.</span>}
          {rows.map((r) => {
            const drop = r.tone === "drop";
            return (
              <div
                key={r.id}
                style={{ display: "grid", gridTemplateColumns: "auto auto auto 1fr auto auto", alignItems: "center", gap: "var(--s3)", padding: "8px 0", borderBottom: "1px dashed var(--line-2)", animation: "st-enter .3s ease-out" }}
              >
                <span style={{ fontSize: "var(--t1)", color: "var(--fg-3)" }}>{r.time}</span>
                <span style={{ fontSize: "var(--t0)", fontWeight: 500, padding: "2px 7px", borderRadius: "var(--r)", background: drop ? "var(--pink)" : "var(--gold)", color: "#0a0a0a" }}>{r.site}</span>
                <span style={{ fontSize: "var(--t1)", letterSpacing: ".1em", color: "var(--fg)" }}>{r.type}</span>
                <span style={{ fontSize: "var(--t1)", color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.payload}</span>
                <span style={{ fontSize: "var(--t0)", letterSpacing: ".1em", whiteSpace: "nowrap", color: drop ? "var(--pink)" : "var(--fg-3)" }}>{r.dest}</span>
                <Star style={{ width: "12px", height: "12px", flex: "none", color: drop ? "var(--pink)" : "var(--gold)", opacity: r.tone === "flight" ? 0.55 : 1 }} fill={drop ? "none" : "currentColor"} stroke={drop ? "currentColor" : "none"} />
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s4)", padding: "var(--s3) var(--s4)", borderTop: "1px solid var(--line-2)", fontSize: "var(--t0)", letterSpacing: ".14em", color: "var(--fg-3)" }}>
          <span>{metrics.opsTotal} OPS</span>
          <span style={{ color: "var(--line)" }}>|</span>
          <span>2 REPLICAS</span>
          <span style={{ color: "var(--line)" }}>|</span>
          <span style={{ color: "var(--gold)" }}>0 CONFLICTS</span>
        </div>
      </Panel>

      <Panel>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "var(--s2)", padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--line-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            <Star style={{ width: "11px", height: "11px", color: "var(--gold)" }} />
            <span style={{ fontSize: "var(--t2)", letterSpacing: ".16em" }}>LIVE METRICS</span>
          </div>
          <span style={{ fontSize: "var(--t0)", letterSpacing: ".14em", color: "var(--fg-3)" }}>LAST 60 SECONDS</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: "var(--s2)", padding: "var(--s4)" }}>
          {metricCells.map((m) => (
            <div key={m.label} style={{ border: "1px solid var(--line-2)", borderRadius: "var(--r)", background: "var(--tile)", padding: "var(--s3)", display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
              <svg viewBox="0 0 24 24" style={{ width: "15px", height: "15px", color: "var(--fg-3)" }} fill="none" stroke="currentColor" strokeWidth={1.2}>
                <path d={m.icon} />
              </svg>
              <div style={{ display: "flex", alignItems: "baseline", gap: "4px" }}>
                <span style={{ fontSize: "var(--t8)", fontWeight: 300, lineHeight: 1.02, whiteSpace: "nowrap", color: "var(--fg)" }}>{m.value}</span>
                {m.unit && <span style={{ fontSize: "var(--t3)", color: "var(--fg-3)" }}>{m.unit}</span>}
              </div>
              <span style={{ fontSize: "var(--t0)", letterSpacing: ".12em", lineHeight: 1.5, color: "var(--fg-3)" }}>{m.label}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
