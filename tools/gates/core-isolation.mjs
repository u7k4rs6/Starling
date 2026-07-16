import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSourceFiles } from "./walk.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PACKAGE_DIR = path.join(REPO_ROOT, "packages/crdt");

// docs/DECISIONS.md #0001: new Date(/crypto.* were added after the original
// list let ReplicaId self-assignment slip through a Math.random() grep.
const BANNED_PATTERNS = [
  { name: "Date.now()", re: /\bDate\.now\s*\(/ },
  { name: "new Date(", re: /\bnew\s+Date\s*\(/ },
  { name: "Math.random()", re: /\bMath\.random\s*\(/ },
  { name: "performance.now()", re: /\bperformance\.now\s*\(/ },
  { name: "crypto.randomUUID()", re: /\bcrypto\.randomUUID\b/ },
  { name: "crypto.getRandomValues()", re: /\bcrypto\.getRandomValues\b/ },
  { name: "DOM global: window", re: /\bwindow\b/ },
  { name: "DOM global: document", re: /\bdocument\b/ },
  { name: "DOM global: navigator", re: /\bnavigator\b/ },
  { name: "DOM global: localStorage", re: /\blocalStorage\b/ },
  { name: "DOM global: sessionStorage", re: /\bsessionStorage\b/ },
  { name: "DOM global: indexedDB", re: /\bindexedDB\b/ },
  { name: "DOM global: XMLHttpRequest", re: /\bXMLHttpRequest\b/ },
];

export function checkCoreIsolation(packageDir = DEFAULT_PACKAGE_DIR) {
  const violations = [];

  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const deps = pkgJson.dependencies ?? {};
  const depNames = Object.keys(deps);
  if (depNames.length > 0) {
    violations.push(
      `package.json "dependencies" is not empty: ${depNames.join(", ")}`
    );
  }

  for (const file of listSourceFiles(path.join(packageDir, "src"))) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(packageDir, file);
    for (const { name, re } of BANNED_PATTERNS) {
      if (re.test(text)) {
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
