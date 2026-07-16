import type { ReplicaId } from "./elem-id.js";
import { Sequence, type Op } from "./sequence.js";

export type NaivePayload = { index: number; char: string };
export type NaiveOp = Op<NaivePayload>;

/**
 * Museum exhibit 1 (PRD §4). A plain array of characters with index-based
 * insert — the thing everyone writes first. The diagnosis, not just the
 * symptom: integrate() is not commutative — integrate(a)∘integrate(b) ≠
 * integrate(b)∘integrate(a) for two concurrent inserts at the same index.
 *
 * From Step 2 onward this sits on the same Sequence base as every other
 * exhibit: it gets a real ElemId per character, idempotence, and causal
 * delivery, all for free. It still diverges, because integrate() below
 * never looks at op.id — it places by raw index regardless. That is
 * deliberate (PRD §4's two-beat lesson): identity alone buys nothing: a
 * merge rule has to use it. Do not "fix" this by making integrate id-aware;
 * that reinvents ArrayDoc and deletes the exhibit.
 */
export class NaiveDoc extends Sequence<NaivePayload> {
  private readonly chars: string[] = [];

  constructor(replica: ReplicaId) {
    super(replica);
  }

  get text(): string {
    return this.chars.join("");
  }

  insertLocal(index: number, char: string): NaiveOp {
    // No causal dependency: an index is a position at send time, not a
    // reference to any other op. deps: [] is honest about what a NaiveDoc
    // op actually knows — that honesty is the bug, restated as data.
    return this.recordLocalOp({ index, char }, []);
  }

  protected integrate(op: NaiveOp): void {
    this.chars.splice(op.payload.index, 0, op.payload.char);
  }
}
