const { spawn } = require("child_process");
const crypto = require("node:crypto");
const { buildProfileLaunch, fingerprintLaunchProfile } = require("./launch-profile");
const { EFFORT_VALUES } = require("./cli-capabilities");

// Reasoning effort for the legacy (profile-less) launch.
//
// The level set is sourced from the CLI capability table, so it cannot drift
// from what the verified Claude binary actually accepts. `medium` is the
// runtime's own default: the CLI's default is not part of its stability
// contract, and a bridge whose depth of thought silently changes under it is
// worse than one that always states what it asked for.
const DEFAULT_EFFORT = "medium";
const EFFORT_SET = new Set(EFFORT_VALUES);

// Strict MCP configuration is on by default: the child must see the tool
// servers Cyberboss injected through --mcp-config and nothing else. Without it
// a stray user-level or project-level .mcp.json joins the launch, and one
// lane's route-scoped tool server stops being the only server it can reach.
const STRICT_MCP_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);

class ClaudeCodeProcessClient {
  constructor({
    command = "claude",
    commandPrefixArgs = [],
    cwd,
    env,
    model = "",
    // Per-binding reasoning effort override. Empty means "no override": the
    // env default, and then the runtime default, apply instead.
    effort = "",
    // Isolated system launches (background author, closeout) opt out entirely.
    // They answer to no chat, so no /effort choice applies to them, and an
    // unattended job must not change depth just because a deployment-wide
    // default was set for interactive turns.
    emitEffort = true,
    permissionMode = "default",
    disableVerbose = false,
    extraArgs = [],
    mcpConfigPaths = [],
    launchProfile = null,
    launchProfileBaseDir = "",
    cliCapabilities = null,
    allowAuthBackendOverride = false,
    allowCloudCredentialInheritance = false,
    g3Preflight = null,
    onLaunchTelemetry = null,
    ipcServer = null,
    workspaceRoot = "",
    // Route identity. Carried so that every event this client emits can be
    // attributed to exactly one lane / session slot / process, and so a result
    // or approval can never be delivered through another lane's client.
    laneKey = "",
    sessionSlotKey = "",
    processKey = "",
  }) {
    this.command = command;
    this.commandPrefixArgs = Array.isArray(commandPrefixArgs) ? commandPrefixArgs : [];
    this.cwd = cwd;
    this.env = env;
    this.model = model;
    this.effort = normalizeEffort(effort);
    this.emitEffort = emitEffort !== false;
    this.permissionMode = permissionMode;
    this.disableVerbose = disableVerbose;
    this.extraArgs = extraArgs;
    this.mcpConfigPaths = mcpConfigPaths;
    this.launchProfile = launchProfile || null;
    // No current-working-directory default: with a profile applied, an unset base directory
    // is a configuration error and must surface as one.
    this.launchProfileBaseDir = typeof launchProfileBaseDir === "string" ? launchProfileBaseDir.trim() : "";
    this.cliCapabilities = cliCapabilities || null;
    this.allowAuthBackendOverride = Boolean(allowAuthBackendOverride);
    this.allowCloudCredentialInheritance = Boolean(allowCloudCredentialInheritance);
    this.g3Preflight = g3Preflight?.enabled ? g3Preflight : null;
    this.launchProfileFingerprint = fingerprintLaunchProfile(this.launchProfile, {
      baseDir: this.launchProfileBaseDir,
      allowAuthBackendOverride: this.allowAuthBackendOverride,
      capabilities: this.cliCapabilities,
    });
    this.onLaunchTelemetry = typeof onLaunchTelemetry === "function" ? onLaunchTelemetry : null;
    this.ipcServer = ipcServer;
    this.workspaceRoot = workspaceRoot;
    this.laneKey = laneKey;
    this.sessionSlotKey = sessionSlotKey;
    this.processKey = processKey;
    this.launchFingerprint = "legacy";
    this.child = null;
    this.stdin = null;
    this.stdoutBuffer = "";
    this.listeners = new Set();
    this.pendingTurnId = "";
    this.sessionId = "";
    this.resumeSessionId = "";
    this.activeThreadId = "";
    this.alive = false;
    this.sessionWaiters = new Set();
    this.suppressNextCloseEvent = false;
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * True only when a turn can actually be written to this child.
   *
   * `alive` flips on the 'close' event, which arrives a tick or more after the
   * child has already gone. Checking the exit code and the stream state closes
   * that window, so a caller relaunches instead of writing into a broken pipe.
   */
  get usable() {
    return Boolean(
      this.alive
      && this.child
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.stdin
      && this.stdin.writable
      && !this.stdin.destroyed,
    );
  }

  emit(event, raw) {
    if (this.ipcServer) {
      this.ipcServer.broadcast({ type: "processEvent", event, raw });
    }
    for (const listener of this.listeners) {
      try {
        listener(event, raw);
      } catch {
        // ignore
      }
    }
  }

  async connect(resumeSessionId = "") {
    if (this.child) return;
    this.suppressNextCloseEvent = false;
    this.sessionId = "";
    this.resumeSessionId = isValidSessionId(resumeSessionId) ? resumeSessionId : "";
    this.activeThreadId = "";
    const profileLaunch = this.launchProfile
      ? buildProfileLaunch({
        profile: this.launchProfile,
        baseEnv: this.env,
        baseCwd: this.cwd,
        baseMcpConfigPaths: this.mcpConfigPaths,
        extraArgs: this.extraArgs,
        baseDir: this.launchProfileBaseDir,
        allowAuthBackendOverride: this.allowAuthBackendOverride,
        allowCloudCredentialInheritance: this.allowCloudCredentialInheritance,
        capabilities: this.cliCapabilities,
      })
      : null;

    // With a profile applied the base model / extraArgs / mcp flags are dropped
    // and rebuilt from the validated profile, so an unvalidated flag can never
    // sit alongside a validated one.
    const args = buildArgs({
      model: profileLaunch ? "" : this.model,
      effort: profileLaunch ? "" : this.effort,
      emitEffort: this.emitEffort,
      permissionMode: this.permissionMode,
      disableVerbose: this.disableVerbose,
      extraArgs: profileLaunch ? [] : this.extraArgs,
      mcpConfigPaths: profileLaunch ? [] : this.mcpConfigPaths,
      resumeSessionId,
      // A validated profile owns --effort and --strict-mcp-config exactly as it
      // owns --model and --mcp-config, so the base launch must not emit its own
      // copy alongside the profile's.
      profileManaged: Boolean(profileLaunch),
    });
    const launchArgs = profileLaunch ? [...args, ...profileLaunch.args] : args;
    const launchCwd = profileLaunch ? profileLaunch.cwd : this.cwd;
    const launchEnv = profileLaunch ? profileLaunch.env : this.env;
    this.launchFingerprint = profileLaunch ? profileLaunch.launchFingerprint : "legacy";
    if (profileLaunch?.telemetry && this.onLaunchTelemetry) {
      const telemetry = this.g3Preflight
        ? Object.freeze({
          ...profileLaunch.telemetry,
          cli_version: this.g3Preflight.cli.cli_version,
          cli_help_hash: this.g3Preflight.cli.help_sha256,
          session_slot_token: crypto.createHash("sha256").update(this.sessionSlotKey, "utf8").digest("hex").slice(0, 24),
          native_session_present: Boolean(this.resumeSessionId),
        })
        : profileLaunch.telemetry;
      this.onLaunchTelemetry(telemetry);
    }
    const mcpLabel = profileLaunch
      ? `${profileLaunch.mcpConfigMode}:${profileLaunch.mcpConfigPaths.length}`
      : (this.mcpConfigPaths.length ? this.mcpConfigPaths.join(",") : "(none)");
    console.log(
      `[claudecode-runtime] launching command=${this.command} cwd=${launchCwd} mcp_config=${mcpLabel}`
    );
    const child = spawn(this.command, [...this.commandPrefixArgs, ...launchArgs], {
      cwd: launchCwd,
      env: launchEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.stdin = child.stdin;
    this.alive = true;

    child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        this.handleLine(line.trim());
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        console.error(`[claudecode-runtime] stderr: ${text}`);
        if (this.ipcServer && !isPotentiallySensitive(text)) {
          this.ipcServer.broadcast({ type: "stderr", text });
        }
      }
    });

    child.stdin.on("error", (err) => {
      // A broken pipe means the child is gone. Surface it as a turn failure
      // rather than an uncaught exception that would take the bridge down.
      this.alive = false;
      this.rejectSessionWaiters(err);
      this.emit({
        type: "process.error",
        error: err.message,
        sessionId: this.activeThreadId || this.sessionId,
        turnId: this.pendingTurnId,
      }, null);
    });

    child.on("error", (err) => {
      this.rejectSessionWaiters(err);
      this.alive = false;
      this.child = null;
      this.stdin = null;
      this.emit({ type: "process.error", error: err.message, sessionId: this.activeThreadId || this.sessionId, turnId: this.pendingTurnId }, null);
    });

    child.on("close", (code) => {
      this.rejectSessionWaiters(new Error(`claudecode process closed with code ${code ?? "unknown"}`));
      this.alive = false;
      this.child = null;
      this.stdin = null;
      if (this.suppressNextCloseEvent) {
        this.suppressNextCloseEvent = false;
        return;
      }
      this.emit({ type: "process.close", code, sessionId: this.activeThreadId || this.sessionId, turnId: this.pendingTurnId }, null);
    });
  }

