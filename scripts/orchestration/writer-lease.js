#!/usr/bin/env node
const path = require("path");
const { acquireWriterLease, clearStaleWriterLease, releaseWriterLease } = require("../../src/orchestration/writer-lease");

const [command, fileArg] = process.argv.slice(2);
const filePath = path.resolve(fileArg || path.join(__dirname, "..", "..", "..", "MEMORY_WRITER_LEASE.json"));
const args = Object.fromEntries(process.argv.slice(4).filter((arg) => arg.startsWith("--") && arg.includes("=")).map((arg) => arg.slice(2).split(/=(.*)/s, 2)));
if (command === "acquire") {
  console.log(JSON.stringify(acquireWriterLease(filePath, args, {
    recoverStale: process.argv.includes("--recover-stale"),
    staleArchiveDir: args.stale_archive_dir,
  }), null, 2));
} else if (command === "release") {
  releaseWriterLease(filePath, args.lease_id);
  console.log(JSON.stringify({ ok: true }));
} else if (command === "clear-stale") {
  const lease = clearStaleWriterLease(filePath, {
    confirm: process.argv.includes("--confirm"),
    archiveDir: args.stale_archive_dir,
  });
  console.log(JSON.stringify({ ok: true, cleared_lease_id: lease.lease_id, owner_pid: lease.owner_pid }));
} else {
  console.error("Usage: writer-lease.js <acquire|release|clear-stale> [file] [--field=value] [--confirm] [--recover-stale] [--stale_archive_dir=path]");
  process.exit(2);
}
