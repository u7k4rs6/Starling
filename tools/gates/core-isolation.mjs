import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsAndStrings } from "./strip-comments.mjs";
import { listSourceFiles } from "./walk.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PACKAGE_DIR = path.join(REPO_ROOT, "packages/crdt");

// docs/DECISIONS.md #0001: new Date(/crypto.* were added after the original
// list let ReplicaId self-assignment slip through a Math.random() grep.
//
// docs/DECISIONS.md #0004: packages/crdt/tsconfig.json now sets
// lib: ["ES2022"] and types: [], which turns window/document/fetch/
// localStorage/process/Buffer/setTimeout/etc into compile errors — a
// stronger, self-maintaining version of the DOM-global checks below. This
// list stays anyway, expanded, as a second gate that doesn't depend on that
// tsconfig setting staying correct: setTimeout/setInterval (bypasses the
// virtual clock in ARCH §4 by scheduling against real time, not reading it),
// fetch/WebSocket (I/O the core must never perform), process.hrtime/
// process.uptime (more ambient clocks), requestAnimationFrame, and self/
// globalThis (indirection that could reach any of the above through a
// property access the other patterns wouldn't match).
const BANNED_PATTERNS = [
  { name: "Date.now()", re: /\bDate\.now\s*\(/ },
  { name: "new Date(", re: /\bnew\s+Date\s*\(/ },
  { name: "Math.random()", re: /\bMath\.random\s*\(/ },
  { name: "performance.now()", re: /\bperformance\.now\s*\(/ },
  { name: "crypto.randomUUID()", re: /\bcrypto\.randomUUID\b/ },
  { name: "crypto.getRandomValues()", re: /\bcrypto\.getRandomValues\b/ },
  { name: "setTimeout()", re: /\bsetTimeout\s*\(/ },
  { name: "setInterval()", re: /\bsetInterval\s*\(/ },
  { name: "fetch()", re: /\bfetch\s*\(/ },
  { name: "WebSocket", re: /\bWebSocket\b/ },
  { name: "process.hrtime()", re: /\bprocess\.hrtime\b/ },
  { name: "process.uptime()", re: /\bprocess\.uptime\b/ },
  { name: "requestAnimationFrame()", re: /\brequestAnimationFrame\s*\(/ },
  { name: "self", re: /\bself\b/ },
  { name: "globalThis", re: /\bglobalThis\b/ },
  // docs/DECISIONS.md #0008: string-blanking hides a banned call's text if
  // it's handed to eval/Function as a string argument, so the mechanism
  // itself is banned outright instead — eval in a CRDT core is a red flag
  // on its own merits regardless.
  { name: "eval(", re: /\beval\s*\(/ },
  { name: "new Function(", re: /\bnew\s+Function\s*\(/ },
  { name: "DOM global: window", re: /\bwindow\b/ },
  { name: "DOM global: document", re: /\bdocument\b/ },
  { name: "DOM global: navigator", re: /\bnavigator\b/ },
  { name: "DOM global: localStorage", re: /\blocalStorage\b/ },
  { name: "DOM global: sessionStorage", re: /\bsessionStorage\b/ },
  { name: "DOM global: indexedDB", re: /\bindexedDB\b/ },
  { name: "DOM global: XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
];

const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

export function checkCoreIsolation(packageDir = DEFAULT_PACKAGE_DIR) {
  const violations = [];

  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  for (const field of DEPENDENCY_FIELDS) {
    const depNames = Object.keys(pkgJson[field] ?? {});
    if (depNames.length > 0) {
      violations.push(`package.json "${field}" is not empty: ${depNames.join(", ")}`);
    }
  }

  const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

  for (const file of listSourceFiles(path.join(packageDir, "src"))) {
    if (TEST_FILE_RE.test(file)) continue; // docs/DECISIONS.md #0004/#0007: tests are exempt
    const text = readFileSync(file, "utf8");
    // docs/DECISIONS.md #0008/#0009: scan code, not prose — "document" and
    // "self" are ordinary English words this project's own comments use
    // constantly, describing a document editor with self-contained replicas.
    const codeOnly = stripCommentsAndStrings(text);
    const rel = path.relative(packageDir, file);
    for (const { name, re } of BANNED_PATTERNS) {
      if (re.test(codeOnly)) {
        violations.push(`${rel}: forbidden use of ${name}`);
      }
    }
  }

  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkCoreIsolation();
  if (violations.length > 0) {
    console.error("Core isolation gate FAILED (packages/crdt):");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log("Core isolation gate passed.");
}
