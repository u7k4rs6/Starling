import fc from "fast-check";
import { EditorState } from "prosemirror-state";
import { AttrStep } from "prosemirror-transform";
import { Doc } from "starling-crdt";
import { describe, expect, it } from "vitest";
import { anchorToPmPos, opsToSteps, pmDocFromDoc, pmPosToAnchor, transactionToOps } from "./binding.js";
import { schema } from "./schema.js";

function freshState(doc: Doc): EditorState {
  return EditorState.create({ doc: pmDocFromDoc(doc) });
}

describe("F1: this whole suite runs with no DOM shim — importing prosemirror-view here would be the bug", () => {
  it("prosemirror-view is not resolvable from this package (headless is enforced by dependency, not discipline)", async () => {
    // A non-literal specifier: with a string literal, `tsc` would try to
    // statically resolve "prosemirror-view" as a module and fail *at
    // typecheck time* (it genuinely isn't a dependency here, which is the
    // point) rather than at runtime, where this test wants to observe it.
    const notADependency = "prosemirror-view";
    await expect(import(notADependency)).rejects.toThrow();
  });
});

describe("transactionToOps: local edits produce matching CRDT ops (FRONTEND §1.2)", () => {
  it("typing into an empty document produces one insert op per character, in order", () => {
    const doc = new Doc("A");
    let state = freshState(doc);

    const tr = state.tr.insertText("abc", 1);
    const ops = transactionToOps(tr, doc);
    state = state.apply(tr);

    expect(doc.text).toBe("abc");
    expect(state.doc.textContent).toBe("abc");
    expect(ops).toHaveLength(3);
    expect(ops.map((op) => (op.payload.type === "insert" ? op.payload.char : null))).toEqual(["a", "b", "c"]);
  });

  it("deleting a range produces one delete op per removed character", () => {
    const doc = new Doc("A");
    for (const ch of "hello") doc.insertLocal(doc.text.length, ch);
    let state = freshState(doc);

    const tr = state.tr.delete(3, 5); // visible indices [2,4) — the two 'l's
    const ops = transactionToOps(tr, doc);
    state = state.apply(tr);

    expect(doc.text).toBe("heo");
    expect(state.doc.textContent).toBe("heo");
    expect(ops).toHaveLength(2);
    expect(ops.every((op) => op.payload.type === "delete")).toBe(true);
  });

  it("a replace (delete + insert in one step) produces deletes then inserts, in that order", () => {
    const doc = new Doc("A");
    for (const ch of "cat") doc.insertLocal(doc.text.length, ch);
    let state = freshState(doc);

    const tr = state.tr.replaceWith(2, 4, schema.text("o")); // "ca" + "o" + "" -> replace "at" with "o"
    const ops = transactionToOps(tr, doc);
    state = state.apply(tr);

    expect(doc.text).toBe("co");
    expect(state.doc.textContent).toBe("co");
    expect(ops[0]!.payload.type).toBe("delete");
    expect(ops[ops.length - 1]!.payload.type).toBe("insert");
  });

  it("a transaction with no steps produces no ops", () => {
    const doc = new Doc("A");
    const state = freshState(doc);
    expect(transactionToOps(state.tr, doc)).toEqual([]);
  });

  it("throws on a step type this schema's own commands never produce, rather than silently ignoring it", () => {
    // AttrStep (node-attribute changes) is real prosemirror-transform
    // output for schemas with node attrs — this schema defines none, so
    // no command of ours ever emits one, but constructing it directly
    // proves the type-guard actually rejects an unexpected step rather
    // than only ever seeing ReplaceStep by happenstance.
    const doc = new Doc("A");
    const state = freshState(doc);
    const tr = state.tr;
    tr.step(new AttrStep(0, "some-attr", "value"));
    expect(() => transactionToOps(tr, doc)).toThrow(/unsupported step type/);
  });
});

