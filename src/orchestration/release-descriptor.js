const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./atomic-json");

const REQUIRED_FIELDS = [
  "active_release_id",
  "telegram_entry",
  "config_dir",
  "state_dir",
  "log_dir",
  "pid_file",
  "watchdog_target",
  "rollback_release",
  "last_verified_sha",
];
const RELEASE_FIELDS = ["telegram_entry", "config_dir", "state_dir", "log_dir", "pid_file", "watchdog_target"];
const ROLLBACK_FIELDS = ["release_id", ...RELEASE_FIELDS, "last_verified_sha"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalAbsolutePath(value) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) return null;
  const normalized = path.normalize(value);
  return normalized === value ? normalized : null;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inferredReleasePath(entry) {
  return path.dirname(path.dirname(entry));
}

function addPathError(errors, target, field, reason) {
  errors.push(`${target}.${field}: ${reason}`);
}

function validateTarget(value, target, releaseId, options, errors) {
  const paths = {};
  for (const field of RELEASE_FIELDS) {
    const absolute = canonicalAbsolutePath(value[field]);
    if (!absolute) {
      addPathError(errors, target, field, "must be an absolute, normalized path");
    } else {
      paths[field] = absolute;
    }
  }
  if (!paths.telegram_entry) return null;

  const releasePath = inferredReleasePath(paths.telegram_entry);
  if (!isWithin(releasePath, paths.telegram_entry)) {
    addPathError(errors, target, "release_path", "cannot be derived from telegram_entry");
  }
  if (paths.watchdog_target && !isWithin(releasePath, paths.watchdog_target)) {
    addPathError(errors, target, "watchdog_target", "must be inside the inferred release_path");
  }
  for (const field of ["config_dir", "state_dir", "log_dir", "pid_file"]) {
    if (paths[field] && isWithin(releasePath, paths[field])) {
      addPathError(errors, target, field, "must be outside the inferred release_path");
    }
  }
  if (paths.pid_file && paths.state_dir && !isWithin(paths.state_dir, paths.pid_file)) {
    addPathError(errors, target, "pid_file", "must belong to state_dir");
  }
  if (typeof releaseId === "string" && !releaseId.trim()) {
    errors.push(`${target}.release_id: must be a non-empty string`);
  }

  if (options.requireExistingPaths) {
    if (!fs.existsSync(releasePath) || !fs.statSync(releasePath).isDirectory()) {
      addPathError(errors, target, "release_path", "does not exist as a directory");
    }
    for (const field of ["telegram_entry", "watchdog_target", "config_dir", "state_dir", "log_dir"]) {
      if (!paths[field]) continue;
      if (!fs.existsSync(paths[field])) {
        addPathError(errors, target, field, "does not exist");
      } else if (["telegram_entry", "watchdog_target"].includes(field) && !fs.statSync(paths[field]).isFile()) {
        addPathError(errors, target, field, "must be a file");
      } else if (["config_dir", "state_dir", "log_dir"].includes(field) && !fs.statSync(paths[field]).isDirectory()) {
        addPathError(errors, target, field, "must be a directory");
      }
    }
    if (paths.pid_file) {
      const pidParent = path.dirname(paths.pid_file);
      if (!fs.existsSync(pidParent) || !fs.statSync(pidParent).isDirectory()) {
        addPathError(errors, target, "pid_file", "parent directory does not exist");
      } else if (fs.existsSync(paths.pid_file) && !fs.lstatSync(paths.pid_file).isFile()) {
        addPathError(errors, target, "pid_file", "must be a regular file when present");
      }
    }
  }
  return { releasePath, paths };
}

