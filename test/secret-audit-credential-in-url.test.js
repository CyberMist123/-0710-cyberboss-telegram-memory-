const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const scriptPath = path.join(__dirname, "..", "scripts", "secret_audit_scan.py");

test("secret audit allows exact CI token placeholders in credential URLs", () => {
  const result = spawnSync("python", [scriptPath, "--check-url", "https://x-access-token:${GH_TOKEN}@github.com/owner/repo.git"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ALLOWED placeholder credential is intentionally ignored/i);
});

test("secret audit still flags real-looking credential URLs", () => {
  const credential = ["ghp", "real", "looking", "fixed", "value"].join("_");
  const blockedUrl = [
    "https",
    "://",
    "x-access-",
    "token",
    ":",
    credential,
    "@github.com/owner/repo.git",
  ].join("");
  const result = spawnSync("python", [scriptPath, "--check-url", blockedUrl], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /BLOCKED credential_in_url detected/i);
});
