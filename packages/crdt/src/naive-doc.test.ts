import { describe, expect, it } from "vitest";
import { NaiveDoc } from "./naive-doc.js";

describe("NaiveDoc (museum exhibit 1): apply() is not commutative", () => {
  it("apply(a)∘apply(b) ≠ apply(b)∘apply(a) for concurrent inserts at the same index", () => {
    const replicaA = new NaiveDoc();
    const replicaB = new NaiveDoc();

    // Both start from "" and insert at index 0 without knowledge of each other.
    const opA = replicaA.insertLocal(0, "A");
    const opB = replicaB.insertLocal(0, "B");

    // Exchange: each replica now applies the other's op, using its raw
    // index verbatim — there is no identity to reconcile it against.
    replicaA.apply(opB);
    replicaB.apply(opA);

    // splice(0, 0, x) always inserts before what's already there, so
    // whichever op a replica applies *second* ends up *first*.
    expect(replicaA.text).toBe("BA");
    expect(replicaB.text).toBe("AB");
    expect(replicaA.text).not.toBe(replicaB.text);
  });

  it("the same non-commutativity holds with a shared non-empty prefix", () => {
    const base = "hello ";
    const replicaA = new NaiveDoc();
    const replicaB = new NaiveDoc();
    for (const ch of base) {
      const op = replicaA.insertLocal(replicaA.text.length, ch);
      replicaB.apply(op);
    }
    expect(replicaA.text).toBe(base);
    expect(replicaB.text).toBe(base);

    const opA = replicaA.insertLocal(base.length, "X");
    const opB = replicaB.insertLocal(base.length, "Y");

    replicaA.apply(opB);
    replicaB.apply(opA);

    expect(replicaA.text).toBe(`${base}YX`);
    expect(replicaB.text).toBe(`${base}XY`);
    expect(replicaA.text).not.toBe(replicaB.text);
  });

  it("apply() does commute for causally-ordered (non-concurrent) ops — the control case", () => {
    // Isolates that non-commutativity is about concurrency, not about
    // index-based ops in general: applying each op only after the previous
    // one is already reflected in both replicas' state commutes fine,
    // because there is only ever one order to apply them in.
    const replicaA = new NaiveDoc();
    const replicaB = new NaiveDoc();

    const op1 = replicaA.insertLocal(0, "A");
    replicaB.apply(op1);
    const op2 = replicaA.insertLocal(1, "B");
    replicaB.apply(op2);

    expect(replicaA.text).toBe(replicaB.text);
    expect(replicaA.text).toBe("AB");
  });
});
