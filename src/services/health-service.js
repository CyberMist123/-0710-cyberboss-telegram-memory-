"use strict";

// Read-only bridge from the Node tool host to the Collar_watch Python health
// store. cyberboss ships no MCP client SDK, so each call spawns Python and runs
// the existing `health_store` logic in-process there, exactly like
// local-whisper-transcriber.js spawns its transcriber.
//
// Single-writer discipline (CLAUDE.md §三.4): this service exposes only the two
// read paths — `health_now` and `execute_health_detail`. It never touches
// `create_command` / `execute_measure_heart_rate`, which write command.json and
// would be a second writer.
//
// Robustness: bounded timeout, bounded stdout, non-zero exit throws a clean
// coded Error. Raw health values are never placed into thrown messages or logs;
// only the parsed structured result is returned to the caller.

const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;

// `health_now()` is sync and may return a dict or a short status string; keep
// both by JSON-encoding whatever it returns. `execute_health_detail` is async
// and already returns a JSON string, so it is printed verbatim.
const NOW_SCRIPT =
  "import health_store,json;print(json.dumps(health_store.health_now(),default=str))";
const DETAIL_SCRIPT =
  "import sys,json,asyncio,health_store;print(asyncio.run(health_store.execute_health_detail(json.loads(sys.argv[1]))))";

function createHealthService({ config } = {}) {
  const resolved = config || {};
  const command = normalizeText(resolved.healthPython) || "python";
  const serverDir = normalizeText(resolved.healthServerDir);
  const dataDir = normalizeText(resolved.healthDataDir);
  const timeoutMs = Number.isInteger(resolved.healthTimeoutMs) && resolved.healthTimeoutMs > 0
    ? resolved.healthTimeoutMs
    : DEFAULT_TIMEOUT_MS;

  function runBridge(args) {
    return runHealthProcess({
      command,
      args,
      cwd: serverDir || undefined,
      dataDir,
      timeoutMs,
    });
  }

  return {
    async now() {
      return runBridge(["-c", NOW_SCRIPT]);
    },
    async detail({ metric, start, end, date } = {}) {
      // Map the tool's field names onto health_store's argument keys. Undefined
      // fields are dropped so the store applies its own defaults.
      const payload = {};
      if (metric !== undefined && metric !== null && metric !== "") payload.metric = String(metric);
      if (start !== undefined && start !== null && start !== "") payload.from = String(start);
      if (end !== undefined && end !== null && end !== "") payload.to = String(end);
      if (date !== undefined && date !== null && date !== "") payload.date = String(date);
      return runBridge(["-c", DETAIL_SCRIPT, JSON.stringify(payload)]);
    },
  };
}

function runHealthProcess({ command, args, cwd, dataDir, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (dataDir) env.HEALTH_DATA_DIR = dataDir;
    // Python must be able to `import health_store` from the Collar_watch server
    // dir. cwd is the primary seam; also seed PYTHONPATH so it works even if a
    // future caller runs from elsewhere.
    if (cwd) env.PYTHONPATH = env.PYTHONPATH ? `${cwd}${pathSep()}${env.PYTHONPATH}` : cwd;

    let child;
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      reject(healthError("health_python_spawn_failed"));
      return;
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (code) => {
      try { child.kill(); } catch {}
      finish(reject, healthError(code));
    };

    timer = setTimeout(() => fail("health_bridge_timeout"), Math.max(1, Number(timeoutMs) || 1));

    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes + bytes.length > DEFAULT_MAX_OUTPUT_BYTES) { fail("health_output_limit"); return; }
      stdoutBytes += bytes.length;
      stdoutChunks.push(bytes);
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Drained but not retained beyond a small cap; stderr may carry a Python
      // traceback and must never enter a thrown message or a log line.
      stderrBytes += bytes.length;
      if (stderrBytes > DEFAULT_MAX_STDERR_BYTES) { fail("health_stderr_limit"); }
    });
    child.on("error", (error) => finish(reject, healthError(classifyProcessError(error))));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) { finish(reject, healthError("health_bridge_exit")); return; }
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8").trim());
      } catch {
        finish(reject, healthError("health_invalid_output"));
        return;
      }
      finish(resolve, payload);
    });
  });
}

function pathSep() {
  return process.platform === "win32" ? ";" : ":";
}

function classifyProcessError(error) {
  if (error?.code === "ENOENT") return "health_python_not_found";
  return "health_python_spawn_failed";
}

function healthError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { createHealthService };
