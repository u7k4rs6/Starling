import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ArrayDoc } from "./array-doc.js";
import {
  opSpecArb,
  runConvergencePropertyTests,
  runDocContractTests,
  runScenario,
} from "./doc-contract.test-helpers.js";
import { RgaDoc } from "./rga-doc.js";

runDocContractTests("RgaDoc (museum exhibit 3)", (replica) => new RgaDoc(replica));
runConvergencePropertyTests("RgaDoc (museum exhibit 3)", (replica) => new RgaDoc(replica));

describe("RgaDoc vs ArrayDoc: differential (same merge rule, different storage)", () => {
  it("converge to the identical text for the same op sequence, every run", () => {
    fc.assert(
      fc.property(
        fc.array(opSpecArb, { minLength: 0, maxLength: 16 }),
        fc.tuple(fc.integer(), fc.integer()),
        (opSpecs, shuffleSeeds) => {
          const arrayTexts = runScenario((r) => new ArrayDoc(r), 2, opSpecs, shuffleSeeds);
          const rgaTexts = runScenario((r) => new RgaDoc(r), 2, opSpecs, shuffleSeeds);
          expect(rgaTexts).toEqual(arrayTexts);
        }
      ),
      { numRuns: 1000 }
    );
  });
});

describe("RgaDoc's own bug (ARCH §2.3, exhibit 3): concurrent backward typing interleaves", () => {
  it("two replicas each typing a word backward converge to an unreadable jumble, not a clean concatenation", () => {
    // "Typing backward": each new character inserted at visible index 0,
    // so the *last* character typed ends up leftmost. Concurrently on two
    // replicas, unaware of each other.
    const a = new RgaDoc("A");
    const b = new RgaDoc("B");
    const opsA = [..."hello"].map((ch) => a.insertLocal(0, ch));
    const opsB = [..."world"].map((ch) => b.insertLocal(0, ch));

    // Each replica alone reconstructs its own word, reversed (expected:
    // inserting each new character before the last one written reverses
    // the typed order — this is not the bug, just how index-0 insertion
    // works, and it's identical for ArrayDoc/RgaDoc/Doc alike).
    expect(a.text).toBe("olleh");
    expect(b.text).toBe("dlrow");

    const allOps = [...opsA, ...opsB];
    const r1 = new RgaDoc("R1");
    for (const op of allOps) r1.receive(op);
    const r2 = new RgaDoc("R2");
    for (const op of [...allOps].reverse()) r2.receive(op);

    // It converges — both delivery orders agree...
    expect(r1.text).toBe(r2.text);
    // ...but on garbage: not "ollehdlrow", not "dlrowolleh", not any
    // clean concatenation of the two per-replica results in either order.
    // Convergence is not correctness (PRD §2.3): agreeing on a jumble is
    // still agreeing.
    expect(r1.text).not.toBe("olleh" + "dlrow");
    expect(r1.text).not.toBe("dlrow" + "olleh");
    // The actual result, pinned so this exhibit keeps demonstrating
    // exactly this failure if anyone is ever tempted to "fix" it here —
    // see rga-doc.ts's own comment: fixing this deletes the exhibit.
    expect(r1.text).toBe("dollrloewh");
  });
});

describe("RgaDoc cold-open performance (S6)", () => {
  it("100k-character document cold-opens in under 1s", () => {
    // Build the op log on one replica (sequential typing, the common
    // case), then time a FRESH replica replaying the whole log from
    // scratch — that replay is what "cold-open" means (ARCH §2.5).
    const N = 100_000;
    const author = new RgaDoc("author");
    const ops = new Array(N);
    for (let i = 0; i < N; i += 1) {
      ops[i] = author.insertLocal(i, String.fromCharCode(97 + (i % 26)));
    }

    const reader = new RgaDoc("reader");
    const start = performance.now();
    for (const op of ops) reader.receive(op);
    const elapsedMs = performance.now() - start;

    expect(reader.text.length).toBe(N);
    console.log(`RgaDoc cold-open, ${N} chars: ${elapsedMs.toFixed(1)}ms`);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("at a shared smaller scale, RgaDoc is faster than ArrayDoc for the same op log (trend check, not the S6 gate itself)", () => {
    // S6's 100k target is RgaDoc-only (ARCH's own comment: ArrayDoc's 100k
    // number is a Step 15 extrapolation, not a test to actually run here —
    // ~41s would make this suite miserable to run). This smaller-scale
    // comparison exists only to confirm the asymptotic trend is real
    // before trusting the extrapolation later.
    const N = 3000;
    const author = new RgaDoc("author");
    const ops = new Array(N);
    for (let i = 0; i < N; i += 1) {
      ops[i] = author.insertLocal(i, String.fromCharCode(97 + (i % 26)));
    }

    const arrayReader = new ArrayDoc("array-reader");
    const arrayStart = performance.now();
    for (const op of ops) arrayReader.receive(op);
    const arrayElapsedMs = performance.now() - arrayStart;

    const rgaReader = new RgaDoc("rga-reader");
    const rgaStart = performance.now();
    for (const op of ops) rgaReader.receive(op);
    const rgaElapsedMs = performance.now() - rgaStart;

    expect(arrayReader.text).toBe(rgaReader.text);
    console.log(
      `cold-open at ${N} chars — ArrayDoc: ${arrayElapsedMs.toFixed(1)}ms, RgaDoc: ${rgaElapsedMs.toFixed(1)}ms`
    );
    expect(rgaElapsedMs).toBeLessThan(arrayElapsedMs);
  });
});
