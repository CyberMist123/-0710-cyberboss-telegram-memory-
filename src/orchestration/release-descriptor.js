const fs = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("./atomic-json");

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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateReleaseDescriptor(value, options = {}) {
  const errors = [];
  if (!isObject(value)) return { ok: false, errors: ["descriptor must be an object"] };
  for (const field of REQUIRED_FIELDS) {
    if (!(field in value)) errors.push(`missing field: ${field}`);
  }
  for (const field of REQUIRED_FIELDS.filter((field) => field !== "rollback_release")) {
    if (field in value && (typeof value[field] !== "string" || !value[field].trim())) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if ("last_verified_sha" in value && !/^[0-9a-f]{40}$/i.test(value.last_verified_sha || "")) {
    errors.push("last_verified_sha must be a full 40-character git SHA");
  }
  if ("pid_file" in value && "state_dir" in value && typeof value.pid_file === "string" && typeof value.state_dir === "string") {
    const relative = path.relative(path.resolve(value.state_dir), path.resolve(value.pid_file));
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      errors.push("pid_file must belong to state_dir for the active release");
    }
  }
  if ("rollback_release" in value) {
    if (!isObject(value.rollback_release)) {
      errors.push("rollback_release must be a release object");
    } else {
      for (const field of ["release_id", "telegram_entry", "config_dir", "state_dir", "log_dir", "pid_file", "watchdog_target", "last_verified_sha"]) {
        if (typeof value.rollback_release[field] !== "string" || !value.rollback_release[field].trim()) {
          errors.push(`rollback_release.${field} must be a non-empty string`);
        }
      }
      if (typeof value.rollback_release.pid_file === "string" && typeof value.rollback_release.state_dir === "string") {
        const relative = path.relative(path.resolve(value.rollback_release.state_dir), path.resolve(value.rollback_release.pid_file));
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          errors.push("rollback_release.pid_file must belong to rollback_release.state_dir");
        }
      }
    }
  }
  const sensitiveFields = [];
  collectSensitiveFields(value, "", sensitiveFields);
  for (const field of sensitiveFields) errors.push(`sensitive value must not appear in release descriptor: ${field}`);
  if (options.requireExistingPaths) {
    for (const field of ["telegram_entry", "config_dir", "state_dir", "log_dir", "watchdog_target"]) {
      if (typeof value[field] === "string" && !fs.existsSync(value[field])) {
        errors.push(`${field} does not exist: ${value[field]}`);
      }
    }
  }
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

function loadReleaseDescriptor(filePath, options = {}) {
  const descriptor = readJson(path.resolve(filePath));
  const result = validateReleaseDescriptor(descriptor, options);
  if (!result.ok) throw new Error(`Invalid release descriptor:\n${result.errors.join("\n")}`);
  return descriptor;
}

function rollbackReleaseDescriptor(filePath) {
  const current = loadReleaseDescriptor(filePath);
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
  const validation = validateReleaseDescriptor(next);
  if (!validation.ok) throw new Error(`Cannot activate rollback release:\n${validation.errors.join("\n")}`);
  writeJsonAtomic(filePath, next);
  return next;
}

module.exports = { REQUIRED_FIELDS, loadReleaseDescriptor, rollbackReleaseDescriptor, validateReleaseDescriptor };