  handleLine(line) {
    if (!line) return;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const eventType = raw?.type;
    switch (eventType) {
      case "system":
        if (raw.session_id) {
          const reportedSessionId = this.acceptReportedSessionId(raw.session_id, raw);
          if (reportedSessionId) {
            this.emit({ type: "session.id", sessionId: reportedSessionId }, raw);
          }
        }
        break;
      case "assistant":
        this.handleAssistant(raw);
        break;
      case "user":
        this.handleUser(raw);
        break;
      case "result":
        this.handleResult(raw);
        break;
      case "control_request":
        this.handleControlRequest(raw);
        break;
      case "control_cancel_request":
        break;
    }
  }

  handleAssistant(raw) {
    const usage = raw?.message?.usage;
    if (usage && typeof usage === "object") {
      this.emit({
        type: "context.updated",
        usage,
        turnId: this.pendingTurnId,
        sessionId: this.activeThreadId || this.sessionId,
      }, raw);
    }
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const itemType = item.type;
      if (itemType === "text" && typeof item.text === "string" && item.text) {
        this.emit({
          type: "assistant.text",
          text: item.text.trim(),
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      } else if (itemType === "tool_use") {
        const toolName = typeof item.name === "string" ? item.name : "";
        if (toolName === "AskUserQuestion") continue;
        this.emit({
          type: "tool.use",
          toolName,
          input: item.input || {},
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      } else if (itemType === "thinking" && typeof item.thinking === "string" && item.thinking) {
        this.emit({
          type: "thinking",
          text: item.thinking.trim(),
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      }
    }
  }

  handleUser(raw) {
    const content = raw?.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "tool_result") {
        const isError = Boolean(item.is_error);
        const resultText = typeof item.content === "string" ? item.content : "";
        this.emit({
          type: "tool.result",
          toolResult: resultText,
          isError,
          turnId: this.pendingTurnId,
          sessionId: this.activeThreadId || this.sessionId,
        }, raw);
      }
    }
  }

  handleResult(raw) {
    if (raw.session_id) {
      const reportedSessionId = this.acceptReportedSessionId(raw.session_id, raw);
      if (!reportedSessionId) {
        return;
      }
    }
    this.emit({
      type: "turn.completed",
      turnId: this.pendingTurnId,
      sessionId: this.activeThreadId || this.sessionId,
      text: typeof raw.result === "string" ? raw.result.trim() : "",
    }, raw);
    this.pendingTurnId = "";
    this.activeThreadId = "";
  }

  acceptReportedSessionId(sessionId, raw) {
    const reportedSessionId = normalizeSessionId(sessionId);
    if (!reportedSessionId) {
      return "";
    }
    const expectedSessionId = normalizeSessionId(this.activeThreadId || this.resumeSessionId);
    if (expectedSessionId && reportedSessionId !== expectedSessionId) {
      this.rejectUnexpectedSessionId(expectedSessionId, reportedSessionId, raw);
      return "";
    }
    if (this.pendingTurnId && !this.activeThreadId) {
      this.activeThreadId = reportedSessionId;
    }
    this.sessionId = reportedSessionId;
    this.resumeSessionId = "";
    this.resolveSessionWaiters(reportedSessionId);
    return reportedSessionId;
  }

  rejectUnexpectedSessionId(expectedSessionId, reportedSessionId, raw) {
    this.suppressNextCloseEvent = true;
    this.emit({
      type: "process.error",
      error: `claudecode resumed unexpected session id: ${reportedSessionId}`,
      sessionId: expectedSessionId,
      turnId: this.pendingTurnId,
    }, raw);
    setImmediate(() => {
      this.close().catch(() => {});
    });
  }

  handleControlRequest(raw) {
    const request = raw?.request || {};
    if (request.subtype !== "can_use_tool") return;
    this.emit({
      type: "approval.requested",
      requestId: raw.request_id,
      toolName: request.tool_name,
      input: request.input,
      sessionId: this.activeThreadId || this.sessionId,
      turnId: this.pendingTurnId,
    }, raw);
  }

  async sendUserMessage({ text, threadId }) {
    if (!this.usable) {
      throw new Error("claudecode process not running");
    }
    this.pendingTurnId = `turn-${Date.now()}`;
    this.activeThreadId = threadId || this.sessionId;
    if (this.ipcServer) {
      this.ipcServer.broadcast({
        type: "inboundMessage",
        workspaceRoot: this.workspaceRoot,
        text,
      });
    }
    const payload = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    await new Promise((resolve, reject) => {
      this.stdin.write(`${payload}\n`, (error) => (error ? reject(error) : resolve()));
    });
    this.emit({
      type: "turn.started",
      turnId: this.pendingTurnId,
      sessionId: this.activeThreadId,
    }, null);
  }

  async sendResponse(requestId, { decision }) {
    if (!this.usable) {
      throw new Error("claudecode process not running");
    }
    const behavior = decision === "accept" ? "allow" : "deny";
    const response = behavior === "allow"
      ? { behavior: "allow", updatedInput: {} }
      : { behavior: "deny", message: "The user denied this tool use. Stop and wait for the user's instructions." };
    const payload = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    });
    this.stdin.write(payload + "\n");
  }

  async waitForSessionId({ timeoutMs = 5000 } = {}) {
    if (this.sessionId) {
      return this.sessionId;
    }
    if (!this.alive) {
      throw new Error("claudecode process not running");
    }
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    return await new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        this.sessionWaiters.delete(entry);
        reject(new Error("timed out waiting for claudecode session id"));
      }, timeout);
      this.sessionWaiters.add(entry);
    });
  }

  async close() {
    if (!this.child) return;
    if (this.stdin && !this.stdin.destroyed) {
      this.stdin.end();
    }
    if (this.child && !this.child.killed) {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 2000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 3000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    if (this.child && !this.child.killed) {
      this.child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 1000)),
        new Promise((resolve) => this.child.once("close", resolve)),
      ]);
    }
    this.alive = false;
    this.child = null;
    this.stdin = null;
    this.sessionId = "";
    this.resumeSessionId = "";
    this.activeThreadId = "";
    this.pendingTurnId = "";
    this.rejectSessionWaiters(new Error("claudecode process closed"));
  }

  resolveSessionWaiters(sessionId) {
    if (!this.sessionWaiters.size) {
      return;
    }
    for (const entry of this.sessionWaiters) {
      clearTimeout(entry.timer);
      entry.resolve(sessionId);
    }
    this.sessionWaiters.clear();
  }

  rejectSessionWaiters(error) {
    if (!this.sessionWaiters.size) {
      return;
    }
    for (const entry of this.sessionWaiters) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.sessionWaiters.clear();
  }
}

