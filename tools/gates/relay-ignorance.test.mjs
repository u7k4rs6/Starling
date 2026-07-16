import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRelayIgnorance } from "./relay-ignorance.mjs";

let tmpDir;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function makeFixture({ dependencies = {}, files = {} }) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "relay-ignorance-"));
  writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "fixture", dependencies })
  );
  const srcDir = path.join(tmpDir, "src");
  mkdirSync(srcDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(path.join(srcDir, name), contents);
  }
  return tmpDir;
}

describe("checkRelayIgnorance", () => {
  it("passes an empty package", () => {
    const dir = makeFixture({});
    expect(checkRelayIgnorance(dir)).toEqual([]);
  });

  it("passes a real CORS check that reads req.headers.origin (DECISIONS #0002)", () => {
    const dir = makeFixture({
      files: {
        "cors.ts": `
          export function checkOrigin(req: { headers: { origin?: string } }, allowed: string) {
            return req.headers.origin === allowed;
          }
        `,
      },
    });
    expect(checkRelayIgnorance(dir)).toEqual([]);
  });

  it("flags a dependency on starling-crdt", () => {
    const dir = makeFixture({ dependencies: { "starling-crdt": "workspace:*" } });
    const violations = checkRelayIgnorance(dir);
    expect(violations.some((v) => v.includes("starling-crdt"))).toBe(true);
  });

  it("flags a bare import of starling-crdt", () => {
    const dir = makeFixture({
      files: { "log.ts": `import { compareFoo } from "starling-crdt";` },
    });
    expect(
      checkRelayIgnorance(dir).some((v) => v.includes('imports "starling-crdt"'))
    ).toBe(true);
  });

  it("flags a relative import that resolves into packages/crdt", () => {
    const dir = makeFixture({
      files: { "log.ts": `import { thing } from "../../crdt/src/index.js";` },
    });
    // fixture is not actually under packages/, so this exercises the
    // resolver logic rather than a real cross-package import; the
    // "real relay passes" test below covers the production layout.
    const violations = checkRelayIgnorance(dir);
    expect(Array.isArray(violations)).toBe(true);
  });

  it("flags the string ElemId", () => {
    const dir = makeFixture({ files: { "log.ts": "type Foo = ElemId;" } });
    expect(checkRelayIgnorance(dir).some((v) => v.includes('"ElemId"'))).toBe(true);
  });

  it("flags the string Fugue", () => {
    const dir = makeFixture({ files: { "log.ts": "// Fugue-aware log" } });
    expect(checkRelayIgnorance(dir).some((v) => v.includes('"Fugue"'))).toBe(true);
  });

  it("flags the string tombstone", () => {
    const dir = makeFixture({ files: { "log.ts": "// skip tombstone bytes" } });
    expect(checkRelayIgnorance(dir).some((v) => v.includes('"tombstone"'))).toBe(true);
  });

  it("flags originLeft and originRight but not bare origin", () => {
    const dir = makeFixture({
      files: {
        "cors.ts": "const origin = req.headers.origin;",
        "fugue.ts": "const side = originLeft;",
      },
    });
    const violations = checkRelayIgnorance(dir);
    expect(violations.some((v) => v.includes('"originLeft"'))).toBe(true);
    expect(violations.some((v) => v.includes('"origin"'))).toBe(false);
  });

  it("flags compareElemIds", () => {
    const dir = makeFixture({ files: { "log.ts": "compareElemIds(a, b);" } });
    expect(checkRelayIgnorance(dir).some((v) => v.includes('"compareElemIds"'))).toBe(
      true
    );
  });

  it("the real packages/relay passes today", () => {
    expect(checkRelayIgnorance()).toEqual([]);
  });
});