describe("opsToSteps: remote ops produce matching ProseMirror steps (FRONTEND §1.2)", () => {
  it("remote insert ops replay onto a second replica's PM state, converging the text", () => {
    const a = new Doc("A");
    let stateA = freshState(a);
    const trA = stateA.tr.insertText("hello", 1);
    const opsA = transactionToOps(trA, a);
    stateA = stateA.apply(trA);

    const b = new Doc("B");
    let stateB = freshState(b);
    const steps = opsToSteps(opsA, b);
    for (const step of steps) {
      const result = step.apply(stateB.doc);
      if (!result.doc) throw new Error("step application failed");
      stateB = EditorState.create({ doc: result.doc });
    }

    expect(b.text).toBe("hello");
    expect(stateB.doc.textContent).toBe("hello");
  });

  it("remote delete ops replay the same way", () => {
    // A delete op names its target by the *same* ElemId the insert
    // created — b has to have already integrated that specific insert
    // (not just typed matching-looking text of its own with entirely
    // different ids) before a delete referencing it means anything to b.
    // An earlier version of this test had b build its own independent
    // "hello" via local inserts, which produced different ids entirely
    // and made the delete op unresolvable — a test bug, not a binding bug
    // (same shape as DECISIONS #0022's crdt-level test bug: two
    // independently-built documents assumed to be "the same" document).
    const a = new Doc("A");
    for (const ch of "hello") a.insertLocal(a.text.length, ch);

    const b = new Doc("B");
    for (const op of a.missingFrom(new Map())) b.receive(op);
    expect(b.text).toBe("hello");

    let stateA = freshState(a);
    const trA = stateA.tr.delete(3, 5); // delete the two 'l's
    const opsA = transactionToOps(trA, a);
    stateA = stateA.apply(trA);

    let stateB = freshState(b);
    const steps = opsToSteps(opsA, b);
    for (const step of steps) {
      const result = step.apply(stateB.doc);
      if (!result.doc) throw new Error("step application failed");
      stateB = EditorState.create({ doc: result.doc });
    }

    expect(b.text).toBe("heo");
    expect(stateB.doc.textContent).toBe("heo");
  });

  it("F2: no ElemId or raw CRDT id appears anywhere in the generated steps' JSON", () => {
    const a = new Doc("replica-with-a-distinctive-id");
    for (const ch of "hi") a.insertLocal(a.text.length, ch);
    const b = new Doc("B");
    const ops = [...a.missingFrom(new Map())];
    const steps = opsToSteps(ops, b);
    const json = JSON.stringify(steps.map((s) => s.toJSON()));
    expect(json).not.toContain("replica-with-a-distinctive-id");
    expect(json).not.toContain("counter");
  });
});

describe("Selection as anchors (ARCH §7 / FRONTEND §1.3) — the editor-level S10 test", () => {
  it("a cursor captured as an anchor tracks a remote insert before it, exactly like the CRDT-level anchor test", () => {
    const a = new Doc("A");
    let stateA = freshState(a);
    const trWorld = stateA.tr.insertText("world", 1);
    transactionToOps(trWorld, a);
    stateA = stateA.apply(trWorld);

    // A's cursor sits right before 'w' — PM position 1.
    const cursor = pmPosToAnchor(a, 1);
    expect(anchorToPmPos(a, cursor)).toBe(1);

    // B already has "world" (causally anchored, per DECISIONS #0022's
    // fix to the equivalent crdt-level test) and types "hello " before it.
    const b = new Doc("B");
    for (const op of a.missingFrom(new Map())) b.receive(op);
    let stateB = freshState(b);
    const trHello = stateB.tr.insertText("hello ", 1);
    const opsB = transactionToOps(trHello, b);
    stateB = stateB.apply(trHello);

    const steps = opsToSteps(opsB, a);
    for (const step of steps) {
      const result = step.apply(stateA.doc);
      if (!result.doc) throw new Error("step application failed");
      stateA = EditorState.create({ doc: result.doc });
    }

    expect(a.text).toBe("hello world");
    expect(stateA.doc.textContent).toBe("hello world");
    // The anchor followed 'w', not the number 1 — six new live characters
    // now precede it.
    expect(anchorToPmPos(a, cursor)).toBe(7);
  });
});

describe("property: a random sequence of local transactions keeps the CRDT and the PM document in lockstep", () => {
  it("doc.text always equals the PM document's own text content, at every step", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant("insert" as const), rawPos: fc.nat({ max: 60 }), char: fc.char() }),
            fc.record({ kind: fc.constant("delete" as const), rawPos: fc.nat({ max: 60 }) })
          ),
          { minLength: 1, maxLength: 60 }
        ),
        (edits) => {
          const doc = new Doc("A");
          let state = freshState(doc);
          for (const edit of edits) {
            const length = state.doc.content.size - 2; // exclude paragraph open/close
            if (edit.kind === "insert") {
              const pos = 1 + Math.min(edit.rawPos, length);
              const tr = state.tr.insertText(edit.char, pos);
              transactionToOps(tr, doc);
              state = state.apply(tr);
            } else if (length > 0) {
              const pos = 1 + (edit.rawPos % length);
              const tr = state.tr.delete(pos, pos + 1);
              transactionToOps(tr, doc);
              state = state.apply(tr);
            }
            expect(doc.text).toBe(state.doc.textContent);
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});
