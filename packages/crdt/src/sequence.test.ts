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

    // Identity counter is 0-based and dense; the Lamport clock is stamped
    // before the counter advances, so it runs one ahead (see allocateId).
    expect(op1.id).toEqual({ replica: "A", counter: 0, clock: 1 });
    expect(op2.id).toEqual({ replica: "A", counter: 1, clock: 2 });
    expect(op3.id).toEqual({ replica: "A", counter: 2, clock: 3 });
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

describe("Sequence: state vector and missingFrom (ARCH §3.2, Step 7)", () => {
  it("getStateVector reports the highest counter with no gap, per replica", () => {
    const seq = new LogSequence("A");
    seq.recordLocal("x"); // counter 0
    seq.recordLocal("y"); // counter 1
    seq.recordLocal("z"); // counter 2
    expect(seq.getStateVector()).toEqual(new Map([["A", 2]]));
  });

  it("a replica with no integrated ops is absent from its own state vector", () => {
    const seq = new LogSequence("A");
    expect(seq.getStateVector()).toEqual(new Map());
  });

  it("a gap in received counters caps the reported vector below the gap, not at the highest received", () => {
    const origin = new LogSequence("A");
    const op0 = origin.recordLocal("first"); // counter 0
    const op1 = origin.recordLocal("second", [op0.id]); // counter 1
    const op2 = origin.recordLocal("third", [op1.id]); // counter 2

    const receiver = new LogSequence("R");
    receiver.receive(op0);
    receiver.receive(op2); // counter 1 (op1) never arrives — a real gap
    // op2 depends on op1, so it's buffered, not integrated — the gap is
    // both "not yet reported" and "not yet applied," for the same reason.
    expect(receiver.getStateVector()).toEqual(new Map([["A", 0]]));
  });

  it("missingFrom returns exactly the ops the other vector doesn't cover, across replicas", () => {
    const a = new LogSequence("A");
    const opA0 = a.recordLocal("a0");
    const opA1 = a.recordLocal("a1", [opA0.id]);
    const b = new LogSequence("B");
    const opB0 = b.recordLocal("b0");

    const full = new LogSequence("F");
    full.receive(opA0);
    full.receive(opA1);
    full.receive(opB0);

    // "I have A up to 0, nothing from B" — missing A's counter 1 and all of B.
    const theirVector = new Map([["A", 0]]);
    const missing = full.missingFrom(theirVector);
    expect(missing.map((op) => op.payload.value).sort()).toEqual(["a1", "b0"]);
  });

  it("missingFrom returns nothing once the other vector already covers everything", () => {
    const seq = new LogSequence("A");
    seq.recordLocal("x");
    seq.recordLocal("y");
    expect(seq.missingFrom(seq.getStateVector())).toEqual([]);
  });

  it("missingFrom against an empty vector returns the entire log", () => {
    const seq = new LogSequence("A");
    seq.recordLocal("x");
    seq.recordLocal("y");
    const missing = seq.missingFrom(new Map());
    expect(missing.map((op) => op.payload.value)).toEqual(["x", "y"]);
  });

  it("round-trips through another replica: applying missingFrom's result reproduces full state", () => {
    const origin = new LogSequence("A");
    origin.recordLocal("x");
    origin.recordLocal("y");
    origin.recordLocal("z");

    const receiver = new LogSequence("R");
    const missing = origin.missingFrom(receiver.getStateVector());
    for (const op of missing) receiver.receive(op);

    expect(receiver.integrated).toEqual(origin.integrated);
    expect(receiver.getStateVector()).toEqual(origin.getStateVector());
  });
});
