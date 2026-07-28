const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const DOCS_DIR = path.join(ROOT, "docs");
const ALLOWED = new Set(["active", "historical", "superseded", "completed", "supplemental"]);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (rel === "docs/images" || rel.startsWith("docs/images/")) continue;
    if (entry.isDirectory()) {
      walk(full, acc);
      continue;
    }
    if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

const offenders = [];
const files = walk(DOCS_DIR);

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(0, 15);
  const statusLine = lines.find((line) => line.includes("Status:"));
  if (!statusLine) {
    offenders.push(rel + ": missing Status: line in first 15 lines");
    continue;
  }
  const match = statusLine.match(/Status:\s*([A-Za-z]+)/);
  if (!match) {
    offenders.push(rel + ": malformed Status: line");
    continue;
  }
  const status = match[1].toLowerCase();
  if (!ALLOWED.has(status)) offenders.push(rel + ": invalid status '" + match[1] + "'");
}

if (offenders.length) {
  console.error("Document status block check failed:");
  for (const offender of offenders) console.error("- " + offender);
  process.exit(1);
}

console.log("Document status block check passed (" + files.length + " files).");
