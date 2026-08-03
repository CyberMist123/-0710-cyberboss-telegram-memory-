"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { assertValidTaskSpec, MAX_TIMEOUT_MS } = require("./delegation/task-spec");
const { lexicalPath } = require("../adapters/runtime/claudecode/route1-runtime-seam");

const SOFT_TIMEOUT_MS = 5 * 60 * 1000;
const CONSULT_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled", "interrupted"]);

function route1DispatchEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED || "").trim())
    && /^(?:1|true|yes|on)$/i.test(String(env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED || "").trim());
}

class Route1DispatchController {
  constructor({ runtimeAdapter, trace = null, idFactory = () => crypto.randomUUID(), queueMicrotaskFn = queueMicrotask } = {}) {
    if (!runtimeAdapter) throw dispatchError("route1_runtime_required");
    this.runtime = runtimeAdapter;
    this.trace = typeof trace === "function" ? trace : null;
    this.idFactory = idFactory;
    this.queueMicrotask = queueMicrotaskFn;
    this.tasks = new Map();
    this.turns = new Map();
    this.tokens = new Map();
    this.queue = [];
    this.runningTaskId = "";
    this.halted = false;
    this.pumpScheduled = false;
  }

  registerTurn({ turnId, workspaceRoot, launchProfile, released = false } = {}) {
    const id = clean(turnId);
    if (!id) return false;
    this.turns.set(id, { workspaceRoot: clean(workspaceRoot), launchProfile: launchProfile || null, released });
    return true;
  }

  releaseTurn(turnId) {
    const id = clean(turnId);
    const turn = this.turns.get(id);
    if (turn) turn.released = true;
    this.invalidateTurnTokens(id);
    this.recordTrace("dispatch_release", { turn_id: id, explanation: "foreground_turn_lock_released" });
    this.schedulePump();
  }

  dispatch(args = {}, context = {}) {
    if (this.halted) return this.reply("halted", "派活已暂停；请先使用 /continue-tasks。", null);
    const turnId = clean(context.turnId);
    const turn = this.turns.get(turnId);
    if (!turn || turn.released || !turn.workspaceRoot || !turn.launchProfile) {
      throw dispatchError("route1_origin_turn_unknown");
    }

    const suppliedToken = clean(args.confirm_token);
    if (suppliedToken) return this.confirm(suppliedToken, turnId);

    const taskId = makeTaskId(this.idFactory());
    if (Number(args.timeout_ms) > MAX_TIMEOUT_MS) {
      this.recordTrace("escalate", { task_id: taskId, turn_id: turnId, explanation: "timeout_exceeds_60_minutes" });
      return this.reply("rejected", "这个活超过 60 分钟绝对上限，请先拆小。", taskId);
    }
    const spec = buildSpec(args, { taskId, workspaceRoot: turn.workspaceRoot });
    const queueBusy = Boolean(this.runningTaskId || this.queue.length);
    const band = decideBand(spec.timeout_ms, queueBusy);
    if (band === "consult") {
      this.createPending({ spec, launchProfile: turn.launchProfile, taskMaterials: normalizeMaterials(args.task_materials), originTurnId: turnId, ownerConsult: true });
      this.recordTrace("escalate", { task_id: taskId, turn_id: turnId, explanation: "estimated_over_15_minutes_consult_owner" });
      return {
        ...this.reply("confirm_required", "这个活预计超 15 分钟，你想怎么处理？", taskId),
        owner_consult_required: true,
      };
    }
    if (band === "confirm") {
      const token = crypto.randomBytes(24).toString("base64url");
      this.createPending({ spec, launchProfile: turn.launchProfile, taskMaterials: normalizeMaterials(args.task_materials), originTurnId: turnId });
      this.tokens.set(token, { turnId, spec, launchProfile: turn.launchProfile, taskMaterials: normalizeMaterials(args.task_materials), used: false });
      this.recordTrace("confirm", { task_id: taskId, turn_id: turnId, explanation: queueBusy ? "queue_requires_self_confirmation" : "estimated_5_to_15_minutes" });
      return {
        ...this.reply("confirm_required", "请由当前窗口自行确认后，带一次性 confirm_token 重调。", taskId),
        confirm_token: token,
      };
    }
    return this.enqueue({ spec, launchProfile: turn.launchProfile, taskMaterials: normalizeMaterials(args.task_materials), originTurnId: turnId });
  }

