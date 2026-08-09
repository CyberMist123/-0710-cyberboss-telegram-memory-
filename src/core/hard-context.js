const fs = require("fs");
const path = require("path");
const { loadCurrentState } = require("./current-state");
const { countNonWhitespace, loadReentry, reentrySnapshotFileFor } = require("./reentry-loader");
const { loadSlowLayer } = require("./slow-layer-loader");

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
  // issue #76 目标 4：reentry 的「门」和「实际吃进去的东西」必须分开可判读。
  // `configured` 只回答 context gate 开没开；`effective` 回答这一轮真正注入了什么
  // （current / fallback / none）。门开着但正文进不去，不得再显示成正常 loaded。
  // 这两个字段只出现在 opening 路径 —— 只有这里真的尝试过装 reentry；
  // refresh / ordinary 的 `existing_thread` 行按设计压根没试，行形状保持不变。
  if (!gates.reentry) {
    skipped.push({ type: "reentry", reason: "gated_off", configured: "off", effective: "none" });
  } else if (existing?.reentry_injected === true) {
    skipped.push({ type: "reentry", reason: "already_injected", configured: "on", effective: "none" });
  } else {
    const loaded = loadReentry({
      filePath: config.reentryFile,
      episodesFile: config.continuityDir ? path.join(config.continuityDir, "episodes.jsonl") : "",
      snapshotFile: reentrySnapshotFileFor(config.continuityDir),
    });
    if (loaded?.text) {
      reentry = loaded;
      blocks.push({
        type: "reentry",
        loaded: true,
        reason,
        configured: "on",
        effective: loaded.effective === "fallback" ? "fallback" : "current",
        ...(loaded.degraded_reason ? { degraded_reason: loaded.degraded_reason } : {}),
        ...pickEvidence(loaded),
      });
    } else {
      skipped.push({
        type: "reentry",
        reason: loaded?.skipped || "missing",
        configured: "on",
        effective: "none",
      });
    }
  }

  // 慢层注入面（E1）：与 reentry 同层，只在开窗这一次装配。三个开关全关时
  // loadSlowLayer 零足迹（blocks/skipped 都空），trace 形状与之前逐字节一致。
  // 任何异常整体吞掉——宁可本轮不注入，不可炸开窗（不变量 5）。
  let slowLayer = { blocks: [], skipped: [] };
  try {
    slowLayer = loadSlowLayer({ config });
  } catch (error) {
    console.warn(`[continuity] slow-layer load failed: ${error.message || String(error)}`);
  }
  for (const block of slowLayer.blocks) {
    blocks.push({ type: block.type, loaded: true, reason, ...pickEvidence(block) });
  }
  for (const miss of slowLayer.skipped) {
    skipped.push({ type: miss.type, reason: miss.reason, configured: "on", effective: "none" });
  }

  const currentState = gates.current_state
    ? loadCurrentState({ filePath: config.desireStateFile, overrideFilePath: config.currentStateOverrideFile })
    : { skipped: "gated_off" };
  if (currentState?.text) {
    blocks.push({ type: "current_state", loaded: true, reason, ...pickEvidence(currentState) });
  } else {
    skipped.push({ type: "current_state", reason: currentState?.skipped || "missing" });
  }
  return {
    opening: true,
    reason,
    reentry,
    slowLayer: slowLayer.blocks,
    currentState: currentState?.text ? currentState : null,
    blocks,
    skipped,
  };
}

function prepareRefreshContext({ config = {}, reason = "refresh" } = {}) {
  const gates = loadContextGates(config);
  const currentState = gates.current_state
    ? loadCurrentState({ filePath: config.desireStateFile, overrideFilePath: config.currentStateOverrideFile })
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
