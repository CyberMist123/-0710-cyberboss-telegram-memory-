const fs = require("fs");
const path = require("path");

// Tool runtime context.
//
// The workspace-keyed map is a singleton: with two topics running at once, the
// turn that wrote last owned every outbound tool send. v2 adds a route-token
// map, one entry per session slot, and the Claude child's MCP server is
// launched with its own token so it reads back exactly its own lane.
//
// Where no token is available the workspace map is still used, but it fails
// closed: if more than one lane has a turn in flight in that workspace the
// lookup reports the ambiguity instead of guessing.
class RuntimeContextStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { contextsByWorkspaceRoot: {}, contextsByRouteToken: {} };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.contextsByWorkspaceRoot) {
        this.state = {
          contextsByWorkspaceRoot: parsed.contextsByWorkspaceRoot,
          contextsByRouteToken: parsed.contextsByRouteToken && typeof parsed.contextsByRouteToken === "object"
            ? parsed.contextsByRouteToken
            : {},
        };
      }
    } catch {
      this.state = { contextsByWorkspaceRoot: {}, contextsByRouteToken: {} };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  setActiveContext({
    workspaceRoot = "",
    runtimeId = "",
    threadId = "",
    bindingKey = "",
    accountId = "",
    senderId = "",
    provider = "",
    // Route lane of the turn that is currently active. Model-initiated sends
    // read it back so a reply lands in the topic that asked, not the chat's
    // default lane.
    chatId = "",
    messageThreadId = null,
    // Route identity of the turn. `routeToken` is the session slot key; the
    // child's tool server is launched knowing it.
    routeToken = "",
    laneKey = "",
    processKey = "",
    turnId = "",
  } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    const normalizedProvider = normalizeText(provider);
    const current = this.state.contextsByWorkspaceRoot?.[normalizedWorkspaceRoot] || {};
    const next = {
      workspaceRoot: normalizedWorkspaceRoot,
      runtimeId: normalizeText(runtimeId),
      threadId: normalizeText(threadId),
      bindingKey: normalizeText(bindingKey),
      accountId: normalizeText(accountId),
      senderId: normalizeText(senderId),
      provider: normalizedProvider,
      telegramSenderId: normalizedProvider === "telegram"
        ? normalizeText(senderId)
        : normalizeText(current.telegramSenderId),
      telegramChatId: normalizedProvider === "telegram"
        ? normalizeText(chatId)
        : normalizeText(current.telegramChatId),
      telegramMessageThreadId: normalizedProvider === "telegram"
        ? normalizeNullableThreadId(messageThreadId)
        : (current.telegramMessageThreadId ?? null),
      routeToken: normalizeText(routeToken),
      laneKey: normalizeText(laneKey),
      processKey: normalizeText(processKey),
      ...(normalizeText(turnId) ? { turnId: normalizeText(turnId) } : {}),
      turnActive: true,
      updatedAt: new Date().toISOString(),
    };
    this.state.contextsByWorkspaceRoot = {
      ...(this.state.contextsByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: next,
    };
    const normalizedToken = normalizeText(routeToken);
    if (normalizedToken && !isUnsafeKey(normalizedToken)) {
      this.state.contextsByRouteToken = {
        ...(this.state.contextsByRouteToken || {}),
        [normalizedToken]: next,
      };
      this.evictRouteTokens();
    }
    this.save();
    return next;
  }

  /**
   * Mark a lane's turn as finished. Its context stays readable (a tool call can
   * arrive slightly after the result) but it no longer counts towards the
   * ambiguity check below.
   */
  clearActiveTurn(routeToken) {
    const normalizedToken = normalizeText(routeToken);
    const entry = normalizedToken ? this.state.contextsByRouteToken?.[normalizedToken] : null;
    if (!entry) {
      return;
    }
    entry.turnActive = false;
    entry.updatedAt = new Date().toISOString();
    this.save();
  }

  evictRouteTokens(maxEntries = 128) {
    const tokens = Object.keys(this.state.contextsByRouteToken || {});
    if (tokens.length <= maxEntries) {
      return;
    }
    tokens
      .sort((left, right) => String(this.state.contextsByRouteToken[left]?.updatedAt || "")
        .localeCompare(String(this.state.contextsByRouteToken[right]?.updatedAt || "")))
      .slice(0, tokens.length - maxEntries)
      .forEach((token) => {
        delete this.state.contextsByRouteToken[token];
      });
  }

  resolveActiveContext({ workspaceRoot = "", runtimeId = "", routeToken = "" } = {}) {
    // A route token identifies exactly one lane. It never falls through to the
    // workspace map: a token that is not present means the caller named a lane
    // this process does not know, which must fail rather than pick another.
    const normalizedToken = normalizeText(routeToken);
    if (normalizedToken) {
      if (isUnsafeKey(normalizedToken)
        || !Object.hasOwn(this.state.contextsByRouteToken || {}, normalizedToken)) {
        return null;
      }
      return this.state.contextsByRouteToken[normalizedToken] || null;
    }

    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    // Fail closed on ambiguity: more than one lane mid-turn in this workspace
    // means an untokened caller cannot tell which one it belongs to.
    const contended = this.listActiveRouteContexts(normalizedWorkspaceRoot);
    if (contended.length > 1) {
      return { ambiguous: true, activeLaneCount: contended.length };
    }
    if (contended.length === 1) {
      return contended[0];
    }

    if (normalizedWorkspaceRoot) {
      const exact = this.state.contextsByWorkspaceRoot?.[normalizedWorkspaceRoot];
      if (exact) {
        return exact;
      }
    }

    const entries = Object.values(this.state.contextsByWorkspaceRoot || {})
      .filter((entry) => entry && typeof entry === "object");
    const normalizedRuntimeId = normalizeText(runtimeId);
    const scoped = normalizedRuntimeId
      ? entries.filter((entry) => normalizeText(entry.runtimeId) === normalizedRuntimeId)
      : entries;
    const sorted = scoped.sort((left, right) => {
      const leftMs = Date.parse(left.updatedAt || "") || 0;
      const rightMs = Date.parse(right.updatedAt || "") || 0;
      return rightMs - leftMs;
    });
    return sorted[0] || null;
  }
}

/**
 * Lanes with a turn in flight in one workspace.
 */
RuntimeContextStore.prototype.listActiveRouteContexts = function listActiveRouteContexts(workspaceRoot) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  return Object.values(this.state.contextsByRouteToken || {})
    .filter((entry) => entry
      && entry.turnActive === true
      && (!normalizedWorkspaceRoot || normalizeText(entry.workspaceRoot) === normalizedWorkspaceRoot));
};

function isUnsafeKey(key) {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableThreadId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const text = String(value).trim();
  return /^[1-9][0-9]*$/.test(text) ? text : null;
}

module.exports = { RuntimeContextStore };
