#!/usr/bin/env node
const path = require("path");
const { loadReleaseDescriptor, rollbackReleaseDescriptor } = require("../../src/orchestration/release-descriptor");

const [command, fileArg] = process.argv.slice(2);
const filePath = path.resolve(fileArg || path.join(__dirname, "..", "..", "..", "deployment", "current.json"));
if (command === "validate") {
  const descriptor = loadReleaseDescriptor(filePath, { requireExistingPaths: process.argv.includes("--require-existing") });
  console.log(JSON.stringify({ ok: true, active_release_id: descriptor.active_release_id }));
} else if (command === "rollback") {
  const descriptor = rollbackReleaseDescriptor(filePath);
  console.log(JSON.stringify({ ok: true, active_release_id: descriptor.active_release_id }));
} else {
  console.error("Usage: release-control.js <validate|rollback> [current.json] [--require-existing]");
  process.exit(2);
}
