class TurnGateStore {
  constructor() {
    this.scopeByThreadId = new Map();
    this.pendingScopeKeys = new Set();
  }

  begin(bindingKey, workspaceRoot) {
    return this.beginScope(buildTurnScopeKey(bindingKey, workspaceRoot));
  }

  // Scope-key API. v2 callers pass a *route lane* scope key so two Telegram
  // topics serialize independently; the binding-key API above is kept for
  // non-lane callers and delegates here.
  beginScope(scopeKey) {
    const normalizedScopeKey = normalizeText(scopeKey);
    if (!normalizedScopeKey) {
      return "";
    }
    this.pendingScopeKeys.add(normalizedScopeKey);
    return normalizedScopeKey;
  }

  releaseScopeKey(scopeKey) {
    const normalizedScopeKey = normalizeText(scopeKey);
    if (!normalizedScopeKey) {
      return;
    }
    this.pendingScopeKeys.delete(normalizedScopeKey);
  }

  isScopePending(scopeKey) {
    const normalizedScopeKey = normalizeText(scopeKey);
    return normalizedScopeKey ? this.pendingScopeKeys.has(normalizedScopeKey) : false;
  }

  /**
   * True when *any* lane currently holds a turn for this workspace root.
   *
   * Lanes are isolated from each other, but a workspace-wide background job
   * (system message, closeout) must still yield to whichever lane is running,
   * because they share one working directory.
   */
  isAnyScopePendingForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return false;
    }
    const suffix = `::${normalizedWorkspaceRoot}`;
    for (const scopeKey of this.pendingScopeKeys) {
      if (scopeKey.endsWith(suffix)) {
        return true;
      }
    }
    return false;
  }

  attachThread(scopeKey, threadId) {
    const normalizedScopeKey = normalizeText(scopeKey);
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedScopeKey || !normalizedThreadId) {
      return;
    }
    this.scopeByThreadId.set(normalizedThreadId, normalizedScopeKey);
  }

  releaseScope(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    this.pendingScopeKeys.delete(scopeKey);
  }

  releaseThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const scopeKey = this.scopeByThreadId.get(normalizedThreadId) || "";
    if (scopeKey) {
      this.pendingScopeKeys.delete(scopeKey);
      this.scopeByThreadId.delete(normalizedThreadId);
    }
  }

  isPending(bindingKey, workspaceRoot) {
    const scopeKey = buildTurnScopeKey(bindingKey, workspaceRoot);
    return scopeKey ? this.pendingScopeKeys.has(scopeKey) : false;
  }
}

function buildTurnScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { TurnGateStore };
