import type { Provider } from "@starling/provider";

export type TextEdit = {
  /** Characters inserted, in order (empty if this was a pure delete). */
  inserted: string;
  /** How many characters were removed. */
  removed: number;
};

/**
 * Turn a textarea's new value into real CRDT ops on the Provider's Doc. Diffs
 * the old text (the Doc's current text) against the new value down to the
 * changed span, then deletes the removed characters and inserts the new ones one
 * at a time through `insertLocal` / `deleteLocal`, which is where genuine Fugue
 * ops with real ids and clocks are minted. This is the whole editor-to-CRDT
 * binding: no ProseMirror, just a plain textarea over the same Doc.
 */
export function applyTextEdit(provider: Provider, oldText: string, newText: string): TextEdit | null {
  const minLen = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < minLen - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix += 1;
  }
  const removed = oldText.length - suffix - prefix;
  const inserted = newText.slice(prefix, newText.length - suffix);
  if (removed === 0 && inserted.length === 0) return null;

  // Delete the removed span first: each deletion at `prefix` shifts the rest
  // left, so repeating at the same index clears the range.
  for (let i = 0; i < removed; i += 1) void provider.deleteLocal(prefix);
  for (let i = 0; i < inserted.length; i += 1) void provider.insertLocal(prefix + i, inserted[i]!);
  return { inserted, removed };
}
