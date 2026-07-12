const fs = require("fs");
const path = require("path");
const { loadCurrentState } = require("./current-state");
const { countNonWhitespace, loadReentry } = require("./reentry-loader");

// Runtime-adjustable context gates. 520 console (or any tool) can write
// CYBERBOSS_STATE_DIR/context-gates.json to toggle which hard-context blocks
// are stitched into turns, without restarting the TG process.
// Shape: {"reentry": true, "current_state": true, "memory_context": true}
// Missing file or missing key = enabled (current behavior).
function loadContextGates(config = {}) {
  const stateDir = typeof config.stateDir === "string" ? config.stateDir.trim() : "";
  if (!stateDir) {
    return { reentry: true, current_state: true, memory_context: true };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, "context-gates.json"), "utf8"));
    return {
      reentry: parsed?.reentry !== false,
      current_state: parsed?.current_state !== false,
      memory_context: parsed?.memory_context !== false,
    };
  } catch {
    return { reentry: true, current_state: true, memory_context: true };
  }
}

function prepareOpeningContext({ config = {}, sessionStore, threadId, reason = "new_thread" } = {}) {
  const gates = loadContextGates(config);
  const blocks = [];
  const skipped = [];
  let reentry = null;
  const existing = sessionStore?.getReentryInjection?.(threadId);
  if (!gates.reentry) {
    skipped.push({ type: "reentry", reason: "gated_off" });
  } else if (existing?.reentry_injected === true) {
    skipped.push({ type: "reentry", reason: "already_injected" });
  } else {
    const loaded = loadReentry({ filePath: config.reentryFile });
    if (loaded?.text) {
      reentry = loaded;
      blocks.push({ type: "reentry", loaded: true, reason, ...pickEvidence(loaded) });
    } else {
      skipped.push({ type: "reentry", reason: loaded?.skipped || "missing" });
    }
  }

  const currentState = gates.current_state
    ? loadCurrentState({ filePath: config.desireStateFile })
    : { skipped: "gated_off" };
  if (currentState?.text) {
    blocks.push({ type: "current_state", loaded: true, reason, ...pickEvidence(currentState) });
  } else {
    skipped.push({ type: "current_state", reason: currentState?.skipped || "missing" });
  }
  return { opening: true, reason, reentry, currentState: currentState?.text ? currentState : null, blocks, skipped };
}

function prepareRefreshContext({ config = {}, reason = "refresh" } = {}) {
  const gates = loadContextGates(config);
  const currentState = gates.current_state
    ? loadCurrentState({ filePath: config.desireStateFile })
    : { skipped: "gated_off" };
  const blocks = [];
  const skipped = [{ type: "reentry", reason: "existing_thread" }];
  if (currentState?.text) {
    blocks.push({ type: "current_state", loaded: true, reason, ...pickEvidence(currentState) });
  } else {
    skipped.push({ type: "current_state", reason: currentState?.skipped || "missing" });
  }
  return { opening: false, reason, reentry: null, currentState: currentState?.text ? currentState : null, blocks, skipped };
}

function prepareOrdinaryContext(text) {
  return {
    opening: false,
    reason: "existing_thread",
    reentry: null,
    currentState: null,
    blocks: [],
    skipped: [
      { type: "reentry", reason: "existing_thread" },
      { type: "current_state", reason: "existing_thread" },
    ],
    total_chars: countNonWhitespace(text),
  };
}

function finalizeOpeningContext(context, { sessionStore, threadId, outboundText, fallback = false } = {}) {
  if (context?.reentry?.text) {
    sessionStore?.markReentryInjected?.(threadId, context.reentry);
  }
  return {
    ...(context || {}),
    fallback,
    total_chars: countNonWhitespace(outboundText),
  };
}

function pickEvidence(value = {}) {
  return {
    chars: Math.max(0, Number(value.chars) || 0),
    hash: typeof value.hash === "string" ? value.hash : "",
    src_mtime: typeof value.src_mtime === "string" ? value.src_mtime : "",
  };
}

module.exports = {
  finalizeOpeningContext,
  loadContextGates,
  prepareOpeningContext,
  prepareOrdinaryContext,
  prepareRefreshContext,
};
