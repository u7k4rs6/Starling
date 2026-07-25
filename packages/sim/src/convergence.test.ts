import fc from "fast-check";
import { Doc, RgaDoc, type CrdtOp } from "starling-crdt";
import { describe, expect, it } from "vitest";
import { Network } from "./network.js";
import { createSeededRng } from "./rng.js";

type OpSpec = { replicaIndex: number; kind: "insert" | "delete"; rawIndex: number; char: string };

const opSpecArb = fc.record({
  replicaIndex: fc.nat({ max: 10 }),
  kind: fc.constantFrom<"insert" | "delete">("insert", "delete"),
  rawIndex: fc.nat({ max: 50 }),
  char: fc.char(),
});

function replicaName(i: number): string {
  return `replica-${i}`;
}

/**
 * F-6.3: the adversarial network model (drops, duplicates, reordering,
 * partitions) previously ran against `RgaDoc` only. `Doc` is the class the
 * provider, the binding and the demo actually use, so the model built
 * specifically to find delivery-order bugs was never pointed at the
 * production code. Both now run the same properties.
 *
 * `RgaDoc` stays in the table rather than being replaced: it is exhibit 3
 * and its convergence is still a real claim (PRD §4 — "if a change to the
 * base breaks an exhibit, the exhibit was load-bearing").
 */
type SimDoc = {
  readonly text: string;
  insertLocal(visibleIndex: number, char: string): CrdtOp;
  deleteLocal(visibleIndex: number): CrdtOp;
  receive(op: CrdtOp): void;
};

const DOC_CLASSES: Array<{ label: string; make: (replica: string) => SimDoc }> = [
  { label: "RgaDoc (exhibit 3)", make: (replica) => new RgaDoc(replica) },
  { label: "Doc (Fugue, production)", make: (replica) => new Doc(replica) },
];

/**
 * S3: generate ops from independently-evolving replica state (real
 * concurrency, same generation strategy as the crdt package's own S1/S2
 * tests), broadcast each to every other replica over the `Network`, then
 * adversarially duplicate some pending envelopes before draining
 * everything in RNG-chosen order — reordering is inherent to `Network`
 * (delivery order is never insertion order once more than one envelope is
 * pending), duplication is explicit.
 */
function runAdversarialScenario(
  makeDoc: (replica: string) => SimDoc,
  replicaCount: number,
  opSpecs: OpSpec[],
  networkSeed: number,
  duplicateRounds: number
): string[] {
  const replicas = Array.from({ length: replicaCount }, (_, i) => makeDoc(replicaName(i)));
  const net = new Network<CrdtOp>(createSeededRng(networkSeed));

  opSpecs.forEach((spec) => {
    const authorIndex = spec.replicaIndex % replicaCount;
    const author = replicas[authorIndex]!;
    const op =
      spec.kind === "delete" && author.text.length > 0
        ? author.deleteLocal(spec.rawIndex % author.text.length)
        : author.insertLocal(Math.min(spec.rawIndex, author.text.length), spec.char);

    for (let i = 0; i < replicaCount; i += 1) {
      if (i !== authorIndex) net.send(replicaName(authorIndex), replicaName(i), op);
    }
  });

  for (let i = 0; i < duplicateRounds; i += 1) net.duplicateOne();

  net.deliverAll((envelope) => {
    const toIndex = replicas.findIndex((_, i) => replicaName(i) === envelope.to);
    replicas[toIndex]!.receive(envelope.message);
  });

  return replicas.map((r) => r.text);
}

