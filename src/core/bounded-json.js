"use strict";

// Bounded, prototype-safe JSON parsing for operator-supplied configuration.
//
// Every limit below is enforced *before* the value reaches profile or route
// validation, so a hostile or accidentally huge environment variable cannot
// exhaust memory, blow the stack through nesting, or smuggle a polluting key
// into an object that is later spread/copied.

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024,
  maxDepth: 6,
  maxStringLength: 8192,
  maxArrayLength: 128,
  maxObjectKeys: 128,
  maxTotalNodes: 4096,
});

const FORBIDDEN_KEYS = Object.freeze(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_KEYS);

class BoundedJsonError extends Error {
  constructor(message, code = "bounded_json_invalid") {
    super(message);
    this.name = "BoundedJsonError";
    this.code = code;
  }
}

function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      throw new BoundedJsonError(`unknown bound: ${key}`, "unknown_bound");
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BoundedJsonError(`bound ${key} must be a positive integer`, "unknown_bound");
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

/**
 * Parse operator JSON under hard bounds.
 *
 * @param {string} raw            raw environment value
 * @param {object} options
 * @param {string} options.label  name used in error messages (never the value)
 * @param {object} options.limits optional limit overrides
 */
function parseBoundedJson(raw, { label = "config", limits: limitOverrides = {} } = {}) {
  const limits = resolveLimits(limitOverrides);
  if (typeof raw !== "string") {
    throw new BoundedJsonError(`${label} must be a string`, "not_a_string");
  }
  const byteLength = Buffer.byteLength(raw, "utf8");
  if (byteLength > limits.maxBytes) {
    throw new BoundedJsonError(
      `${label} exceeds the ${limits.maxBytes} byte limit (${byteLength})`,
      "too_large",
    );
  }

  let parsed;
  try {
    // The reviver runs for every key/value pair and is the only reliable place
    // to reject `__proto__` before it becomes an own property of the result.
    parsed = JSON.parse(raw, function boundedReviver(key, value) {
      if (FORBIDDEN_KEY_SET.has(key)) {
        throw new BoundedJsonError(
          `${label} contains a forbidden key: ${key}`,
          "forbidden_key",
        );
      }
      return value;
    });
  } catch (error) {
    if (error instanceof BoundedJsonError) {
      throw error;
    }
    throw new BoundedJsonError(`${label} is not valid JSON`, "invalid_json");
  }

  assertBounded(parsed, limits, label);
  return parsed;
}

function assertBounded(root, limits, label) {
  let nodes = 0;
  // Explicit stack; recursion would itself be a depth hazard.
  const stack = [{ value: root, depth: 1 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > limits.maxTotalNodes) {
      throw new BoundedJsonError(`${label} has too many nodes`, "too_many_nodes");
    }
    if (depth > limits.maxDepth) {
      throw new BoundedJsonError(
        `${label} exceeds the maximum nesting depth of ${limits.maxDepth}`,
        "too_deep",
      );
    }
    if (typeof value === "string") {
      if (value.length > limits.maxStringLength) {
        throw new BoundedJsonError(`${label} contains an over-long string`, "string_too_long");
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new BoundedJsonError(`${label} contains a non-finite number`, "non_finite_number");
      }
      continue;
    }
    if (value === null || typeof value === "boolean") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayLength) {
        throw new BoundedJsonError(`${label} contains an over-long array`, "array_too_long");
      }
      for (const item of value) {
        stack.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    if (typeof value === "object") {
      const keys = Object.keys(value);
      if (keys.length > limits.maxObjectKeys) {
        throw new BoundedJsonError(`${label} contains too many object keys`, "too_many_keys");
      }
      for (const key of keys) {
        if (FORBIDDEN_KEY_SET.has(key)) {
          throw new BoundedJsonError(`${label} contains a forbidden key: ${key}`, "forbidden_key");
        }
        if (key.length > limits.maxStringLength) {
          throw new BoundedJsonError(`${label} contains an over-long key`, "string_too_long");
        }
        stack.push({ value: value[key], depth: depth + 1 });
      }
      continue;
    }
    throw new BoundedJsonError(`${label} contains an unsupported value`, "unsupported_value");
  }
}

/**
 * Object literal with a null prototype, safe to index with attacker-chosen
 * keys. Used wherever operator-supplied names become object keys.
 */
function createNullPrototypeObject() {
  return Object.create(null);
}

function assertSafeKey(key, label) {
  if (typeof key !== "string" || !key.length) {
    throw new BoundedJsonError(`${label} requires a non-empty key`, "invalid_key");
  }
  if (FORBIDDEN_KEY_SET.has(key)) {
    throw new BoundedJsonError(`${label} contains a forbidden key: ${key}`, "forbidden_key");
  }
  return key;
}

/**
 * Strict boolean parsing for environment variables. An arbitrary non-empty
 * string is *not* true.
 */
function parseStrictBoolean(value, { label = "flag", fallback = false } = {}) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    throw new BoundedJsonError(`${label} must be a boolean-like string`, "invalid_boolean");
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "1" || normalized === "true") {
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    return false;
  }
  throw new BoundedJsonError(
    `${label} must be one of 1/0/true/false, not an arbitrary string`,
    "invalid_boolean",
  );
}

module.exports = {
  BoundedJsonError,
  DEFAULT_LIMITS,
  FORBIDDEN_KEYS,
  assertSafeKey,
  createNullPrototypeObject,
  parseBoundedJson,
  parseStrictBoolean,
};
