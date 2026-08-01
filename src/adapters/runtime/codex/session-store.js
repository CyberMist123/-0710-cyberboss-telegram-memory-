const fs = require("fs");
const path = require("path");
const { normalizeModelCatalog } = require("./model-catalog");
const { normalizeCommandTokens } = require("../shared/approval-command");

class SessionStore {
  constructor({ filePath, runtimeId = "" }) {
    this.filePath = filePath;
    this.runtimeId = normalizeValue(runtimeId);
    this.state = createEmptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.bindings) {
        this.state = {
          ...createEmptyState(),
          ...parsed,
          bindings: parsed.bindings || {},
          approvalCommandAllowlistByWorkspaceRoot: parsed.approvalCommandAllowlistByWorkspaceRoot || {},
          approvalPromptStateByThreadId: parsed.approvalPromptStateByThreadId || {},
          continuityByThreadId: parsed.continuityByThreadId || {},
          availableModelCatalog: parsed.availableModelCatalog || {
            models: [],
            updatedAt: "",
          },
        };
      }
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getBinding(bindingKey) {
    return this.state.bindings[bindingKey] || null;
  }

  listBindings() {
    return Object.entries(this.state.bindings || {}).map(([bindingKey, binding]) => ({
      bindingKey,
      ...(binding || {}),
    }));
  }

  getActiveWorkspaceRoot(bindingKey) {
    return normalizeValue(this.state.bindings[bindingKey]?.activeWorkspaceRoot);
  }

  updateBinding(bindingKey, nextBinding) {
    this.state.bindings[bindingKey] = {
      ...(this.state.bindings[bindingKey] || {}),
      ...(nextBinding || {}),
    };
    this.save();
    return this.state.bindings[bindingKey];
  }

  getThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return "";
    }
    const binding = this.getBinding(bindingKey) || {};
    const scoped = getThreadMapForRuntime(binding, runtimeId);
    if (scoped[normalizedWorkspaceRoot]) {
      return scoped[normalizedWorkspaceRoot];
    }
    return "";
  }

  setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, extra = {}, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }

    const current = this.getBinding(bindingKey) || {};
    const normalizedRuntimeId = normalizeValue(runtimeId);
    const normalizedThreadId = normalizeThreadValue(threadId);
    const threadIdByWorkspaceRootByRuntime = {
      ...getThreadRuntimeMap(current),
      [normalizedRuntimeId || "default"]: {
        ...getThreadMapForRuntime(current, normalizedRuntimeId),
        [normalizedWorkspaceRoot]: normalizedThreadId,
      },
    };
    const nextBinding = {
      ...current,
      ...extra,
      activeWorkspaceRoot: normalizedWorkspaceRoot,
      threadIdByWorkspaceRootByRuntime,
    };

    if (normalizedRuntimeId === "codex") {
      nextBinding.threadIdByWorkspaceRoot = {
        ...getLegacyThreadMap(current),
        [normalizedWorkspaceRoot]: normalizedThreadId,
      };
    }

    return this.updateBinding(bindingKey, nextBinding);
  }

  getRuntimeParamsForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return { model: "", modelProvider: "" };
    }
    const current = this.getBinding(bindingKey) || {};
    const runtimeId = normalizeValue(this.runtimeId);
    const entry = getRuntimeParamsMapForRuntime(current, runtimeId)[normalizedWorkspaceRoot]
      || (runtimeId === "codex" ? getCodexParamsMap(current)[normalizedWorkspaceRoot] : null);
    const effort = normalizeValue(entry?.effort);
    const windowOverride = entry?.windowOverride && typeof entry.windowOverride === "object" && !Array.isArray(entry.windowOverride)
      ? JSON.parse(JSON.stringify(entry.windowOverride))
      : null;
    return {
      model: normalizeValue(entry?.model),
      modelProvider: normalizeValue(entry?.modelProvider || entry?.model_provider),
      // Present only once the binding has actually chosen a level. Absent means
      // "no override", which is what every binding that has never run /effort
      // reports -- their params keep the exact shape they had before.
      ...(effort ? { effort } : {}),
      ...(windowOverride ? { windowOverride } : {}),
    };
  }

  setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, params = {}) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    const runtimeId = normalizeValue(this.runtimeId) || "default";
    const previousEntry = getRuntimeParamsMapForRuntime(current, runtimeId)[normalizedWorkspaceRoot]
      || (runtimeId === "codex" ? getCodexParamsMap(current)[normalizedWorkspaceRoot] : {})
      || {};
    const hasModel = Object.prototype.hasOwnProperty.call(params, "model");
    const hasModelProvider = Object.prototype.hasOwnProperty.call(params, "modelProvider");
    // Each field is only rewritten when the caller names it, so /model does not
    // reset the binding's effort and /effort does not reset its model.
    const hasEffort = Object.prototype.hasOwnProperty.call(params, "effort");
    const hasWindowOverride = Object.prototype.hasOwnProperty.call(params, "windowOverride");
    const nextEffort = hasEffort
      ? normalizeValue(params.effort)
      : normalizeValue(previousEntry.effort);
    const nextEntry = {
      ...previousEntry,
      model: hasModel ? normalizeValue(params.model) : normalizeValue(previousEntry.model),
      modelProvider: hasModelProvider
        ? normalizeValue(params.modelProvider)
        : normalizeValue(previousEntry.modelProvider || previousEntry.model_provider),
    };
    // Only written once a level has been chosen, so a binding that never runs
    // /effort keeps the record it already had on disk. Clearing the level
    // removes the key rather than leaving an empty one behind.
    if (nextEffort) {
      nextEntry.effort = nextEffort;
    } else {
      delete nextEntry.effort;
    }
    if (hasWindowOverride) {
      if (params.windowOverride && typeof params.windowOverride === "object" && !Array.isArray(params.windowOverride)) {
        nextEntry.windowOverride = JSON.parse(JSON.stringify(params.windowOverride));
      } else {
        delete nextEntry.windowOverride;
      }
    }
    const runtimeParamsByWorkspaceRootByRuntime = {
      ...getRuntimeParamsRuntimeMap(current),
      [runtimeId]: {
        ...getRuntimeParamsMapForRuntime(current, runtimeId),
        [normalizedWorkspaceRoot]: nextEntry,
      },
    };
    const nextBinding = {
      ...current,
      runtimeParamsByWorkspaceRootByRuntime,
    };
    if (runtimeId === "codex") {
      nextBinding.codexParamsByWorkspaceRoot = {
        ...getCodexParamsMap(current),
        [normalizedWorkspaceRoot]: {
          ...previousEntry,
          ...nextEntry,
        },
      };
    }
    return this.updateBinding(bindingKey, nextBinding);
  }

  getContextFingerprintForWorkspace(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) return "";
    const current = this.getBinding(bindingKey) || {};
    const runtimeId = normalizeValue(this.runtimeId) || "default";
    return normalizeValue(current.contextFingerprintByWorkspaceRootByRuntime?.[runtimeId]?.[normalizedWorkspaceRoot]);
  }

  setContextFingerprintForWorkspace(bindingKey, workspaceRoot, fingerprint = "") {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) return this.getBinding(bindingKey);
    const current = this.getBinding(bindingKey) || {};
    const runtimeId = normalizeValue(this.runtimeId) || "default";
    return this.updateBinding(bindingKey, {
      contextFingerprintByWorkspaceRootByRuntime: {
        ...(current.contextFingerprintByWorkspaceRootByRuntime || {}),
        [runtimeId]: {
          ...(current.contextFingerprintByWorkspaceRootByRuntime?.[runtimeId] || {}),
          [normalizedWorkspaceRoot]: normalizeValue(fingerprint),
        },
      },
    });
  }

  clearThreadIdForWorkspace(bindingKey, workspaceRoot, runtimeId = this.runtimeId) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    const current = this.getBinding(bindingKey) || {};
    const normalizedRuntimeId = normalizeValue(runtimeId);
    const threadIdByWorkspaceRootByRuntime = {
      ...getThreadRuntimeMap(current),
      [normalizedRuntimeId || "default"]: {
        ...getThreadMapForRuntime(current, normalizedRuntimeId),
        [normalizedWorkspaceRoot]: "",
      },
    };
    const nextBinding = {
      ...current,
      threadIdByWorkspaceRootByRuntime,
    };
    if (normalizedRuntimeId === "codex") {
      nextBinding.threadIdByWorkspaceRoot = {
        ...getLegacyThreadMap(current),
        [normalizedWorkspaceRoot]: "",
      };
    }
    return this.updateBinding(bindingKey, nextBinding);
  }

  getReentryInjection(threadId) {
    const normalizedThreadId = normalizeThreadValue(threadId);
    if (!normalizedThreadId) return null;
    const record = this.state.continuityByThreadId?.[normalizedThreadId];
    return record && typeof record === "object" ? { ...record } : null;
  }

  markReentryInjected(threadId, record = {}) {
    const normalizedThreadId = normalizeThreadValue(threadId);
    if (!normalizedThreadId) return null;
    const current = this.getReentryInjection(normalizedThreadId);
    if (current?.reentry_injected === true) return current;
    this.state.continuityByThreadId = {
      ...(this.state.continuityByThreadId || {}),
      [normalizedThreadId]: {
        reentry_injected: true,
        hash: normalizeValue(record.hash),
        chars: Math.max(0, Number(record.chars) || 0),
        ts: normalizeValue(record.ts) || new Date().toISOString(),
      },
    };
    this.save();
    return this.getReentryInjection(normalizedThreadId);
  }

  setActiveWorkspaceRoot(bindingKey, workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return this.getBinding(bindingKey);
    }
    return this.updateBinding(bindingKey, {
      activeWorkspaceRoot: normalizedWorkspaceRoot,
    });
  }

  listWorkspaceRoots(bindingKey, runtimeId = this.runtimeId) {
    const current = this.getBinding(bindingKey) || {};
    return Object.keys(getThreadMapForRuntime(current, runtimeId));
  }

  findBindingForThreadId(threadId, runtimeId = this.runtimeId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const normalizedRuntimeId = normalizeValue(runtimeId);
    for (const [bindingKey, binding] of Object.entries(this.state.bindings || {})) {
      for (const [workspaceRoot, candidateThreadId] of Object.entries(getThreadMapForRuntime(binding, normalizedRuntimeId))) {
        if (normalizeValue(candidateThreadId) === normalizedThreadId) {
          return {
            bindingKey,
            workspaceRoot: normalizeValue(workspaceRoot),
          };
        }
      }
    }
    return null;
  }

  getApprovalCommandAllowlistForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return [];
    }
    const raw = this.state.approvalCommandAllowlistByWorkspaceRoot?.[normalizedWorkspaceRoot];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((entry) => Array.isArray(entry))
      .map((entry) => entry.map((part) => normalizeValue(part)).filter(Boolean))
      .filter((entry) => entry.length);
  }

  rememberApprovalPrefixForWorkspace(workspaceRoot, commandTokens) {
    const normalizedWorkspaceRoot = normalizeValue(workspaceRoot);
    const normalizedTokens = normalizeCommandTokens(commandTokens);
    if (!normalizedWorkspaceRoot || !normalizedTokens.length) {
      return this.getApprovalCommandAllowlistForWorkspace(workspaceRoot);
    }
    const current = this.getApprovalCommandAllowlistForWorkspace(normalizedWorkspaceRoot);
    if (!current.some((entry) => isSameTokenList(entry, normalizedTokens))) {
      current.push(normalizedTokens);
      this.state.approvalCommandAllowlistByWorkspaceRoot = {
        ...(this.state.approvalCommandAllowlistByWorkspaceRoot || {}),
        [normalizedWorkspaceRoot]: current,
      };
      this.save();
    }
    return current;
  }

  getApprovalPromptState(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const raw = this.state.approvalPromptStateByThreadId?.[normalizedThreadId];
    if (!raw || typeof raw !== "object") {
      return null;
    }
    return {
      requestId: normalizeValue(raw.requestId),
      signature: normalizeValue(raw.signature),
      promptedAt: normalizeValue(raw.promptedAt),
    };
  }

  rememberApprovalPrompt(threadId, requestId, signature = "") {
    const normalizedThreadId = normalizeValue(threadId);
    const normalizedRequestId = normalizeValue(requestId);
    const normalizedSignature = normalizeValue(signature);
    if (!normalizedThreadId || !normalizedRequestId) {
      return null;
    }
    this.state.approvalPromptStateByThreadId = {
      ...(this.state.approvalPromptStateByThreadId || {}),
      [normalizedThreadId]: {
        requestId: normalizedRequestId,
        signature: normalizedSignature,
        promptedAt: new Date().toISOString(),
      },
    };
    this.save();
    return this.getApprovalPromptState(normalizedThreadId);
  }

  clearApprovalPrompt(threadId) {
    const normalizedThreadId = normalizeValue(threadId);
    if (!normalizedThreadId || !this.state.approvalPromptStateByThreadId?.[normalizedThreadId]) {
      return;
    }
    const next = {
      ...(this.state.approvalPromptStateByThreadId || {}),
    };
    delete next[normalizedThreadId];
    this.state.approvalPromptStateByThreadId = next;
    this.save();
  }

  getAvailableModelCatalog() {
    const raw = this.state.availableModelCatalog;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const models = normalizeModelCatalog(raw.models);
    if (!models.length) {
      return null;
    }
    const updatedAt = normalizeValue(raw.updatedAt);
    return { models, updatedAt };
  }

  setAvailableModelCatalog(models) {
    const normalizedModels = normalizeModelCatalog(models);
    if (!normalizedModels.length) {
      return null;
    }
    this.state.availableModelCatalog = {
      models: normalizedModels,
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.state.availableModelCatalog;
  }

  buildBindingKey({ workspaceId, accountId, senderId }) {
    return `${normalizeValue(workspaceId)}:${normalizeValue(accountId)}:${normalizeValue(senderId)}`;
  }
}

