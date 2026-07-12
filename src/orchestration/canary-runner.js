const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("./atomic-json");

function snapshotSources(sourcePaths) {
  return Object.fromEntries(sourcePaths.map((item) => {
    const resolved = path.resolve(item);
    let size = 0;
    try { size = fs.statSync(resolved).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
    return [resolved, size];
  }));
}

function createCanaryState(sourcePaths, metadata = {}) {
  return {
    schema_version: 1,
    canary_id: `canary-${crypto.randomUUID()}`,
    status: "WAITING_FOR_LOCAL_EVIDENCE",
    created_at: new Date().toISOString(),
    offsets: snapshotSources(sourcePaths),
    thread_state: metadata.thread_state || null,
    message_ids: [],
  };
}

function scanLocalEvidence(state) {
  for (const [source, offset] of Object.entries(state.offsets)) {
    let handle;
    try {
      handle = fs.openSync(source, "r");
      const size = fs.fstatSync(handle).size;
      if (size <= offset) continue;
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(handle, buffer, 0, buffer.length, offset);
      if (buffer.toString("utf8").includes(state.canary_id)) {
        return { matched: true, source, end_offset: size };
      }
      state.offsets[source] = size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
  }
  return { matched: false };
}

async function runCanary(options) {
  const statePath = path.resolve(options.statePath);
  const sources = (options.sources || []).map((item) => path.resolve(item));
  if (!sources.length) throw new Error("At least one local log/state/recorder source is required");
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 300_000;
  let state;
  if (options.resume && fs.existsSync(statePath)) {
    state = readJson(statePath);
  } else {
    state = createCanaryState(sources, options.metadata);
    writeJsonAtomic(statePath, state);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const match = scanLocalEvidence(state);
    if (match.matched) {
      state.status = "VERIFIED";
      state.verified_at = new Date().toISOString();
      state.matched_source = match.source;
      state.offsets[match.source] = match.end_offset;
      writeJsonAtomic(statePath, state);
      return { status: "VERIFIED", canary_id: state.canary_id, matched_source: match.source };
    }
    if (Date.now() + pollIntervalMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  state.status = "USER_ACTION_PENDING";
  state.pending_since = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  return { status: "USER_ACTION_PENDING", canary_id: state.canary_id };
}

module.exports = { createCanaryState, runCanary, scanLocalEvidence, snapshotSources };
