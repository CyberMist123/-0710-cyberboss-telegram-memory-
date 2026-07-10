const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("./core/config");
const { renderInstructionTemplate } = require("./core/instructions-template");
const { CyberbossApp } = require("./core/app");
const { runSystemCheckinPoller } = require("./app/system-checkin-poller");
const { buildTerminalHelpText } = require("./core/command-registry");
const { parseTerminalMemoryCommand } = require("./core/memory-command-router");
const { ensureStickerCatalogFilesSync } = require("./services/sticker-service");
const { createProjectTooling } = require("./tools/create-project-tooling");
const { runToolMcpServer } = require("./tools/mcp-stdio-server");

// Archive builder — 独立项目，处理 Cyberboss / DeepSeek conversation 脱水
const ARCHIVE_BUILDER_PATH = path.join(os.homedir(), "archive", "src", "archive-builder");
let archiveBuilderModule = null;
try {
  archiveBuilderModule = require(ARCHIVE_BUILDER_PATH);
} catch {} // allow missing

function ensureDefaultStateDirectory() {
  fs.mkdirSync(path.join(os.homedir(), ".cyberboss"), { recursive: true });
}

function loadEnv() {
  ensureDefaultStateDirectory();
  const configuredStateDir = process.env.CYBERBOSS_STATE_DIR
    ? path.resolve(process.env.CYBERBOSS_STATE_DIR)
    : path.join(os.homedir(), ".cyberboss");
  const baseCandidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".cyberboss", ".env"),
  ];
  for (const envPath of baseCandidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath, override: true });
  }
  const stateEnvPath = path.join(configuredStateDir, ".env");
  if (fs.existsSync(stateEnvPath)) {
    dotenv.config({ path: stateEnvPath, override: true });
  }
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
    const workspaceRoot = readFlagValue(argv.slice(1), "--workspace-root") || process.cwd();
    const { toolHost } = createProjectTooling(config);
    runToolMcpServer({ toolHost, runtimeId, workspaceRoot });
    return;
  }

  const archiveOpts = () => ({
    sourceDir: path.join(os.homedir(), ".deepseek", "conversations"),
    sourceName: "deepseek",
    aiName: "程言",
    userName: "安安",
    archiveDir: process.env.ARCHIVE_DIR || path.join(os.homedir(), "archive", "output"),
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

module.exports = { main };

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
