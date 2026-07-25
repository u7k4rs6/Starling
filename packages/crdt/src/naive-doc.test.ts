import { describe, expect, it } from "vitest";
import { NaiveDoc } from "./naive-doc.js";

describe("NaiveDoc (museum exhibit 1): apply() is not commutative", () => {
  it("integrate(a)∘integrate(b) ≠ integrate(b)∘integrate(a) for concurrent inserts at the same index", () => {
    const replicaA = new NaiveDoc("A");
    const replicaB = new NaiveDoc("B");

    // Both start from "" and insert at index 0 without knowledge of each other.
    const opA = replicaA.insertLocal(0, "A");
    const opB = replicaB.insertLocal(0, "B");

    // Exchange: each replica now receives the other's op. Sequence's
    // idempotence/causal-buffering machinery runs (both ops have deps: []
    // so nothing is ever buffered), but integrate() places by raw index —
    // there is no id-based reconciliation.
    replicaA.receive(opB);
    replicaB.receive(opA);

    // splice(0, 0, x) always inserts before what's already there, so
    // whichever op a replica integrates *second* ends up *first*.
    expect(replicaA.text).toBe("BA");
    expect(replicaB.text).toBe("AB");
    expect(replicaA.text).not.toBe(replicaB.text);
  });

  it("the same non-commutativity holds with a shared non-empty prefix", () => {
    const base = "hello ";
    const replicaA = new NaiveDoc("A");
    const replicaB = new NaiveDoc("B");
    for (const ch of base) {
      const op = replicaA.insertLocal(replicaA.text.length, ch);
      replicaB.receive(op);
    }
    expect(replicaA.text).toBe(base);
    expect(replicaB.text).toBe(base);

    const opA = replicaA.insertLocal(base.length, "X");
    const opB = replicaB.insertLocal(base.length, "Y");

    replicaA.receive(opB);
    replicaB.receive(opA);

    expect(replicaA.text).toBe(`${base}YX`);
    expect(replicaB.text).toBe(`${base}XY`);
    expect(replicaA.text).not.toBe(replicaB.text);
  });

  it("integrate() does commute for causally-ordered (non-concurrent) ops — the control case", () => {
    // Isolates that non-commutativity is about concurrency, not about
    // index-based ops in general: applying each op only after the previous
    // one is already reflected in both replicas' state commutes fine,
    // because there is only ever one order to apply them in.
    const replicaA = new NaiveDoc("A");
    const replicaB = new NaiveDoc("B");

    const op1 = replicaA.insertLocal(0, "A");
    replicaB.receive(op1);
    const op2 = replicaA.insertLocal(1, "B");
    replicaB.receive(op2);

    expect(replicaA.text).toBe(replicaB.text);
    expect(replicaA.text).toBe("AB");
  });

  it("Step 2 retrofit: NaiveDoc now has real identity and idempotence, and still diverges — commutativity lives in the merge rule, not in identity", () => {
    const replicaA = new NaiveDoc("A");
    const replicaB = new NaiveDoc("B");

    const opA = replicaA.insertLocal(0, "A");
    const opB = replicaB.insertLocal(0, "B");

    // Identity is real now: distinct, non-reused ElemIds, not raw indices.
    expect(opA.id).toEqual({ replica: "A", counter: 0, clock: 1 });
    expect(opB.id).toEqual({ replica: "B", counter: 0, clock: 1 });
    expect(opA.id).not.toEqual(opB.id);

    // Idempotence is free, inherited from Sequence: re-receiving an
    // already-integrated op (your own, or a remote one already applied)
    // changes nothing.
    replicaA.receive(opA);
    replicaA.receive(opB);
    replicaA.receive(opB);
    expect(replicaA.text).toBe("BA");

    // But integrate() (naive-doc.ts) never reads op.id — it still places
    // by op.payload.index alone — so none of the identity machinery above
    // touches the merge decision. Same divergence as Step 1, on a replica
    // that now has everything ArrayDoc has except a merge rule that uses it.
    replicaB.receive(opA);
    expect(replicaB.text).toBe("AB");
    expect(replicaA.text).not.toBe(replicaB.text);
  });

  it("deps matches its payload's actual dependency: none (DECISIONS #0010)", () => {
    // The pattern every doc class owns one instance of: assert deps
    // reflects what the payload actually depends on, not just whatever the
    // implementation currently emits. For NaiveDoc that's trivially [],
    // because {index, char} contains no id to depend on — but it's the
    // same assertion RgaDoc (Step 3) will make non-trivial, when deps
    // needs to contain exactly the origin id.
    const replica = new NaiveDoc("A");
    const op1 = replica.insertLocal(0, "a");
    const op2 = replica.insertLocal(1, "b");
    const op3 = replica.insertLocal(0, "c");

    expect(op1.deps).toEqual([]);
    expect(op2.deps).toEqual([]);
    expect(op3.deps).toEqual([]);
  });
});
