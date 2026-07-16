import { describe, expect, it } from "vitest";
import type { ElemId } from "./elem-id.js";
import { Sequence, type Op } from "./sequence.js";

type LogPayload = { value: string };

/** Minimal concrete Sequence: integrate() just records payloads in order. */
class LogSequence extends Sequence<LogPayload> {
  readonly integrated: string[] = [];

  constructor(replica: string) {
    super(replica);
  }

  recordLocal(value: string, deps: ElemId[] = []): Op<LogPayload> {
    return this.recordLocalOp({ value }, deps);
  }

  protected integrate(op: Op<LogPayload>): void {
    this.integrated.push(op.payload.value);
  }
}

describe("Sequence (abstract base, Step 2)", () => {
  it("allocates unique, monotonically increasing per-replica ids for local ops", () => {
    const seq = new LogSequence("A");
    const op1 = seq.recordLocal("x");
    const op2 = seq.recordLocal("y");
    const op3 = seq.recordLocal("z");

    expect(op1.id).toEqual({ replica: "A", counter: 0 });
    expect(op2.id).toEqual({ replica: "A", counter: 1 });
    expect(op3.id).toEqual({ replica: "A", counter: 2 });
  });

  it("integrates local ops immediately, in order", () => {
    const seq = new LogSequence("A");
    seq.recordLocal("x");
    seq.recordLocal("y");
    expect(seq.integrated).toEqual(["x", "y"]);
  });

  it("is idempotent: receiving the same already-integrated op twice integrates it once", () => {
    const seq = new LogSequence("A");
    const op = seq.recordLocal("x");
    expect(seq.integrated).toEqual(["x"]);

    seq.receive(op);
    seq.receive(op);
    expect(seq.integrated).toEqual(["x"]);
  });

  it("buffers an op with an unmet dependency instead of integrating it", () => {
    const seqA = new LogSequence("A");
    const seqB = new LogSequence("B");

    const opA = seqA.recordLocal("dependency");
    const opB = seqB.recordLocal("dependent", [opA.id]);

    // B never saw A's op — deliver only the dependent op to a fresh replica.
    const seqC = new LogSequence("C");
    seqC.receive(opB);
    expect(seqC.integrated).toEqual([]);

    // Now the dependency arrives: the buffered op drains.
    seqC.receive(opA);
    expect(seqC.integrated).toEqual(["dependency", "dependent"]);
  });

  it("drains a multi-level dependency chain in causal order regardless of delivery order", () => {
    const origin = new LogSequence("A");
    const op1 = origin.recordLocal("first");
    const op2 = origin.recordLocal("second", [op1.id]);
    const op3 = origin.recordLocal("third", [op2.id]);

    const receiver = new LogSequence("R");
    // Deliver out of causal order: 3, 1, 2.
    receiver.receive(op3);
    receiver.receive(op1);
    expect(receiver.integrated).toEqual(["first"]); // op3 still blocked on op2
    receiver.receive(op2);
    expect(receiver.integrated).toEqual(["first", "second", "third"]);
  });

  it("is idempotent even when the duplicate arrives while the original is still pending", () => {
    const origin = new LogSequence("A");
    const dep = origin.recordLocal("dependency");
    const opB = origin.recordLocal("dependent", [dep.id]);

    const receiver = new LogSequence("R");
    receiver.receive(opB); // pending: dep not yet known
    receiver.receive(opB); // duplicate, still pending — must not double-queue
    expect(receiver.integrated).toEqual([]);

    receiver.receive(dep); // drains the single queued copy of opB
    expect(receiver.integrated).toEqual(["dependency", "dependent"]);
  });
});
