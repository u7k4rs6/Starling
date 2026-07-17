import { describe, expect, it } from "vitest";
import { Network } from "./network.js";
import { createSeededRng } from "./rng.js";

describe("Network", () => {
  it("deliverOne returns null when nothing is pending", () => {
    const net = new Network<string>(createSeededRng(1));
    expect(net.deliverOne()).toBeNull();
  });

  it("send queues an envelope; deliverOne removes it and returns it", () => {
    const net = new Network<string>(createSeededRng(1));
    net.send("A", "B", "hello");
    expect(net.pendingCount).toBe(1);
    const envelope = net.deliverOne();
    expect(envelope).toMatchObject({ from: "A", to: "B", message: "hello" });
    expect(net.pendingCount).toBe(0);
  });

  it("deliverAll drains every pending envelope and reports how many", () => {
    const net = new Network<number>(createSeededRng(2));
    for (let i = 0; i < 10; i += 1) net.send("A", "B", i);
    const delivered: number[] = [];
    const count = net.deliverAll((env) => delivered.push(env.message));
    expect(count).toBe(10);
    expect(net.pendingCount).toBe(0);
    expect(delivered.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("delivery order is a deterministic function of the seed — same seed, same order", () => {
    const build = (seed: number) => {
      const net = new Network<number>(createSeededRng(seed));
      for (let i = 0; i < 12; i += 1) net.send("A", "B", i);
      const order: number[] = [];
      net.deliverAll((env) => order.push(env.message));
      return order;
    };
    expect(build(777)).toEqual(build(777));
  });

  it("delivery order actually varies with the seed (not silently insertion order)", () => {
    const build = (seed: number) => {
      const net = new Network<number>(createSeededRng(seed));
      for (let i = 0; i < 12; i += 1) net.send("A", "B", i);
      const order: number[] = [];
      net.deliverAll((env) => order.push(env.message));
      return order;
    };
    const orders = new Set([1, 2, 3, 4, 5].map((seed) => JSON.stringify(build(seed))));
    expect(orders.size).toBeGreaterThan(1);
  });

  it("dropOne removes an envelope without delivering it", () => {
    const net = new Network<string>(createSeededRng(3));
    net.send("A", "B", "x");
    const dropped = net.dropOne();
    expect(dropped).toBe(true);
    expect(net.pendingCount).toBe(0);
    expect(net.deliverOne()).toBeNull();
  });

  it("dropOne on an empty queue returns false", () => {
    const net = new Network<string>(createSeededRng(3));
    expect(net.dropOne()).toBe(false);
  });

  it("duplicateOne adds a second copy that delivers as an independent envelope", () => {
    const net = new Network<string>(createSeededRng(4));
    net.send("A", "B", "x");
    const duplicated = net.duplicateOne();
    expect(duplicated).toBe(true);
    expect(net.pendingCount).toBe(2);
    const delivered: string[] = [];
    net.deliverAll((env) => delivered.push(env.message));
    expect(delivered).toEqual(["x", "x"]);
  });

  it("partition blocks delivery across group boundaries", () => {
    const net = new Network<string>(createSeededRng(5));
    net.partition([["A"], ["B"]]);
    net.send("A", "B", "cross-partition");
    expect(net.deliverOne()).toBeNull();
    expect(net.pendingCount).toBe(1); // still queued, just undeliverable right now
  });

  it("partition allows delivery within the same group", () => {
    const net = new Network<string>(createSeededRng(5));
    net.partition([["A", "B"], ["C"]]);
    net.send("A", "B", "same-partition");
    expect(net.deliverOne()).toMatchObject({ message: "same-partition" });
  });

  it("healPartitions makes previously-blocked messages deliverable", () => {
    const net = new Network<string>(createSeededRng(6));
    net.partition([["A"], ["B"]]);
    net.send("A", "B", "was-blocked");
    expect(net.deliverOne()).toBeNull();
    net.healPartitions();
    expect(net.deliverOne()).toMatchObject({ message: "was-blocked" });
  });

  it("replicas not named in any partition group keep their previous group", () => {
    const net = new Network<string>(createSeededRng(8));
    net.partition([["A"], ["B"]]);
    net.send("A", "C", "to-unmentioned"); // C defaults to group 0, A is group 1
    expect(net.deliverOne()).toBeNull();
  });
});
