#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_CWD = path.resolve(__dirname, "..");
const OFFICIAL_RUNTIME_RE = /(?:^|[\\/])runtime[\\/]app[\\/]telegram[\\/]bin[\\/]cyberboss\.js(?:[\s"']|$)/i;
const LEGACY_RUNTIME_RE = /(?:^|[\\/])cyberlink[\\/]cyberboss[\\/]bin[\\/]cyberboss\.js(?:[\s"']|$)/i;
const NGINX_RE = /(?:^|[\\/ ])nginx(?:\.exe)?(?:\s|$)/i;
const DOCKER_NGINX_RE = /docker(?:\.exe)?\b.*\b(?:nginx|cyberboss-nginx)\b/i;

function collectStatus({ cwd = DEFAULT_CWD, run = defaultRun, processSnapshot = null } = {}) {
  const git = readGitStatus(cwd, run);
  const processes = processSnapshot || readProcessSnapshot(run);
  const runtime = processes.find((entry) => OFFICIAL_RUNTIME_RE.test(entry.commandLine || "")) || null;
  const legacy = processes.find((entry) => LEGACY_RUNTIME_RE.test(entry.commandLine || "")) || null;
  const hostNginx = processes.find((entry) => NGINX_RE.test(entry.commandLine || "")) || null;
  const dockerNginx = processes.find((entry) => DOCKER_NGINX_RE.test(entry.commandLine || "")) || null;
  const services = {
    runtime: classify(runtime),
    legacy: classify(legacy, "legacy"),
    watchdog: classify(processes.find((entry) => /watchdog/i.test(entry.commandLine || ""))),
    mcp: classify(processes.find((entry) => /mcp/i.test(entry.commandLine || ""))),
    nginx: hostNginx
      ? classify(hostNginx, "host")
      : dockerNginx
        ? { alive: true, pid: dockerNginx.pid || "unknown", mode: "containerized", message: "containerized (docker)" }
        : { alive: false, pid: null, mode: "containerized", message: "containerized, use docker ps" },
  };
  return {
    directory: runtime ? resolveProcessDirectory(runtime.commandLine) : "unknown (runtime process not found)",
    branch: git.branch,
    sha: git.sha,
    main: git.main,
    commitsBehindMain: git.commitsBehindMain,
    services,
  };
}

function formatStatus(status) {
  const lines = [
    "Cyberboss status",
    `Runtime directory: ${status.directory}`,
    `Git branch: ${status.branch}`,
    `Git SHA: ${status.sha}`,
    `GitHub main: ${status.main}`,
    `Commits behind main: ${status.commitsBehindMain}`,
    "Processes:",
  ];
  for (const [name, state] of Object.entries(status.services)) {
    const detail = state.pid ? ` (PID ${state.pid})` : "";
    const message = state.message ? ` — ${state.message}` : "";
    lines.push(`  ${name}: ${state.alive ? "UP" : "DOWN"}${detail}${message}`);
  }
  return `${lines.join("\n")}\n`;
}

function readGitStatus(cwd, run) {
  const branch = run("git", ["-C", cwd, "branch", "--show-current"]) || "detached HEAD";
  const sha = run("git", ["-C", cwd, "rev-parse", "--short", "HEAD"]) || "unknown";
  const main = run("git", ["-C", cwd, "rev-parse", "--short", "origin/main"]) || "unavailable";
  let commitsBehindMain = "unknown";
  if (main !== "unavailable") {
    const counts = run("git", ["-C", cwd, "rev-list", "--left-right", "--count", "HEAD...origin/main"]);
    const [, behind] = counts.split(/\s+/);
    commitsBehindMain = Number.isInteger(Number(behind)) ? Number(behind) : "unknown";
  }
  return { branch, sha, main, commitsBehindMain };
}

function readProcessSnapshot(run) {
  if (process.platform === "win32") {
    const raw = run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"]);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
        pid: Number(entry.ProcessId),
        commandLine: String(entry.CommandLine || ""),
      }));
    } catch {
      return [];
    }
  }
  const raw = run("ps", ["-eo", "pid=,args="]);
  return raw.split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
  }).filter(Boolean);
}

function resolveProcessDirectory(commandLine) {
  const quoted = commandLine.match(/["']([^"']*cyberboss\.js)\b["']/i);
  const unquoted = commandLine.match(/([^\s"']*cyberboss\.js)\b/i);
  const scriptPath = quoted?.[1] || unquoted?.[1];
  return scriptPath ? path.dirname(scriptPath) : "unknown";
}

function classify(entry, mode = null) {
  return {
    alive: Boolean(entry),
    pid: entry ? entry.pid || "unknown" : null,
    ...(mode ? { mode } : {}),
  };
}

function defaultRun(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

if (require.main === module) {
  process.stdout.write(formatStatus(collectStatus()));
}

module.exports = { collectStatus, formatStatus, readGitStatus, readProcessSnapshot, resolveProcessDirectory };
