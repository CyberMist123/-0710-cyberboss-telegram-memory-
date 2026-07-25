"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class LocalWhisperTranscriber {
  constructor(config = {}) {
    this.config = config;
    this.enabled = config.localWhisperEnabled === true;
  }

  async transcribe({ filePath, language = "" } = {}) {
    if (!this.enabled) return { ok: false, provider: "local-whisper", error: "disabled" };
    const inputPath = String(filePath || "").trim();
    if (!inputPath) return { ok: false, provider: "local-whisper", error: "input_missing" };
    let stat;
    try { stat = fs.statSync(inputPath); } catch { return { ok: false, provider: "local-whisper", error: "input_unreadable" }; }
    if (!stat.isFile()) return { ok: false, provider: "local-whisper", error: "input_not_file" };
    if (this.config.localWhisperMaxInputBytes && stat.size > this.config.localWhisperMaxInputBytes) {
      return { ok: false, provider: "local-whisper", error: "input_too_large" };
    }
    const modelPath = resolveExistingLocalModel(this.config.localWhisperModel);
    if (!modelPath) return { ok: false, provider: "local-whisper", error: "model_missing" };
    const scriptPath = path.resolve(__dirname, "../../tools/transcribe-file.py");
    const args = [
      scriptPath,
      "--input", inputPath,
      "--model", modelPath,
      "--device", String(this.config.localWhisperDevice || "cpu"),
      "--compute-type", String(this.config.localWhisperComputeType || "int8"),
      "--max-audio-seconds", String(this.config.localWhisperMaxAudioSeconds || 180),
      "--max-output-chars", String(this.config.localWhisperMaxOutputChars || 4000),
    ];
    if (language) args.push("--language", String(language));
    return runWhisperProcess({
      command: String(this.config.localWhisperPythonCommand || "python"),
      args,
      timeoutMs: this.config.localWhisperTimeoutMs || 120_000,
      maxOutputChars: this.config.localWhisperMaxOutputChars || 4000,
      maxStderrChars: this.config.localWhisperMaxStderrChars || 4000,
    });
  }
}

function runWhisperProcess({ command, args, timeoutMs, maxOutputChars, maxStderrChars }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, provider: "local-whisper", error: "python_spawn_failed" });
      return;
    }
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let abortPromise = null;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const abort = (error) => {
      if (abortPromise) return abortPromise;
      abortPromise = (async () => {
        clearTimeout(timer);
        await terminateProcessTree(child);
        finish({ ok: false, provider: "local-whisper", error });
      })();
      return abortPromise;
    };
    timer = setTimeout(() => { void abort("timeout"); }, Math.max(1, Number(timeoutMs) || 1));
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stdoutBytes + bytes.length > maxOutputChars) {
        void abort("stdout_limit");
        return;
      }
      stdoutBytes += bytes.length;
      stdoutChunks.push(bytes);
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrBytes + bytes.length > maxStderrChars) {
        void abort("stderr_limit");
        return;
      }
      stderrBytes += bytes.length;
    });
    child.on("error", (error) => finish({ ok: false, provider: "local-whisper", error: classifyProcessError(error) }));
    child.on("close", (code) => {
      if (settled || abortPromise) return;
      if (code !== 0) {
        finish({ ok: false, provider: "local-whisper", error: `process_exit_${code ?? "unknown"}` });
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8").trim());
        if (payload?.error) {
          finish({ ok: false, provider: "local-whisper", error: sanitizeProviderError(payload.error) });
          return;
        }
        const text = typeof payload?.text === "string" ? payload.text.trim() : "";
        if (!text) finish({ ok: false, provider: "local-whisper", error: "empty_transcription" });
        else finish({ ok: true, provider: "local-whisper", text, model: payload.model || "", elapsedMs: payload.elapsedMs || 0 });
      } catch {
        finish({ ok: false, provider: "local-whisper", error: "invalid_output" });
      }
    });
  });
}

async function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await runTerminator("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    await waitForChildClose(child, 5_000);
    return;
  }
  try { child.kill("SIGTERM"); } catch {}
  if (await waitForChildClose(child, 1_000)) return;
  try { child.kill("SIGKILL"); } catch {}
  await waitForChildClose(child, 5_000);
}

function runTerminator(command, args) {
  return new Promise((resolve) => {
    let killer;
    try { killer = spawn(command, args, { shell: false, windowsHide: true, stdio: "ignore" }); } catch { resolve(); return; }
    killer.once("error", resolve);
    killer.once("close", resolve);
  });
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const onClose = () => { cleanup(); resolve(true); };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
    };
    child.once("close", onClose);
  });
}

function sanitizeProviderError(value) {
  const code = String(value || "").trim();
  return ["model_missing", "provider_dependency_missing", "audio_duration_limit", "output_limit", "transcription_failed"].includes(code)
    ? code
    : "transcription_failed";
}

function resolveExistingLocalModel(value) {
  const configured = String(value || "").trim();
  if (!configured || !path.isAbsolute(configured)) return "";
  try {
    const resolved = fs.realpathSync(configured);
    return fs.statSync(resolved).isDirectory() ? resolved : "";
  } catch {
    return "";
  }
}

function classifyProcessError(error) {
  if (error?.code === "ENOENT") return "python_not_found";
  return "python_spawn_failed";
}

module.exports = { LocalWhisperTranscriber, runWhisperProcess, resolveExistingLocalModel };
