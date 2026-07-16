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

function makeFixture({ dependencies = {}, peerDependencies, optionalDependencies, files = {} }) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "core-isolation-"));
  writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ name: "fixture", dependencies, peerDependencies, optionalDependencies })
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

  it("flags a non-empty peerDependencies block", () => {
    const dir = makeFixture({ peerDependencies: { react: "^18.0.0" } });
    const violations = checkCoreIsolation(dir);
    expect(violations.some((v) => v.match(/peerDependencies.*react/))).toBe(true);
  });

  it("flags a non-empty optionalDependencies block (ships to consumers)", () => {
    const dir = makeFixture({ optionalDependencies: { fsevents: "^2.0.0" } });
    const violations = checkCoreIsolation(dir);
    expect(violations.some((v) => v.match(/optionalDependencies.*fsevents/))).toBe(true);
  });

  it("flags setTimeout — real hole: schedules against real time instead of the sim's virtual clock (ARCH §4)", () => {
    const dir = makeFixture({ files: { "retry.ts": "setTimeout(() => {}, 100);" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("setTimeout()"))).toBe(true);
  });

  it("flags setInterval", () => {
    const dir = makeFixture({ files: { "retry.ts": "setInterval(() => {}, 100);" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("setInterval()"))).toBe(true);
  });

  it("flags fetch — I/O in the core", () => {
    const dir = makeFixture({ files: { "sync.ts": "fetch('/ops');" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("fetch()"))).toBe(true);
  });

  it("flags WebSocket", () => {
    const dir = makeFixture({ files: { "sync.ts": "new WebSocket('wss://x');" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("WebSocket"))).toBe(true);
  });

  it("flags process.hrtime()", () => {
    const dir = makeFixture({ files: { "clock.ts": "process.hrtime();" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("process.hrtime()"))).toBe(true);
  });

  it("flags process.uptime()", () => {
    const dir = makeFixture({ files: { "clock.ts": "process.uptime();" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("process.uptime()"))).toBe(true);
  });

  it("flags requestAnimationFrame", () => {
    const dir = makeFixture({ files: { "tick.ts": "requestAnimationFrame(() => {});" } });
    expect(
      checkCoreIsolation(dir).some((v) => v.includes("requestAnimationFrame()"))
    ).toBe(true);
  });

  it("flags self as an indirection vector", () => {
    const dir = makeFixture({ files: { "leak.ts": "self.setTimeout(() => {}, 0);" } });
    expect(checkCoreIsolation(dir).some((v) => v.includes('"self"') || v.endsWith("self"))).toBe(
      true
    );
  });

  it("flags globalThis as an indirection vector", () => {
    const dir = makeFixture({ files: { "leak.ts": "globalThis.crypto.randomUUID();" } });
    const violations = checkCoreIsolation(dir);
    expect(violations.some((v) => v.includes("globalThis"))).toBe(true);
  });

  it("flags eval() even when it's the only way a banned call would be visible (DECISIONS #0008)", () => {
    // String-blanking (the fix for #0008) hides the text "Date.now()" once
    // it's inside a string literal — eval must be banned as a mechanism,
    // not detected by trying to see through it.
    const dir = makeFixture({ files: { "leak.ts": 'eval("Date.now()");' } });
    expect(checkCoreIsolation(dir).some((v) => v.includes("eval("))).toBe(true);
  });

  it("flags new Function( for the same reason", () => {
    const dir = makeFixture({
      files: { "leak.ts": 'const f = new Function("return Math.random()");' },
    });
    expect(checkCoreIsolation(dir).some((v) => v.includes("new Function("))).toBe(true);
  });

  it("does not flag banned patterns in *.test.ts files — tests are exempt (DECISIONS #0004/#0007)", () => {
    const dir = makeFixture({
      files: { "sequence.test.ts": "const seed = Math.random(); crypto.randomUUID();" },
    });
    expect(checkCoreIsolation(dir)).toEqual([]);
  });

  it("does not flag banned patterns in *.spec.ts files either", () => {
    const dir = makeFixture({
      files: { "sequence.spec.ts": "setTimeout(() => {}, 0);" },
    });
    expect(checkCoreIsolation(dir)).toEqual([]);
  });

  it("still flags the same banned pattern in a same-named non-test file", () => {
    // Sanity check that the exemption is about the .test./.spec. suffix,
    // not about matching "sequence" or any other coincidental substring.
    const dir = makeFixture({
      files: { "sequence.ts": "const seed = Math.random();" },
    });
    expect(checkCoreIsolation(dir).some((v) => v.includes("Math.random()"))).toBe(true);
  });

  it("the real packages/crdt passes today", () => {
    expect(checkCoreIsolation()).toEqual([]);
  });
});
