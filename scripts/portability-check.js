#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const trackedFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: repoRoot,
  encoding: "utf8",
}).split(/\r?\n/).filter(Boolean);

const currentUsername = String(process.env.USERNAME || process.env.USER || "").trim();
const legacyProjectName = "cyberboss-" + "deepseek-test";
const legacyWorkspaceName = "cyberboss-" + "deepseek-workspace";
const legacyStateName = "." + "cyberboss-" + "deepseek-test";

const checks = [
  { name: "windows-user-path", pattern: new RegExp("C:[\\\\/]+Users[\\\\/]+", "i") },
  { name: "legacy-project-dir", pattern: new RegExp(escapeRegExp(legacyProjectName), "i") },
  { name: "legacy-workspace-dir", pattern: new RegExp(escapeRegExp(legacyWorkspaceName), "i") },
  { name: "legacy-state-dir", pattern: new RegExp(escapeRegExp(legacyStateName), "i") },
];
if (currentUsername) {
  checks.push({ name: "current-username", pattern: new RegExp(escapeRegExp(currentUsername), "i") });
}

const findings = [];
for (const relativePath of trackedFiles) {
  if (isProbablyBinary(relativePath)) {
    continue;
  }
  const absolutePath = path.join(repoRoot, relativePath);
  let content = "";
  try {
    content = fs.readFileSync(absolutePath, "utf8");
  } catch {
    continue;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const check of checks) {
      if (check.pattern.test(line)) {
        findings.push({
          check: check.name,
          path: relativePath.replace(/\\/g, "/"),
          line: index + 1,
          text: line.trim().slice(0, 180),
        });
      }
    }
  }
}

if (findings.length) {
  console.error("Portability check failed:");
  for (const finding of findings) {
    console.error(`${finding.path}:${finding.line} [${finding.check}] ${finding.text}`);
  }
  process.exit(1);
}

console.log("Portability check passed.");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isProbablyBinary(relativePath) {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz)$/i.test(relativePath);
}
