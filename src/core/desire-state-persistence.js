const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DRIVE_KEYS = [
  "attachment", "curiosity", "reflection", "duty",
  "social", "fatigue", "libido", "stress",
];

function persistReportedDesireState({ state, stateFile, historyFile = "", now = new Date().toISOString(), appendHistory = true }) {
  if (!stateFile || !state || !Array.isArray(state.drives)) return { saved: false, reason: "invalid_state" };
  const normalizedDrives = state.drives.filter((drive) => drive && DRIVE_KEYS.includes(String(drive.key || "")));
  if (normalizedDrives.length !== DRIVE_KEYS.length) return { saved: false, reason: "incomplete_drives" };

  const sourceHash = hashReportedState({ ...state, drives: normalizedDrives });
  const previousState = readJson(stateFile);
  if (previousState?.sourceHash === sourceHash) {
    return { saved: false, reason: "duplicate_report", sourceHash };
  }

  const previous = Array.isArray(previousState?.drives)
    ? { drives: previousState.drives, updatedAt: previousState.updatedAt || "" }
    : null;
  const next = { ...state, drives: normalizedDrives, previous, updatedAt: now, sourceHash };
  atomicWriteJson(stateFile, next);

  // History rows are the AI's own hourly reports and nothing else. Engine
  // settlements update the state file but must not append here, or the ledger
  // mixes two kinds of rows under one note and the next heartbeat quotes an
  // echo instead of what the AI actually said last time.
  if (appendHistory) {
    const targetHistory = historyFile || path.join(path.dirname(stateFile), "desire-history.jsonl");
    const row = {
      time: now,
      most_want: String(state.most_want || state.intent?.want_action || "").trim(),
      note: "claude-runtime-reported",
      drives: normalizedDrives.map((drive) => ({
        key: String(drive.key || ""),
        label: String(drive.label || ""),
        score: normalizeScore(drive.score),
        change: String(drive.change || ""),
        cause: String(drive.cause || ""),
      })),
    };
    for (const drive of normalizedDrives) row[drive.key] = normalizeScore(drive.score);
    fs.appendFileSync(targetHistory, `${JSON.stringify(row)}\n`, "utf8");
  }
  return { saved: true, reason: "reported_state", sourceHash };
}

function readLatestDesireHistory(historyFile = "") {
  if (!historyFile) return null;
  let content = "";
  try {
    content = fs.readFileSync(historyFile, "utf8");
  } catch {
    return null;
  }
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {}
  }
  return null;
}

function readPersistedDesireState(stateFile = "") {
  if (!stateFile) return null;
  const parsed = readJson(stateFile);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function hashReportedState(state) {
  const stable = {
    most_want: String(state.most_want || "").trim(),
    intent: state.intent || null,
    drives: state.drives.map((drive) => ({
      key: drive.key,
      score: normalizeScore(drive.score),
      change: String(drive.change || ""),
      cause: String(drive.cause || ""),
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function normalizeScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

module.exports = { DRIVE_KEYS, persistReportedDesireState, readLatestDesireHistory, readPersistedDesireState };
