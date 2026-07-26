#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const python = process.env.PYTHON || "python";

const nodeTests = [
  "test/phase1-offline-config.test.js",
  "test/phase1-memory-gates.test.js",
  "test/phase1-runtime-safety.test.js",
  "test/phase1-switch.test.js",
  "test/phase1-python-args.test.js",
  "test/memory-background-pipeline.test.js",
  "test/stream-delivery.test.js",
  "test/telegram-channel-services.test.js",
  "test/telegram-service-compat.test.js",
  "test/telegram-runtime-payload.test.js",
  "test/orchestration-release-watchdog.test.js",
  "test/writer-lease.test.js",
  "test/orchestrator-resume.test.js",
  "test/canary-runner.test.js",
  "test/canary-receipt.test.js",
];

const steps = [
  {
    name: "phase1 node tests",
    command: process.execPath,
    args: ["--test", ...nodeTests],
  },
  {
    name: "python janitor fixture tests",
    command: python,
    args: ["extensions/relationship-memory/memory-kit/tests/test_janitor.py"],
  },
  {
    name: "dashboard janitor config tests",
    command: python,
    args: ["extensions/relationship-memory/memory-kit/tests/test_dashboard_janitor_config.py"],
  },
  {
    name: "portability check",
    command: process.execPath,
    args: ["scripts/portability-check.js"],
  },
  {
    name: "PowerShell parse checks",
    run: runPowerShellParseChecks,
  },
];

for (const step of steps) {
  console.log(`\n[phase1] ${step.name}`);
  const result = step.run
    ? step.run()
    : spawnSync(step.command, step.args, {
      cwd: repoRoot,
      stdio: "inherit",
      env: process.env,
    });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log("\n[phase1] all checks passed");

function runPowerShellParseChecks() {
  const scripts = [
    ...listFiles(path.join(repoRoot, "scripts", "windows"), ".ps1"),
    ...listFiles(path.join(repoRoot, "extensions", "windows-launcher"), ".ps1"),
  ];
  if (!scripts.length) {
    console.error("No PowerShell scripts were found for parsing.");
    return { status: 1 };
  }

  const shell = resolvePowerShell();
  if (!shell) {
    if (process.platform === "win32") {
      console.error("PowerShell is required on Windows for phase1 parse checks.");
      return { status: 1 };
    }
    console.log("PowerShell parse checks skipped on non-Windows because pwsh is unavailable.");
    return { status: 0 };
  }

  for (const script of scripts) {
    const code = [
      "$tokens = $null",
      "$errors = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile(${quotePowerShell(script)}, [ref]$tokens, [ref]$errors) | Out-Null`,
      "if ($errors -and $errors.Count -gt 0) {",
      "  $errors | ForEach-Object { Write-Error $_.Message }",
      "  exit 1",
      "}",
    ].join("; ");
    const result = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", code], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      return result;
    }
    console.log(`parsed ${path.relative(repoRoot, script).replace(/\\/g, "/")}`);
  }
  return { status: 0 };
}

function listFiles(dir, extension) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(fullPath, extension));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      out.push(fullPath);
    }
  }
  return out.sort();
}

function resolvePowerShell() {
  const candidates = process.platform === "win32" ? ["powershell.exe", "pwsh.exe", "pwsh"] : ["pwsh"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return "";
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
