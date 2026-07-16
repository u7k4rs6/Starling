import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCoreIsolation } from "./core-isolation.mjs";

let tmpDir;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function makeFixture({ dependencies = {}, files = {} }) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "core-isolation-"));
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

describe("checkCoreIsolation", () => {
  it("passes an empty package with no source and no dependencies", () => {
    const dir = makeFixture({});
    expect(checkCoreIsolation(dir)).toEqual([]);
  });

  it("passes clean source that injects time and randomness", () => {
    const dir = makeFixture({
      files: {
        "index.ts": `
          export function tick(now: () => number, rand: () => number) {
            return now() + rand();
          }
        `,
      },
    });
    expect(checkCoreIsolation(dir)).toEqual([]);
  });

  it("flags a non-empty dependencies block", () => {
    const dir = makeFixture({ dependencies: { "left-pad": "^1.0.0" } });
    const violations = checkCoreIsolation(dir);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/dependencies.*left-pad/);
  });

  it("flags Date.now()", () => {
    const dir = makeFixture({ files: { "clock.ts": "const t = Date.now();" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("Date.now()"))).toBe(true);
  });

  it("flags new Date(", () => {
    const dir = makeFixture({ files: { "clock.ts": "const t = new Date();" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("new Date("))).toBe(true);
  });

  it("flags Math.random()", () => {
    const dir = makeFixture({ files: { "id.ts": "const r = Math.random();" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("Math.random()"))).toBe(true);
  });

  it("flags performance.now()", () => {
    const dir = makeFixture({ files: { "clock.ts": "const t = performance.now();" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("performance.now()"))).toBe(true);
  });

  it("flags crypto.randomUUID() — the ReplicaId self-assignment case (DECISIONS #0001)", () => {
    const dir = makeFixture({
      files: {
        "sequence.ts": `
          export class Sequence {
            replica = crypto.randomUUID();
          }
        `,
      },
    });
    const violations = checkCoreIsolation(dir);
    expect(violations.some((v) => v.includes("crypto.randomUUID()"))).toBe(true);
  });

  it("flags crypto.getRandomValues()", () => {
    const dir = makeFixture({
      files: { "id.ts": "crypto.getRandomValues(new Uint8Array(16));" },
    });
    expect(
      checkCoreIsolation(dir).some((v) => v.includes("crypto.getRandomValues()"))
    ).toBe(true);
  });

  it("flags DOM globals", () => {
    const dir = makeFixture({
      files: { "leak.ts": "document.title = 'oops';" },
    });
    expect(checkCoreIsolation(dir).some((v) => v.includes("DOM global: document"))).toBe(
      true
    );
  });

  it("reports one violation per offending file, not just the first", () => {
    const dir = makeFixture({
      files: {
        "a.ts": "Date.now();",
        "b.ts": "Math.random();",
      },
    });
    const violations = checkCoreIsolation(dir);
    expect(violations).toHaveLength(2);
  });

  it("the real packages/crdt passes today", () => {
    expect(checkCoreIsolation()).toEqual([]);
  });
});
