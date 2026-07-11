const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readJson } = require("./atomic-json");

const REQUIRED_LEASE_FIELDS = ["writer", "model", "phase", "branch", "worktree", "base_sha"];

function acquireWriterLease(filePath, details) {
  for (const field of REQUIRED_LEASE_FIELDS) {
    if (typeof details[field] !== "string" || !details[field].trim()) {
      throw new Error(`Missing writer lease field: ${field}`);
    }
  }
  const destination = path.resolve(filePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const ownerPid = details.owner_pid === undefined ? process.pid : Number(details.owner_pid);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error("owner_pid must be a positive integer");
  const lease = {
    schema_version: 1,
    lease_id: crypto.randomUUID(),
    owner_pid: ownerPid,
    acquired_at: new Date().toISOString(),
    ...Object.fromEntries(REQUIRED_LEASE_FIELDS.map((field) => [field, details[field]])),
  };
  let handle;
  try {
    handle = fs.openSync(destination, "wx", 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
    fs.fsyncSync(handle);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Writer lease already held: ${destination}`);
    }
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  return lease;
}

function releaseWriterLease(filePath, leaseId) {
  const current = readJson(filePath);
  if (!leaseId || current.lease_id !== leaseId) throw new Error("Writer lease identity mismatch; refusing release");
  fs.unlinkSync(filePath);
}

function clearStaleWriterLease(filePath, options = {}) {
  if (!options.confirm) throw new Error("Manual stale lease cleanup requires confirm=true");
  const lease = readJson(filePath);
  const isAlive = (options.isProcessAlive || defaultIsProcessAlive)(lease.owner_pid);
  if (isAlive) throw new Error(`Writer process ${lease.owner_pid} is still alive; refusing stale cleanup`);
  fs.unlinkSync(filePath);
  return lease;
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

module.exports = { acquireWriterLease, clearStaleWriterLease, releaseWriterLease };