function createEmptyState() {
  return {
    bindings: {},
    approvalCommandAllowlistByWorkspaceRoot: {},
    approvalPromptStateByThreadId: {},
    continuityByThreadId: {},
    availableModelCatalog: {
      models: [],
      updatedAt: "",
    },
  };
}

function normalizeValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadValue(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function getLegacyThreadMap(binding) {
  return binding?.threadIdByWorkspaceRoot && typeof binding.threadIdByWorkspaceRoot === "object"
    ? binding.threadIdByWorkspaceRoot
    : {};
}

function getThreadRuntimeMap(binding) {
  return binding?.threadIdByWorkspaceRootByRuntime && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
}

function getThreadMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeValue(runtimeId);
  const runtimeMap = getThreadRuntimeMap(binding);
  if (!normalizedRuntimeId) {
    return {};
  }
  const scoped = runtimeMap[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function getCodexParamsMap(binding) {
  return binding?.codexParamsByWorkspaceRoot && typeof binding.codexParamsByWorkspaceRoot === "object"
    ? binding.codexParamsByWorkspaceRoot
    : {};
}

function getRuntimeParamsRuntimeMap(binding) {
  return binding?.runtimeParamsByWorkspaceRootByRuntime && typeof binding.runtimeParamsByWorkspaceRootByRuntime === "object"
    ? binding.runtimeParamsByWorkspaceRootByRuntime
    : {};
}

function getRuntimeParamsMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeValue(runtimeId);
  if (!normalizedRuntimeId) {
    return {};
  }
  const scoped = getRuntimeParamsRuntimeMap(binding)[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function isSameTokenList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

module.exports = { SessionStore };
