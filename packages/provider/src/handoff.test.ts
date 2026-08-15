import { describe, expect, it } from "vitest";
import { LocalRelayHub } from "./local-transport.js";
import { InMemoryPersistence } from "./persistence.js";
import { Provider } from "./provider.js";

const ROOM = "8f14e45f-ceea-467e-bd7e-2e8912cee2b8";

/**
 * The local-to-relay handoff: a visitor types in local-only mode, then shares.
 * The document already holds their ops, but the read cursor and last-pushed
 * vector belonged to the local log and mean nothing in the relay's log.
 * `switchTransport` resets both and reconciles. Here a second LocalRelayHub
 * stands in for the hosted relay, so both sides are exercised without a server.
 */
describe("Provider.switchTransport: local to relay", () => {
  it("empty relay room: local edits replay into it and a peer joining sees them", async () => {
    const local = new LocalRelayHub();
    const relay = new LocalRelayHub();

    const a = await Provider.create("a", new InMemoryPersistence(), local.transport(ROOM));
    await a.insertLocal(0, "h");
    await a.insertLocal(1, "i");
    await a.sync(); // converged locally; the relay is still empty

    await a.switchTransport(relay.transport(ROOM)); // share

    const b = await Provider.create("b", new InMemoryPersistence(), relay.transport(ROOM));
    await b.sync();
    expect(b.text).toBe("hi");
  });

  it("pre-existing relay room: the two histories merge with no lost or duplicated ops", async () => {
    const local = new LocalRelayHub();
    const relay = new LocalRelayHub();

    // The relay room already holds content from another participant.
    const b = await Provider.create("b", new InMemoryPersistence(), relay.transport(ROOM));
    await b.insertLocal(0, "B");
    await b.insertLocal(1, "B");
    await b.sync();

    // A has been editing locally the whole time.
    const a = await Provider.create("a", new InMemoryPersistence(), local.transport(ROOM));
    await a.insertLocal(0, "a");
    await a.insertLocal(1, "a");
    await a.sync();

    await a.switchTransport(relay.transport(ROOM)); // share into the non-empty room
    await b.sync();
    await a.sync();

    // Converged, and exactly the four ops survive: two a's and two B's, none
    // lost, none duplicated.
    expect(a.text).toBe(b.text);
    expect(a.text).toHaveLength(4);
    expect([...a.text].filter((c) => c === "a")).toHaveLength(2);
    expect([...a.text].filter((c) => c === "B")).toHaveLength(2);
  });

  it("re-reading its own pushed ops after the switch does not grow or corrupt the document", async () => {
    const local = new LocalRelayHub();
    const relay = new LocalRelayHub();
    const a = await Provider.create("a", new InMemoryPersistence(), local.transport(ROOM));
    for (const [i, ch] of [..."hello"].entries()) await a.insertLocal(i, ch);
    await a.sync();

    await a.switchTransport(relay.transport(ROOM));
    await a.sync();
    await a.sync();
    expect(a.text).toBe("hello");

    const b = await Provider.create("b", new InMemoryPersistence(), relay.transport(ROOM));
    await b.sync();
    expect(b.text).toBe("hello");
  });
});
