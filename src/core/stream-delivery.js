const { sanitizeProtocolLeakText } = require("../adapters/runtime/codex/protocol-leak-monitor");

const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";

class StreamDelivery {
  constructor({ channelAdapter, telegramChannelAdapter, sessionStore, runtimeId = "", onDeferredSystemReply, systemReplyRetryScheduleMs, sameTokenRetryDelayMs, transformReplyDelivery, onSystemReplySent }) {
    this.channelAdapter = channelAdapter;
    this.telegramChannelAdapter = telegramChannelAdapter || null;
    this.sessionStore = sessionStore;
    this.runtimeId = normalizeRuntimeId(runtimeId);
    this.systemReplyPolicy = createSystemReplyPolicy(this.runtimeId);
    this.onDeferredSystemReply = typeof onDeferredSystemReply === "function" ? onDeferredSystemReply : null;
    this.systemReplyRetryScheduleMs = Array.isArray(systemReplyRetryScheduleMs) && systemReplyRetryScheduleMs.length
      ? systemReplyRetryScheduleMs.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
      : [1_500, 2_500, 4_000, 6_000];
    this.sameTokenRetryDelayMs = Number.isFinite(sameTokenRetryDelayMs) && sameTokenRetryDelayMs >= 0
      ? sameTokenRetryDelayMs
      : 800;
    this.transformReplyDelivery = typeof transformReplyDelivery === "function" ? transformReplyDelivery : null;
    this.onSystemReplySent = typeof onSystemReplySent === "function" ? onSystemReplySent : null;
    this.replyTargetByBindingKey = new Map();
    this.replyTargetByTurnKey = new Map();
    this.replyTargetQueueByThreadId = new Map();
    // Reply target keyed by Claude session id. Sessions are lane-scoped in v2,
    // so this is a 1:1 map to a route lane and is consulted *before* the
    // binding-key map -- which is shared across a user's lanes and would
    // otherwise be able to deliver one topic's reply into another.
    this.replyTargetByThreadId = new Map();
    this.maxReplyTargetsByThreadId = 256;
    this.deferredReplyPrefixByBindingKey = new Map();
    this.stateByRunKey = new Map();
    this.runSequence = 0;
  }

  setReplyTarget(bindingKey, target) {
    if (!bindingKey || !target?.userId || !target?.contextToken) {
      return;
    }
    this.replyTargetByBindingKey.set(bindingKey, {
      userId: String(target.userId).trim(),
      contextToken: String(target.contextToken).trim(),
      provider: normalizeText(target.provider),
      ...threadIdField(target.messageThreadId),
      ...laneKeyField(target.laneKey),
    });
  }

