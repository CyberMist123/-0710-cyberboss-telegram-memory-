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
  // closeout 提示词的宪法要素（issue #35）；phase1 已接进 .github/workflows/phase1-offline.yml。
  "test/closeout-letter-prompt.test.js",
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

  // 一个进程检查全部文件，不是一个文件一个进程。ParseFile 本身 16 个文件加
  // 起来不到 1 秒，而 powershell.exe 冷启动在 windows-latest 上约 9 秒 —— 旧写
  // 法让 CI 的 phase1 步骤 180 秒里有约 150 秒纯粹花在反复启动 PowerShell 上。
  // 检查范围与逐个起进程时完全一致：仍然对每个文件调一次 ParseFile，仍然逐个
  // 报错，只是全部错误一次报完再退出，而不是撞到第一个就中止。
  const code = [
    `$files = @(${scripts.map(quotePowerShell).join(", ")})`,
    "$failed = 0",
    "foreach ($file in $files) {",
    "  $tokens = $null",
    "  $errors = $null",
    "  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors) | Out-Null",
    "  if ($errors -and $errors.Count -gt 0) {",
    "    $failed = 1",
    "    $errors | ForEach-Object { Write-Error ('{0}: {1}' -f $file, $_.Message) }",
    "  } else {",
    "    Write-Output ('parsed {0}' -f $file)",
    "  }",
    "}",
    "exit $failed",
  ].join("\n");
  return spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", code], {
    cwd: repoRoot,
    stdio: "inherit",
  });
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
