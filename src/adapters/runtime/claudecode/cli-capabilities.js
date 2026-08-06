"use strict";

const { BoundedJsonError, parseBoundedJson } = require("../../../core/bounded-json");

// Claude Code CLI capability table.
//
// A launch profile must never hand the child a flag the installed CLI does not
// understand: the child would either reject the whole invocation or, worse,
// silently ignore the restriction the operator asked for.
//
// Verified against Claude Code 2.1.220, whose help declares:
//   --effort low|medium|high|xhigh|max
//   --settings
//   --mcp-config
//   --strict-mcp-config
//   --tools
//   --agents
//   --system-prompt
//   --bare
//   --disable-slash-commands
//   --setting-sources
//
// `--config-dir` and `--output-style` are NOT declared by that help output, so
// they are treated as unverified: a profile using them fails validation before
// launch unless the deployment explicitly declares that its CLI supports them.

const VERIFIED_CLI_VERSION = "2.1.220";

// Flags the runtime itself always emits; these are part of the transport
// contract, not of a profile.
const BASE_FLAGS = Object.freeze(new Set([
  "--output-format",
  "--input-format",
  "--permission-prompt-tool",
  "--verbose",
  "--permission-mode",
  "--resume",
  "--model",
]));

// Profile-controlled flags confirmed present in the verified CLI version.
const VERIFIED_PROFILE_FLAGS = Object.freeze(new Set([
  "--effort",
  "--settings",
  "--mcp-config",
  "--strict-mcp-config",
  "--tools",
  "--agents",
  "--system-prompt",
  // Verified present in the installed CLI 2.1.222: "Append a system prompt to
  // the default". Route 3 needs it -- `--system-prompt` replaces the default
  // harness, which is exactly what an escalation for a real project must not do.
  "--append-system-prompt",
  "--bare",
  "--disable-slash-commands",
  "--setting-sources",
]));

// Profile fields whose flag is not declared by the verified CLI help output.
// Each must be declared supported before it can be used.
const UNVERIFIED_FIELD_FLAGS = Object.freeze({
  configDir: "--config-dir",
  outputStyle: "--output-style",
});

const DECLARABLE_FLAGS = Object.freeze(new Set(Object.values(UNVERIFIED_FIELD_FLAGS)));

const EFFORT_VALUES = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

class CliCapabilityError extends Error {
  constructor(message, code = "cli_flag_unsupported") {
    super(message);
    this.name = "CliCapabilityError";
    this.code = code;
  }
}

/**
 * Resolve the capability set for this deployment.
 *
 * @param {object} options
 * @param {string} options.declaredJson  raw value of
 *        CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON, e.g. `["--output-style"]`
 */
function resolveCliCapabilities({ declaredJson = "" } = {}) {
  const declared = new Set();
  const raw = typeof declaredJson === "string" ? declaredJson.trim() : "";
  if (raw) {
    let parsed;
    try {
      parsed = parseBoundedJson(raw, {
        label: "CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON",
        limits: { maxBytes: 2048, maxDepth: 2, maxArrayLength: 16, maxStringLength: 64 },
      });
    } catch (error) {
      throw new CliCapabilityError(
        error instanceof BoundedJsonError
          ? error.message
          : "CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON is not valid JSON",
        "invalid_capability_declaration",
      );
    }
    if (!Array.isArray(parsed)) {
      throw new CliCapabilityError(
        "CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON must be a JSON array of flag names",
        "invalid_capability_declaration",
      );
    }
    for (const entry of parsed) {
      const flag = typeof entry === "string" ? entry.trim() : "";
      if (!DECLARABLE_FLAGS.has(flag)) {
        // Only the known-unverified flags may be declared. An arbitrary flag
        // cannot be whitelisted into the launch this way.
        throw new CliCapabilityError(
          `${flag || "(empty)"} is not a declarable CLI capability; declarable: ${[...DECLARABLE_FLAGS].join(", ")}`,
          "undeclarable_capability",
        );
      }
      declared.add(flag);
    }
  }

  const supported = new Set([...BASE_FLAGS, ...VERIFIED_PROFILE_FLAGS, ...declared]);
  return Object.freeze({
    verifiedVersion: VERIFIED_CLI_VERSION,
    declared: Object.freeze([...declared].sort()),
    supports(flag) {
      return supported.has(flag);
    },
    /** The profile field is usable only when its flag is supported. */
    supportsField(field) {
      const flag = UNVERIFIED_FIELD_FLAGS[field];
      return flag ? supported.has(flag) : true;
    },
    flagForField(field) {
      return UNVERIFIED_FIELD_FLAGS[field] || "";
    },
  });
}

/**
 * Last line of defence before spawn: refuse to pass a flag the installed CLI is
 * not known to accept.
 */
function assertLaunchArgsSupported(args, capabilities) {
  const caps = capabilities || resolveCliCapabilities();
  for (const arg of Array.isArray(args) ? args : []) {
    if (typeof arg !== "string" || !arg.startsWith("--")) {
      continue;
    }
    if (!caps.supports(arg)) {
      throw new CliCapabilityError(
        `${arg} is not supported by the verified Claude CLI (${caps.verifiedVersion}); `
        + "declare it in CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON if your CLI does support it",
        "cli_flag_unsupported",
      );
    }
  }
  return true;
}

module.exports = {
  BASE_FLAGS,
  CliCapabilityError,
  DECLARABLE_FLAGS,
  EFFORT_VALUES,
  UNVERIFIED_FIELD_FLAGS,
  VERIFIED_CLI_VERSION,
  VERIFIED_PROFILE_FLAGS,
  assertLaunchArgsSupported,
  resolveCliCapabilities,
};
