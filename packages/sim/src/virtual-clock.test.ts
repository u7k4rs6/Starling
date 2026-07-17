import { describe, expect, it } from "vitest";
import { VirtualClock } from "./virtual-clock.js";

describe("VirtualClock", () => {
  it("starts at time 0 and never moves without an explicit advance", () => {
    const clock = new VirtualClock();
    expect(clock.now()).toBe(0);
  });

  it("advanceTo runs callbacks scheduled at or before the target time, in time order", () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    clock.scheduleAt(30, () => order.push("c"));
    clock.scheduleAt(10, () => order.push("a"));
    clock.scheduleAt(20, () => order.push("b"));
    clock.advanceTo(30);
    expect(order).toEqual(["a", "b", "c"]);
    expect(clock.now()).toBe(30);
  });

  it("does not run callbacks scheduled after the target time", () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    clock.scheduleAt(10, () => order.push("a"));
    clock.scheduleAt(100, () => order.push("late"));
    clock.advanceTo(10);
    expect(order).toEqual(["a"]);
    expect(clock.pendingCount).toBe(1); // "late" still scheduled
  });

  it("ties at the same time break on schedule sequence, not on anything incidental", () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    clock.scheduleAt(5, () => order.push("first"));
    clock.scheduleAt(5, () => order.push("second"));
    clock.scheduleAt(5, () => order.push("third"));
    clock.advanceTo(5);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("a callback that schedules another callback due by the same target time still runs it within this advance", () => {
    const clock = new VirtualClock();
    const order: string[] = [];
    clock.scheduleAt(10, () => {
      order.push("first");
      clock.scheduleAt(15, () => order.push("chained"));
    });
    clock.advanceTo(20);
    expect(order).toEqual(["first", "chained"]);
  });

  it("scheduleAfter is relative to the current time", () => {
    const clock = new VirtualClock();
    const order: number[] = [];
    clock.advanceTo(100);
    clock.scheduleAfter(5, () => order.push(clock.now()));
    clock.advanceTo(105);
    expect(order).toEqual([105]);
  });

  it("advanceBy advances relative to the current time", () => {
    const clock = new VirtualClock();
    clock.advanceBy(10);
    expect(clock.now()).toBe(10);
    clock.advanceBy(5);
    expect(clock.now()).toBe(15);
  });

  it("refuses to schedule in the past", () => {
    const clock = new VirtualClock();
    clock.advanceTo(10);
    expect(() => clock.scheduleAt(5, () => {})).toThrow(RangeError);
  });

  it("refuses to advance backward", () => {
    const clock = new VirtualClock();
    clock.advanceTo(10);
    expect(() => clock.advanceTo(5)).toThrow(RangeError);
  });
});
