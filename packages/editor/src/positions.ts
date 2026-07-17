/**
 * FRONTEND §1.2: "visible indices exist only at the boundary, and die
 * inside it." These two functions ARE the boundary — everywhere else in
 * this package works in one coordinate system or the other, never both,
 * and every crossing goes through here.
 *
 * Given `schema.ts`'s doc shape (exactly one paragraph, text only): PM
 * position 0 is before the paragraph opens, position 1 is the first
 * position inside it (before any character), and position `1 + n` is
 * after the nth character. A CRDT visible index `i` (0 = before the first
 * live character) is therefore always `pmPos - 1`.
 */
export function pmPosToVisibleIndex(pmPos: number): number {
  return pmPos - 1;
}

export function visibleIndexToPmPos(visibleIndex: number): number {
  return visibleIndex + 1;
}
