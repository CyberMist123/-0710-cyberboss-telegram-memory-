"use strict";

const { assertValidTaskSpec } = require("../../../orchestration/delegation/task-spec");

const ROUTE1_TASK_SESSION_FLAG = "CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED";
const TASK_SESSION_STATES = Object.freeze([
  "create",
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
]);
const TERMINAL_STATES = new Set(["completed", "failed", "timed_out", "cancelled"]);
const RESUMABLE_STATES = new Set(["waiting_approval", "failed", "timed_out", "cancelled"]);
const MAX_PROGRESS_CHARS = 500;
const MAX_INSTRUCTIONS = 16;
const MAX_INSTRUCTION_CHARS = 2_000;
const MAX_TASK_MATERIALS = 16;
const MAX_MATERIAL_SOURCE_CHARS = 128;
const MAX_MATERIAL_TEXT_CHARS = 2_000;
const MAX_MATERIAL_TOTAL_CHARS = 8_000;

function route1TaskSessionEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.[ROUTE1_TASK_SESSION_FLAG] || "").trim());
}

function boundText(value, maxChars, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 12))} [truncated]`;
}

class StrongInterruptLatch {
  constructor() {
    this.requested = false;
    this.reason = "";
  }

  request(reason = "strong_interrupt") {
    if (!this.requested) {
      this.requested = true;
      this.reason = boundText(reason, 128, "strong_interrupt");
    }
    return this.snapshot();
  }

  isRequested() {
    return this.requested;
  }

  snapshot() {
    return Object.freeze({ requested: this.requested, reason: this.reason });
  }
}

async function runAtomicTaskStep(latch, step) {
  if (!(latch instanceof StrongInterruptLatch)) {
    throw new TypeError("StrongInterruptLatch is required");
  }
  if (typeof step !== "function") {
    throw new TypeError("atomic task step must be a function");
  }
  if (latch.isRequested()) {
    return Object.freeze({ ran: false, stopAtBoundary: true, value: undefined });
  }
  // The latch is deliberately not consulted again until the awaited step has
  // settled. An external interrupt therefore cannot kill an in-flight atomic
  // operation; it only prevents the next operation from starting.
  const value = await step();
  return Object.freeze({ ran: true, stopAtBoundary: latch.isRequested(), value });
}

class TaskSessionRegistry {
  constructor() {
    this.tasks = new Map();
  }

  create({ spec, sessionSlotKey, profileId }) {
    assertValidTaskSpec(spec);
    if (this.tasks.has(spec.task_id)) {
      throw taskSessionError("task_session_already_exists");
    }
    const now = new Date().toISOString();
    const record = {
      taskId: spec.task_id,
      state: "create",
      sessionSlotKey: String(sessionSlotKey || ""),
      profileId: String(profileId || ""),
      nativeSessionId: "",
      progress: "task created",
      attempts: 0,
      instructions: [],
      latch: new StrongInterruptLatch(),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(record.taskId, record);
    this.transition(record.taskId, "queued", "task queued");
    return this.snapshot(record.taskId);
  }

  transition(taskId, nextState, progress = "") {
    const record = this.require(taskId);
    if (!TASK_SESSION_STATES.includes(nextState)) {
      throw taskSessionError("task_session_state_unknown");
    }
    assertTransition(record.state, nextState);
    record.state = nextState;
    record.progress = boundText(progress, MAX_PROGRESS_CHARS, nextState);
    record.updatedAt = new Date().toISOString();
    if (nextState === "running") record.attempts += 1;
    return this.snapshot(taskId);
  }

  setNativeSessionId(taskId, nativeSessionId) {
    const record = this.require(taskId);
    const value = String(nativeSessionId || "").replace(/\s+/g, "").trim();
    if (!value) return this.snapshot(taskId);
    record.nativeSessionId = value;
    record.updatedAt = new Date().toISOString();
    return this.snapshot(taskId);
  }

  addInstruction(taskId, instruction) {
    const record = this.require(taskId);
    if (record.state === "completed") throw taskSessionError("task_session_not_resumable");
    const text = boundText(instruction, MAX_INSTRUCTION_CHARS);
    if (!text) throw taskSessionError("task_session_instruction_required");
    if (record.instructions.length >= MAX_INSTRUCTIONS) {
      throw taskSessionError("task_session_instruction_limit");
    }
    record.instructions.push(text);
    record.progress = boundText(`instruction queued (${record.instructions.length})`, MAX_PROGRESS_CHARS);
    record.updatedAt = new Date().toISOString();
    return this.snapshot(taskId);
  }

  takeInstructions(taskId) {
    const record = this.require(taskId);
    const instructions = record.instructions.splice(0, record.instructions.length);
    record.updatedAt = new Date().toISOString();
    return instructions;
  }

  requestCancel(taskId, reason = "cancel_requested") {
    const record = this.require(taskId);
    record.latch.request(reason);
    record.progress = "stop requested; waiting for atomic step boundary";
    record.updatedAt = new Date().toISOString();
    if (record.state === "create" || record.state === "queued") {
      this.transition(taskId, "cancelled", "cancelled before execution");
    }
    return this.snapshot(taskId);
  }

  resume(taskId) {
    const record = this.require(taskId);
    if (!RESUMABLE_STATES.has(record.state)) throw taskSessionError("task_session_not_resumable");
    record.latch = new StrongInterruptLatch();
    return this.transition(taskId, "queued", "task queued for resume");
  }

  getLatch(taskId) {
    return this.require(taskId).latch;
  }

  get(taskId) {
    return this.tasks.has(taskId) ? this.snapshot(taskId) : null;
  }

  snapshot(taskId) {
    const record = this.require(taskId);
    return Object.freeze({
      taskId: record.taskId,
      state: record.state,
      sessionSlotKey: record.sessionSlotKey,
      profileId: record.profileId,
      nativeSessionId: record.nativeSessionId,
      progress: record.progress,
      attempts: record.attempts,
      queuedInstructions: record.instructions.length,
      interrupt: record.latch.snapshot(),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  require(taskId) {
    const record = this.tasks.get(String(taskId || ""));
    if (!record) throw taskSessionError("task_session_unknown");
    return record;
  }
}

function assertTransition(current, next) {
  if (current === next) return;
  const allowed = {
    create: ["queued", "cancelled"],
    queued: ["running", "cancelled"],
    running: ["waiting_approval", "completed", "failed", "timed_out", "cancelled"],
    waiting_approval: ["queued", "running", "completed", "failed", "timed_out", "cancelled"],
    completed: [],
    failed: ["queued"],
    timed_out: ["queued"],
    cancelled: ["queued"],
  };
  if (!allowed[current]?.includes(next)) {
    throw taskSessionError("task_session_transition_invalid");
  }
}

function normalizeTaskMaterials(materials) {
  if (materials === undefined) return [];
  if (!Array.isArray(materials) || materials.length > MAX_TASK_MATERIALS) {
    throw taskSessionError("task_session_materials_invalid");
  }
  let total = 0;
  return materials.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw taskSessionError("task_session_material_invalid");
    }
    const source = boundText(entry.source, MAX_MATERIAL_SOURCE_CHARS);
    const text = boundText(entry.text, MAX_MATERIAL_TEXT_CHARS);
    if (!source || !text) throw taskSessionError("task_session_material_invalid");
    total += source.length + text.length;
    if (total > MAX_MATERIAL_TOTAL_CHARS) throw taskSessionError("task_session_materials_too_large");
    return Object.freeze({ source, text });
  });
}

function buildTaskSessionPrompt({ spec, taskMaterials = [] } = {}) {
  assertValidTaskSpec(spec);
  const materials = normalizeTaskMaterials(taskMaterials);
  return [
    "Execute the bounded task described by this D14 task spec.",
    "Return exactly one JSON object conforming to the existing D14 v1 result-capsule contract.",
    "Do not return transcript, messages, stdout, stderr, logs, history, or extra fields.",
    `task_spec=${JSON.stringify(spec)}`,
    `task_materials=${JSON.stringify(materials)}`,
  ].join("\n");
}

function parseTaskSessionCapsule(text) {
  const source = typeof text === "string" ? text.trim() : "";
  if (!source) throw taskSessionError("task_session_capsule_empty");
  try {
    return JSON.parse(source);
  } catch {
    throw taskSessionError("task_session_capsule_invalid_json");
  }
}

function buildTaskShortStatus({ task, capsule, verification }) {
  return Object.freeze({
    task_id: task.taskId,
    lifecycle: task.state,
    decision: verification.decision,
    summary: boundText(capsule.summary, MAX_PROGRESS_CHARS, capsule.status),
    native_session_id: task.nativeSessionId,
  });
}

function taskSessionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  MAX_PROGRESS_CHARS,
  ROUTE1_TASK_SESSION_FLAG,
  StrongInterruptLatch,
  TASK_SESSION_STATES,
  TaskSessionRegistry,
  buildTaskSessionPrompt,
  buildTaskShortStatus,
  parseTaskSessionCapsule,
  route1TaskSessionEnabled,
  runAtomicTaskStep,
};
