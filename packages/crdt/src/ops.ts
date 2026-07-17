import type { ElemId } from "./elem-id.js";
import type { Op } from "./sequence.js";

/**
 * Shared op payload for every RGA-family doc class (ArrayDoc, RgaDoc, and
 * eventually Doc once Fugue replaces RGA at Step 6 — Fugue's payload adds a
 * side field but the insert/delete split stays the same shape). Factored
 * out so the exhibits can share a test suite (PRD §4's requirement) and,
 * incidentally, so an op produced by one is a valid op for another — they
 * differ only in storage and merge rule, never in what an op means.
 */
export type InsertPayload = { type: "insert"; l: ElemId | null; char: string };
export type DeletePayload = { type: "delete"; target: ElemId };
export type CrdtPayload = InsertPayload | DeletePayload;
export type CrdtOp = Op<CrdtPayload>;
