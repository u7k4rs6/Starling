export type NaiveInsertOp = {
  index: number;
  char: string;
};

/**
 * Museum exhibit 1 (PRD §4). A plain array of characters with index-based
 * insert — the thing everyone writes first. The diagnosis, not just the
 * symptom: apply() is not commutative — apply(a)∘apply(b) ≠ apply(b)∘apply(a)
 * for two concurrent inserts at the same index, because an insert op is just
 * "put this character at this index" with no element identity to reconcile
 * against. Every step from here on is an attempt to build an apply() that
 * does commute; see naive-doc.test.ts for the proof, and PRD §4 for why
 * Step 2 makes this sharper instead of fixing it. Do not fix this class; it
 * is preserved broken on purpose.
 */
export class NaiveDoc {
  private readonly chars: string[] = [];

  get text(): string {
    return this.chars.join("");
  }

  insertLocal(index: number, char: string): NaiveInsertOp {
    const op: NaiveInsertOp = { index, char };
    this.apply(op);
    return op;
  }

  apply(op: NaiveInsertOp): void {
    this.chars.splice(op.index, 0, op.char);
  }
}
