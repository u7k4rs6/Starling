/**
 * A room id is a capability: the relay has no auth (SECURITY §1), so whoever
 * holds the link can read and write that room. That forces three things.
 *
 * 1. The id is 128 bits from a CSPRNG, never sequential and never guessable,
 *    so the namespace cannot be enumerated to read strangers' documents.
 * 2. It is formatted in the 8-4-4-4-12 hex shape the relay validates. The relay
 *    checks the shape, not the RFC-4122 version and variant nibbles, so all 128
 *    bits stay random rather than the 122 a v4 UUID would leave.
 * 3. It travels in the URL fragment, never the query string. A fragment is not
 *    sent in any HTTP request, so the id stays out of the GitHub Pages access
 *    logs and out of referrer headers to third parties. It does NOT hide the id
 *    from the relay: the relay receives it as a path segment in
 *    `POST /doc/:id`, and the host (Render) logs request paths, so a room id is
 *    visible to whoever runs the relay. That is unavoidable, since the relay
 *    needs the id to route, and acceptable, since the relay is exactly the party
 *    a room is being shared through.
 */
const ROOM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function generateRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isValidRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id);
}

/** Build the fragment that carries a room id, e.g. `#room=<id>`. */
export function roomFragment(roomId: string): string {
  return `#room=${roomId}`;
}

/** Read a room id out of a URL fragment (`location.hash`), or null if there
 * isn't a well-formed one. A malformed id is treated as absent rather than
 * trusted, the same way the relay rejects a bad doc id outright. */
export function roomIdFromFragment(fragment: string): string | null {
  const hash = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const id = new URLSearchParams(hash).get("room");
  return id !== null && isValidRoomId(id) ? id : null;
}

export type TransportMode = "local" | "relay";

/**
 * Which transport to set up on load. The default is local-only, deliberately:
 * the relay is not woken on an ordinary visit, so a sleeping free instance
 * stays asleep and inside its instance-hour budget. The relay is attempted
 * only when the visitor arrived through a shared link (a room id in the URL) or
 * explicitly asked to share. A "relay" result still means "try the relay, and
 * fall back to local if it is unreachable", never "fail if the relay is down".
 */
export function decideTransportMode(input: { hasRoomId: boolean; shareRequested: boolean }): TransportMode {
  return input.hasRoomId || input.shareRequested ? "relay" : "local";
}