function normalizeEffort(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EFFORT_SET.has(normalized) ? normalized : "";
}

/**
 * Reasoning effort actually handed to the child.
 *
 * Precedence, most specific first:
 *   1. the binding's own override (/effort in a chat)
 *   2. CYBERBOSS_CLAUDE_EFFORT, the deployment-wide default
 *   3. DEFAULT_EFFORT
 *
 * An unrecognised value at any level is not an error here -- it simply does not
 * win, and the next level down applies. Rejecting the operator's typo is the
 * command layer's job; a launch must not be blocked by it.
 */
function resolveEffortLevel(requested = "", env = process.env) {
  return normalizeEffort(requested)
    || normalizeEffort(env?.CYBERBOSS_CLAUDE_EFFORT)
    || DEFAULT_EFFORT;
}

function resolveStrictMcpConfig(env = process.env) {
  const raw = typeof env?.CYBERBOSS_CLAUDE_STRICT_MCP === "string"
    ? env.CYBERBOSS_CLAUDE_STRICT_MCP.trim().toLowerCase()
    : "";
  return !STRICT_MCP_DISABLE_VALUES.has(raw);
}

/**
 * True when the operator already passes this flag through
 * CYBERBOSS_CLAUDE_EXTRA_ARGS, in either `--flag value` or `--flag=value` form.
 * An explicit extra arg wins: emitting the runtime's copy as well would hand the
 * CLI the same flag twice and leave which one applies up to its parser.
 */
