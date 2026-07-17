import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.mjs";
import { listSourceFiles } from "./walk.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PACKAGE_DIR = path.join(REPO_ROOT, "packages/relay");
const CRDT_PACKAGE_DIR = path.join(REPO_ROOT, "packages/crdt");
const CRDT_PACKAGE_NAME = "starling-crdt";

// docs/DECISIONS.md #0002: bare "origin" was dropped because a correct relay
// reads req.headers.origin for CORS (03-SECURITY.md §2.3). originLeft/
// originRight (Fugue's side field, ARCH §2.3) and compareElemIds (ARCH §2.1)
// have no legitimate relay use, so they stay distinctive tripwires.
const BANNED_STRINGS = [
  "ElemId",
  "Fugue",
  "tombstone",
  "originLeft",
  "originRight",
  "compareElemIds",
];

const IMPORT_SPECIFIER_RE =
  /(?:from|require\()\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsFromCrdt(file, text) {
  const specifiers = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
    specifiers.push(match[1] ?? match[2]);
  }

  const violations = [];
  for (const specifier of specifiers) {
    if (specifier === CRDT_PACKAGE_NAME || specifier.startsWith(`${CRDT_PACKAGE_NAME}/`)) {
      violations.push(`imports "${specifier}" (the crdt package) directly`);
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(file), specifier);
      const relToCrdt = path.relative(CRDT_PACKAGE_DIR, resolved);
      if (relToCrdt === "" || (!relToCrdt.startsWith("..") && !path.isAbsolute(relToCrdt))) {
        violations.push(`imports "${specifier}", which resolves into packages/crdt`);
      }
    }
  }
  return violations;
}

export function checkRelayIgnorance(packageDir = DEFAULT_PACKAGE_DIR) {
  const violations = [];

  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
  if (CRDT_PACKAGE_NAME in deps) {
    violations.push(`package.json depends on "${CRDT_PACKAGE_NAME}"`);
  }

  for (const file of listSourceFiles(path.join(packageDir, "src"))) {
    const text = readFileSync(file, "utf8");
    // docs/DECISIONS.md #0008: blank comments (not strings — the import
    // specifier and any banned string this is meant to catch are both
    // string literals in real code) so a comment explaining why a concept
    // is *absent* doesn't trip the gate meant to catch its *presence*.
    const codeText = stripComments(text);
    const rel = path.relative(packageDir, file);

    for (const v of importsFromCrdt(file, codeText)) {
      violations.push(`${rel}: ${v}`);
    }

    for (const needle of BANNED_STRINGS) {
      if (codeText.includes(needle)) {
        violations.push(`${rel}: contains banned string "${needle}"`);
      }
    }
  }

  return violations;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = checkRelayIgnorance();
  if (violations.length > 0) {
    console.error("Relay ignorance gate FAILED (packages/relay):");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log("Relay ignorance gate passed.");
}