  setReplyTargetForThread(threadId, target) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTarget) {
      return;
    }
    if (this.replyTargetByThreadId.size >= this.maxReplyTargetsByThreadId) {
      const oldest = this.replyTargetByThreadId.keys().next().value;
      this.replyTargetByThreadId.delete(oldest);
    }
    this.replyTargetByThreadId.set(normalizedThreadId, normalizedTarget);
  }

  queueReplyTargetForThread(threadId, target) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTarget) {
      return;
    }
    const queue = this.replyTargetQueueByThreadId.get(normalizedThreadId) || [];
    queue.push(normalizedTarget);
    this.replyTargetQueueByThreadId.set(normalizedThreadId, queue);
    this.bindQueuedReplyTargetsToActiveThreadRuns(normalizedThreadId);
  }

  bindReplyTargetForTurn({ threadId = "", turnId = "", target = null } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTurnId || !normalizedTarget) {
      this.queueReplyTargetForThread(normalizedThreadId, target);
      return;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    this.replyTargetByTurnKey.set(runKey, normalizedTarget);
    const activeState = this.stateByRunKey.get(runKey);
    if (activeState) {
      this.applyThreadReplyTarget(activeState, normalizedTarget);
      return;
    }

    const pendingState = this.stateByRunKey.get(buildRunKey(normalizedThreadId, ""));
    if (pendingState) {
      this.applyThreadReplyTarget(pendingState, normalizedTarget);
    }
  }

  setDeferredReplyPrefix(bindingKey, text) {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedText = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalizedBindingKey || !normalizedText) {
      return;
    }
    this.deferredReplyPrefixByBindingKey.set(normalizedBindingKey, normalizedText);
  }

  resolveReplyTargetForRun({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const state = this.stateByRunKey.get(runKey);
    if (state?.replyTarget) {
      return normalizeReplyTarget(state.replyTarget);
    }

    const exactTurnTarget = this.replyTargetByTurnKey.get(runKey);
    if (exactTurnTarget) {
      return normalizeReplyTarget(exactTurnTarget);
    }

    const queuedTargets = this.replyTargetQueueByThreadId.get(normalizedThreadId);
    if (Array.isArray(queuedTargets) && queuedTargets.length > 0) {
      return normalizeReplyTarget(queuedTargets[0]);
    }

    // Session-scoped target. The session id identifies exactly one lane.
    const threadTarget = this.replyTargetByThreadId.get(normalizedThreadId);
    if (threadTarget) {
      return normalizeReplyTarget(threadTarget);
    }

    // Fail closed. A binding-scoped target is shared by every lane that binding
    // owns, so using it here would deliver an unlocatable reply into whichever
    // topic replied most recently. Callers that legitimately have no lane pass
    // an explicit fallback target instead.
    return null;
  }

  async handleRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    if (!threadId) {
      return;
    }

    switch (event.type) {
      case "runtime.turn.started": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.attachReplyTarget(state);
        return;
      }
      case "runtime.reply.delta": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: false,
        });
        return;
      }
      case "runtime.reply.completed": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: true,
        });
        await this.flush(state, { force: false });
        return;
      }
      case "runtime.turn.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.captureTurnCompletionText(state, event.payload.text);
        await this.flush(state, { force: true });
        this.disposeRunState(state.runKey);
        return;
      }
      case "runtime.turn.failed":
        this.disposeRunState(buildRunKey(threadId, turnId));
        return;
      default:
        return;
    }
  }

  ensureRunState(threadId, turnId = "") {
    const runKey = buildRunKey(threadId, turnId);
    const existing = this.stateByRunKey.get(runKey);
    if (existing) {
      return existing;
    }

    const normalizedTurnId = normalizeText(turnId);
    if (normalizedTurnId) {
      const pendingRunKey = buildRunKey(threadId, "");
      const pendingState = this.stateByRunKey.get(pendingRunKey);
      if (pendingState) {
        pendingState.runKey = runKey;
        pendingState.turnId = normalizedTurnId;
        this.stateByRunKey.delete(pendingRunKey);
        this.stateByRunKey.set(runKey, pendingState);
        const exactTurnTarget = this.replyTargetByTurnKey.get(runKey);
        if (exactTurnTarget) {
          this.applyThreadReplyTarget(pendingState, exactTurnTarget);
        }
        return pendingState;
      }
    }

    const created = {
      runKey,
      threadId,
      bindingKey: "",
      replyTarget: null,
      deferredReplyPrefix: "",
      turnId: normalizedTurnId,
      itemOrder: [],
      items: new Map(),
      sentItemIds: new Set(),
      sendChain: Promise.resolve(),
      flushPromise: null,
      sequence: this.runSequence += 1,
      threadReplyTargetAttached: false,
    };
    this.stateByRunKey.set(runKey, created);
    this.attachReplyTarget(created);
    return created;
  }

  attachReplyTarget(state) {
    if (!state.threadReplyTargetAttached && state.turnId) {
      const exactTurnTarget = this.replyTargetByTurnKey.get(buildRunKey(state.threadId, state.turnId)) || null;
      if (exactTurnTarget) {
        this.applyThreadReplyTarget(state, exactTurnTarget);
      }
    }
    if (!state.threadReplyTargetAttached) {
      const threadTarget = this.consumeQueuedReplyTarget(state.threadId);
      if (threadTarget) {
        this.applyThreadReplyTarget(state, threadTarget);
      }
    }
    if (!state.threadReplyTargetAttached) {
      const sessionTarget = this.replyTargetByThreadId.get(state.threadId);
      if (sessionTarget) {
        this.applyThreadReplyTarget(state, sessionTarget);
      }
    }
    const linked = this.sessionStore.findBindingForThreadId(state.threadId);
    if (!linked?.bindingKey) {
      return;
    }
    // The binding is still recorded (deferred-reply prefixes are binding-scoped
    // by design), but it may only supply a reply *target* when no lane-scoped
    // target exists for this session -- and never when one lane has already
    // claimed the run.
    state.bindingKey = linked.bindingKey;
    if (!state.replyTarget && !this.replyTargetByThreadId.has(state.threadId)) {
      state.replyTarget = this.replyTargetByBindingKey.get(linked.bindingKey);
    }
    if (!state.deferredReplyPrefix) {
      const prefix = this.deferredReplyPrefixByBindingKey.get(linked.bindingKey) || "";
      if (prefix) {
        state.deferredReplyPrefix = prefix;
        this.deferredReplyPrefixByBindingKey.delete(linked.bindingKey);
      }
    }
  }

  captureTurnCompletionText(state, text) {
    const normalized = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalized || state.itemOrder.length > 0) {
      return;
    }
    this.upsertItem(state, {
      itemId: `result-${state.turnId || state.threadId}`,
      text: normalized,
      completed: true,
    });
  }

  upsertItem(state, { itemId, text, completed }) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
      });
    }

    const current = state.items.get(itemId);
    if (completed) {
      current.currentText = text;
      current.completedText = text;
      current.completed = true;
      return;
    }

    current.currentText = appendStreamingText(current.currentText, text);
  }

  setItemText(state, itemId, text, completed) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
      });
    }

    const current = state.items.get(itemId);
    current.currentText = text;
    if (completed) {
      current.completedText = text;
    }
    current.completed = Boolean(completed);
  }

  async flush(state, { force }) {
    const previous = state.flushPromise || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.flushNow(state, { force }));
    const tracked = current.finally(() => {
      const latestState = this.stateByRunKey.get(state.runKey);
      if (latestState && latestState.flushPromise === tracked) {
        latestState.flushPromise = null;
      }
    });
    state.flushPromise = tracked;
    await tracked;
  }

  async flushNow(state, { force }) {
    if (!state.replyTarget) {
      return;
    }

    if (state.replyTarget.provider === "system") {
      await this.flushSystemReply(state, { force });
      return;
    }

    const pendingDeliveries = collectPendingReplyDeliveries(state, { force });
    if (!pendingDeliveries.length) {
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      for (let index = 0; index < pendingDeliveries.length; index += 1) {
        const delivery = pendingDeliveries[index];
        await this.sendReplyDelivery(state, delivery, {
          prependDeferredPrefix: index === 0 && Boolean(state.deferredReplyPrefix),
        });
        state.sentItemIds.add(delivery.itemId);
        if (index === 0 && state.deferredReplyPrefix) {
          state.deferredReplyPrefix = "";
        }
      }
    }).catch((error) => {
      const failedDelivery = pendingDeliveries[0];
      const failedText = buildDeliveryPreviewText(failedDelivery);
      void this.deferSystemReply(state, buildEffectiveReplyText(state.deferredReplyPrefix, failedText), error, "plain_reply");
      console.error(`[cyberboss] failed to deliver reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async flushSystemReply(state, { force }) {
    if (!force) {
      return;
    }

    const replyText = buildReplyText(state, { completedOnly: false });
    const resolved = resolveSystemReplyDelivery(replyText, this.systemReplyPolicy);
    if (resolved.kind === "silent") {
      this.markAllItemsSent(state);
      console.log(
        `[cyberboss] suppressed system reply thread=${state.threadId} action=silent preview=${JSON.stringify(replyText.slice(0, 120))}`
      );
      try {
        if (this.onSystemReplySent) {
          this.onSystemReplySent(state.threadId, state.turnId, replyText);
        }
      } catch (cbError) {
        console.error(`[desire] onSystemReplySent callback error in silent path:`, cbError);
      }
      return;
    }

    if (resolved.kind !== "send_message") {
      console.error(
        `[cyberboss] invalid system reply thread=${state.threadId} reason=${resolved.reason} preview=${JSON.stringify(replyText.slice(0, 160))}`
      );
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      await this.sendSystemReply(state, resolved.message);
      this.markAllItemsSent(state);
      try {
        if (this.onSystemReplySent) {
          this.onSystemReplySent(state.threadId, state.turnId, replyText);
        }
      } catch (cbError) {
        console.error(`[desire] onSystemReplySent callback error:`, cbError);
      }
    }).catch((error) => {
      console.error(`[cyberboss] failed to deliver system reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async sendReplyDelivery(state, delivery, { prependDeferredPrefix = false } = {}) {
    if (!delivery || !state.replyTarget) {
      return;
    }

    if (delivery.kind === "silent") {
      return;
    }

    if (delivery.kind === "invalid_action") {
      console.error(
        `[cyberboss] invalid structured action item thread=${state.threadId} reason=${delivery.reason} preview=${JSON.stringify((delivery.sourceText || "").slice(0, 160))}`
      );
      return;
    }

    const baseText = delivery.kind === "action" ? delivery.message : delivery.text;
    if (!baseText) {
      return;
    }

    const transformedText = await this.resolveReplyDeliveryText(state, delivery, baseText);
    if (!transformedText) {
      return;
    }

    const payload = {
      userId: state.replyTarget.userId,
      text: prependDeferredPrefix ? buildEffectiveReplyText(state.deferredReplyPrefix, transformedText) : transformedText,
      contextToken: state.replyTarget.contextToken,
      ...threadIdField(state.replyTarget.messageThreadId),
    };
    if (prependDeferredPrefix) {
      payload.preserveBlock = true;
    }
    await this.sendTextWithRetry(state, payload, { kind: "plain_reply" });
  }

  async resolveReplyDeliveryText(state, delivery, baseText) {
    if (!this.transformReplyDelivery) {
      return baseText;
    }
    const resolved = await this.transformReplyDelivery({
      state,
      delivery,
      text: baseText,
    });
    if (resolved === false || resolved === null) {
      return "";
    }
    if (typeof resolved === "string") {
      return resolved;
    }
    if (typeof resolved?.text === "string") {
      return resolved.text;
    }
    return baseText;
  }

  async sendSystemReply(state, text) {
    const initialTarget = state.replyTarget;
    const payload = {
      userId: initialTarget.userId,
      text,
      contextToken: initialTarget.contextToken,
      ...threadIdField(initialTarget.messageThreadId),
    };
    await this.sendTextWithRetry(state, payload, { kind: "system_reply" });
  }

  async sendTextWithRetry(state, payload, { kind }) {
    const initialTarget = state.replyTarget;
    try {
      await this.sendTextByProvider(initialTarget.provider, payload);
      return;
    } catch (error) {
      const retryTarget = this.resolveRetriableReplyTarget(initialTarget, error);
      if (!retryTarget) {
        const deferred = await this.deferSystemReply(state, payload.text, error, kind);
        if (deferred) {
          return;
        }
        throw error;
      }
      console.warn(
        `[cyberboss] system reply retrying with refreshed context token thread=${state.threadId} user=${retryTarget.userId}`
      );
      try {
        const retryPayload = {
          userId: retryTarget.userId,
          text: payload.text,
          contextToken: retryTarget.contextToken,
          ...threadIdField(payload.messageThreadId ?? retryTarget.messageThreadId),
        };
        if (payload.preserveBlock) {
          retryPayload.preserveBlock = true;
        }
        await this.sendTextByProvider(retryTarget.provider, retryPayload);
        state.replyTarget = retryTarget;
        if (state.bindingKey) {
          this.replyTargetByBindingKey.set(state.bindingKey, {
            userId: retryTarget.userId,
            contextToken: retryTarget.contextToken,
            provider: retryTarget.provider,
            ...threadIdField(retryTarget.messageThreadId),
            ...laneKeyField(retryTarget.laneKey),
          });
        }
      } catch (retryError) {
        const deferred = await this.deferSystemReply(state, payload.text, retryError, kind);
        if (deferred) {
          return;
        }
        throw retryError;
      }
    }
  }

  async deferSystemReply(state, text, error, kind = "plain_reply") {
    if (typeof this.onDeferredSystemReply !== "function") {
      return false;
    }
    if (!isSystemReplyContextFailure(error)) {
      return false;
    }
    const target = state?.replyTarget || {};
    if (!target.userId || !text) {
      return false;
    }
    try {
      await this.onDeferredSystemReply({
        threadId: state.threadId,
        userId: target.userId,
        text,
        error,
        kind,
      });
      console.warn(
        `[cyberboss] deferred system reply until the next inbound message thread=${state.threadId} user=${target.userId}`
      );
      return true;
    } catch (deferError) {
      console.error(`[cyberboss] failed to defer system reply thread=${state.threadId}: ${deferError.message}`);
      return false;
    }
  }

  async sendTextByProvider(provider, payload) {
    if (provider === "telegram" && this.telegramChannelAdapter) {
      await this.telegramChannelAdapter.sendText(payload);
      return;
    }
    await this.channelAdapter.sendText(payload);
  }

  resolveRetriableReplyTarget(currentTarget, error) {
    if (!isSystemReplyContextFailure(error)) {
      return null;
    }
    if (!currentTarget?.userId) {
      return null;
    }
    if (typeof this.channelAdapter.getKnownContextTokens !== "function") {
      return null;
    }
    const tokens = this.channelAdapter.getKnownContextTokens();
    const refreshedContextToken = normalizeText(tokens?.[currentTarget.userId]);
    if (!refreshedContextToken || refreshedContextToken === currentTarget.contextToken) {
      return null;
    }
    return {
      userId: currentTarget.userId,
      contextToken: refreshedContextToken,
      provider: currentTarget.provider,
      ...threadIdField(currentTarget.messageThreadId),
      ...laneKeyField(currentTarget.laneKey),
    };
  }

  disposeRunState(runKey) {
    const normalizedRunKey = normalizeText(runKey);
    if (!normalizedRunKey) {
      return;
    }
    this.replyTargetByTurnKey.delete(normalizedRunKey);
    this.stateByRunKey.delete(normalizedRunKey);
  }

  bindQueuedReplyTargetsToActiveThreadRuns(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return;
    }
    const states = [...this.stateByRunKey.values()]
      .filter((state) => state.threadId === threadId && !state.threadReplyTargetAttached)
      .sort((left, right) => left.sequence - right.sequence);
    for (const state of states) {
      const nextTarget = queue.shift();
      if (!nextTarget) {
        break;
      }
      this.applyThreadReplyTarget(state, nextTarget);
    }
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
      return;
    }
    this.replyTargetQueueByThreadId.delete(threadId);
  }

  consumeQueuedReplyTarget(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return null;
    }
    const target = queue.shift() || null;
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
    } else {
      this.replyTargetQueueByThreadId.delete(threadId);
    }
    return target;
  }

  applyThreadReplyTarget(state, target) {
    state.replyTarget = {
      userId: target.userId,
      contextToken: target.contextToken,
      provider: target.provider,
      ...threadIdField(target.messageThreadId),
      ...laneKeyField(target.laneKey),
    };
    state.threadReplyTargetAttached = true;
  }

  markAllItemsSent(state) {
    for (const itemId of state.itemOrder) {
      state.sentItemIds.add(itemId);
    }
  }
}