  confirm(token, turnId) {
    const pending = this.tokens.get(token);
    if (!pending || pending.used || pending.turnId !== turnId) throw dispatchError("route1_confirm_token_invalid");
    pending.used = true;
    this.tokens.delete(token);
    this.recordTrace("confirm", { task_id: pending.spec.task_id, turn_id: turnId, explanation: "self_confirmation_consumed", approval_required: false, scope: "window" });
    return { ...this.enqueue({ ...pending, originTurnId: turnId }), self_confirmed: true };
  }

  enqueue({ spec, launchProfile, taskMaterials = [], originTurnId }) {
    assertValidTaskSpec(spec);
    const record = this.tasks.get(spec.task_id) || {
      taskId: spec.task_id,
      spec,
      launchProfile,
      taskMaterials,
      originTurnId,
      state: "queued",
      started: false,
      capsule: null,
      shortStatus: null,
      runPromise: null,
      resumeEligible: true,
    };
    record.state = "queued";
    record.resumeEligible = true;
    this.tasks.set(record.taskId, record);
    this.queue.push(record.taskId);
    this.recordTrace("dispatch", { task_id: record.taskId, turn_id: originTurnId, explanation: "created_and_queued_only" });
    this.schedulePump();
    return this.reply("queued", `任务已入队：${record.taskId}`, record.taskId);
  }

  createPending({ spec, launchProfile, taskMaterials, originTurnId, ownerConsult = false }) {
    this.tasks.set(spec.task_id, {
      taskId: spec.task_id,
      spec,
      launchProfile,
      taskMaterials,
      originTurnId,
      state: "confirm_required",
      ownerConsult,
      started: false,
      capsule: null,
      shortStatus: null,
      runPromise: null,
      resumeEligible: false,
    });
  }

  schedulePump() {
    if (this.pumpScheduled || this.halted || this.runningTaskId) return;
    this.pumpScheduled = true;
    this.queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  async pump() {
    if (this.halted || this.runningTaskId) return;
    const index = this.queue.findIndex((taskId) => {
      const task = this.tasks.get(taskId);
      return task && this.turns.get(task.originTurnId)?.released === true;
    });
    if (index < 0) return;
    const [taskId] = this.queue.splice(index, 1);
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "queued") return this.schedulePump();
    this.runningTaskId = taskId;
    task.state = "running";
    task.runPromise = this.run(task);
    await task.runPromise;
    this.runningTaskId = "";
    this.schedulePump();
  }

  async run(task) {
    try {
      const result = task.started
        ? await this.runtime.continueTaskSession({ taskId: task.taskId })
        : await this.runtime.runTaskSession({ spec: task.spec, launchProfile: task.launchProfile, taskMaterials: task.taskMaterials });
      task.started = true;
      task.capsule = result?.capsule || null;
      task.shortStatus = result?.shortStatus || null;
      task.state = clean(result?.shortStatus?.lifecycle) || clean(result?.capsule?.status) || "failed";
    } catch (error) {
      task.started = true;
      task.state = "failed";
      task.shortStatus = { task_id: task.taskId, lifecycle: "failed", decision: "stop", summary: clean(error?.code || error?.message) || "worker failed" };
    }
    return task;
  }

  softInterrupt() {
    return this.interrupt("soft");
  }

  hardInterrupt() {
    return this.interrupt("hard");
  }

  interrupt(level) {
    this.halted = true;
    this.tokens.clear();
    const cancelled = [];
    for (const taskId of this.queue.splice(0)) {
      const task = this.tasks.get(taskId);
      if (!task || TERMINAL.has(task.state)) continue;
      task.state = "cancelled";
      task.resumeEligible = true;
      cancelled.push(taskId);
    }
    for (const task of this.tasks.values()) {
      if (task.state !== "confirm_required") continue;
      task.state = "cancelled";
      task.resumeEligible = false;
      cancelled.push(task.taskId);
    }
    const running = this.runningTaskId ? this.tasks.get(this.runningTaskId) : null;
    let stopPromise = Promise.resolve();
    if (running) {
      running.resumeEligible = true;
      try {
        const status = level === "hard"
          ? this.runtime.requestTaskSessionStrongInterrupt({ taskId: running.taskId })
          : this.runtime.cancelTaskSession({ taskId: running.taskId, reason: "owner_soft_interrupt" });
        stopPromise = Promise.resolve(status).then(() => running.runPromise).catch(() => running.runPromise);
      } catch {
        stopPromise = running.runPromise || Promise.resolve();
      }
    }
    this.recordTrace("interrupt", { explanation: level === "hard" ? "process_kill_immediate" : "stop_at_small_round_boundary", level, cancelled_count: cancelled.length, waiting_count: running ? 1 : 0 });
    const formal = Promise.resolve(stopPromise).then(() => formatInterruptStatus({ level, cancelled, running: running?.taskId || "" }));
    return { acknowledgement: "收到", formal };
  }

