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
const knownPrivateNames = ["程言", "安安", "绋嬭", "瀹夊畨"];
const knownOldUsernames = ["anan"];

const checks = [
  { name: "windows-user-path", pattern: /[A-Za-z]:[\\/]+Users[\\/]+/i },
  { name: "windows-drive-path", pattern: /\b[A-Za-z]:[\\/](?![\\/])/ },
  { name: "unix-home-path", pattern: /\/home\/(?!<USER>|<HOME>)[A-Za-z0-9_.-]+/ },
  { name: "legacy-project-dir", pattern: new RegExp(escapeRegExp(legacyProjectName), "i") },
  { name: "legacy-workspace-dir", pattern: new RegExp(escapeRegExp(legacyWorkspaceName), "i") },
  { name: "legacy-state-dir", pattern: new RegExp(escapeRegExp(legacyStateName), "i") },
  { name: "os-homedir-fallback", pattern: /os\.homedir\(\)/ },
  { name: "process-cwd-fallback", pattern: /process\.cwd\(\)/ },
  { name: "private-role-name", pattern: new RegExp(knownPrivateNames.map(escapeRegExp).join("|")) },
  { name: "old-username", pattern: new RegExp(`\\b(?:${knownOldUsernames.map(escapeRegExp).join("|")})\\b`, "i") },
];

if (currentUsername) {
  checks.push({ name: "current-username", pattern: new RegExp(escapeRegExp(currentUsername), "i") });
}

const findings = [];
for (const relativePath of trackedFiles) {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  if (normalizedPath.startsWith("vendor/")) {
    continue;
  }
  if (isProbablyBinary(normalizedPath)) {
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
    if (isAllowedPortabilityFixture(normalizedPath, line) || isPortabilityCheckDefinition(normalizedPath)) {
      continue;
    }
    for (const check of checks) {
      if (check.pattern.test(line)) {
        findings.push({
          check: check.name,
          path: normalizedPath,
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
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|pyc)$/i.test(relativePath);
}

function isAllowedPortabilityFixture(relativePath, line) {
  return relativePath.startsWith("test/") && /PORTABILITY_FIXTURE/.test(line);
}

function isPortabilityCheckDefinition(relativePath) {
  return relativePath === "scripts/portability-check.js";
}
