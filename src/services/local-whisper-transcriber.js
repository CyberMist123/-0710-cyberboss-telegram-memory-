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
    const scriptPath = path.resolve(__dirname, "../../tools/transcribe-file.py");
    const args = [
      scriptPath,
      "--input", inputPath,
      "--model", String(this.config.localWhisperModel || "small"),
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
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = setTimeout(() => {
      terminateProcessTree(child);
      finish({ ok: false, provider: "local-whisper", error: "timeout" });
    }, Math.max(1, Number(timeoutMs) || 1));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > maxOutputChars) {
        terminateProcessTree(child);
        finish({ ok: false, provider: "local-whisper", error: "stdout_limit" });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > maxStderrChars) {
        terminateProcessTree(child);
        finish({ ok: false, provider: "local-whisper", error: "stderr_limit" });
      }
    });
    child.on("error", (error) => finish({ ok: false, provider: "local-whisper", error: classifyProcessError(error) }));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ ok: false, provider: "local-whisper", error: `process_exit_${code ?? "unknown"}` });
        return;
      }
      try {
        const payload = JSON.parse(stdout.trim());
        const text = typeof payload?.text === "string" ? payload.text.trim() : "";
        if (!text) finish({ ok: false, provider: "local-whisper", error: "empty_transcription" });
        else finish({ ok: true, provider: "local-whisper", text, model: payload.model || "", elapsedMs: payload.elapsedMs || 0 });
      } catch {
        finish({ ok: false, provider: "local-whisper", error: "invalid_output" });
      }
    });
  });
}

function terminateProcessTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { shell: false, windowsHide: true, stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  } catch {}
}

function classifyProcessError(error) {
  if (error?.code === "ENOENT") return "python_not_found";
  return "python_spawn_failed";
}

module.exports = { LocalWhisperTranscriber, runWhisperProcess };
