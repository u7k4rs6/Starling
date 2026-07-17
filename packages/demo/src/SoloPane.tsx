import { useState } from "react";
import { EditorPane } from "./EditorPane.js";
import { REPLICA_A_COLOR } from "./colors.js";

/** Each solo tab is its own independent replica — a fresh random pane id
 * per tab (not shared via the URL), so opening several "third replica"
 * tabs at once demonstrates N-way convergence, not just two. */
function randomSoloPaneId(): string {
  return `pane-solo-${crypto.randomUUID()}`;
}

export function SoloPane() {
  const [paneId] = useState(randomSoloPaneId);

  return (
    <div className="app app-solo">
      <header className="app-header">
        <span className="app-title">starling — third replica</span>
      </header>
      <main className="panes panes-solo">
        <EditorPane paneId={paneId} label="C" color={REPLICA_A_COLOR} />
      </main>
    </div>
  );
}