function buildRunKey(threadId, turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  return normalizedTurnId
    ? `${normalizedThreadId}:${normalizedTurnId}`
    : `${normalizedThreadId}:pending`;
}

function buildReplyText(state, { completedOnly }) {
  const parts = [];
  for (const itemId of state.itemOrder) {
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }

    const sourceText = completedOnly
      ? (item.completed ? item.completedText : "")
      : (item.completed ? item.completedText : item.currentText);
    const normalized = trimOuterBlankLines(sourceText);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.join("\n\n");
}

function collectPendingReplyDeliveries(state, { force }) {
  const pending = [];
  for (const itemId of state.itemOrder) {
    if (state.sentItemIds.has(itemId)) {
      continue;
    }
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }
    const sourceText = resolvePlainReplySourceText(item, force);
    if (!sourceText) {
      continue;
    }
    const structuredAction = classifyReplyItemSourceText(sourceText);
    if (structuredAction) {
      pending.push(buildActionDelivery(itemId, sourceText, structuredAction));
      continue;
    }
    const plainText = markdownToPlainText(sourceText);
    const sanitizedText = sanitizeReplyText(plainText);
    if (!sanitizedText) {
      continue;
    }
    pending.push({ itemId, kind: "plain", text: sanitizedText });
  }
  return pending;
}

