import { Schema } from "prosemirror-model";

/**
 * FRONTEND §1.1/§0: the binding targets ProseMirror's model layer only,
 * and the demo has "no toolbar, no bold/italic/headings beyond what
 * ProseMirror's basic schema gives free" — read literally as "give it
 * nothing beyond what a flat character sequence needs", not "wire in
 * prosemirror-schema-basic and simply not expose its extra nodes/marks in
 * the UI". The CRDT (`starling-crdt`'s `Doc`) represents exactly one flat
 * run of characters; this schema is the smallest PM shape that matches
 * that one to one — a single required paragraph, text only, no marks.
 * `content: "paragraph"` (not `"paragraph+"` or `"paragraph*"`) makes it
 * structurally impossible to delete the paragraph itself or add a second
 * one, which is what keeps the position boundary math in `positions.ts`
 * this simple: PM position 0 is always "before the one paragraph", and
 * every position a `ReplaceStep` can name for a text edit falls inside it.
 */
export const schema = new Schema({
  nodes: {
    doc: { content: "paragraph" },
    paragraph: { content: "text*" },
    text: { inline: true },
  },
});
