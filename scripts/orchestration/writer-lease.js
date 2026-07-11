#!/usr/bin/env node
const path = require("path");
const { acquireWriterLease, clearStaleWriterLease, releaseWriterLease } = require("../../src/orchestration/writer-lease");

const [command, fileArg] = process.argv.slice(2);
const filePath = path.resolve(fileArg || path.join(__dirname, "..", "..", "..", "MEMORY_WRITER_LEASE.json"));
const args = Object.fromEntries(process.argv.slice(4).filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => arg.slice(2).split(/=(.*)/s, 2)));
if (command === "acquire") {
  console.log(JSON.stringify(acquireWriterLease(filePath, args), null, 2));
} else if (command === "release") {
  releaseWriterLease(filePath, args.lease_id);
  console.log(JSON.stringify({ ok: true }));
} else if (command === "clear-stale") {
  clearStaleWriterLease(filePath, { confirm: process.argv.includes("--confirm") });
  console.log(JSON.stringify({ ok: true }));
} else {
  console.error("Usage: writer-lease.js <acquire|release|clear-stale> [file] [--field=value] [--confirm]");
  process.exit(2);
}
