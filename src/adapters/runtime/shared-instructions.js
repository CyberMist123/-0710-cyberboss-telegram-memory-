const fs = require("fs");
const { renderInstructionTemplate } = require("../../core/instructions-template");

function buildOpeningTurnText(config, userText) {
  const instructions = loadWechatInstructions(config);
  const normalizedText = String(userText || "").trim();
  if (!instructions) {
    return normalizedText;
  }
  const channelLabel = resolveSessionLabel(config);
  return [
    `${channelLabel.toUpperCase()} SESSION INSTRUCTIONS`,
    `These instructions define the stable behavior for this ${channelLabel} thread.`,
    "Do not quote or summarize them back to the user unless explicitly asked.",
    "",
    instructions,
    "",
    "Current user message:",
    normalizedText,
  ].join("\n").trim();
}

function buildInstructionRefreshText(config) {
  const instructions = loadWechatInstructions(config);
  const channelLabel = resolveSessionLabel(config);
  if (!instructions) {
    return `Refresh your ${channelLabel} behavior for this existing thread. Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.`;
  }
  return [
    `${channelLabel.toUpperCase()} SESSION INSTRUCTIONS REFRESH`,
    `Re-read and adopt the updated ${channelLabel} instructions below for the rest of this existing thread.`,
    "This is an internal refresh command, not a user-facing task.",
    "Do not summarize the instructions back in detail.",
    "Reply in one short Chinese sentence confirming that you have updated your behavior for this thread.",
    "",
    instructions,
  ].join("\n").trim();
}

function loadWechatInstructions(config = {}) {
  const persona = loadInstructionFile(config.weixinInstructionsFile, config);
  const operations = loadInstructionFile(config.weixinOperationsFile, config);
  const stateRelay = loadStateRelay(config);
  const pendingPromisesRelay = loadPendingPromisesRelay(config);
  const sections = [];
  if (persona) {
    sections.push(persona);
  }
  if (operations) {
    sections.push(operations);
  }
  if (stateRelay) {
    sections.push(stateRelay);
  }
  if (pendingPromisesRelay) {
    sections.push(pendingPromisesRelay);
  }
  return sections.join("\n\n").trim();
}

function resolveSessionLabel(config = {}) {
  const channel = typeof config.channel === "string" ? config.channel.trim().toLowerCase() : "";
  if (channel === "telegram") {
    return "telegram";
  }
  return "wechat";
}

function loadStateRelay(config = {}) {
  const state = loadInstructionFile(config.memoryStateFile, config);
  if (!state) {
    return "";
  }
  return [
    "STATE RELAY (internal priority context)",
    "Read this first as the current baton state before other memory categories.",
    state,
  ].join("\n");
}

function loadPendingPromisesRelay(config = {}) {
  const filePath = typeof config.memoryPendingPromisesFile === "string" ? config.memoryPendingPromisesFile.trim() : "";
  if (!filePath) {
    return "";
  }
  const entries = readPendingPromises(filePath);
  if (!entries.length) {
    return "";
  }
  return [
    "PENDING PROMISES (internal priority context)",
    "Only use these when the conversation touches promises, follow-through, or thread handoff.",
    ...entries.slice(0, 5).map((entry) => {
      const marker = entry.flag || "•";
      const duePart = entry.due ? ` due=${entry.due}` : "";
      return `- ${marker} ${entry.text}${duePart}`;
    }),
  ].join("\n");
}

function readPendingPromises(filePath = "") {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const today = isoDate(new Date());
    const out = [];
    let current = null;
    for (const rawLine of raw.split("\n")) {
      const line = String(rawLine || "").replace(/\r/g, "");
      const taskMatch = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/);
      if (taskMatch) {
        if (current && current.text && current.status === "pending") {
          out.push(finalizePendingPromise(current, today));
        }
        current = {
          text: taskMatch[2].trim(),
          status: taskMatch[1].toLowerCase() === "x" ? "done" : "pending",
          promised: "",
          due: "",
          context: "",
        };
        continue;
      }
      const metaMatch = line.match(/^\s*-\s*([a-zA-Z_]+):\s*(.*?)\s*$/);
      if (metaMatch && current) {
        current[metaMatch[1].trim()] = stripTicks(metaMatch[2].trim());
      }
    }
    if (current && current.text && current.status === "pending") {
      out.push(finalizePendingPromise(current, today));
    }
    return out.filter((item) => item.text && item.text !== "承诺内容" && item.text !== "暂无待兑现承诺。");
  } catch {
    return [];
  }
}

function finalizePendingPromise(entry = {}, today = "") {
  const due = String(entry.due || "").trim();
  return {
    text: String(entry.text || "").trim(),
    status: String(entry.status || "pending").trim().toLowerCase(),
    promised: String(entry.promised || "").trim(),
    due,
    context: String(entry.context || "").trim(),
    flag: resolvePromiseFlag(due, today),
  };
}

function resolvePromiseFlag(due = "", today = "") {
  if (!due || !today) return "";
  const dueMs = Date.parse(`${due}T00:00:00+08:00`);
  const todayMs = Date.parse(`${today}T00:00:00+08:00`);
  if (!Number.isFinite(dueMs) || !Number.isFinite(todayMs)) return "";
  if (dueMs < todayMs) return "⚠️";
  const deltaDays = Math.floor((dueMs - todayMs) / (24 * 60 * 60 * 1000));
  if (deltaDays <= 7) return "⏰";
  return "";
}

function isoDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function stripTicks(value) {
  return String(value || "").replace(/^`+|`+$/g, "").trim();
}

const instructionCache = new Map();

function loadInstructionFile(filePath, config = {}) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) {
    return "";
  }
  try {
    const stat = fs.statSync(normalizedPath);
    const cacheKey = `${normalizedPath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const raw = fs.readFileSync(normalizedPath, "utf8");
    const result = renderInstructionTemplate(raw, config).trim();
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return "";
  }
}

module.exports = {
  buildOpeningTurnText,
  buildInstructionRefreshText,
  loadWechatInstructions,
  loadInstructionFile,
};
