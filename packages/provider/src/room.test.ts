import { describe, expect, it } from "vitest";
import {
  decideTransportMode,
  generateRoomId,
  isValidRoomId,
  roomFragment,
  roomIdFromFragment,
} from "./room.js";

describe("generateRoomId: 128-bit unguessable capability", () => {
  it("is a well-formed room id", () => {
    expect(isValidRoomId(generateRoomId())).toBe(true);
  });

  it("carries a full 128 bits, i.e. 32 hex digits", () => {
    const hex = generateRoomId().replace(/-/g, "");
    expect(hex).toHaveLength(32);
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not repeat across many draws", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateRoomId()));
    expect(ids.size).toBe(1000);
  });
});

describe("isValidRoomId", () => {
  it("accepts the 8-4-4-4-12 hex shape", () => {
    expect(isValidRoomId("8f14e45f-ceea-467e-bd7e-2e8912cee2b8")).toBe(true);
  });

  it("rejects a sequential id, a slug, wrong length, and traversal attempts", () => {
    expect(isValidRoomId("1")).toBe(false);
    expect(isValidRoomId("my-room")).toBe(false);
    expect(isValidRoomId("8f14e45f-ceea-467e-bd7e-2e8912cee2b")).toBe(false); // one short
    expect(isValidRoomId("../../etc/passwd")).toBe(false);
  });
});

describe("room id in the URL fragment (not the query string)", () => {
  it("round-trips through the fragment", () => {
    const id = generateRoomId();
    expect(roomIdFromFragment(roomFragment(id))).toBe(id);
  });

  it("reads the id whether or not the leading # is present", () => {
    const id = "8f14e45f-ceea-467e-bd7e-2e8912cee2b8";
    expect(roomIdFromFragment(`#room=${id}`)).toBe(id);
    expect(roomIdFromFragment(`room=${id}`)).toBe(id);
  });

  it("treats a missing or malformed id as absent rather than trusting it", () => {
    expect(roomIdFromFragment("")).toBeNull();
    expect(roomIdFromFragment("#")).toBeNull();
    expect(roomIdFromFragment("#room=not-a-room")).toBeNull();
    expect(roomIdFromFragment("#other=8f14e45f-ceea-467e-bd7e-2e8912cee2b8")).toBeNull();
  });
});

describe("decideTransportMode: local by default, relay only on intent", () => {
  it("stays local on an ordinary visit, so the relay is not woken", () => {
    expect(decideTransportMode({ hasRoomId: false, shareRequested: false })).toBe("local");
  });

  it("tries the relay when the visitor arrived through a shared link", () => {
    expect(decideTransportMode({ hasRoomId: true, shareRequested: false })).toBe("relay");
  });

  it("tries the relay when the visitor explicitly asks to share", () => {
    expect(decideTransportMode({ hasRoomId: false, shareRequested: true })).toBe("relay");
  });
});