for (const { label, make } of DOC_CLASSES) {
describe(`S3 [${label}]: convergence holds under arbitrary delivery order`, () => {
  it("adversarial delivery (RNG-reordered, some envelopes duplicated) still converges", () => {
    fc.assert(
      fc.property(
        fc.array(opSpecArb, { minLength: 0, maxLength: 20 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 5 }),
        (opSpecs, networkSeed, duplicateRounds) => {
          const texts = runAdversarialScenario(make, 3, opSpecs, networkSeed, duplicateRounds);
          expect(new Set(texts).size).toBe(1);
        }
      ),
      { numRuns: 500 }
    );
  });

  it("a fixed adversarial seed is committed as a concrete, debuggable example (PRD §6: seed committed)", () => {
    // Not chasing a specific historical failure — there wasn't one — but
    // establishing the pattern: if the property test above ever fails,
    // fast-check prints a {seed, path}; that gets pasted in as a new case
    // here, exactly like this one, so the regression stays pinned.
    const opSpecs: OpSpec[] = [
      { replicaIndex: 0, kind: "insert", rawIndex: 0, char: "h" },
      { replicaIndex: 1, kind: "insert", rawIndex: 0, char: "w" },
      { replicaIndex: 2, kind: "insert", rawIndex: 0, char: "z" },
      { replicaIndex: 0, kind: "insert", rawIndex: 1, char: "i" },
      { replicaIndex: 1, kind: "delete", rawIndex: 0, char: "x" },
    ];
    const texts = runAdversarialScenario(make, 3, opSpecs, 424242, 3);
    expect(new Set(texts).size).toBe(1);
  });
});

describe(`S4 [${label}]: convergence holds under partition and rejoin`, () => {
  it("partitioned groups diverge from each other while healthy within their own group; healing converges everyone", () => {
    const net = new Network<CrdtOp>(createSeededRng(1));
    const a = make("A");
    const b = make("B");
    const c = make("C");
    const replicas = new Map([
      ["A", a],
      ["B", b],
      ["C", c],
    ]);

    const broadcastFrom = (name: string, op: CrdtOp) => {
      for (const other of replicas.keys()) {
        if (other !== name) net.send(name, other, op);
      }
    };

    net.partition([["A", "B"], ["C"]]);

    broadcastFrom("A", a.insertLocal(0, "a"));
    broadcastFrom("B", b.insertLocal(0, "b"));
    broadcastFrom("C", c.insertLocal(0, "c"));

    net.deliverAll((envelope) => replicas.get(envelope.to)!.receive(envelope.message));

    // A and B share a partition and converge with each other...
    expect(a.text).toBe(b.text);
    // ...but C, isolated, has diverged — proving the partition actually
    // did something, not just that nothing was sent across it.
    expect(a.text).not.toBe(c.text);
    expect(c.text).toBe("c");

    net.healPartitions();
    net.deliverAll((envelope) => replicas.get(envelope.to)!.receive(envelope.message));

    expect(a.text).toBe(b.text);
    expect(b.text).toBe(c.text);
  });

  it("property: for many random op sequences, partition causes divergence and healing always converges", () => {
    fc.assert(
      fc.property(
        fc.array(opSpecArb, { minLength: 1, maxLength: 12 }),
        fc.array(opSpecArb, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (groupOneOps, groupTwoOps, seed) => {
          const net = new Network<CrdtOp>(createSeededRng(seed));
          const replicas = [make(replicaName(0)), make(replicaName(1))];
          net.partition([[replicaName(0)], [replicaName(1)]]);

          const apply = (replicaIndex: number, spec: OpSpec) => {
            const author = replicas[replicaIndex]!;
            const op =
              spec.kind === "delete" && author.text.length > 0
                ? author.deleteLocal(spec.rawIndex % author.text.length)
                : author.insertLocal(Math.min(spec.rawIndex, author.text.length), spec.char);
            const other = replicaName(1 - replicaIndex);
            net.send(replicaName(replicaIndex), other, op);
          };

          for (const spec of groupOneOps) apply(0, spec);
          for (const spec of groupTwoOps) apply(1, spec);

          // Genuinely partitioned: nothing is deliverable yet, so there is
          // nothing to drain here. (Calling deliverAll with a no-op
          // callback would silently discard anything that *was*
          // deliverable instead of proving nothing was — exactly the bug
          // this test had on first write; see DECISIONS #0015.)
          expect(net.deliverOne()).toBeNull();

          net.healPartitions();
          net.deliverAll((envelope) => {
            const toIndex = envelope.to === replicaName(0) ? 0 : 1;
            replicas[toIndex]!.receive(envelope.message);
          });

          expect(replicas[0]!.text).toBe(replicas[1]!.text);
        }
      ),
      { numRuns: 500 }
    );
  });
});
}
