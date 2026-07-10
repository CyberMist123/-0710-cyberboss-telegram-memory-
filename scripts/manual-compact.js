const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");
const { readConfig } = require("../src/core/config");
const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode");
const { CompactStateStore } = require("../src/core/compact-state-store");
const { CYBERBOSS_COMPACT_INSTRUCTIONS } = require("../src/core/compact-instructions");

async function main() {
  loadEnv();
  ensureRuntimeEnv();
  const config = readConfig();
  const runtime = createClaudeCodeRuntimeAdapter(config);
  const compactStateStore = new CompactStateStore({
    stateFile: config.compactStateFile,
    historyDir: config.compactHistoryDir,
    pendingDir: config.compactPendingDir,
    transcriptRoot: path.join(os.homedir(), ".claude", "projects"),
  });
  compactStateStore.ensureDirectories();
  const sessionStore = runtime.getSessionStore();
  const binding = sessionStore.listBindings().find((entry) =>
    normalizeText(entry.activeWorkspaceRoot) === normalizeText(config.workspaceRoot)
    && normalizeText(entry.accountId) === "telegram"
  ) || sessionStore.listBindings()[0];
  if (!binding?.bindingKey) {
    throw new Error("No active Telegram binding found in sessions.json");
  }
  const workspaceRoot = binding.activeWorkspaceRoot || config.workspaceRoot;
  const threadId = sessionStore.getThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
  if (!threadId) {
    throw new Error("No active thread found for the current workspace");
  }
  const tokenUsageBeforeCompact = readLatestInputUsage({ config, threadId });
  const effectiveTurnCountBeforeCompact = compactStateStore.countEffectiveTurns({ threadId });
  const compactSequence = compactStateStore.getThreadState(threadId).compactCount + 1;
  compactStateStore.writePendingCompact(threadId, {
    timestamp: new Date().toISOString(),
    threadId,
    trigger: "manual_script",
    tokenUsageBeforeCompact,
    effectiveTurnCountBeforeCompact,
    compactSequence,
  });

  try {
    await runtime.initialize();
    const result = await waitForCompactAndRefresh({
      runtime,
      workspaceRoot,
      threadId,
      model: sessionStore.getRuntimeParamsForWorkspace(binding.bindingKey, workspaceRoot).model,
    });
    const afterUsage = result.latestContext ? summarizeInputUsage(result.latestContext) : null;
    compactStateStore.saveThreadState(threadId, {
      compactCount: compactSequence,
      lastCompactAt: new Date().toISOString(),
      lastCompactTokens: tokenUsageBeforeCompact.currentInputTokens,
      lastCompactTurnCount: effectiveTurnCountBeforeCompact,
      rolloverRecommended: compactSequence >= Math.max(1, Number(config.autoCompactMaxPerThread) || 2),
      lastError: "",
    });
    console.log(JSON.stringify({
      threadId,
      tokenUsageBeforeCompact,
      tokenUsageAfterCompact: afterUsage,
      effectiveTurnCountBeforeCompact,
      effectiveTurnCountAfterCompact: compactStateStore.countEffectiveTurns({ threadId }),
    }, null, 2));
  } finally {
    compactStateStore.clearPendingCompact(threadId);
    await runtime.close().catch(() => {});
  }
}

async function waitForCompactAndRefresh({ runtime, workspaceRoot, threadId, model = "" }) {
  let compactTurnId = "";
  let latestContext = null;
  let compactFinished = false;
  let currentPhase = "compact";
  let timeout = null;

  const done = new Promise((resolve, reject) => {
    const cleanup = runtime.onEvent(async (event) => {
      if (event?.type === "runtime.context.updated" && normalizeText(event?.payload?.threadId) === normalizeText(threadId)) {
        latestContext = event.payload;
      }
      if (event?.type === "runtime.turn.failed" && normalizeText(event?.payload?.threadId) === normalizeText(threadId)) {
        clearTimeout(timeout);
        cleanup();
        reject(new Error(event?.payload?.text || `${currentPhase} failed`));
        return;
      }
      if (event?.type !== "runtime.turn.completed" || normalizeText(event?.payload?.threadId) !== normalizeText(threadId)) {
        return;
      }
      if (!compactFinished && normalizeText(event?.payload?.turnId) === normalizeText(compactTurnId)) {
        compactFinished = true;
        try {
          currentPhase = "refresh";
          await runtime.refreshThreadInstructions({ threadId, workspaceRoot, model });
          setTimeout(() => {
            clearTimeout(timeout);
            cleanup();
            resolve({ latestContext });
          }, 6000);
        } catch (error) {
          clearTimeout(timeout);
          cleanup();
          reject(error);
        }
        return;
      }
    });

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for compact/refresh to finish"));
    }, 120000);
  });

  const result = await runtime.compactThread({
    threadId,
    workspaceRoot,
    model,
    instructions: CYBERBOSS_COMPACT_INSTRUCTIONS,
  });
  compactTurnId = normalizeText(result?.turnId);
  return done;
}

function loadEnv() {
  const configuredStateDir = process.env.CYBERBOSS_STATE_DIR
    ? path.resolve(process.env.CYBERBOSS_STATE_DIR)
    : path.join(os.homedir(), ".cyberboss");
  const baseCandidates = [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".cyberboss", ".env"),
  ];
  for (const envPath of baseCandidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: true });
    }
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

function readLatestInputUsage({ config, threadId }) {
  const conversationFile = resolveLatestConversationFile(config.conversationDir);
  if (!conversationFile) {
    return {
      inputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      currentInputTokens: null,
    };
  }
  try {
    const lines = fs.readFileSync(conversationFile, "utf8").trim().split("\n").reverse();
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry?.type !== "runtime.context.updated") continue;
      if (normalizeText(entry?.threadId) !== normalizeText(threadId)) continue;
      return summarizeInputUsage(entry.meta || entry.payload || {});
    }
  } catch {
    // ignore
  }
  return {
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    currentInputTokens: null,
  };
}

function summarizeInputUsage(payload = {}) {
  const inputTokens = safeNumber(payload.inputTokens ?? payload.input_tokens);
  const cacheCreationInputTokens = safeNumber(payload.cacheCreationInputTokens ?? payload.cache_creation_input_tokens);
  const cacheReadInputTokens = safeNumber(payload.cacheReadInputTokens ?? payload.cache_read_input_tokens);
  return {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    currentInputTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

function resolveLatestConversationFile(conversationDir = "") {
  if (!conversationDir || !fs.existsSync(conversationDir)) {
    return "";
  }
  const candidates = fs.readdirSync(conversationDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(conversationDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  return candidates[0] || "";
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