function resolvePlainReplySourceText(item, force) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.completed) {
    return trimOuterBlankLines(item.completedText || item.currentText || "");
  }
  if (!force) {
    return "";
  }
  return trimOuterBlankLines(item.currentText || "");
}

function buildEffectiveReplyText(deferredPrefix, replyText) {
  const prefix = trimOuterBlankLines(normalizeLineEndings(deferredPrefix));
  const body = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (prefix && body) {
    return `${prefix}\n\n${CURRENT_REPLY_HEADER}\n${body}`;
  }
  return prefix || body;
}

function markdownToPlainText(text) {
  let result = normalizeLineEndings(text);
  result = result.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/```([^\n]*)\n?([\s\S]*)$/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s*(.+)$/gm, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/^>\s?/gm, "> ");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    String(inner || "").split("|").map((cell) => cell.trim()).join("  ")
  );
  result = result.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(result);
}

function appendStreamingText(current, next) {
  const base = String(current || "");
  const incoming = String(next || "");
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }
  if (base.endsWith(incoming)) {
    return base;
  }
  if (incoming.startsWith(base)) {
    return incoming;
  }

  const maxOverlap = Math.min(base.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === incoming.slice(0, size)) {
      return `${base}${incoming.slice(size)}`;
    }
  }

  return `${base}${incoming}`;
}

function indentBlock(text) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(text));
  if (!normalized) {
    return "";
  }
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Both fields are omitted when absent so a non-Telegram payload/target keeps
// exactly the shape it had before v2.
function threadIdField(value) {
  return value === null || value === undefined ? {} : { messageThreadId: value };
}

function laneKeyField(value) {
  const normalized = normalizeText(value);
  return normalized ? { laneKey: normalized } : {};
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
    // Route lane fields travel with the target so every outbound send derived
    // from it lands in the originating Telegram topic.
    ...threadIdField(target.messageThreadId),
    ...laneKeyField(target.laneKey),
  };
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function sanitizeReplyText(plainReplyText) {
  const normalized = normalizeLineEndings(String(plainReplyText || ""));
  if (!normalized) {
    return "";
  }
  const protocolSanitized = sanitizeProtocolLeakText(normalized);
  return trimOuterBlankLines(protocolSanitized.text || "");
}

function resolveSystemReplyDelivery(replyText, policy = createSystemReplyPolicy("")) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return { kind: "invalid", reason: "final reply is empty" };
  }

  const source = normalizeSystemReplySource(normalized);
  if (source.requiresStructuredAction || source.text.startsWith("{")) {
    return resolveSystemReplyAction(source.text);
  }

  if (!policy.allowPlainTextSendMessage) {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  return resolvePlainTextSystemReply(source.text, policy);
}

function resolveSystemReplyAction(candidate) {
  const parsed = tryParseJson(candidate);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  const action = normalizeSystemActionName(parsed.action || parsed.cyberboss_action);
  if (action === "silent") {
    return { kind: "silent" };
  }
  if (action !== "send_message") {
    return { kind: "invalid", reason: "unsupported action" };
  }

  const message = sanitizeProtocolLeakText(normalizeLineEndings(String(parsed.message || parsed.text || ""))).text.trim();
  if (!message) {
    return { kind: "invalid", reason: "send_message requires a non-empty message" };
  }

  return { kind: "send_message", message };
}

function normalizeSystemReplySource(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  const unfenced = unwrapJsonCodeFence(normalized);
  if (unfenced) {
    return {
      text: unfenced.replace(/^json\s*:\s*/i, "").trim(),
      requiresStructuredAction: true,
    };
  }
  const strippedJsonPrefix = normalized.replace(/^json\s*:\s*/i, "").trim();
  return {
    text: strippedJsonPrefix,
    requiresStructuredAction: strippedJsonPrefix !== normalized,
  };
}

function resolvePlainTextSystemReply(replyText, policy) {
  const message = sanitizePlainTextSystemReply(replyText, policy);
  if (!message) {
    return { kind: "invalid", reason: "plain text system reply is unsafe" };
  }
  return { kind: "send_message", message };
}

function sanitizePlainTextSystemReply(replyText, policy) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (!normalized) {
    return "";
  }
  if (normalized.length > policy.maxPlainTextLength) {
    return "";
  }
  if (normalized.split("\n").length > policy.maxPlainTextLines) {
    return "";
  }
  if (containsPlainTextSystemHazard(normalized)) {
    return "";
  }
  return sanitizeReplyText(normalized);
}

function containsPlainTextSystemHazard(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized) {
    return true;
  }
  return /```/.test(normalized)
    || /^\s*[\[{]/.test(normalized)
    || /(?:^|\n)\s*(?:analysis|commentary|final)\s+to=/i.test(normalized)
    || /\b(?:tool_use|tool_result|function_call|mcp__|exec_command|apply_patch|read_mcp_resource)\b/i.test(normalized)
    || /(?:^|\n)\s*(?:\{|\[).*"(?:action|cyberboss_action|tool|toolName|tool_name)"\s*:/i.test(normalized);
}

function createSystemReplyPolicy(runtimeId) {
  const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
  /*
   * System/check-in turns are intentionally stricter than normal chat replies.
   * The stable protocol is one JSON action object: {"action":"silent"} or
   * {"action":"send_message","message":"..."}. JSON may be wrapped in a pure
   * ```json fence or prefixed with "json:" because those are presentation
   * wrappers around the same object, not alternate meanings.
   *
   * Codex must stay JSON-only: its streaming item protocol has historically been
   * able to expose tool/protocol fragments as assistant text, so plain system
   * text is not trusted. Claude Code is different in this bridge: tool use,
   * thinking, and assistant text are non-deliverable events, and the chat bridge receives
   * only the final result event. For claudecode only, a short natural final text
   * with no code fence, JSON/action fragment, tool marker, or protocol marker is
   * treated as send_message so random check-ins do not disappear when the model
   * forgets the JSON wrapper.
   */
  return {
    runtimeId: normalizedRuntimeId,
    allowPlainTextSendMessage: normalizedRuntimeId === "claudecode",
    maxPlainTextLength: 280,
    maxPlainTextLines: 3,
  };
}

function classifyReplyItemSourceText(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return null;
  }
  const unfenced = unwrapJsonCodeFence(normalized) || normalized;
  const stripped = unfenced.replace(/^json\s*:\s*/i, "").trim();
  const candidate = extractSystemActionJsonCandidate(stripped) || (stripped.startsWith("{") ? stripped : "");
  if (!candidate) {
    return null;
  }
  if (candidate !== stripped) {
    return null;
  }
  return resolveSystemReplyAction(candidate);
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildActionDelivery(itemId, sourceText, action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  if (action.kind === "silent") {
    return { itemId, kind: "silent", sourceText };
  }
  if (action.kind === "send_message") {
    return { itemId, kind: "action", sourceText, message: action.message };
  }
  return {
    itemId,
    kind: "invalid_action",
    sourceText,
    reason: action.reason || "invalid structured action",
  };
}

function buildDeliveryPreviewText(delivery) {
  if (!delivery || typeof delivery !== "object") {
    return "";
  }
  if (delivery.kind === "action") {
    return delivery.message || "";
  }
  if (delivery.kind === "plain") {
    return delivery.text || "";
  }
  return "";
}

// The stable system-reply protocol has exactly two actions: send_message and
// silent. But the subject keeps intuiting natural verbs (`reach_out`, `message`,
// `sent`, `chosen_silence` — all seen in production), and an unrecognised verb
// discards the whole turn as "unsupported action" — a silently lost proactive
// reach-out. These synonyms are semantically identical to a canonical action, so
// honour them. Deliberately NARROW: only synonyms of send_message / silent.
// Verbs like consolidate / browse / next_wake are NOT here — those are
// desire_state fields or in-turn skill calls, and aliasing them to send_message
// would mis-send her private intent to the Owner.
const SYSTEM_ACTION_SYNONYMS = new Map([
  ["reach_out", "send_message"], ["reach", "send_message"], ["reachout", "send_message"],
  ["message", "send_message"], ["sent", "send_message"], ["send", "send_message"],
  ["tell", "send_message"], ["say", "send_message"], ["reply", "send_message"],
  ["respond", "send_message"],
  ["chosen_silence", "silent"], ["choose_silence", "silent"], ["stay_silent", "silent"],
  ["silence", "silent"], ["quiet", "silent"], ["none", "silent"],
  ["do_nothing", "silent"], ["nothing", "silent"],
]);

function normalizeSystemActionName(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  return SYSTEM_ACTION_SYNONYMS.get(normalized) || normalized;
}

function normalizeRuntimeId(value) {
  return String(value || "").trim().toLowerCase();
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSystemActionJsonCandidate(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized || !normalized.endsWith("}")) {
    return "";
  }
  if (normalized.startsWith("{")) {
    return normalized;
  }
  for (let index = normalized.lastIndexOf("{"); index >= 0; index = normalized.lastIndexOf("{", index - 1)) {
    const candidate = normalized.slice(index).trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(candidate);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      continue;
    }
    if ("action" in parsed || "cyberboss_action" in parsed) {
      return candidate;
    }
  }
  return "";
}

function isSystemReplyContextFailure(error) {
  const message = String(error?.message || "");
  const ret = normalizeNumericErrorCode(error?.ret);
  const errcode = normalizeNumericErrorCode(error?.errcode);
  return ret === -2
    || errcode === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2");
}

function normalizeNumericErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

module.exports = {
  StreamDelivery,
  createSystemReplyPolicy,
  resolveSystemReplyDelivery,
};
