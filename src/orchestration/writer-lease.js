const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readJson } = require("./atomic-json");

const REQUIRED_LEASE_FIELDS = ["writer", "model", "phase", "branch", "worktree", "base_sha"];

function acquireWriterLease(filePath, details, options = {}) {
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

  let recoveryAttempted = false;
  while (true) {
    let handle;
    try {
      handle = fs.openSync(destination, "wx", 0o600);
      fs.writeFileSync(handle, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
      fs.fsyncSync(handle);
      return lease;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!options.recoverStale || recoveryAttempted) {
        throw new Error(`Writer lease already held: ${destination}`);
      }
      recoveryAttempted = true;
      const recovery = recoverStaleWriterLease(destination, {
        archiveDir: options.staleArchiveDir,
        isProcessAlive: options.isProcessAlive,
      });
      if (recovery.status === "live") {
        throw new Error(`Writer lease already held: ${destination}`);
      }
      // A recovered or concurrently removed stale lease permits one exclusive retry.
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  }
}

function releaseWriterLease(filePath, leaseId) {
  const current = readJson(filePath);
  if (!leaseId || current.lease_id !== leaseId) throw new Error("Writer lease identity mismatch; refusing release");
  fs.unlinkSync(filePath);
}

function clearStaleWriterLease(filePath, options = {}) {
  if (!options.confirm) throw new Error("Manual stale lease cleanup requires confirm=true");
  const recovery = recoverStaleWriterLease(filePath, options);
  if (recovery.status === "missing") throw new Error("Writer lease does not exist");
  if (recovery.status === "live") {
    throw new Error(`Writer process ${recovery.lease.owner_pid} is still alive; refusing stale cleanup`);
  }
  return recovery.lease;
}

function recoverStaleWriterLease(filePath, options = {}) {
  const destination = path.resolve(filePath);
  let lease;
  try {
    lease = readJson(destination);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    throw new Error(`Writer lease is unreadable; refusing stale recovery: ${error.message || String(error)}`);
  }
  validateStoredLease(lease);
  const isAlive = (options.isProcessAlive || defaultIsProcessAlive)(lease.owner_pid);
  if (isAlive) return { status: "live", lease };

  // Re-read immediately before moving so an obvious identity change is never deleted.
  const current = readJson(destination);
  if (current.lease_id !== lease.lease_id) {
    throw new Error("Writer lease changed during stale recovery; refusing cleanup");
  }

  const archiveDir = path.resolve(options.archiveDir || path.join(path.dirname(destination), ".stale-writer-leases"));
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, staleArchiveName(lease));
  try {
    fs.renameSync(destination, archivePath);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  return { status: "recovered", lease, archive_path: archivePath };
}

function validateStoredLease(lease) {
  if (!lease || typeof lease !== "object") throw new Error("Stored writer lease must be an object");
  if (typeof lease.lease_id !== "string" || !lease.lease_id.trim()) {
    throw new Error("Stored writer lease is missing lease_id");
  }
  if (!Number.isInteger(lease.owner_pid) || lease.owner_pid <= 0) {
    throw new Error("Stored writer lease has invalid owner_pid");
  }
}

function staleArchiveName(lease) {
  const stamp = String(lease.acquired_at || "unknown-time").replace(/[^0-9A-Za-z_-]/g, "-");
  const id = String(lease.lease_id).replace(/[^0-9A-Za-z_-]/g, "-");
  return `MEMORY_WRITER_LEASE.stale-${stamp}-${id}.json`;
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

module.exports = {
  acquireWriterLease,
  clearStaleWriterLease,
  recoverStaleWriterLease,
  releaseWriterLease,
  validateStoredLease,
};