  continueTasks() {
    this.halted = false;
    const resumed = [];
    for (const task of this.tasks.values()) {
      if (task.resumeEligible && !task.started && task.state === "cancelled") {
        task.state = "queued";
        this.queue.push(task.taskId);
        resumed.push(task.taskId);
      } else if (task.resumeEligible && task.started && ["cancelled", "interrupted"].includes(task.state)) {
        task.state = "queued";
        this.queue.push(task.taskId);
        resumed.push(task.taskId);
      }
    }
    this.recordTrace("interrupt", { explanation: "dispatch_resumed", resumed_count: resumed.length });
    this.schedulePump();
    return { status: "resumed", resumed };
  }

  getTask(taskId) {
    const task = this.tasks.get(clean(taskId));
    return task ? { ...task, spec: { ...task.spec }, launchProfile: undefined, runPromise: undefined } : null;
  }

  invalidateTurnTokens(turnId) {
    for (const [token, pending] of this.tokens) if (pending.turnId === turnId) this.tokens.delete(token);
  }

  recordTrace(action, details) {
    try { this.trace?.({ action, ...details }); } catch {}
  }

  reply(status, text, taskId) {
    return { status, text, ...(taskId ? { task_id: taskId } : {}) };
  }
}

class Route1DispatchIpcClient {
  constructor({ stateDir, timeoutMs = 5000 } = {}) {
    this.stateDir = clean(stateDir);
    this.timeoutMs = timeoutMs;
  }

  async dispatch(args, context) {
    if (!this.stateDir) throw dispatchError("route1_ipc_state_dir_required");
    const endpoint = JSON.parse(fs.readFileSync(path.join(this.stateDir, "claudecode-runtime.json"), "utf8"));
    const token = fs.readFileSync(endpoint.tokenFile, "utf8").trim();
    const requestId = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      let buffer = "";
      const timer = setTimeout(() => finish(dispatchError("route1_ipc_timeout")), this.timeoutMs);
      const finish = (error, value) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "auth", token })}\n`);
        socket.write(`${JSON.stringify({ type: "route1.dispatch", requestId, args, context })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message?.type !== "route1.dispatch.result" || message.requestId !== requestId) continue;
          if (message.error) return finish(dispatchError(message.error));
          return finish(null, message.result);
        }
      });
      socket.on("error", (error) => finish(error));
    });
  }
}

function buildSpec(args, { taskId, workspaceRoot }) {
  const spec = {
    task_id: taskId,
    objective: clean(args.objective),
    allowed_paths: Array.isArray(args.allowed_paths) ? args.allowed_paths : [],
    forbidden_paths: Array.isArray(args.forbidden_paths) ? args.forbidden_paths : [],
    workspace: lexicalPath(workspaceRoot),
    base_sha: clean(args.base_sha),
    acceptance_tests: Array.isArray(args.acceptance_tests) ? args.acceptance_tests : [],
    timeout_ms: Number(args.timeout_ms),
    approval_policy: clean(args.approval_policy),
  };
  assertValidTaskSpec(spec);
  return Object.freeze(spec);
}

function decideBand(timeoutMs, queueBusy) {
  if (timeoutMs > MAX_TIMEOUT_MS) return "absolute";
  if (timeoutMs > CONSULT_TIMEOUT_MS) return "consult";
  if (queueBusy || timeoutMs > SOFT_TIMEOUT_MS) return "confirm";
  return "free";
}

function normalizeMaterials(value) { return Array.isArray(value) ? value : []; }
function clean(value) { return typeof value === "string" ? value.trim() : ""; }
function makeTaskId(value) { return `route1-${String(value || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)}`; }
function dispatchError(code) { const error = new Error(code); error.code = code; return error; }
function formatInterruptStatus({ level, cancelled, running }) {
  const boundedCancelled = cancelled.slice(0, 20);
  return [
    level === "hard" ? "已硬掐断工程车。" : "当前小步已收住，后续派活保持暂停。",
    "<route1_interrupt_status>",
    `level=${level}`,
    `cancelled=${boundedCancelled.join(",") || "none"}`,
    `stopped=${running || "none"}`,
    "halted=true",
    "</route1_interrupt_status>",
  ].join("\n");
}

module.exports = {
  CONSULT_TIMEOUT_MS,
  Route1DispatchController,
  Route1DispatchIpcClient,
  SOFT_TIMEOUT_MS,
  decideBand,
  formatInterruptStatus,
  route1DispatchEnabled,
};
