"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildCatalog } = require("../scripts/audit/catalog-metering");

const script = path.join(__dirname, "../scripts/audit/catalog-metering.js");
const baseline = path.join(__dirname, "fixtures/catalog-metering-baseline.json");
function run(args = [], env = {}) { return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } }); }
function assertFailedClosed(result, message) { assert.equal(result.error, undefined, `process never ran: ${result.error}`); assert.notEqual(result.status, null, "process never ran: spawnSync returned status null"); assert.notEqual(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`); }
function assertNoPrivateText(value) { for (const pattern of [/[A-Za-z]:[\\/]/, /\/home\/[A-Za-z0-9_.-]+/, /\/Users\/[A-Za-z0-9_.-]+/, /(sk|ghp|xoxb)-[A-Za-z0-9_-]{8,}/]) assert.doesNotMatch(value, pattern); if (process.env.USERNAME) assert.equal(value.includes(process.env.USERNAME), false); }

test("catalog has exactly four categories, stable metrics and no fictional result ceiling", () => {
  const first = run([], { CB_AUDIT_SECRET: "sk-not-output-12345678" }); const second = run(); assert.equal(first.status, 0); assert.equal(first.stdout, second.stdout);
  const catalog = JSON.parse(first.stdout); assert.deepEqual(Object.keys(catalog.categories), ["memory", "tool", "mcp", "skill"]);
  for (const item of catalog.items) { assert.ok(Number.isInteger(item.schema_chars) && item.schema_chars >= 0); assert.ok(Number.isInteger(item.schema_bytes) && item.schema_bytes >= item.schema_chars); assert.equal(item.has_max_result_bytes, false); assert.equal(item.max_result_bytes, null); }
  for (const name of ["memory_lookup", "memory_note", "cyberboss_reminder", "cyberboss_diary_append", "cyberboss_system_send", "cyberboss_time"]) { const item = catalog.items.find((entry) => entry.name === name); assert.ok(item); assert.equal(item.hidden, false); assert.equal(item.deprecated, false); }
  assertNoPrivateText(first.stdout);
  assertNoPrivateText(fs.readFileSync(baseline, "utf8"));
});

test("baseline check is repeatable and fails closed when fixture changes", () => {
  assert.equal(run(["--check"]).status, 0);
  const original = fs.readFileSync(baseline, "utf8");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-metering-"));
  const altered = path.join(tempDir, "baseline.json");
  try { fs.writeFileSync(altered, `${original}x`, "utf8"); assertFailedClosed(run(["--check", "--baseline", altered]), "changed baseline must fail closed"); } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
});

test("an unclassified injected entry fails rather than entering a fallback category", () => {
  assert.throws(() => buildCatalog({ projectTools: [{ name: "bad", topics: null, inputSchema: {} }] , aliases: { nope: { name: "missing" } }, extraHosts: [] }), /Unclassified catalog entry/);
});
