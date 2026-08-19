const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const scriptPath = path.join(__dirname, "..", "scripts", "secret_audit_scan.py");

// The planted value must match aws_access_key at scan time but must never
// appear contiguously in this source file, or the real repository's own gate
// would flag this test forever (same trick as secret-audit-credential-in-url).
const plantedSecret = ["AKIA", "QQQQQQQQQQQQQQQQ"].join("");

function git(cwd, ...args) {
  const result = spawnSync(
    "git",
    ["-c", "user.email=gate@test", "-c", "user.name=gate-test", ...args],
    { cwd, encoding: "utf8" }
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function scan(cwd, ...args) {
  return spawnSync("python", [scriptPath, ...args], { cwd, encoding: "utf8" });
}

// One fixture, three assertions against it:
// repo with commit A (clean, "on origin"), commit B (planted secret), commit C
// (clean, on top of B). origin/main is faked with update-ref -- no network.
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-gate-"));
  git(dir, "init", "-q");

  fs.writeFileSync(path.join(dir, "clean.txt"), "nothing to see\n");
  git(dir, "add", "clean.txt");
  git(dir, "commit", "-q", "-m", "A: clean baseline");
  const shaA = git(dir, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(dir, "oops.txt"), `key=${plantedSecret}\n`);
  git(dir, "add", "oops.txt");
  git(dir, "commit", "-q", "-m", "B: plants a secret");
  const shaB = git(dir, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(dir, "more.txt"), "still nothing\n");
  git(dir, "add", "more.txt");
  git(dir, "commit", "-q", "-m", "C: clean on top");
  const shaC = git(dir, "rev-parse", "HEAD");

  return { dir, shaA, shaB, shaC };
}

test("incremental scan flags a secret in the commits being pushed", () => {
  const { dir, shaA, shaB } = buildFixture();
  git(dir, "update-ref", "refs/remotes/origin/main", shaA);
  const result = scan(dir, "--push-tip", shaB);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /aws_access_key/);
});

test("incremental scan skips objects origin already has", () => {
  const { dir, shaB, shaC } = buildFixture();
  // The secret is now "already public": origin/main points past it.
  git(dir, "update-ref", "refs/remotes/origin/main", shaB);
  const result = scan(dir, "--push-tip", shaC);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Secret audit passed/);
});

test("full scan still sees the whole history (CI backstop unchanged)", () => {
  const { dir, shaB } = buildFixture();
  git(dir, "update-ref", "refs/remotes/origin/main", shaB);
  const result = scan(dir);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /aws_access_key/);
});

test("incremental scan passes when everything pushed is already on origin", () => {
  const { dir, shaB, shaC } = buildFixture();
  git(dir, "update-ref", "refs/remotes/origin/main", shaC);
  const result = scan(dir, "--push-tip", shaB);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
