import { EditorPane } from "./EditorPane.js";
import { SoloPane } from "./SoloPane.js";
import { REPLICA_A_COLOR, REPLICA_B_COLOR } from "./colors.js";

/** FRONTEND §2.4: "A 'third replica' button that opens the same doc in a
 * new tab" — a plain URL param, not a router: this demo has exactly one
 * document and exactly one other view to reach (§2.5: no document list,
 * no navigation to build). */
function isSoloView(): boolean {
  return new URLSearchParams(window.location.search).has("solo");
}

export function App() {
  if (isSoloView()) return <SoloPane />;

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">starling</span>
        <button
          type="button"
          className="third-replica-button"
          onClick={() => {
            // Carry forward any doc/awareness override already on this
            // page (config.ts) so the solo tab joins the *same* document
            // instead of silently falling back to the fixed default.
            const params = new URLSearchParams(window.location.search);
            params.set("solo", "1");
            window.open(`${window.location.pathname}?${params.toString()}`, "_blank", "noopener");
          }}
        >
          open a third replica
        </button>
      </header>
      <main className="panes">
        <EditorPane paneId="pane-a" label="A" color={REPLICA_A_COLOR} />
        <EditorPane paneId="pane-b" label="B" color={REPLICA_B_COLOR} />
      </main>
    </div>
  );
}
