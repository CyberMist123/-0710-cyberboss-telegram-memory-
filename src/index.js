const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("./core/config");
const { validateStartupPreflight } = require("./core/startup-preflight");
const { renderInstructionTemplate } = require("./core/instructions-template");
const { CyberbossApp } = require("./core/app");
const { runSystemCheckinPoller } = require("./app/system-checkin-poller");
const { buildTerminalHelpText } = require("./core/command-registry");
const { parseTerminalMemoryCommand } = require("./core/memory-command-router");
const { ensureStickerCatalogFilesSync } = require("./services/sticker-service");
const { createProjectTooling } = require("./tools/create-project-tooling");
const { runToolMcpServer } = require("./tools/mcp-stdio-server");

// Archive builder — optional external project, configured explicitly when used.
const ARCHIVE_BUILDER_PATH = process.env.CYBERBOSS_ARCHIVE_BUILDER_PATH
  ? path.resolve(process.env.CYBERBOSS_ARCHIVE_BUILDER_PATH)
  : "";
let archiveBuilderModule = null;
if (ARCHIVE_BUILDER_PATH) {
  try {
    archiveBuilderModule = require(ARCHIVE_BUILDER_PATH);
  } catch {} // allow missing until archive commands are used
}

function loadEnv() {
  const explicitEnvFile = process.env.CYBERBOSS_ENV_FILE
    ? path.resolve(process.env.CYBERBOSS_ENV_FILE)
    : "";
  const configEnvFile = process.env.CYBERBOSS_CONFIG_DIR
    ? path.join(path.resolve(process.env.CYBERBOSS_CONFIG_DIR), ".env")
    : "";
  const envPath = explicitEnvFile || configEnvFile;
  if (!envPath || !fs.existsSync(envPath)) {
    return "";
  }
  dotenv.config({ path: envPath, override: true });
  return envPath;
}

function ensureRuntimeEnv() {
  if (!process.env.CYBERBOSS_HOME) {
    process.env.CYBERBOSS_HOME = path.resolve(__dirname, "..");
  }
}

function ensureBootstrapFiles(config) {
  ensureInstructionsTemplate(config);
  ensureStickerCatalogFilesSync(config);
}

function ensureInstructionsTemplate(config) {
  const filePath = typeof config?.weixinInstructionsFile === "string"
    ? config.weixinInstructionsFile.trim()
    : "";
  if (!filePath || fs.existsSync(filePath)) {
    return;
  }

  const templatePath = path.resolve(__dirname, "..", "templates", "weixin-instructions.md");
  let template = "";
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    return;
  }

  const userName = String(config?.userName || "").trim() || "User";
  const content = renderInstructionTemplate(template, {
    ...config,
    userName,
  }).trimEnd() + "\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function printHelp() {
  console.log(buildTerminalHelpText());
}

let runtimeErrorHooksInstalled = false;

function installRuntimeErrorHooks() {
  if (runtimeErrorHooksInstalled) {
    return;
  }
  runtimeErrorHooksInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[cyberboss] unhandled rejection ${message}`);
  });

  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[cyberboss] uncaught exception ${message}`);
    process.exitCode = 1;
  });
}

async function main() {
  loadEnv();
  ensureRuntimeEnv();
  installRuntimeErrorHooks();
  const argv = process.argv.slice(2);
  const config = readConfig();
  const command = config.mode || "help";
  if (requiresStartupPreflight(command)) {
    validateStartupPreflight(config);
  }

  if (command !== "help" && command !== "--help" && command !== "-h" && command !== "doctor") {
    if (!config.channel) {
      console.error("[cyberboss] FATAL: CYBERBOSS_CHANNEL is not set.");
      console.error("Set CYBERBOSS_CHANNEL=telegram (or your target channel) in your environment or .env file.");
      process.exit(1);
    }
    if (config.runtime !== "claudecode") {
      console.error(`[cyberboss] FATAL: CYBERBOSS_RUNTIME is "${config.runtime}", expected "claudecode".`);
      console.error("Set CYBERBOSS_RUNTIME=claudecode in your environment or .env file.");
      process.exit(1);
    }
  }

  ensureBootstrapFiles(config);
  let app = null;
  const getApp = () => {
    if (!app) {
      app = new CyberbossApp(config);
    }
    return app;
  };

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(buildTerminalHelpText());
    return;
  }

  if (command === "doctor") {
    getApp().printDoctor();
    return;
  }

  if (command === "login") {
    await getApp().login();
    return;
  }

  if (command === "accounts") {
    getApp().printAccounts();
    return;
  }

  if (command === "memory") {
    const parsed = parseTerminalMemoryCommand(argv.slice(1));
    const output = await getApp().executeMemoryCommand(parsed);
    console.log(output);
    return;
  }

  if (command === "start") {
    await getApp().start();
    return;
  }

  if (command === "tool-mcp-server") {
    const runtimeId = readFlagValue(argv.slice(1), "--runtime-id") || "";
    const workspaceRoot = readFlagValue(argv.slice(1), "--workspace-root") || config.workspaceRoot;
    if (!workspaceRoot) {
      throw new Error("workspaceRoot is required. Set --workspace-root or CYBERBOSS_WORKSPACE.");
    }
    const { toolHost } = createProjectTooling(config);
    runToolMcpServer({ toolHost, runtimeId, workspaceRoot });
    return;
  }

  const archiveOpts = () => ({
    sourceDir: requireEnvPath("CYBERBOSS_ARCHIVE_SOURCE_DIR"),
    sourceName: "deepseek",
    aiName: process.env.CYBERBOSS_ARCHIVE_AI_NAME || "AI",
    userName: process.env.CYBERBOSS_ARCHIVE_USER_NAME || "User",
    archiveDir: requireEnvPath("CYBERBOSS_ARCHIVE_DIR"),
  });

  if (command === "build-archive") {
    if (!archiveBuilderModule) { console.error("ArchiveBuilder not found. git clone ~/archive/ first."); process.exit(1); }
    await new archiveBuilderModule.ArchiveBuilder(archiveOpts()).buildArchive();
    return;
  }

  if (command === "rebuild-archive") {
    const threadId = argv[1] || "";
    if (!threadId || !archiveBuilderModule) { console.error("Usage: cyberboss rebuild-archive <threadId>"); process.exit(1); }
    await new archiveBuilderModule.ArchiveBuilder(archiveOpts()).rebuildThread(threadId);
    return;
  }

  // ── 增量脱水（手动触发） ──
  if (command === "dehydrate-archive") {
    if (!archiveBuilderModule) { console.error("ArchiveBuilder not found. git clone ~/archive/ first."); process.exit(1); }
    const { ThreadTracker } = archiveBuilderModule;
    const tracker = new ThreadTracker({
      filePath: path.join(archiveOpts().archiveDir, ".thread-tracker.json"),
    });
    await new archiveBuilderModule.ArchiveBuilder(archiveOpts()).dehydrate({ tracker, mode: "incremental" });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = { main, loadEnv };

function requiresStartupPreflight(command) {
  const normalized = String(command || "").trim();
  return Boolean(normalized)
    && normalized !== "help"
    && normalized !== "--help"
    && normalized !== "-h";
}

function readFlagValue(args, flag) {
  if (!Array.isArray(args)) {
    return "";
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}

function requireEnvPath(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is required for archive commands.`);
  }
  return path.resolve(value);
}
