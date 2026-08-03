// Result capsule: the ONLY thing a bounded sub-agent hands back.
//
// The point of the capsule is that the sub-agent's transcript never reaches the
// orchestrator's context. So the capsule carries conclusions and evidence
// pointers -- status, changed files, test results, commit sha, risks, and a
// recommended next action -- and nothing else.
//
// Two rules keep that true, and both are enforced here rather than by
// convention:
//
//   1. A capsule carrying a known transcript-shaped key is REJECTED outright,
//      not silently stripped. Stripping would teach callers that sending a
//      transcript is fine.
//   2. Free-text fields are length-capped, because "put the whole transcript in
//      summary" is the obvious way around rule 1.

const CAPSULE_FIELDS = [
  "task_id",
  "status",
  "summary",
  "files_changed",
  "tests",
  "commit_sha",
  "risks",
  "recommended_action",
];

const CAPSULE_STATUSES = ["completed", "failed", "timed_out", "cancelled", "interrupted", "rejected"];

const RECOMMENDED_ACTIONS = ["accept", "rework", "stop"];

// Keys that mean "raw process output". Their presence is the failure, so the
// list is matched case-insensitively and after stripping separators, to catch
// rawOutput / raw_output / RAW-OUTPUT alike.
const FORBIDDEN_CAPSULE_KEYS = [
  "transcript",
  "messages",
  "conversation",
  "rawoutput",
  "stdout",
  "stderr",
  "thread",
  "events",
  "log",
  "logs",
  "history",
];

const MAX_SUMMARY_CHARS = 2000;
const MAX_RISK_CHARS = 500;
const MAX_RISKS = 20;
const MAX_FILES_CHANGED = 200;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z]/g, "");
}

// Walks the whole object graph: a transcript nested one level down
// (tests[0].transcript) is just as much of a leak as a top-level one.
function findForbiddenKeys(value, trail = "", found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenKeys(entry, `${trail}[${index}]`, found));
    return found;
  }
  if (!isPlainObject(value)) {
    return found;
  }
  for (const key of Object.keys(value)) {
    const where = trail ? `${trail}.${key}` : key;
    if (FORBIDDEN_CAPSULE_KEYS.includes(canonicalKey(key))) {
      found.push(where);
    }
    findForbiddenKeys(value[key], where, found);
  }
  return found;
}

function validateTestResult(entry, index, errors) {
  const label = `tests[${index}]`;
  if (!isPlainObject(entry)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (!isNonEmptyString(entry.name)) {
    errors.push(`${label}.name must be a non-empty string`);
  }
  if (typeof entry.passed !== "boolean") {
    errors.push(`${label}.passed must be a boolean`);
  }
  if (!Number.isInteger(entry.exit_code)) {
    errors.push(`${label}.exit_code must be an integer`);
  }
}

function validateResultCapsule(value) {
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["result capsule must be an object"] };
  }

  const leaked = findForbiddenKeys(value);
  for (const where of leaked) {
    errors.push(`capsule must not carry raw process output: ${where}`);
  }

  for (const field of CAPSULE_FIELDS) {
    if (!(field in value)) {
      errors.push(`missing field: ${field}`);
    }
  }

  const unknown = Object.keys(value).filter((key) => !CAPSULE_FIELDS.includes(key));
  for (const key of unknown) {
    errors.push(`unknown field: ${key}`);
  }

  if ("task_id" in value && !isNonEmptyString(value.task_id)) {
    errors.push("task_id must be a non-empty string");
  }
  if ("status" in value && !CAPSULE_STATUSES.includes(value.status)) {
    errors.push(`status must be one of: ${CAPSULE_STATUSES.join(", ")}`);
  }
  if ("recommended_action" in value && !RECOMMENDED_ACTIONS.includes(value.recommended_action)) {
    errors.push(`recommended_action must be one of: ${RECOMMENDED_ACTIONS.join(", ")}`);
  }

  if ("summary" in value) {
    if (!isNonEmptyString(value.summary)) {
      errors.push("summary must be a non-empty string");
    } else if (value.summary.length > MAX_SUMMARY_CHARS) {
      errors.push(`summary must be <= ${MAX_SUMMARY_CHARS} chars, got ${value.summary.length}`);
    }
  }

  if ("files_changed" in value) {
    if (!Array.isArray(value.files_changed)) {
      errors.push("files_changed must be an array");
    } else if (value.files_changed.length > MAX_FILES_CHANGED) {
      errors.push(`files_changed must hold <= ${MAX_FILES_CHANGED} entries`);
    } else if (value.files_changed.some((entry) => !isNonEmptyString(entry))) {
      errors.push("files_changed must contain only non-empty strings");
    }
  }

  if ("tests" in value) {
    if (!Array.isArray(value.tests)) {
      errors.push("tests must be an array");
    } else {
      value.tests.forEach((entry, index) => validateTestResult(entry, index, errors));
    }
  }

  // null is meaningful: the run produced no commit.
  if ("commit_sha" in value && value.commit_sha !== null && !SHA_PATTERN.test(String(value.commit_sha || ""))) {
    errors.push("commit_sha must be null or a full 40-character hex sha");
  }

  if ("risks" in value) {
    if (!Array.isArray(value.risks)) {
      errors.push("risks must be an array");
    } else if (value.risks.length > MAX_RISKS) {
      errors.push(`risks must hold <= ${MAX_RISKS} entries`);
    } else {
      value.risks.forEach((entry, index) => {
        if (!isNonEmptyString(entry)) {
          errors.push(`risks[${index}] must be a non-empty string`);
        } else if (entry.length > MAX_RISK_CHARS) {
          errors.push(`risks[${index}] must be <= ${MAX_RISK_CHARS} chars`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function assertValidResultCapsule(value) {
  const validation = validateResultCapsule(value);
  if (!validation.ok) {
    throw new Error(`Invalid result capsule:\n${validation.errors.join("\n")}`);
  }
  return value;
}

module.exports = {
  CAPSULE_FIELDS,
  CAPSULE_STATUSES,
  FORBIDDEN_CAPSULE_KEYS,
  MAX_FILES_CHANGED,
  MAX_RISKS,
  MAX_RISK_CHARS,
  MAX_SUMMARY_CHARS,
  RECOMMENDED_ACTIONS,
  assertValidResultCapsule,
  findForbiddenKeys,
  validateResultCapsule,
};
