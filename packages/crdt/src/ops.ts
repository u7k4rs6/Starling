import type { ElemId } from "./elem-id.js";
import type { Op } from "./sequence.js";

/**
 * Shared op payload for every RGA-family doc class (ArrayDoc, RgaDoc, and
 * Doc, once Fugue replaces RGA at Step 6). Factored out so the exhibits
 * can share a test suite (PRD §4's requirement) and, incidentally, so an
 * op produced by one is a valid op for another — they differ only in
 * storage and merge rule, never in what an op means.
 *
 * `side` is Fugue-specific (ARCH §2.3): which side of `l` this element was
 * inserted on. `ArrayDoc`/`RgaDoc`'s integrate() never reads it — RGA's
 * merge rule has no concept of side, only origin — so it's optional and
 * those two classes' insertLocal never sets it.
 */
export type InsertPayload = { type: "insert"; l: ElemId | null; char: string; side?: "L" | "R" };
export type DeletePayload = { type: "delete"; target: ElemId };
export type CrdtPayload = InsertPayload | DeletePayload;
export type CrdtOp = Op<CrdtPayload>;
