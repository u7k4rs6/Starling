import { compareElemIds, type ElemId, type ReplicaId } from "./elem-id.js";
import { Sequence, type Op } from "./sequence.js";

export type InsertPayload = { l: ElemId | null; char: string };
export type InsertOp = Op<InsertPayload>;

type Elem = { id: ElemId; char: string };

/**
 * Museum exhibit 2 (PRD §4). Correct RGA merge, array-backed storage.
 * `integrate()` is exactly ARCH §2.3's four lines, unmodified: insert after
 * the origin, then skip forward past concurrent elements with
 * higher-precedence ids. It converges (proven below by fast-check, S1/S2)
 * — the exhaustive origin-forest search (`research/origin-forest-search.mjs`,
 * DECISIONS #0012) is what says this had to be true before this class was
 * even written.
 *
 * It is also unusable at scale. `indexOfId` is a linear scan and `integrate`
 * calls it on every insert, so cold-open is O(n) per character, O(n²) for
 * the whole document. That is deliberate — this exhibit gets replaced by
 * the order-statistic treap at Step 4b (ARCH §2.5), and the benchmark
 * proving why (~41s extrapolated at 100k characters) is Step 15's, not
 * this one's. Do not "fix" the linear scan here; that deletes the exhibit.
 *
 * It also interleaves on concurrent backward typing (ARCH §2.3) — that
 * anomaly isn't demonstrated until Step 6 preserves `RgaDoc` as exhibit 3
 * once Fugue replaces it; `ArrayDoc` and `RgaDoc` share this same merge
 * rule and only diverge in storage, per PRD §4's exhibit list.
 */
export class ArrayDoc extends Sequence<InsertPayload> {
  private readonly elems: Elem[] = [];

  constructor(replica: ReplicaId) {
    super(replica);
  }

  get text(): string {
    return this.elems.map((e) => e.char).join("");
  }

  insertLocal(index: number, char: string): InsertOp {
    const l = index === 0 ? null : this.elems[index - 1]!.id;
    return this.recordLocalOp({ l, char }, l === null ? [] : [l]);
  }

  private indexOfId(id: ElemId): number {
    return this.elems.findIndex((e) => e.id.replica === id.replica && e.id.counter === id.counter);
  }

  protected integrate(op: InsertOp): void {
    const { l, char } = op.payload;
    // l, if not null, is guaranteed already integrated: Sequence buffers
    // this op (deps: [l]) until it is (DECISIONS #0010), so indexOfId
    // below never returns -1.
    let at = l === null ? 0 : this.indexOfId(l) + 1;
    while (at < this.elems.length && compareElemIds(this.elems[at]!.id, op.id) > 0) {
      at += 1;
    }
    this.elems.splice(at, 0, { id: op.id, char });
  }
}
