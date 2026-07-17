import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

export type RemoteCursor = { replica: string; pos: number; color: string; label: string };

const key = new PluginKey<DecorationSet>("starling-remote-cursors");

function buildDecorations(doc: Parameters<typeof DecorationSet.create>[0], cursors: RemoteCursor[]): DecorationSet {
  const decorations = cursors.map((c) =>
    Decoration.widget(
      c.pos,
      () => {
        const el = document.createElement("span");
        el.className = "remote-cursor";
        el.style.setProperty("--cursor-color", c.color);
        el.title = c.label;
        const flag = document.createElement("span");
        flag.className = "remote-cursor-label";
        flag.textContent = c.label;
        el.appendChild(flag);
        return el;
      },
      { key: `remote-cursor-${c.replica}`, side: 0 }
    )
  );
  return DecorationSet.create(doc, decorations);
}

/**
 * FRONTEND §2.4: "Remote cursors and selections, coloured per replica,
 * with the replica label." Rendered as widget decorations — ProseMirror's
 * own mechanism for "extra stuff at a position that isn't part of the
 * document" — driven entirely from outside the view (via `setRemoteCursors`)
 * rather than from transactions, since remote presence isn't a document
 * edit at all (ARCH §7: awareness is never written to the op log, and
 * this plugin's decorations aren't either — nothing here ever touches
 * `doc`).
 */
export function remoteCursorPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => buildDecorations(state.doc, []),
      apply: (tr, decorations, _oldState, newState) => {
        const cursors = tr.getMeta(key) as RemoteCursor[] | undefined;
        if (cursors !== undefined) return buildDecorations(newState.doc, cursors);
        return decorations.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}

export function setRemoteCursors(view: EditorView, cursors: RemoteCursor[]): void {
  view.dispatch(view.state.tr.setMeta(key, cursors));
}
