"use strict";

const fsApi = require("node:fs");
const path = require("node:path");

const TASK_RESULTS_FILENAME = "task-results.jsonl";

/**
 * Route 1 result ledger.  This is deliberately a new file and a new writer
 * domain: only the DispatchController calls append*(), and no handoff,
 * History, or memory lease is involved.
 */
class Route1TaskStore {
  constructor({ stateDir = "", fs = fsApi, now = () => new Date().toISOString() } = {}) {
    this.fs = fs;
    this.now = typeof now === "function" ? now : () => new Date().toISOString();
    this.stateDir = clean(stateDir);
    this.filePath = this.stateDir
      ? path.join(this.stateDir, "route1", TASK_RESULTS_FILENAME)
      : "";
    this.rows = [];
    if (this.filePath) {
      this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.rows = readRows(this.filePath, this.fs);
    }
  }

  appendTerminal({ taskId, capsule, verification, originRoute, shortStatus } = {}) {
    return this.append({
      event: "terminal",
      task_id: clean(taskId) || clean(capsule?.task_id),
      capsule: cloneJson(capsule),
      verification: cloneJson(verification) || {},
      origin_route: cloneJson(originRoute) || null,
      short_status: cloneJson(shortStatus) || null,
    });
  }

  appendNotice({ taskId, originState, blockChars } = {}) {
    return this.append({
      event: "notice",
      task_id: clean(taskId),
      origin_state: clean(originState),
      block_chars: Number(blockChars) || 0,
    });
  }

  appendClaim({ taskId, originState, source } = {}) {
    return this.append({
      event: "claim",
      task_id: clean(taskId),
      origin_state: clean(originState),
      source: clean(source),
    });
  }

  append(entry = {}) {
    const row = { ts: this.now(), ...cloneJson(entry) };
    this.rows.push(row);
    if (this.filePath) {
      // This is the sole task-results.jsonl write site.
      this.fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, { encoding: "utf8" });
    }
    return row;
  }

  listTerminalRows() {
    const latest = new Map();
    for (const row of this.rows) {
      if (row?.event === "terminal" && row.task_id) latest.set(row.task_id, row);
    }
    return [...latest.values()];
  }

  getTerminal(taskId) {
    const id = clean(taskId);
    return this.listTerminalRows().find((row) => row.task_id === id) || null;
  }

  listRows(event = "") {
    const kind = clean(event);
    return this.rows.filter((row) => !kind || row?.event === kind);
  }

  get rowsFilePath() {
    return this.filePath;
  }
}

function createTaskStore(options = {}) {
  return new Route1TaskStore(options);
}

function readRows(filePath, fs) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function clean(value) { return typeof value === "string" ? value.trim() : ""; }
function buildRoute1Notice(shortStatus = {}) {
  const taskId = xml(clean(shortStatus.task_id));
  const lifecycle = xml(clean(shortStatus.lifecycle));
  const decision = xml(clean(shortStatus.decision));
  const prefix = `<route1_task_notice>task_id=${taskId}; lifecycle=${lifecycle}; decision=${decision}; summary=`;
  const suffix = "</route1_task_notice>";
  const budget = Math.max(0, 200 - prefix.length - suffix.length);
  return `${prefix}${xml(clean(shortStatus.summary)).slice(0, budget)}${suffix}`;
}
function xml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = {
  buildRoute1Notice,
  Route1TaskStore,
  TASK_RESULTS_FILENAME,
  createTaskStore,
};