function validateReleaseDescriptor(value, options = {}) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ["descriptor must be an object"] };
  for (const field of REQUIRED_FIELDS) {
    if (!(field in value)) errors.push(`missing field: ${field}`);
  }
  for (const field of REQUIRED_FIELDS.filter((field) => field !== "rollback_release")) {
    if (field in value && (typeof value[field] !== "string" || !value[field].trim())) {
      errors.push(`active.${field}: must be a non-empty string`);
    }
  }
  if ("last_verified_sha" in value && !/^[0-9a-f]{40}$/i.test(value.last_verified_sha || "")) {
    errors.push("active.last_verified_sha: must be a full 40-character git SHA");
  }
  const active = validateTarget(value, "active", value.active_release_id, options, errors);

  let rollback = null;
  if (!isObject(value.rollback_release)) {
    errors.push("rollback: must be a release object");
  } else {
    for (const field of ROLLBACK_FIELDS) {
      if (typeof value.rollback_release[field] !== "string" || !value.rollback_release[field].trim()) {
        errors.push(`rollback.${field}: must be a non-empty string`);
      }
    }
    if (!/^[0-9a-f]{40}$/i.test(value.rollback_release.last_verified_sha || "")) {
      errors.push("rollback.last_verified_sha: must be a full 40-character git SHA");
    }
    rollback = validateTarget(value.rollback_release, "rollback", value.rollback_release.release_id, options, errors);
  }
  if (active && rollback) {
    if (path.resolve(active.releasePath) === path.resolve(rollback.releasePath)) {
      errors.push("active.release_path and rollback.release_path: must refer to distinct release directories");
    }
    if (value.active_release_id === value.rollback_release.release_id) {
      errors.push("active.release_id and rollback.release_id: must be distinct");
    }
    if (active.paths.pid_file && isWithin(rollback.releasePath, active.paths.pid_file)) {
      addPathError(errors, "active", "pid_file", "must be outside rollback.release_path");
    }
    if (rollback.paths.pid_file && isWithin(active.releasePath, rollback.paths.pid_file)) {
      addPathError(errors, "rollback", "pid_file", "must be outside active.release_path");
    }
  }
  const sensitiveFields = [];
  collectSensitiveFields(value, "", sensitiveFields);
  for (const field of sensitiveFields) errors.push(`sensitive value must not appear in release descriptor: ${field}`);
  return { ok: errors.length === 0, errors };
}

function collectSensitiveFields(value, prefix, output) {
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (/(^|_)(token|secret|env|environment)(_|$)/i.test(key)) output.push(field);
    if (isObject(child)) collectSensitiveFields(child, field, output);
  }
}

function readReleaseDescriptor(filePath) {
  const raw = fs.readFileSync(filePath);
  if (raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error("Release descriptor must be UTF-8 without BOM");
  }
  return JSON.parse(raw.toString("utf8"));
}

function loadReleaseDescriptor(filePath, options = {}) {
  const descriptor = readReleaseDescriptor(path.resolve(filePath));
  const result = validateReleaseDescriptor(descriptor, options);
  if (!result.ok) throw new Error(`Invalid release descriptor:\n${result.errors.join("\n")}`);
  return descriptor;
}

function rollbackReleaseDescriptor(filePath) {
  const current = loadReleaseDescriptor(filePath, { requireExistingPaths: true });
  const rollback = current.rollback_release;
  const next = {
    active_release_id: rollback.release_id,
    telegram_entry: rollback.telegram_entry,
    config_dir: rollback.config_dir,
    state_dir: rollback.state_dir,
    log_dir: rollback.log_dir,
    pid_file: rollback.pid_file,
    watchdog_target: rollback.watchdog_target,
    workspace_dir: rollback.workspace_dir || current.workspace_dir || "",
    watchdog_owner_dir: current.watchdog_owner_dir || "",
    last_verified_sha: rollback.last_verified_sha,
    rollback_release: {
      release_id: current.active_release_id,
      telegram_entry: current.telegram_entry,
      config_dir: current.config_dir,
      state_dir: current.state_dir,
      log_dir: current.log_dir,
      pid_file: current.pid_file,
      watchdog_target: current.watchdog_target,
      workspace_dir: current.workspace_dir || "",
      watchdog_owner_dir: current.watchdog_owner_dir || "",
      last_verified_sha: current.last_verified_sha,
    },
  };
  const validation = validateReleaseDescriptor(next, { requireExistingPaths: true });
  if (!validation.ok) throw new Error(`Cannot activate rollback release:\n${validation.errors.join("\n")}`);
  writeJsonAtomic(filePath, next);
  return next;
}

module.exports = { REQUIRED_FIELDS, loadReleaseDescriptor, rollbackReleaseDescriptor, validateReleaseDescriptor };