function extraArgsContainFlag(extraArgs, flag) {
  if (!Array.isArray(extraArgs)) {
    return false;
  }
  return extraArgs.some((arg) => {
    if (typeof arg !== "string") {
      return false;
    }
    const trimmed = arg.trim();
    return trimmed === flag || trimmed.startsWith(`${flag}=`);
  });
}

function buildArgs({
  model,
  permissionMode,
  disableVerbose,
  extraArgs,
  mcpConfigPaths,
  resumeSessionId,
  effort = "",
  emitEffort = true,
  profileManaged = false,
  env = process.env,
}) {
  const args = [
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--permission-prompt-tool", "stdio",
  ];
  if (!disableVerbose) {
    args.push("--verbose");
  }
  if (permissionMode && permissionMode !== "default") {
    args.push("--permission-mode", permissionMode);
  }
  if (resumeSessionId && isValidSessionId(resumeSessionId)) {
    args.push("--resume", resumeSessionId);
  }
  if (model) {
    args.push("--model", model);
  }
  if (!profileManaged && emitEffort !== false && !extraArgsContainFlag(extraArgs, "--effort")) {
    args.push("--effort", resolveEffortLevel(effort, env));
  }
  if (Array.isArray(mcpConfigPaths)) {
    for (const configPath of mcpConfigPaths) {
      if (typeof configPath === "string" && configPath.trim()) {
        args.push("--mcp-config", configPath.trim());
      }
    }
  }
  if (!profileManaged
    && resolveStrictMcpConfig(env)
    && !extraArgsContainFlag(extraArgs, "--strict-mcp-config")) {
    args.push("--strict-mcp-config");
  }
  if (Array.isArray(extraArgs)) {
    const safe = extraArgs.filter((arg) =>
      typeof arg === "string" && arg.length > 0 && !/^-[ce]\b/i.test(arg)
    );
    args.push(...safe);
  }
  return args;
}

function isValidSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

function normalizeSessionId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

const SENSITIVE_KEYWORDS = /\b(?:key|token|secret|password|credential|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\b/i;
const SENSITIVE_PATTERNS = /\b(?:sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9_\-]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36})\b/i;

function isPotentiallySensitive(text) {
  return SENSITIVE_KEYWORDS.test(text) || SENSITIVE_PATTERNS.test(text);
}

module.exports = {
  ClaudeCodeProcessClient,
  DEFAULT_EFFORT,
  EFFORT_VALUES,
  buildArgs,
  normalizeEffort,
  resolveEffortLevel,
  resolveStrictMcpConfig,
  extraArgsContainFlag,
  isPotentiallySensitive,
};
