import { describe, expect, it } from "vitest";
import { stripComments, stripCommentsAndStrings } from "./strip-comments.mjs";

describe("stripComments (comments only, strings preserved)", () => {
  it("blanks comments but leaves string contents intact", () => {
    const out = stripComments('const s = "keep document.title"; // drop document.title');
    // Only the occurrence inside the string literal should survive; the
    // one in the // comment should be gone.
    expect((out.match(/document/g) ?? []).length).toBe(1);
    expect(out).toMatch(/"keep document\.title"/);
  });
});

describe("stripCommentsAndStrings", () => {
  it("blanks a line comment but keeps code on the same line", () => {
    const out = stripCommentsAndStrings('const x = 1; // uses document.title\nconst y = 2;');
    expect(out).not.toMatch(/document/);
    expect(out).toMatch(/const x = 1;/);
    expect(out).toMatch(/const y = 2;/);
  });

  it("blanks a block comment, including doc comments about 'document class'", () => {
    const out = stripCommentsAndStrings(
      "/**\n * every document class inherits this\n */\nexport class Sequence {}"
    );
    expect(out).not.toMatch(/document/);
    expect(out).toMatch(/export class Sequence/);
  });

  it("blanks string and template literal contents", () => {
    const out = stripCommentsAndStrings('const s = "self destructs"; const t = `origin: ${x}`;');
    expect(out).not.toMatch(/self/);
    expect(out).not.toMatch(/origin/);
    // the ${x} interpolation braces/identifier are inside the template and
    // get blanked too — acceptable, since real code never lives only there.
  });

  it("does not blank real code", () => {
    const src = "if (a.deps.every((d) => seen.has(d))) integrate(op);";
    expect(stripCommentsAndStrings(src)).toBe(src);
  });

  it("handles escaped quotes inside strings without ending the string early", () => {
    const out = stripCommentsAndStrings('const s = "a \\"document\\" b"; document.title;');
    // the escaped-quote string is fully blanked...
    expect(out.split("document.title")[0]).not.toMatch(/document/);
    // ...but the real reference after the string survives.
    expect(out).toMatch(/document\.title/);
  });

  it("preserves line count (comments become blank lines of the same length class)", () => {
    const src = "a\n/* multi\nline */\nb";
    const out = stripCommentsAndStrings(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
  });
});
