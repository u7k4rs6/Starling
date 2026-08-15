export type ControlState = {
  connectedA: boolean;
  connectedB: boolean;
  latencyMs: number;
  dropRate: number;
  reorderRate: number;
};

/**
 * The break-it panel. Each control maps onto one field of the two panes' link
 * state (see ControllableTransport): the visitor partitions a replica, slows
 * both links, or makes them lossy, and watches the document above diverge and
 * then heal. Nothing here can produce a conflict dialog or lose a keystroke,
 * which is the whole point being shown.
 */
export function Controls({
  state,
  onChange,
}: {
  state: ControlState;
  onChange: (patch: Partial<ControlState>) => void;
}) {
  return (
    <div className="controls">
      <div className="controls-row">
        <button
          type="button"
          className={`link-toggle ${state.connectedA ? "" : "is-cut"}`}
          onClick={() => onChange({ connectedA: !state.connectedA })}
        >
          {state.connectedA ? "cut A's link" : "restore A's link"}
        </button>
        <button
          type="button"
          className={`link-toggle ${state.connectedB ? "" : "is-cut"}`}
          onClick={() => onChange({ connectedB: !state.connectedB })}
        >
          {state.connectedB ? "cut B's link" : "restore B's link"}
        </button>
      </div>

      <label className="slider">
        <span className="slider-label">latency</span>
        <input
          type="range"
          min={0}
          max={2000}
          step={100}
          value={state.latencyMs}
          onChange={(e) => onChange({ latencyMs: Number(e.target.value) })}
        />
        <span className="slider-value">{state.latencyMs} ms</span>
      </label>

      <label className="slider">
        <span className="slider-label">packet loss</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(state.dropRate * 100)}
          onChange={(e) => onChange({ dropRate: Number(e.target.value) / 100 })}
        />
        <span className="slider-value">{Math.round(state.dropRate * 100)}%</span>
      </label>

      <label className="slider">
        <span className="slider-label">reordering</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(state.reorderRate * 100)}
          onChange={(e) => onChange({ reorderRate: Number(e.target.value) / 100 })}
        />
        <span className="slider-value">{Math.round(state.reorderRate * 100)}%</span>
      </label>
    </div>
  );
}
