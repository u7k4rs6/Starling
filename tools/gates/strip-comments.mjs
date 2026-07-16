/**
 * Blanks out comments (and, optionally, string/template contents) in JS/TS
 * source, so a grep-based gate matches code, not prose. "document", "self",
 * and "origin" are ordinary English words that show up constantly in
 * comments about a *document* editor with *self*-contained replicas and
 * *origin* pointers — without this, every gate here is one doc comment away
 * from a false positive. Blanked characters are replaced with spaces (not
 * deleted, newlines kept as newlines) so line/column positions and total
 * line count are unaffected.
 *
 * Known limitations, both acceptable for a tripwire over a small, known
 * codebase rather than a general-purpose JS parser: it does not parse regex
 * literals, so a regex containing `//` (e.g. `/https:\/\//`) can be misread
 * as the start of a line comment; and with `blankStrings: true`, a template
 * literal's `${...}` interpolations are blanked along with the rest of the
 * template, so a banned call written only inside an interpolation would be
 * missed.
 */
export function stripComments(source, { blankStrings = false } = {}) {
  let out = "";
  let i = 0;
  const n = source.length;
  let mode = "code";
  let stringChar = "";

  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];

    if (mode === "code") {
      if (c === "/" && c2 === "/") {
        mode = "line-comment";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        mode = "block-comment";
        out += "  ";
        i += 2;
        continue;
      }
      if (blankStrings && (c === '"' || c === "'" || c === "`")) {
        mode = "string";
        stringChar = c;
        out += " ";
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }

    if (mode === "line-comment") {
      out += c === "\n" ? "\n" : " ";
      if (c === "\n") mode = "code";
      i += 1;
      continue;
    }

    if (mode === "block-comment") {
      if (c === "*" && c2 === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    // mode === "string" (only reachable when blankStrings is true)
    if (c === "\\") {
      out += "  ";
      i += 2;
      continue;
    }
    if (c === stringChar) {
      mode = "code";
      out += " ";
      i += 1;
      continue;
    }
    out += c === "\n" ? "\n" : " ";
    i += 1;
  }

  return out;
}

export function stripCommentsAndStrings(source) {
  return stripComments(source, { blankStrings: true });
}
