"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "../scripts/audit/cli-capability-snapshot.js");
const fake = path.join(__dirname, "helpers/fake-claude-help-cli.cmd");
const sample = require("./fixtures/cli-capability-snapshot.sample.json");
function execute(args = [], env = {}) {
  return spawnSync(process.execPath, [script, "--bin", fake, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}
function assertFailedClosed(result, message) {
  assert.equal(result.error, undefined, `process never ran: ${result.error}`);
  assert.notEqual(result.status, null, "process never ran: spawnSync returned status null");
  assert.notEqual(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
}

test("fake CLI snapshot has the specified shape and never emits path, transcript, or env values", () => {
  const result = execute([], { CB_FAKE_SECRET: "sk-not-output-12345678" });
  assert.equal(result.status, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.cli_version, "0.0.0-fake");
  assert.deepEqual(value, sample);
  assert.match(value.help_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(value.missing_flags, []);
  assert.deepEqual(value.observed_optional_flags, ["--config-dir", "--output-style"]);
  assert.equal(result.stdout.includes("sk-not-output-12345678"), false);
  assert.doesNotMatch(result.stdout, /[A-Za-z]:[\\/]/);
  assert.doesNotMatch(JSON.stringify(sample), /[A-Za-z]:[\\/]/);
  assert.doesNotMatch(JSON.stringify(sample), /(sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}/);
});

test("missing required flag is reported and fail-on-missing fails closed", () => {
  const normal = execute([], { CB_FAKE_HELP_MODE: "missing-strict" });
  assert.equal(normal.status, 0);
  assert.ok(JSON.parse(normal.stdout).missing_flags.includes("--strict-mcp-config"));
  assertFailedClosed(execute(["--fail-on-missing"], { CB_FAKE_HELP_MODE: "missing-strict" }), "missing flag must fail with --fail-on-missing");
});
