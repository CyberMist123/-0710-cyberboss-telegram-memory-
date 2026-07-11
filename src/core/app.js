const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { createTelegramChannelAdapter } = require("../adapters/channel/telegram");
const { DEFAULT_MIN_WEIXIN_CHUNK, MAX_MIN_WEIXIN_CHUNK } = require("../adapters/channel/weixin/config-store");
const { persistIncomingWeixinAttachments } = require("../adapters/channel/weixin/media-receive");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { createTimelineIntegration } = require("../integrations/timeline");
const {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildMergedInboundPrepared,
  clonePreparedInboundMessage,
  isPlainTextPreparedMessage,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
} = require("./inbound-turn");
const { resolveVisionContext } = require("../services/vision-context");
const {
  buildWeixinHelpText,
} = require("./command-registry");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { StreamDelivery, createSystemReplyPolicy, resolveSystemReplyDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { ContextTraceRecorder } = require("./context-trace");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { TimelineScreenshotQueueStore } = require("./timeline-screenshot-queue-store");
const { TurnGateStore } = require("./turn-gate-store");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const { ConversationRecorder } = require("../services/conversation-recorder");
const {
  matchesCommandPrefix,
  canonicalizeCommandTokens,
  extractApprovalFilePaths,
  isPathWithinRoot,
  normalizeCommandTokens,
  splitCommandLine,
} = require("../adapters/runtime/shared/approval-command");
const { runSystemCheckinPoller } = require("../app/system-checkin-poller");
const { runHourlyDesirePoller } = require("../app/hourly-desire-poller");
const { createProjectTooling } = require("../tools/create-project-tooling");
const { formatBeijingDateTime } = require("../utils/beijing-time");
const { runMemoryPostResponsePipeline } = require("./memory-background-pipeline");
const { resolveMemoryRetrievalPlan } = require("./memory-resolver");
const { parseMemoryCommand } = require("./memory-command-router");
const { validateDraftAgainstMemory, rewriteDraftToMatchMemory } = require("./memory-validator");
const { buildRecentStateMemoryLines } = require("../location/recent-state-memory");
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const INBOUND_IMAGE_BATCH_IDLE_MS = 1_500;

function createRuntimeAdapter(config) {
  if (config.runtime === "claudecode") {
    return createClaudeCodeRuntimeAdapter(config);
  }
  return require("../adapters/runtime/codex").createCodexRuntimeAdapter(config);
}

function hasLegacyMemoryPipelineEnabled(config = {}) {
  return Boolean(
    config.legacyMemoryRetrieval
    || config.legacyMemoryBackgroundWrite
    || config.legacyMemoryReplyTransform
    || config.includeLegacyMemoryRelays
  );
}

class CyberbossApp {
  constructor(config) {
    this.config = config;
    this.legacyMemoryPipelineEnabled = hasLegacyMemoryPipelineEnabled(config);
    this.telegramChannelAdapter = createTelegramChannelAdapter(config);
    this.weixinChannelAdapter = config.channel !== "telegram" ? createWeixinChannelAdapter(config) : null;
    this.channelAdapter = config.channel === "telegram"
      ? this.telegramChannelAdapter
      : this.weixinChannelAdapter;
    this.timelineIntegration = createTimelineIntegration(config);
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      timelineIntegration: this.timelineIntegration,
    });
    this.projectServices = projectTooling.services;
    this.projectToolHost = projectTooling.toolHost;
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.runtimeAdapter = createRuntimeAdapter(config);
    this.embeddingService = null;
    this.memoryService = null;
    if (this.legacyMemoryPipelineEnabled) {
      this.createEmbeddingService();
      this.createMemoryService({ ensureFiles: true });
    }
    this.memoryBgState = { lastMineAtMs: Date.now(), userMsgCountSinceMine: 0, userCharsSinceMine: 0, buffer: [] };
    this.threadStateStore = new ThreadStateStore();
    this.contextTraceRecorder = new ContextTraceRecorder({ filePath: config.contextTraceFile });
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.turnGateStore = new TurnGateStore();
    this.conversationRecorder = config.conversationDir ? new ConversationRecorder({ dirPath: config.conversationDir }) : null;
    this.pendingInboundByScope = new Map();
    this.pendingImageInboundByScope = new Map();
    this.telegramPendingInboundByMessageId = new Set();
    this.turnBoundaryScopeKeys = new Set();
    this.systemMessageDispatcher = null;
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      telegramChannelAdapter: this.telegramChannelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      runtimeId: this.runtimeAdapter.describe().id,
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
      transformReplyDelivery: config.legacyMemoryReplyTransform
        ? (payload) => this.transformReplyDelivery(payload)
        : null,
      onSystemReplySent: (threadId, turnId, replyText) => this.handleSystemReplySent(threadId, turnId, replyText),
    });
    this.pendingOperationByRunKey = new Map();
    this.runtimeEventChain = Promise.resolve();
    this.runtimeAdapter.onEvent((event) => {
      this.threadStateStore.applyRuntimeEvent(event);
      this.recordRuntimeEvent(event);
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(() => this.handleRuntimeEvent(event))
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(`[cyberboss] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
  }

  createEmbeddingService() {
    if (!this.embeddingService) {
      const { EmbeddingService } = require("../services/embedding-service");
      this.embeddingService = new EmbeddingService();
    }
    return this.embeddingService;
  }

  createMemoryService({ ensureFiles = false } = {}) {
    if (!this.memoryService) {
      if (!this.config.memoryDir) {
        throw new Error("CYBERBOSS_MEMORY_DIR or CYBERBOSS_STATE_DIR is required before using memory commands.");
      }
      const { MemoryService } = require("../services/memory-service");
      this.memoryService = new MemoryService({
        memoryDir: this.config.memoryDir,
        vectorFile: this.config.memoryVectorFile,
      });
    }
    if (ensureFiles) {
      this.memoryService.ensureFiles();
    }
    return this.memoryService;
  }

  getMemoryServiceForCommand() {
    return this.createMemoryService({ ensureFiles: true });
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      telegram: this.telegramChannelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    const account = this.channelAdapter.resolveAccount();
    this.activeAccountId = account.accountId;
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: account.accountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
    const syncBuffer = this.channelAdapter.loadSyncBuffer();
    await this.restoreBoundThreadSubscriptions();

    console.log("[cyberboss] bootstrap ok");
    console.log(`[cyberboss] channel=${this.channelAdapter.describe().id}`);
    console.log(`[cyberboss] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[cyberboss] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] baseUrl=${account.baseUrl || "(none)"}`);
    console.log(`[cyberboss] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[cyberboss] knownContextTokens=${knownContextTokens}`);
    console.log(`[cyberboss] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[cyberboss] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[cyberboss] runtimeModels=${runtimeState.models?.length || 0}`);
    this.logTelegramDebug(`state=${this.telegramChannelAdapter.describe().state}`);
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log(`[cyberboss] bridge loop started; waiting for ${this.config.channel === "telegram" ? "Telegram" : "WeChat"} messages.`);
    if (
      this.config.channel !== "telegram"
      && this.config.telegramBotToken
      && Array.isArray(this.config.telegramAllowedUserIds)
      && this.config.telegramAllowedUserIds.length
    ) {
      void this.runTelegramPoller().catch((error) => {
        this.logTelegramDebug(`poller stopped error=${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (this.config.startWithCheckin) {
      console.log("[cyberboss] checkin: enabled");
      void runSystemCheckinPoller(this.config).catch((error) => {
        console.error(`[cyberboss] checkin poller stopped: ${error.message}`);
      });
    }

    void runHourlyDesirePoller(this.config).catch((error) => {
      console.error(`[desire] hourly poller stopped: ${error.message}`);
    });

    const shutdown = createShutdownController(async () => {
      this.clearPendingImageInboundTimers();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    });

    try {
      let consecutiveFailures = 0;
      while (!shutdown.stopped) {
        try {
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
          if (this.config.channel === "telegram") {
            const response = await this.telegramChannelAdapter.getUpdates({
              timeoutMs: this.resolveLongPollTimeoutMs(),
            });
            const updates = Array.isArray(response?.result) ? response.result : [];
            consecutiveFailures = 0;
            for (const update of updates) {
              if (shutdown.stopped) {
                break;
              }
              const normalized = this.telegramChannelAdapter.normalizeIncomingMessage(update);
              if (!normalized) {
                continue;
              }
              this.logTelegramDebug(`inbound messageId=${normalized.messageId} chatId=${normalized.chatId} senderId=${normalized.senderId} workspace=${normalized.workspaceId}`);
              await this.handleTelegramMessage(normalized);
            }
          } else {
            const response = await this.channelAdapter.getUpdates({
              syncBuffer: this.channelAdapter.loadSyncBuffer(),
              timeoutMs: this.resolveLongPollTimeoutMs(),
            });
            assertWeixinUpdateResponse(response);
            consecutiveFailures = 0;
            const messages = sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : []);
            for (const message of messages) {
              if (shutdown.stopped) {
                break;
              }
              await this.handleIncomingMessage(message);
            }
          }
          await Promise.all([
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          if (isSessionExpiredError(error)) {
            throw new Error("The WeChat session has expired. Run `npm run login` again.");
          }

          const isTimeout = String(error?.message || "").includes("timeout");
          const is409 = String(error?.message || "").includes("telegram request failed: 409");
          if (this.config.channel === "telegram" && isTimeout) {
            consecutiveFailures = 0;
            continue;
          }
          if (this.config.channel === "telegram" && is409) {
            console.error(`[cyberboss] telegram 409 conflict (old poll still active), sleeping 5s...`);
            await sleep(5_000);
            consecutiveFailures = 0;
            continue;
          }

          consecutiveFailures += 1;
          console.error(`[cyberboss] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      shutdown.dispose();
      this.clearPendingImageInboundTimers();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    }
  }

  async ensureLocationServerStarted() {
    if (!this.projectServices?.whereabouts) {
      return null;
    }
    await this.projectServices.whereabouts.startServer({
      onAccepted: (result) => this.handleLocationAccepted(result),
    });
    console.log(
      `[cyberboss] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
    );
    return this.projectServices.whereabouts.server || null;
  }

  async closeLocationServer() {
    if (!this.projectServices?.whereabouts) {
      return;
    }
    await this.projectServices.whereabouts.closeServer();
  }

  async handleLocationAccepted(result) {
    if (!this.activeAccountId) {
      return;
    }

    const point = result?.appended?.point || null;
    const movementEvent = result?.appended?.movementEvent || null;
    if (!point && !movementEvent) {
      return;
    }
    if (!this.config.locationV2Enabled) {
      this.handleLegacyLocationAccepted(result);
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeAccountId,
      senderId,
      sessionStore,
    });
    if (!senderId || !workspaceRoot) {
      return;
    }

    const currentStay = this.projectServices?.whereabouts?.getCurrentStay?.() || null;
    const recentStays = this.projectServices?.whereabouts?.listRecentStays?.({ limit: 1 }) || [];
    const previousSnapshot = this.projectServices?.locationStateStore?.getSnapshot?.() || {};
    const enrichedPoint = await this.projectServices?.placeResolver?.resolvePoint?.({
      latitude: point?.latitude ?? currentStay?.centerLat,
      longitude: point?.longitude ?? currentStay?.centerLng,
      isGcj02: false,
      address: point?.address || currentStay?.address || "",
      placeTag: point?.placeTag || currentStay?.placeTag || "",
      notes: point?.notes || "",
    }) || null;
    const evaluated = this.projectServices?.locationStateEngine?.evaluate?.({
      point,
      enrichedPoint,
      currentStay,
      recentStays,
      movementEvent,
      previousSnapshot,
      now: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString(),
    }) || { snapshot: previousSnapshot, events: [] };
    const decisions = this.projectServices?.locationSentinel?.process?.(evaluated.events, evaluated.snapshot) || {
      accepted: [],
      dropped: [],
    };
    this.projectServices?.locationStateStore?.recordSnapshot?.(evaluated.snapshot, {
      resolvedPlace: enrichedPoint,
    });
    this.projectServices?.locationStateStore?.recordDecisions?.([
      ...decisions.accepted,
      ...decisions.dropped,
    ]);
    for (const decision of decisions.accepted) {
      const event = decision?.event;
      if (!event) {
        continue;
      }
      this.projectServices?.locationEventStore?.append?.(event);
      if (!event.queueEligible) {
        continue;
      }
      this.systemMessageQueue.enqueue({
        id: `location-event:${event.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: buildLocationStateEventSystemText(event),
        sourceType: "location_state",
        createdAt: normalizeIsoTime(event?.occurredAt) || new Date().toISOString(),
      });
    }
  }

  handleLegacyLocationAccepted(result) {
    const point = result?.appended?.point || null;
    const movementEvent = result?.appended?.movementEvent || null;
    const triggerText = buildLocationTriggerSystemText(point?.trigger);
    if (!triggerText && !movementEvent) {
      return;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeAccountId,
      senderId,
      sessionStore,
    });
    if (!senderId || !workspaceRoot) {
      return;
    }
    if (triggerText && point?.id) {
      this.systemMessageQueue.enqueue({
        id: `location-trigger:${point.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: triggerText,
        createdAt: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString(),
      });
    }
    if (movementEvent) {
      this.systemMessageQueue.enqueue({
        id: `location-move:${movementEvent.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: buildLocationMovementSystemText(movementEvent),
        createdAt: normalizeIsoTime(movementEvent?.movedAt) || new Date().toISOString(),
      });
    }
  }

  async sendTimelineScreenshot({
    senderId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    return this.projectServices.timeline.queueScreenshot({
      userId: senderId,
      outputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    }, {});
  }

  async sendLocalFileToCurrentChat({ senderId = "", filePath = "" } = {}) {
    return this.projectServices.channelFile.sendToCurrentChat({
      userId: senderId,
      filePath,
    }, {});
  }

  async handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      return;
    }

    this.recordInboundMessage(normalized);
    this.updateSleepModeFromInboundMessage(normalized);
    this.primeDeferredRepliesForSender(normalized);
    await this.handlePreparedMessage(normalized, { allowCommands: true });
  }

  deferSystemReply({ threadId = "", userId = "", text = "", error = null, kind = "plain_reply" }) {
    return this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId: this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
    });
  }

  updateSleepModeFromInboundMessage(normalized) {
    if (!normalized || normalized.provider === "system") {
      return;
    }
    const text = normalizeText(normalized.text);
    if (!text) {
      return;
    }
    const sleepMode = this.projectToolHost?.services?.system;
    if (!sleepMode || typeof sleepMode.getSleepMode !== "function") {
      return;
    }
    const receivedAt = normalizeIsoTime(normalized.receivedAt) || new Date().toISOString();
    if (detectSleepModeIntent(text) === "sleep") {
      sleepMode.enableSleepMode({ startedAt: receivedAt });
      return;
    }
    sleepMode.disableSleepMode({ resumedAt: receivedAt });
  }

  primeDeferredRepliesForSender(normalized) {
    if (!normalized?.accountId || !normalized?.senderId || !normalized?.contextToken) {
      return;
    }
    const pendingReplies = this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId);
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, formatDeferredSystemReplyBatch(pendingReplies));
    console.warn(
      `[cyberboss] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
    );
  }

  async handlePreparedMessage(normalized, { allowCommands }) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    if (normalized.provider !== "telegram") {
      this.streamDelivery.setReplyTarget(bindingKey, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
    }

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }

    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    if (!prepared) {
      return;
    }

    if (shouldBatchImageOnlyInbound(prepared)) {
      this.enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared });
      return;
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot) && isPlainTextPreparedMessage(prepared)) {
      const merged = await this.flushPendingImageInboundBatch({
        bindingKey,
        workspaceRoot,
        trailingPrepared: prepared,
      });
      if (merged) {
        return;
      }
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot)) {
      await this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot });
    }

    if (normalized.provider === "telegram") {
      await this.dispatchTelegramPreparedInbound({ bindingKey, workspaceRoot, prepared, messageId: normalized.messageId });
      return;
    }

    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
    this.maybeRunLegacyMemoryBackgroundPipeline(normalized, "post-response");
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  async dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared, pendingOperation = null }) {
    const pendingScopeKey = this.turnGateStore.begin(bindingKey, workspaceRoot);
    await this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});

    try {
      const model = this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;
      const runtimeTurn = await this.buildRuntimeTurn({ prepared, model });
      const sendTurn = typeof this.runtimeAdapter.sendTurn === "function"
        ? this.runtimeAdapter.sendTurn.bind(this.runtimeAdapter)
        : this.runtimeAdapter.sendTextTurn.bind(this.runtimeAdapter);
      const turn = await sendTurn({
        bindingKey,
        workspaceRoot,
        text: runtimeTurn.text,
        attachments: runtimeTurn.attachments,
        model,
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
          provider: prepared.provider,
          chatId: prepared.chatId || prepared.telegram?.chatId || "",
          messageId: prepared.messageId || prepared.telegram?.messageId || "",
          channelSource: prepared.provider,
        },
      });
      this.recordContextTrace?.(turn.threadId, turn.turnId, turn.continuity);
      this.runtimeContextStore?.setActiveContext?.({
        workspaceRoot,
        runtimeId: this.runtimeAdapter.describe().id,
        threadId: turn.threadId,
        bindingKey,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
        provider: prepared.provider,
      });
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      const replyTarget = {
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
      };
      if (turn.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
        if (pendingOperation && typeof pendingOperation === "object") {
          this.pendingOperationByRunKey.set(buildRunKey(turn.threadId, turn.turnId), pendingOperation);
        }
      } else {
        this.streamDelivery.queueReplyTargetForThread(turn.threadId, replyTarget);
      }
      return true;
    } catch (error) {
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      await this.channelAdapter.sendText({
        userId: prepared.senderId,
        text: `❌ Request failed\n${messageText}`,
        contextToken: prepared.contextToken,
      }).catch(() => {});
      return false;
    }
  }

  async resolveMemoryContextForPrepared(prepared) {
    const text = String(prepared?.originalText || prepared?.text || "").trim();
    if (!text) {
      return { lines: [] };
    }
    const locationLines = this.resolveRecentLocationStateMemoryLines();
    this.projectServices?.locationStateStore?.recordMemoryInjection?.({
      lines: locationLines,
      source: "location_v2",
      used: this.config.locationV2Enabled,
      text,
    });
    if (!this.config.legacyMemoryRetrieval) {
      return {
        lines: dedupeMemoryContextLines(locationLines),
        slots: [],
        mode: "disabled",
      };
    }
    const memoryService = this.memoryService || this.createMemoryService({ ensureFiles: true });
    const embeddingService = this.embeddingService || this.createEmbeddingService();
    const retrievalPlan = resolveMemoryRetrievalPlan(text);
    const recentMemoryLines = retrievalPlan.mode === "targeted"
      ? formatSevenDayContextLines(
        memoryService.readSevenDayMemory({ status: "active", limit: 20 }),
        text,
        1,
      )
      : [];
    const pendingPromiseLines = retrievalPlan.includePendingPromises
      ? formatPendingPromiseContextLines(memoryService.readPendingPromises({ status: "pending", limit: 10 }), 1)
      : [];
    if (retrievalPlan.mode !== "targeted") {
      return {
        lines: locationLines,
        slots: retrievalPlan.retrievalSlots,
        mode: retrievalPlan.mode,
      };
    }
    if (!Array.isArray(retrievalPlan.retrievalSlots) || !retrievalPlan.retrievalSlots.length) {
      return {
        lines: dedupeMemoryContextLines([...pendingPromiseLines, ...locationLines]),
        slots: [],
        mode: retrievalPlan.mode,
      };
    }
    const memoryQuery = memoryService.resolvePreResponseMemory({ slots: retrievalPlan.retrievalSlots });
    const curated = await selectCuratedMemoryLines(memoryQuery.markdownLines, text, 1, {
      embeddingService,
      memoryService,
    });
    return {
      lines: dedupeMemoryContextLines([...pendingPromiseLines, ...curated, ...recentMemoryLines, ...locationLines]),
      slots: retrievalPlan.retrievalSlots,
      mode: retrievalPlan.mode,
    };
  }

  resolveRecentLocationStateMemoryLines() {
    if (!this.config.locationV2Enabled) {
      return [];
    }
    const recentEvents = this.projectServices?.locationEventStore?.listRecent?.({
      sinceHours: 24,
      limit: 50,
    }) || [];
    return buildRecentStateMemoryLines(recentEvents, { maxLines: 3 });
  }

  async buildRuntimeTurn({ prepared, model = "" }) {
    if (prepared?.provider === "system") {
      return {
        text: String(prepared.text || "").trim(),
        attachments: [],
      };
    }
    if (prepared?.provider === "telegram") {
      return {
        text: formatTelegramRuntimeText(prepared),
        attachments: [],
      };
    }
    const visionContext = await resolveVisionContext({
      prepared,
      config: this.config,
      runtimeAdapter: this.runtimeAdapter,
      model,
    });
    const resolveMemoryContext = typeof this.resolveMemoryContextForPrepared === "function"
      ? this.resolveMemoryContextForPrepared
      : CyberbossApp.prototype.resolveMemoryContextForPrepared;
    const memoryContext = await resolveMemoryContext.call(this, prepared);
    return {
      text: assembleRuntimeTurnText({
        prepared,
        config: this.config,
        visionContext,
        memoryContext,
      }),
      attachments: Array.isArray(visionContext.runtimeAttachments) ? visionContext.runtimeAttachments : [],
      visionContext,
      memoryContext,
    };
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    if (prepared?.provider === "telegram") {
      return this.dispatchTelegramPreparedInbound({ bindingKey, workspaceRoot, prepared, messageId: prepared?.messageId || "" });
    }
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  hasPendingImageInbound(bindingKey, workspaceRoot) {
    return this.pendingImageInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingImageInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      timer: null,
    };
    current.messages.push(clonePreparedInboundMessage(prepared));
    this.pendingImageInboundByScope.set(scopeKey, current);
    this.schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = INBOUND_IMAGE_BATCH_IDLE_MS) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    draft.timer = setTimeout(() => {
      void this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot }).catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[cyberboss] image inbound debounce flush failed ${message}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    this.pendingImageInboundByScope.set(scopeKey, draft);
  }

  clearPendingImageInboundTimer(scopeKey) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft?.timer) {
      return;
    }
    clearTimeout(draft.timer);
    draft.timer = null;
  }

  clearPendingImageInboundTimers() {
    for (const [scopeKey] of this.pendingImageInboundByScope.entries()) {
      this.clearPendingImageInboundTimer(scopeKey);
    }
  }

  async flushPendingImageInboundBatch({ bindingKey = "", workspaceRoot = "", trailingPrepared = null } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const draft = scopeKey ? this.pendingImageInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot) {
      if (scopeKey) {
        this.pendingImageInboundByScope.delete(scopeKey);
      }
      return false;
    }

    this.clearPendingImageInboundTimer(scopeKey);
    this.pendingImageInboundByScope.delete(scopeKey);

    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return false;
    }

    const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
    if (!batchMessages.length) {
      return false;
    }

    if (remainingMessages.length) {
      this.pendingImageInboundByScope.set(scopeKey, {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        messages: remainingMessages,
        timer: null,
      });
    }

    const prepared = buildMergedInboundPrepared({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      messages: batchMessages,
      trailingPrepared,
    });
    await this.routePreparedInbound({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      prepared,
    });

    if (remainingMessages.length) {
      await this.flushPendingImageInboundBatch({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
      });
    }

    return true;
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
    };
    current.messages.push({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      messageId: prepared.messageId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      originalText: prepared.originalText,
      text: prepared.text,
      attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
      attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
      receivedAt: prepared.receivedAt,
    });
    this.pendingInboundByScope.set(scopeKey, current);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot) {
    return this.pendingInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    const targetScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];

    for (const [scopeKey, draft] of scopeEntries) {
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      if (this.isTurnDispatchBlocked(draft.bindingKey, draft.workspaceRoot, { ignoreBoundary })) {
        continue;
      }
      const pendingDispatch = this.mergePendingInboundDraft(draft);
      if (!pendingDispatch?.prepared) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      if (pendingDispatch.prepared?.provider === "telegram") {
        this.pendingInboundByScope.delete(scopeKey);
        await this.dispatchTelegramPreparedInbound({
          bindingKey: pendingDispatch.prepared.bindingKey,
          workspaceRoot: pendingDispatch.prepared.workspaceRoot,
          prepared: pendingDispatch.prepared,
          messageId: pendingDispatch.prepared.messageId || "",
        });
        continue;
      }
      this.pendingInboundByScope.delete(scopeKey);
      const dispatched = await this.dispatchPreparedTurn({
        bindingKey: pendingDispatch.prepared.bindingKey,
        workspaceRoot: pendingDispatch.prepared.workspaceRoot,
        prepared: {
          workspaceId: pendingDispatch.prepared.workspaceId,
          accountId: pendingDispatch.prepared.accountId,
          senderId: pendingDispatch.prepared.senderId,
          contextToken: pendingDispatch.prepared.contextToken,
          provider: pendingDispatch.prepared.provider,
          originalText: pendingDispatch.prepared.originalText,
          text: pendingDispatch.prepared.text,
          attachments: pendingDispatch.prepared.attachments,
          attachmentFailures: pendingDispatch.prepared.attachmentFailures,
          receivedAt: pendingDispatch.prepared.receivedAt,
        },
      });
      if (!dispatched) {
        this.pendingInboundByScope.set(scopeKey, draft);
        continue;
      }
      if (pendingDispatch.remainingMessages.length) {
        this.pendingInboundByScope.set(scopeKey, {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: pendingDispatch.remainingMessages,
        });
      }
    }
  }

  mergePendingInboundDraft(draft) {
    const queued = Array.isArray(draft?.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return null;
    }
    if (queued.every((message) => shouldBatchImageOnlyInbound(message))) {
      const { batchMessages, remainingMessages } = takeImageOnlyBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
      return {
        prepared: buildMergedInboundPrepared({
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: batchMessages,
        }),
        remainingMessages,
      };
    }

    if (queued.length === 1) {
      return {
        prepared: {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          ...queued[0],
        },
        remainingMessages: [],
      };
    }

    const latest = queued[queued.length - 1];
    const blocks = queued
      .map((message) => String(message.text || "").trim())
      .filter(Boolean);

    return {
      prepared: {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        ...latest,
        text: [
          "Multiple newer WeChat messages arrived while you were still handling the previous turn.",
          "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them.",
          "",
          blocks.join("\n\n"),
        ].join("\n").trim(),
      },
      remainingMessages: [],
    };
  }

  async prepareIncomingMessageForRuntime(normalized, workspaceRoot) {
    if (normalized?.provider === "system") {
      return {
        ...normalized,
        originalText: normalized.text,
        text: String(normalized.text || "").trim(),
        attachments: [],
        attachmentFailures: [],
      };
    }

    const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
    if (!attachments.length) {
      return buildInboundDraft(normalized);
    }

    const persisted = await persistIncomingWeixinAttachments({
      attachments,
      stateDir: this.config.stateDir,
      cdnBaseUrl: this.config.weixinCdnBaseUrl,
      messageId: normalized.messageId,
      receivedAt: normalized.receivedAt,
    });

    if (!persisted.saved.length && persisted.failed.length && !String(normalized.text || "").trim()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    const prepared = buildInboundDraft(normalized, {
      attachments: persisted.saved,
      attachmentFailures: persisted.failed,
    });
    if (!prepared.originalText && !prepared.attachments.length && prepared.attachmentFailures.length) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
        contextToken: normalized.contextToken,
        preserveBlock: true,
      }).catch(() => {});
      return null;
    }

    return prepared;
  }

  async flushPendingSystemMessages() {
    const pendingMessages = this.systemMessageDispatcher?.drainPending() || [];
    for (const message of pendingMessages) {
      try {
        const dispatched = await this.dispatchSystemMessage(message);
        if (!dispatched) {
          this.systemMessageDispatcher.requeue(message);
        }
      } catch {
        this.systemMessageDispatcher?.requeue(message);
      }
    }
  }

  async flushPendingTimelineScreenshots(account) {
    const pendingJobs = this.timelineScreenshotQueue.drainForAccount(account.accountId);
    for (const job of pendingJobs) {
      try {
        const captured = await this.projectServices.timeline.captureScreenshot({
          outputFile: job.outputFile,
          selector: job.selector,
          range: job.range,
          date: job.date,
          week: job.week,
          month: job.month,
          category: job.category,
          subcategory: job.subcategory,
          width: job.width,
          height: job.height,
          sidePadding: job.sidePadding,
          locale: job.locale,
        });
        await this.sendLocalFileToCurrentChat({
          senderId: job.senderId,
          filePath: captured.outputFile,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[cyberboss] timeline screenshot failed job=${job.id} ${messageText}`);
        await this.channelAdapter.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: job.senderId,
          text: `❌ Timeline screenshot failed\n${messageText}`,
          preserveBlock: true,
        }).catch(() => {});
      }
    }
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.activeAccountId && this.timelineScreenshotQueue.hasPendingForAccount(this.activeAccountId)) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }

    const nextDueAtMs = this.reminderQueue.peekNextDueAtMs();
    if (!nextDueAtMs) {
      return DEFAULT_LONG_POLL_TIMEOUT_MS;
    }

    const remainingMs = nextDueAtMs - Date.now();
    if (remainingMs <= MIN_LONG_POLL_TIMEOUT_MS) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    return Math.max(MIN_LONG_POLL_TIMEOUT_MS, Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, remainingMs));
  }

  async flushDueReminders(account) {
    const dueReminders = this.reminderQueue
      .listDue(Date.now())
      .filter((reminder) => reminder.accountId === account.accountId);

    for (const reminder of dueReminders) {
      try {
        this.systemMessageQueue.enqueue({
          id: `reminder:${reminder.id}`,
          accountId: reminder.accountId,
          senderId: reminder.senderId,
          workspaceRoot: this.resolveReminderWorkspaceRoot(reminder),
          text: buildReminderSystemTrigger(reminder, this.config),
          sourceType: "reminder",
          createdAt: new Date().toISOString(),
        });
      } catch {
        this.reminderQueue.enqueue({
          ...reminder,
          dueAtMs: Date.now() + 5_000,
        });
      }
    }
  }

  resolveReminderWorkspaceRoot(reminder) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: reminder.accountId,
      senderId: reminder.senderId,
    });
    return this.runtimeAdapter.getSessionStore().getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async dispatchSystemMessage(message) {
    const systemContextToken = this.config.channel === "telegram"
      ? `telegram:${message.senderId}`
      : (this.channelAdapter.getKnownContextTokens()[message.senderId] || "");
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(message, systemContextToken);
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(bindingKey);
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      return false;
    }
    return this.dispatchPreparedTurn({
      bindingKey,
      workspaceRoot,
      prepared,
    });
  }

  async dispatchChannelCommand(normalized, command) {
    switch (command.name) {
      case "bind":
        await this.handleBindCommand(normalized, command);
        return;
      case "status":
        await this.handleStatusCommand(normalized);
        return;
      case "new":
        await this.handleNewCommand(normalized);
        return;
      case "reread":
        await this.handleRereadCommand(normalized);
        return;
      case "compact":
        await this.handleCompactCommand(normalized);
        return;
      case "switch":
        await this.handleSwitchCommand(normalized, command);
        return;
      case "stop":
        await this.handleStopCommand(normalized);
        return;
      case "checkin":
        await this.handleCheckinCommand(normalized, command);
        return;
      case "chunk":
        await this.handleChunkCommand(normalized, command);
        return;
      case "yes":
      case "always":
      case "no":
        await this.handleApprovalCommand(normalized, command);
        return;
      case "model":
        await this.handleModelCommand(normalized, command);
        return;
      case "star":
        await this.handleStarCommand(normalized);
        return;
      case "help":
        await this.handleHelpCommand(normalized);
        return;
      case "memory":
        await this.handleMemoryCommand(normalized);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /bind /absolute/path",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot, this.config)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within CYBERBOSS_WORKSPACE.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Workspace bound\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const context = threadState?.context?.runtimeId === runtimeName
      ? threadState.context
      : this.threadStateStore.getLatestContext(runtimeName);
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const storedModel = runtimeParams.model || "";
    const storedModelProvider = runtimeParams.modelProvider || this.runtimeAdapter.describe().modelProvider || "";
    const effectiveModel = this.runtimeAdapter.describe().model || storedModel;

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🧵 thread: ${threadId || "(none)"}`,
      `📊 status: ${threadState?.status || "idle"}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
      `🤖 provider: ${storedModelProvider || "(default)"}`,
    ];
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
    }
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Switched to a fresh thread draft\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const refreshed = await this.runtimeAdapter.refreshThreadInstructions({
        threadId,
        workspaceRoot,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
        reason: "reread",
      });
      this.recordContextTrace?.(threadId, refreshed?.turnId || "", refreshed?.continuity);
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Reread failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot,
        model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
      }).then((result) => {
        const compactTurnId = normalizeCommandArgument(result?.turnId);
        if (compactTurnId) {
          this.pendingOperationByRunKey.set(buildRunKey(threadId, compactTurnId), {
            kind: "compact",
            userId: normalized.senderId,
            contextToken: normalized.contextToken,
          });
        }
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `🗜️ Compact request sent\nthread: ${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeThreadId(command.args);
    if (!targetThreadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /switch <threadId>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    let resumed;
    try {
      resumed = await this.runtimeAdapter.resumeThread({
        threadId: targetThreadId,
        workspaceRoot,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
        resumeOrigin: "user_switch",
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Switch failed; the requested thread was not replaced.\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
      }).catch(() => {});
      return;
    }
    if (resumed?.empty === true) {
      if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
        await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
      }
      sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `✅ Empty thread selected; the next message will start a fresh thread.\nworkspace: ${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resumed?.threadId || targetThreadId,
    );
    try {
      const refreshed = await this.runtimeAdapter.refreshThreadInstructions({
        threadId: resumed?.threadId || targetThreadId,
        workspaceRoot,
        model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
        reason: "user_switch",
      });
      this.recordContextTrace?.(resumed?.threadId || targetThreadId, refreshed?.turnId || "", refreshed?.continuity);
    } catch {
      // ignore refresh failure on switch; thread is already switched
    }
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Thread switched\nworkspace: ${workspaceRoot}\nthread: ${resumed?.threadId || targetThreadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    if (!rangeInput) {
      const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⏰ Current check-in interval is ${Math.round(currentRange.minIntervalMs / 60000)}-${Math.round(currentRange.maxIntervalMs / 60000)} minutes.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /checkin <min>-<max>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    this.checkinConfigStore.setRange({
      minIntervalMs: parsedRange.minMinutes * 60_000,
      maxIntervalMs: parsedRange.maxMinutes * 60_000,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Check-in interval reset to ${parsedRange.minMinutes}-${parsedRange.maxMinutes} minutes and will apply on the next polling cycle.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    if (!arg) {
      const current = this.channelAdapter.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 Current minimum merge chunk is ${current} characters. Usage: /chunk <number> (e.g. /chunk 50)`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${MAX_MIN_WEIXIN_CHUNK}.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Minimum merge chunk set to ${updated} characters. Shorter fragments will be merged into one message up to this size.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
    if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no pending approval request right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
      });
      return;
    }
    console.log(
      `[cyberboss] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    this.runtimeAdapter.getSessionStore().clearApprovalPrompt(threadId);
    console.log(
      `[cyberboss] approval response delivered thread=${threadId} requestId=${approval.requestId}`
    );
    if (command.name === "always" && isApprovalAcceptResponse(approvalResponse)) {
      this.runtimeAdapter.getSessionStore().rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
    }
    this.threadStateStore.resolveApproval(threadId, "running");
    const text = buildApprovalResponseText(approval, command.name, approvalResponse);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleModelCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const query = normalizeCommandArgument(command.args);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const catalog = sessionStore.getAvailableModelCatalog();
    const currentModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;

    if (!query) {
      const lines = [
        `Current model: ${currentModel || "(default)"}`,
      ];
      if (catalog?.models?.length) {
        lines.push(`Available models: ${catalog.models.map((item) => item.model).join(", ")}`);
      } else {
        lines.push("Available models: (not available)");
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const runtimeId = this.runtimeAdapter.describe().id || "runtime";
    let matched = require("../adapters/runtime/codex/model-catalog").findModelByQuery(catalog?.models || [], query);
    if (!matched && runtimeId !== "codex" && !catalog?.models?.length) {
      matched = { model: query };
    }
    if (!matched) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Model not found\n${query}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Model switched\nworkspace: ${workspaceRoot}\nmodel: ${matched.model}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStarCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "⭐️ Liked this project? Throw me a star on GitHub!",
        "It really means a lot to an indie dev working on passion projects 💖",
        "",
        "https://github.com/WenXiaoWendy/cyberboss",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
    await this.channelAdapter.sendFile({
      userId: normalized.senderId,
      filePath: path.join(__dirname, "../../assets/star-guide.jpg"),
      contextToken: normalized.contextToken,
    }).catch(() => {});
  }

  async runTelegramPoller() {
    let failureCount = 0;
    while (true) {
      try {
        const response = await this.telegramChannelAdapter.getUpdates({ timeoutMs: this.resolveLongPollTimeoutMs() });
        const updates = Array.isArray(response?.result) ? response.result : [];
        for (const update of updates) {
          const normalized = this.telegramChannelAdapter.normalizeIncomingMessage(update);
          if (!normalized) {
            continue;
          }
          this.logTelegramDebug(`inbound messageId=${normalized.messageId} chatId=${normalized.chatId} senderId=${normalized.senderId} workspace=${normalized.workspaceId}`);
          await this.handleTelegramMessage(normalized);
        }
        failureCount = 0;
      } catch (error) {
        failureCount += 1;
        const delayMs = Math.min(30_000, 2_000 * Math.max(1, failureCount));
        this.logTelegramDebug(`poller error=${error instanceof Error ? error.message : String(error)} retryIn=${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }

  async handleTelegramMessage(normalized) {
    this.logTelegramDebug(`handleTelegramMessage messageId=${normalized.messageId} senderId=${normalized.senderId}`);
    if (this.config.channel === "telegram") {
      await this.handlePreparedMessage(normalized, { allowCommands: true });
      return;
    }
    const account = this.channelAdapter.resolveAccount();
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindingKey = sessionStore.buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: account.accountId,
      senderId: this.resolvePrimaryWeixinSenderId(),
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    if (!prepared) {
      return;
    }
    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
  }

  resolvePrimaryWeixinSenderId() {
    const account = this.channelAdapter.resolveAccount();
    const store = this.runtimeAdapter.getSessionStore();
    const candidates = [];
    for (const binding of Object.values(store.state?.bindings || {})) {
      if (String(binding?.accountId || "").trim() !== String(account.accountId || "").trim()) {
        continue;
      }
      const senderId = String(binding?.senderId || "").trim();
      const activeWorkspaceRoot = String(binding?.activeWorkspaceRoot || "").trim();
      if (senderId && activeWorkspaceRoot) {
        candidates.push(senderId);
      }
    }
    return candidates[0] || String(this.config.allowedUserIds?.[0] || "").trim();
  }

  async dispatchTelegramPreparedInbound({ bindingKey, workspaceRoot, prepared, messageId = "" }) {
    this.logTelegramDebug(`dispatchTelegramPreparedInbound messageId=${messageId} senderId=${prepared?.senderId || ""}`);
    const startedAt = Date.now();
    while (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      if (Date.now() - startedAt > 30_000) {
        this.logTelegramDebug(`dispatch timeout buffered messageId=${messageId}`);
        this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
        return false;
      }
      await sleep(500);
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  logTelegramDebug(message) {
    const logFile = this.config.telegramStateFile
      ? path.join(path.dirname(this.config.telegramStateFile), "telegram-poller.log")
      : "";
    if (!logFile) {
      throw new Error("CYBERBOSS_STATE_DIR is required before writing telegram poller logs.");
    }
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
  }

  async handleHelpCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText(),
      contextToken: normalized.contextToken,
    });
  }

  async handleMemoryCommand(normalized) {
    const parsed = parseMemoryCommand(normalized.text);
    if (!parsed) {
      return;
    }
    const reply = await this.executeMemoryCommand(parsed).catch((error) =>
      `❌ Memory command failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`
    );
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: reply,
      contextToken: normalized.contextToken,
      preserveBlock: true,
    });
  }

  async executeMemoryCommand(parsed) {
    const action = String(parsed?.action || "help").toLowerCase();
    const args = Array.isArray(parsed?.args) ? parsed.args : [];
    const options = parsed?.options && typeof parsed.options === "object" ? parsed.options : {};
    const memoryService = action === "help"
      ? null
      : (typeof this.getMemoryServiceForCommand === "function" ? this.getMemoryServiceForCommand() : this.memoryService);
    switch (action) {
      case "help":
        return buildMemoryHelpText();
      case "list": {
        const status = normalizeMemoryStatus(args[0]) || normalizeMemoryStatus(options.status) || "active";
        const category = normalizeMemoryCategory(args[1] || options.category);
        const limit = normalizeMemoryLimit(options.limit, 20);
        const rows = status === "pending"
          ? memoryService.readPending({ limit })
          : memoryService.readIndex({ status, categories: category ? [category] : [], limit });
        if (options.json) return JSON.stringify(rows, null, 2);
        return formatMemoryRows(status === "pending" ? "7-Day memory" : `Memories (${status})`, rows);
      }
      case "review": {
        const category = normalizeMemoryCategory(args[0] || options.category);
        const limit = normalizeMemoryLimit(options.limit, 20);
        const rows = memoryService.readPending({ limit: Math.max(limit * 2, limit) })
          .filter((item) => !category || item.category === category)
          .slice(0, limit);
        if (options.json) return JSON.stringify(rows.map((item) => ({ ...item, suggestion: buildPendingRewriteSuggestion(item) })), null, 2);
        return formatPendingReviewRows("7-Day memory review", rows);
      }
      case "suggest": {
        const id = args[0] || "";
        if (!id) return "💡 Usage: /memory suggest <entryId>";
        const pending = findPendingMemoryById(memoryService, id);
        if (!pending) return `❌ 7-Day entry not found\n${id}`;
        const suggestion = buildPendingRewriteSuggestion(pending);
        return [
          `7-Day suggestion: ${id}`,
          `original: ${String(pending.summary || pending.text || pending.value || "").trim()}`,
          `suggested: ${suggestion || "(none)"}`,
        ].join("\n");
      }
      case "apply-suggestion": {
        const id = args[0] || "";
        if (!id) return "💡 Usage: /memory apply-suggestion <entryId>";
        const pending = findPendingMemoryById(memoryService, id);
        if (!pending) return `❌ 7-Day entry not found\n${id}`;
        const suggestion = buildPendingRewriteSuggestion(pending);
        const approved = memoryService.approvePending(id, { text: suggestion });
        return approved ? `✅ 7-Day entry promoted with suggestion\n${formatMemoryRow({ ...approved, text: suggestion || approved.text || approved.value, tier: 'stable', status: 'active' })}` : `❌ 7-Day entry not found\n${id}`;
      }
      case "search": {
        const query = args.join(" ").trim();
        if (!query) return "💡 Usage: /memory search <query>";
        const rows = memoryService.searchMemory(query);
        if (options.json) return JSON.stringify(rows, null, 2);
        return formatMemoryRows(`Memory search: ${query}`, rows);
      }
      case "add": {
        const category = normalizeMemoryCategory(args[0]) || "facts";
        const text = args.slice(1).join(" ").trim();
        if (!text) return "💡 Usage: /memory add <category> <text>";
        const candidate = {
          id: `mem_${Date.now()}`,
          category,
          value: text,
          text,
          priority: inferPriorityForCategory(category),
          tier: "stable",
          scope: "user",
          source: "manual",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "active",
        };
        const dup = memoryService.findDuplicate(candidate);
        if (dup) return `⚠️ Memory already exists\n${formatMemoryRow(dup)}`;
        const saved = memoryService.saveFormalMemory(candidate, { markdownText: text });
        return `✅ Memory saved\n${formatMemoryRow(saved)}`;
      }
      case "delete": {
        const reference = args[0] || "";
        if (!reference) return "💡 Usage: /memory delete <id|key>";
        return memoryService.markDeleted(reference)
          ? `✅ Memory deleted\n${reference}`
          : `❌ Memory not found\n${reference}`;
      }
      case "update": {
        const reference = args[0] || "";
        const value = args.slice(1).join(" ").trim();
        if (!reference || !value) return "💡 Usage: /memory update <id|key> <text>";
        const updated = memoryService.updateMemoryReference(reference, value);
        return updated
          ? `✅ Memory updated\n${formatMemoryRow(updated)}`
          : `❌ Active memory not found\n${reference}`;
      }
      case "undo":
        return memoryService.undoLastWrite() ? "✅ Last memory write was reverted" : "❌ No memory write to undo";
      case "pending":
        return this.executeMemoryCommand({ action: "review", args, options });
      case "approve": {
        const id = args[0] || "";
        const text = args.slice(1).join(" ").trim();
        if (!id) return "💡 Usage: /memory approve <entryId> [rewrite text]";
        const approved = memoryService.approvePending(id, { text });
        return approved ? `✅ 7-Day entry promoted into formal memory\n${formatMemoryRow({ ...approved, text: text || approved.text || approved.value, tier: 'stable', status: 'active' })}` : `❌ 7-Day entry not found\n${id}`;
      }
      case "reject": {
        const id = args[0] || "";
        if (!id) return "💡 Usage: /memory reject <entryId>";
        return memoryService.rejectPending(id) ? `✅ 7-Day entry rejected\n${id}` : `❌ 7-Day entry not found\n${id}`;
      }
      case "prune": {
        const category = normalizeMemoryCategory(args[0]);
        if (!category) return "💡 Usage: /memory prune <category>";
        const result = memoryService.pruneCategory(category);
        return result
          ? `✅ Memory category pruned\ncategory: ${category}\nbefore: ${result.before}\nafter: ${result.after}`
          : `❌ Unknown memory category\n${args[0] || ""}`;
      }
      case "cleanup": {
        const result = memoryService.cleanupHistoricalMemories();
        return [
          "✅ Memory cleanup finished",
          `deleted: ${result.deleted}`,
          `downgraded_to_observation: ${result.downgraded}`,
          `stabilized: ${result.stabilized}`,
          `backups: ${result.backups.length}`,
        ].join("\n");
      }
      default:
        return buildMemoryHelpText();
    }
  }

  transformReplyDelivery({ state, text }) {
    const candidate = String(text || "").trim();
    if (!candidate || !state?.threadId) {
      return candidate;
    }
    const resolved = this.memoryService?.resolvePreResponseMemory?.({
      slots: ["identity", "relationship", "preference", "project", "pattern", "pending_promise"],
      maxPerCategory: 8,
    }) || { index: [] };
    const rewritten = rewriteDraftToMatchMemory(candidate, resolved);
    if (rewritten.ok) {
      if (rewritten.changed && rewritten.text !== candidate) {
        console.warn(
          `[memory] rewrote reply to match memory thread=${state.threadId} conflicts=${(rewritten.originalConflicts || []).map((item) => item.key || item.type).join(",")}`
        );
      }
      this.recordAssistantReplyForMemory(rewritten.text);
      return rewritten.text;
    }
    const validation = validateDraftAgainstMemory(candidate, resolved);
    if (validation.ok) {
      this.recordAssistantReplyForMemory(candidate);
      return candidate;
    }
    console.warn(
      `[memory] blocked conflicting reply thread=${state.threadId} conflicts=${validation.conflicts.map((item) => item.key).join(",")}`
    );
    const fallback = "我先确认一下，免得我把前面的约定说反。";
    this.recordAssistantReplyForMemory(fallback);
    return fallback;
  }

  recordAssistantReplyForMemory(text = "") {
    const candidate = String(text || "").trim();
    if (!candidate) {
      return;
    }
    this.maybeRunLegacyMemoryBackgroundPipeline({
      text: candidate,
      role: "assistant",
      receivedAt: new Date().toISOString(),
    }, "assistant reply");
  }

  maybeRunLegacyMemoryBackgroundPipeline(normalized, label = "post-response") {
    if (!this.config.legacyMemoryBackgroundWrite) {
      return;
    }
    const memoryService = this.memoryService || this.createMemoryService({ ensureFiles: true });
    const embeddingService = this.embeddingService || this.createEmbeddingService();
    void runMemoryPostResponsePipeline({
      memoryService,
      embeddingService,
      normalized,
      bgState: this.memoryBgState,
    }).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error || "unknown");
      console.warn(`[memory] ${label} pipeline failed: ${msg}`);
    });
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async handleRuntimeEvent(event) {
    const failureReplyTarget = event?.type === "runtime.turn.failed"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event?.payload?.threadId,
          turnId: event?.payload?.turnId,
        })
      : null;
    if (event?.payload?.threadId) {
      const linkedForTrace = this.runtimeAdapter.getSessionStore().findBindingForThreadId(event.payload.threadId);
      const replyTargetForTrace = this.streamDelivery.resolveReplyTargetForRun({
        threadId: event?.payload?.threadId,
        turnId: event?.payload?.turnId,
      });    }
    await this.streamDelivery.handleRuntimeEvent(event);
    if (!event) {
      return;
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      if (event.type === "runtime.turn.completed") {
        this.maybeCloseDesireLoopForPendingOperation(pendingOperation, event?.payload);
        this.maybeSaveDesireStateFromTurnText(event?.payload?.text || "");
      }
      const sessionStore = this.runtimeAdapter.getSessionStore();
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(event.payload.threadId);
      const scopeKey = linked?.bindingKey && linked?.workspaceRoot
        ? buildScopeKey(linked.bindingKey, linked.workspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        this.turnGateStore.releaseThread(event.payload.threadId);
        if (event.type === "runtime.turn.failed") {
          await this.sendFailureToThread(
            event.payload.threadId,
            event.payload.text || "❌ Execution failed",
            failureReplyTarget,
          );
        }
        if (linked?.bindingKey && linked?.workspaceRoot) {
          await this.flushPendingInboundMessages({
            bindingKey: linked.bindingKey,
            workspaceRoot: linked.workspaceRoot,
            ignoreBoundary: true,
          });
        } else {
          await this.flushPendingInboundMessages();
        }
        await this.flushPendingSystemMessages();
        if (pendingOperation?.kind === "compact" && event.type === "runtime.turn.completed") {
          await this.channelAdapter.sendText({
            userId: pendingOperation.userId,
            text: `✅ Compact finished\nthread: ${event.payload.threadId}`,
            contextToken: pendingOperation.contextToken,
          }).catch(() => {});
        }
        const shouldKeepTyping = linked?.bindingKey && linked?.workspaceRoot
          ? (
            this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
            || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)
          )
          : false;
        if (!shouldKeepTyping) {
          await this.stopTypingForThread(event.payload.threadId);
        }
      } finally {
        if (scopeKey) {
          this.turnBoundaryScopeKeys.delete(scopeKey);
        }
      }
      return;
    }
    if (event.type !== "runtime.approval.requested") {
      return;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    const allowlist = sessionStore.getApprovalCommandAllowlistForWorkspace(linked.workspaceRoot);
    const shouldAutoApprove = isAutoApprovedStateDirOperation(event.payload, this.config)
      || matchesBuiltInCommandPrefix(event.payload.commandTokens)
      || matchesCommandPrefix(event.payload.commandTokens, allowlist);
    if (!shouldAutoApprove) {
      const promptState = sessionStore.getApprovalPromptState(event.payload.threadId);
      const promptSignature = buildApprovalPromptSignature(event.payload);
      if (promptState?.signature && promptState.signature === promptSignature) {
        sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
        console.log(
          `[cyberboss] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        return;
      }
      sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch((error) => {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        throw error;
      });
      return;
    }
    const approvalResponse = buildApprovalResponsePayload(event.payload, "yes");
    if (!approvalResponse) {
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch(() => {});
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
  }

  async stopTypingForThread(threadId) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
    if (!target) {
      return;
    }
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  recordInboundMessage(normalized) {
    if (!this.conversationRecorder || !normalized) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    this.conversationRecorder.record({
      type: "user",
      timestamp: normalizeIsoTime(normalized.receivedAt) || new Date().toISOString(),
      threadId,
      workspaceRoot,
      text: typeof normalized.text === "string" ? normalized.text : "",
      meta: {
        workspaceId: normalized.workspaceId,
        accountId: normalized.accountId,
        senderId: normalized.senderId,
        provider: normalized.provider,
        messageId: normalized.messageId,
        contextToken: normalized.contextToken,
        attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
      },
    });
  }

  recordRuntimeEvent(event) {
    if (!this.conversationRecorder || !event || typeof event !== "object") {
      return;
    }
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const threadId = normalizeText(payload.threadId);
    const linked = threadId ? this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId) : null;
    const workspaceRoot = normalizeText(payload.workspaceRoot) || normalizeText(linked?.workspaceRoot);
    this.conversationRecorder.record({
      type: String(event.type || "").trim(),
      timestamp: normalizeIsoTime(payload.timestamp) || new Date().toISOString(),
      threadId,
      turnId: normalizeText(payload.turnId),
      workspaceRoot,
      text: typeof payload.text === "string" ? payload.text : "",
      meta: payload,
    });
    if (event.type === "runtime.turn.started") {
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
    }
  }

  async sendFailureToThread(threadId, text, fallbackTarget = null) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = normalizeReplyTarget(
      linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null
    ) || normalizeReplyTarget(fallbackTarget);
    if (!target) {
      return;
    }
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: normalizeText(text) || "❌ Execution failed",
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendApprovalPrompt({ bindingKey, approval }) {
    const target = this.resolveReplyTargetForBinding(bindingKey);
    if (!target) {
      console.warn(
        `[cyberboss] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    console.log(
      `[cyberboss] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: buildApprovalPromptText(approval),
      contextToken: target.contextToken,
      preserveBlock: true,
    });
    console.log(
      `[cyberboss] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindings = sessionStore.listBindings();
    const seenThreadIds = new Set();

    for (const binding of bindings) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }

      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }

      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const normalizedWorkspaceRoot = normalizeCommandArgument(workspaceRoot);
        const normalizedThreadId = normalizeCommandArgument(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot)
        );
        if (!normalizedThreadId || seenThreadIds.has(normalizedThreadId)) {
          continue;
        }
        seenThreadIds.add(normalizedThreadId);
        await this.runtimeAdapter.resumeThread({
          threadId: normalizedThreadId,
          workspaceRoot: normalizedWorkspaceRoot,
          resumeOrigin: "implicit_restore",
        }).catch(() => {});
      }
    }
  }

  recordContextTrace(threadId, turnId, continuity = {}) {
    const context = continuity && typeof continuity === "object" ? continuity : {};
    void this.contextTraceRecorder.record({
      threadId,
      turnId,
      opening: context.opening === true,
      blocks: context.blocks,
      skipped: context.skipped,
      fallback: context.fallback,
      total_chars: context.total_chars,
      recall_calls: [],
    });
  }

  resolveReplyTargetForBinding(bindingKey) {
    const binding = this.runtimeAdapter.getSessionStore().getBinding(bindingKey) || null;
    const userId = normalizeCommandArgument(binding?.senderId);
    if (!userId) {
      return null;
    }
    const provider = this.config.channel === "telegram" ? "telegram" : "weixin";
    const contextToken = provider === "telegram"
      ? `telegram:${userId}`
      : (this.channelAdapter.getKnownContextTokens()[userId] || "");
    if (provider !== "telegram" && !contextToken) {
      return null;
    }
    return {
      userId,
      contextToken,
      provider,
    };
  }

  handleSystemReplySent(threadId, turnId, replyText) {
    if (!replyText) return;
    try {
      const text = typeof replyText === "string" ? replyText.trim() : "";
      if (!text) return;
      const isObj = text.startsWith("{");
      if (!isObj) { console.log(`[desire] handleSystemReplySent non-JSON text thread=${threadId}`); return; }
      const parsed = JSON.parse(text);
      const state = parsed?.desire_state;
      if (state && this.config.desireStateFile) {
        const fs = require("fs");
        const drives = normalizeDesireDrives(state?.drives);
        const intent = normalizeDesireIntent(state?.intent);
        const now = new Date().toISOString();
        let previous = null;
        try {
          const raw = JSON.parse(fs.readFileSync(this.config.desireStateFile, "utf8"));
          if (raw.drives && raw.updatedAt !== now) {
            previous = { drives: raw.drives, updatedAt: raw.updatedAt };
          }
        } catch {}
        fs.writeFileSync(this.config.desireStateFile, JSON.stringify({
          ...state,
          drives,
          intent,
          previous,
          updatedAt: now,
        }, null, 2));
      }
    } catch {}
  }

  maybeCloseDesireLoopForPendingOperation(pendingOperation, payload = {}) {
  }

  maybeSaveDesireStateFromTurnText(text) {
    if (!text || !this.config.desireStateFile) return;
    try {
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed || !trimmed.startsWith("{")) return;
      const parsed = JSON.parse(trimmed);
      const state = parsed?.desire_state;
      if (!state || !Array.isArray(state?.drives)) return;
      const fs = require("fs");
      const drives = normalizeDesireDrives(state.drives);
      const now = new Date().toISOString();
      let previous = null;
      try {
        const raw = JSON.parse(fs.readFileSync(this.config.desireStateFile, "utf8"));
        if (raw.drives && raw.updatedAt !== now) {
          previous = { drives: raw.drives, updatedAt: raw.updatedAt };
        }
      } catch {}
      fs.writeFileSync(this.config.desireStateFile, JSON.stringify({
        ...state,
        drives,
        previous,
        updatedAt: now,
      }, null, 2));
    } catch {}
  }
}

const DRIVE_KEY_ALIASES = {
  responsibility: "duty",
  sexuality: "libido",
};
const VALID_DRIVE_KEYS = new Set([
  "attachment", "curiosity", "reflection", "duty",
  "social", "fatigue", "libido", "stress",
]);

function normalizeDesireDrives(drives) {
  if (!Array.isArray(drives)) return drives;
  return drives.map((d) => {
    if (!d || typeof d !== "object") return d;
    const key = normalizeText(d.key);
    const normalized = DRIVE_KEY_ALIASES[key] || (VALID_DRIVE_KEYS.has(key) ? key : "");
    return normalized ? { ...d, key: normalized } : null;
  }).filter(Boolean);
}

function normalizeDesireIntent(intent) {
  if (!intent || typeof intent !== "object") return intent;
  const driveKey = normalizeText(intent.drive_key);
  const normalized = DRIVE_KEY_ALIASES[driveKey] || (VALID_DRIVE_KEYS.has(driveKey) ? driveKey : "");
  return normalized ? { ...intent, drive_key: normalized } : intent;
}

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
  };
}

function formatCompactNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "0";
  }
  if (normalized >= 1_000_000) {
    return `${Math.round(normalized / 100_000) / 10}m`;
  }
  if (normalized >= 1_000) {
    return `${Math.round(normalized / 100) / 10}k`;
  }
  return String(Math.round(normalized));
}

function buildPendingSystemDesireOperation(message, desireState) {
  const intent = desireState?.intent && typeof desireState.intent === "object" ? desireState.intent : {};
  return {
    kind: "system_desire",
    sourceType: normalizeText(message?.sourceType) || "system",
    drivenBehaviorEnabled: desireState?.driven_behavior_enabled === true,
    driveKey: normalizeText(intent.drive_key) || "attachment",
    wantAction: normalizeText(intent.want_action) || "none",
  };
}

function shouldPulseSelfExperienceForAction(action) {
  const normalized = normalizeText(action);
  return normalized === "github"
    || normalized === "web_search"
    || normalized === "web_browse"
    || normalized === "co_read";
}

function sourceDriveKeyForAction(action) {
  switch (normalizeText(action)) {
    case "co_read":
      return "reflection";
    case "web_browse":
      return "social";
    case "github":
    case "web_search":
      return "curiosity";
    default:
      return "";
  }
}

function resolveDesireAvailableActionsSafe(app) {
  if (app && typeof app.resolveDesireAvailableActions === "function") {
    return app.resolveDesireAvailableActions();
  }
  return ["co_read", "github", "web_search", "web_browse", "tease", "vent", "none"];
}

function formatContextStatusLine({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  if (runtimeName === "claudecode") {
    const configuredWindow = Number(claudeContextWindow);
    if (!Number.isFinite(configuredWindow) || configuredWindow <= 0) {
      return "📦 context: set CYBERBOSS_CLAUDE_CONTEXT_WINDOW";
    }
    const reservedOutputTokens = Math.max(0, Number(claudeMaxOutputTokens) || 0);
    const availableMessageWindow = configuredWindow - reservedOutputTokens;
    if (availableMessageWindow <= 0) {
      return "📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS";
    }
    if (!context || !Number.isFinite(Number(context.currentTokens))) {
      return "📦 context: unavailable";
    }
    const summary = formatContextUsage(Number(context.currentTokens), availableMessageWindow);
    if (reservedOutputTokens > 0) {
      return `📦 context: approx ${summary} | reserve ${formatCompactNumber(reservedOutputTokens)}`;
    }
    return `📦 context: approx ${summary}`;
  }
  if (!context) {
    return "📦 context: unavailable";
  }
  const currentTokens = Number(context.currentTokens);
  const contextWindow = Number(context.contextWindow);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "📦 context: unavailable";
  }
  return `📦 context: ${formatContextUsage(currentTokens, contextWindow)}`;
}

function formatContextUsage(currentTokens, contextWindow) {
  const safeCurrent = Math.max(0, Number(currentTokens) || 0);
  const safeWindow = Math.max(1, Number(contextWindow) || 1);
  const clampedCurrent = Math.min(safeCurrent, safeWindow);
  const leftPercent = Math.max(0, Math.min(100, Math.round(((safeWindow - clampedCurrent) / safeWindow) * 100)));
  return `${formatCompactNumber(clampedCurrent)}/${formatCompactNumber(safeWindow)} | ${leftPercent}% left`;
}

function buildLocationMovementSystemText(event) {
  const distanceText = `${formatCompactNumber(event?.distanceMeters || 0)}m`;
  const fromLabel = normalizeText(event?.fromAddress) || formatLatLng(event?.fromCenterLat, event?.fromCenterLng);
  const toLabel = normalizeText(event?.toAddress) || formatLatLng(event?.toCenterLat, event?.toCenterLng);
  const movedAt = normalizeText(event?.movedAt) || new Date().toISOString();
  return [
    "System context: the user's location appears to have changed significantly.",
    `Distance: about ${distanceText}.`,
    fromLabel ? `From: ${fromLabel}` : "",
    toLabel ? `To: ${toLabel}` : "",
    `Observed at: ${movedAt}.`,
  ].filter(Boolean).join("\n");
}

function buildLocationTriggerSystemText(trigger) {
  switch (normalizeText(trigger)) {
    case "arrive_home":
      return "User arrives home.";
    case "leave_home":
      return "User leaves home.";
    default:
      return "";
  }
}

function buildLocationStateEventSystemText(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  if (event?.type === "ArrivedPlace") {
    const placeLabel = normalizeText(payload.placeName) || normalizeText(payload.placeTag) || "a place";
    const district = normalizeText(payload.district) || normalizeText(payload.city);
    return `System context: the user arrived at ${placeLabel}${district ? ` (${district})` : ""}.`;
  }
  if (event?.type === "LeftPlace") {
    return `System context: the user left ${normalizeText(payload.fromPlaceName) || normalizeText(payload.fromPlaceTag) || "a place"}.`;
  }
  if (event?.type === "MajorMovement") {
    return buildLocationMovementSystemText({
      distanceMeters: payload.distanceMeters,
      fromAddress: payload.fromPlaceName || payload.fromPlaceTag,
      toAddress: payload.toPlaceName || payload.toPlaceTag,
      movedAt: event?.occurredAt,
    });
  }
  if (event?.type === "BatteryCritical") {
    return `System context: the user's battery is critical${Number.isFinite(Number(payload.batteryLevel)) ? ` (${Math.round(Number(payload.batteryLevel))}%)` : ""}${normalizeText(payload.placeName) ? ` near ${normalizeText(payload.placeName)}` : ""}.`;
  }
  return "";
}

function formatLatLng(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function createShutdownController(onStop) {
  let stopped = false;
  let stoppingPromise = null;

  const stop = async () => {
    if (stopped) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = Promise.resolve().then(onStop);
    return stoppingPromise;
  };

  const handleSignal = () => {
    stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    },
  };
}

function assertWeixinUpdateResponse(response) {
  const ret = normalizeErrorCode(response?.ret);
  const errcode = normalizeErrorCode(response?.errcode);
  if ((ret !== 0 && ret !== null) || (errcode !== 0 && errcode !== null)) {
    const error = new Error(
      `weixin getUpdates ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${normalizeText(response?.errmsg) || ""}`
    );
    error.ret = ret;
    error.errcode = errcode;
    throw error;
  }
}

function isSessionExpiredError(error) {
  const ret = normalizeErrorCode(error?.ret);
  const errcode = normalizeErrorCode(error?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || String(error?.message || "").includes("session expired")
    || String(error?.message || "").includes("session invalidated");
}

function normalizeErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  if (isSessionExpiredError(error)) {
    return "The WeChat session has expired. Run `npm run login` again.";
  }
  return raw;
}

function detectSleepModeIntent(text) {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const sleepKeywords = ["晚安", "睡了", "睡觉了", "去睡了", "去睡", "我睡了", "我睡啦", "睡啦", "goodnight", "good night", "sleep", "going to bed", "gonna sleep"];
  if (sleepKeywords.some((keyword) => normalized.includes(keyword))) {
    return "sleep";
  }
  return "";
}

function formatTelegramRuntimeText(prepared) {
  const chatId = normalizeText(prepared?.chatId || prepared?.telegram?.chatId);
  const messageId = normalizeText(prepared?.messageId || prepared?.telegram?.messageId);
  const userId = normalizeText(prepared?.senderId || prepared?.telegram?.userId);
  const username = normalizeText(prepared?.telegram?.username);
  const sentAt = normalizeText(prepared?.receivedAt);
  const body = String(prepared?.originalText || prepared?.text || "").trim();
  const openTag = [
    '<channel source="telegram"',
    chatId ? `chat_id="${escapeXmlAttribute(chatId)}"` : '',
    messageId ? `message_id="${escapeXmlAttribute(messageId)}"` : '',
    userId ? `user_id="${escapeXmlAttribute(userId)}"` : '',
    username ? `username="${escapeXmlAttribute(username)}"` : '',
    sentAt ? `sent_at="${escapeXmlAttribute(sentAt)}"` : '',
  ].filter(Boolean).join(' ') + '>';
  return [
    openTag,
    body,
    '</channel>',
  ].join('\n');
}

function escapeXmlAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { CyberbossApp };

function parseChannelCommand(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("/")) {
    return null;
  }
  const [rawName, ...rest] = normalized.slice(1).split(/\s+/);
  const name = normalizeCommandName(rawName);
  if (!name) {
    return null;
  }
  return {
    name,
    args: rest.join(" ").trim(),
  };
}

function normalizeCommandName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const MEMORY_CATEGORIES = new Set([
  "facts",
  "preferences",
  "patterns",
  "projects",
  "pending_promises",
  "relationships",
  "profile",
]);

const MEMORY_STATUSES = new Set(["active", "pending", "deleted", "superseded"]);

function buildMemoryHelpText() {
  return [
    "Memory commands:",
    "/memory list [status] [category]",
    "/memory review [category] [--limit N] [--json]",
    "/memory suggest <pendingId>",
    "/memory apply-suggestion <pendingId>",
    "/memory search <query>",
    "/memory add <category> <text>",
    "/memory update <id|key> <text>",
    "/memory delete <id|key>",
    "/memory pending",
    "/memory approve <entryId> [rewrite text]",
    "/memory reject <entryId>",
    "/memory prune <category>",
    "/memory cleanup",
    "/memory undo",
  ].join("\n");
}

function normalizeMemoryCategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MEMORY_CATEGORIES.has(normalized) ? normalized : "";
}

function normalizeMemoryStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return MEMORY_STATUSES.has(normalized) ? normalized : "";
}

function normalizeMemoryLimit(value, fallback = 20) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 200);
}

function inferPriorityForCategory(category) {
  switch (category) {
    case "preferences":
      return "hard_preference";
    case "profile":
    case "facts":
      return "hard_fact";
    case "relationships":
      return "relationship";
    case "projects":
      return "project";
    case "patterns":
      return "pattern";
    case "pending_promises":
      return "pending_promise";
    default:
      return "soft_preference";
  }
}

function formatMemoryRows(title, rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) {
    return `${title}\n(empty)`;
  }
  return [title, ...items.map((item) => formatMemoryRow(item))].join("\n");
}

function formatPendingReviewRows(title, rows = []) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) return `${title}\n(empty)`;
  return [
    title,
    ...items.map((item) => {
      const category = String(item.category || "memory").trim();
      const id = String(item.id || "").trim() || "(no-id)";
      const text = String(item.summary || item.text || item.value || "").trim() || "(empty)";
      const suggestion = buildPendingRewriteSuggestion(item);
      const status = String(item.status || 'active').trim();
      const key = String(item.key || 'no').trim();
      const promoteTo = String(item.promote_to || item.suggested_category || '').trim();
      const suffix = suggestion && suggestion !== text ? `\n  suggest: ${suggestion}` : "";
      const meta = [`status=${status}`, `key=${key}`];
      if (promoteTo) meta.push(`promote_to=${promoteTo}`);
      return `- ${id} [${category}] ${text} (${meta.join(", ")})${suffix}`;
    }),
  ].join("\n");
}

function findPendingMemoryById(memoryService, id = "") {
  const target = String(id || "").trim();
  if (!memoryService || !target) return null;
  const rows = memoryService.readPending({ limit: 1000 });
  return rows.find((item) => String(item.id || "").trim() === target) || null;
}

function buildPendingRewriteSuggestion(item = {}) {
  const text = String(item.summary || item.text || item.value || "").trim();
  const category = String(item.category || "").trim();
  if (!text) return "";
  if (category === "preferences") {
    if (/直接一点|更容易理解/.test(text)) return "偏好直接、易理解的表达";
    if (/奇奇怪怪的比喻|别用.*比喻/.test(text)) return "不喜欢奇怪比喻，偏好直接表达";
    if (/telegram|微信/.test(text)) return "私密话题优先放 Telegram；微信主要聊日常、工作、提醒和正经事";
  }
  if (category === "facts") {
    if (/吃太辣/.test(text) && /胃疼/.test(text)) return "吃太辣会胃疼";
    if (/下雨/.test(text) && /(讨厌|不喜欢)/.test(text)) return "不喜欢下雨";
  }
  return text;
}

function formatMemoryRow(item = {}) {
  const id = String(item.id || "").trim() || "(no-id)";
  const category = String(item.category || item.status || "memory").trim();
  const text = String(item.text || item.value || "").trim() || "(empty)";
  const key = String(item.key || "").trim();
  const extras = [];
  if (key) extras.push(`key=${key}`);
  if (item.status) extras.push(`status=${item.status}`);
  if (item.tier) extras.push(`tier=${item.tier}`);
  if (item.promote_to) extras.push(`promote_to=${item.promote_to}`);
  return `- ${id} [${category}] ${text}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

async function selectCuratedMemoryLines(markdownLines = {}, query = "", limit = 4, options = {}) {
  const items = [];
  for (const [category, lines] of Object.entries(markdownLines || {})) {
    for (const line of Array.isArray(lines) ? lines : []) {
      const text = String(line || "").trim();
      if (!text) continue;
      items.push({ category, text, score: scoreCuratedMemoryLine(text, query) });
    }
  }
  if (!items.length) return [];
  const keywordRanked = items
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  const topKeywordScore = keywordRanked.length ? keywordRanked[0].score : 0;
  if (topKeywordScore >= 4 || !options?.embeddingService || !options?.memoryService?.syncMarkdownEmbeddings) {
    return keywordRanked
      .slice(0, limit)
      .map((item) => `${item.category}: ${item.text}`);
  }
  const queryVector = await options.embeddingService.embedText(query);
  if (!Array.isArray(queryVector) || !queryVector.length) {
    return keywordRanked
      .slice(0, limit)
      .map((item) => `${item.category}: ${item.text}`);
  }
  const embeddingEntries = await options.memoryService.syncMarkdownEmbeddings({
    categories: Object.keys(markdownLines || {}),
    markdownLines,
    embeddingService: options.embeddingService,
  });
  const semanticByKey = new Map();
  for (const entry of Array.isArray(embeddingEntries) ? embeddingEntries : []) {
    const score = Number(options.embeddingService.cosineSimilarity(queryVector, Array.isArray(entry.vector) ? entry.vector : [])) || 0;
    semanticByKey.set(`${entry.category}\n${entry.text}`, score);
  }
  return items
    .map((item) => {
      const semanticScore = semanticByKey.get(`${item.category}\n${item.text}`) || 0;
      const semanticBoost = semanticScore >= 0.35 ? semanticScore * 3 : 0;
      return {
        ...item,
        semanticScore,
        finalScore: item.score + semanticBoost,
      };
    })
    .filter((item) => item.score > 0 || item.semanticScore >= 0.45)
    .sort((a, b) => b.finalScore - a.finalScore || b.score - a.score || a.text.length - b.text.length)
    .slice(0, limit)
    .map((item) => `${item.category}: ${item.text}`);
}

function scoreCuratedMemoryLine(line = "", query = "") {
  const text = String(line || "").trim();
  if (!text) return 0;
  const q = String(query || "").trim().toLowerCase();
  if (!q) return 0;
  let score = 0;
  const keywords = q.split(/[\s，。！？!?,；;、]+/).map((x) => x.trim()).filter((x) => x.length >= 2);
  for (const keyword of keywords) {
    if (text.toLowerCase().includes(keyword)) score += 2;
  }
  if (q.length >= 4 && text.toLowerCase().includes(q)) score += 4;
  if (/(telegram|微信)/i.test(q) && /(telegram|微信)/i.test(text)) score += 3;
  if (/(提醒|下班|时间|免打扰)/.test(q) && /(提醒|时间|免打扰|下班)/.test(text)) score += 3;
  if (/(喜欢|讨厌|不要|别用|说话|表达)/.test(q) && /(喜欢|讨厌|不要|别用|表达|说话)/.test(text)) score += 3;
  if (/(线程|记忆|连续性)/.test(q) && /(线程|记忆|连续性|偏爱)/.test(text)) score += 4;
  if (/(痛经|胃疼|拉肚子|生病|下雨|天气|工作|外贸)/.test(q) && /(痛经|胃疼|拉肚子|生病|下雨|天气|工作|外贸)/.test(text)) score += 3;
  return score;
}

function dedupeMemoryContextLines(lines = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || "").trim();
    if (!line) continue;
    const normalized = line.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(line);
  }
  return out;
}

function formatSevenDayContextLines(entries = [], query = "", limit = 3) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      entry,
      score: scoreSevenDayEntry(entry, query),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => {
      const category = String(entry.promote_to || entry.suggested_category || entry.category || "recent").trim();
      const summary = String(entry.summary || entry.text || "").trim();
      const keyFlag = String(entry.key || "").trim().toLowerCase() === "yes" ? " KEY" : "";
      return `7day:${category}${keyFlag}: ${summary}`;
    });
}

function scoreSevenDayEntry(entry = {}, query = "") {
  const summary = String(entry.summary || entry.text || "").trim();
  if (!summary) return 0;
  const q = String(query || "").trim();
  if (!q) return 0;
  let score = scoreCuratedMemoryLine(summary, q);
  const quoted = String(entry.quoted || "").trim();
  if (quoted) score += Math.max(0, scoreCuratedMemoryLine(quoted, q) - 1);
  const keywords = Array.isArray(entry.keywords) ? entry.keywords : String(entry.keywords || '').split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  for (const keyword of keywords) {
    if (keyword && q.toLowerCase().includes(keyword.toLowerCase())) score += 2;
  }
  if (String(entry.key || '').trim().toLowerCase() === 'yes') score += 2;
  return score;
}

function formatPendingPromiseContextLines(entries = [], limit = 3) {
  const today = isoDateForMemoryContext(new Date());
  const prioritized = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      ...entry,
      due: String(entry?.due || "").trim(),
      text: String(entry?.text || "").trim(),
      flag: resolvePendingPromiseFlag(String(entry?.due || "").trim(), today),
    }))
    .filter((entry) => entry.text && String(entry.status || "pending").trim().toLowerCase() === "pending")
    .sort((left, right) => comparePendingPromiseEntries(left, right));
  return prioritized.slice(0, limit).map((entry) => {
    const marker = entry.flag || "•";
    const duePart = entry.due ? ` due=${entry.due}` : "";
    return `pending_promises: ${marker} ${entry.text}${duePart}`;
  });
}

function comparePendingPromiseEntries(left = {}, right = {}) {
  const leftRank = pendingPromiseUrgencyRank(left.flag);
  const rightRank = pendingPromiseUrgencyRank(right.flag);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftDue = normalizeSortableDate(left.due);
  const rightDue = normalizeSortableDate(right.due);
  if (leftDue !== rightDue) return leftDue - rightDue;
  return String(left.text || "").length - String(right.text || "").length;
}

function pendingPromiseUrgencyRank(flag = "") {
  if (flag === "⚠️") return 0;
  if (flag === "⏰") return 1;
  return 2;
}

function resolvePendingPromiseFlag(due = "", today = "") {
  if (!due || !today) return "";
  const dueMs = normalizeSortableDate(due);
  const todayMs = normalizeSortableDate(today);
  if (!Number.isFinite(dueMs) || !Number.isFinite(todayMs)) return "";
  if (dueMs < todayMs) return "⚠️";
  const deltaDays = Math.floor((dueMs - todayMs) / (24 * 60 * 60 * 1000));
  if (deltaDays <= 7) return "⏰";
  return "";
}

function normalizeSortableDate(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(`${normalized}T00:00:00+08:00`);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function isoDateForMemoryContext(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isPathWithinAllowedDirectories(rawPath, config = {}) {
  const resolved = path.resolve(rawPath);
  const normalized = resolved.replace(/\\/g, "/") + "/";
  const allowedDirs = [
    config?.workspaceRoot,
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).replace(/\\/g, "/") + "/");
  return allowedDirs.some((prefix) => normalized.startsWith(prefix));
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\s+/g, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function matchesBuiltInCommandPrefix(commandTokens) {
  const normalized = normalizeCommandTokensForMatching(commandTokens);
  if (!normalized.length) {
    return false;
  }

  if (normalized[0] === "view_image") {
    return true;
  }

   if (normalized[0] === "mcp_tool" && normalized[1] === "cyberboss_tools") {
    return true;
  }

  return false;
}

function normalizeCommandTokensForMatching(commandTokens) {
  return canonicalizeCommandTokens(commandTokens);
}

function buildApprovalPromptText(approval) {
  if (approval?.kind === "mcp_elicitation") {
    return buildElicitationApprovalPromptText(approval);
  }
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const toolName = extractToolNameFromReason(reasonText) || "";
  const commandLines = commandText ? commandText.split("\n") : [];
  const firstCommandLine = normalizeText(commandLines[0]);
  const restCommandLines = commandLines.slice(1);
  const shouldShowReason = reasonText && normalizeText(reasonText) !== normalizeText(`Tool: ${firstCommandLine}`);

  const out = [];
  out.push(`🔐 【Approval】${toolName || "Tool request"}`);

  if (shouldShowReason) {
    out.push(`📋 ${reasonText}`);
  }

  if (commandText) {
    if (firstCommandLine) {
      out.push(`⌨️ ${firstCommandLine}`);
    }
    if (restCommandLines.length) {
      out.push(restCommandLines.map((line) => `  ${line}`).join("\n"));
    }
  }

  if (!reasonText && !commandText) {
    out.push("❓ (unknown)");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  out.push("👉 /yes    allow once");
  out.push("👉 /always auto-allow");
  out.push("👉 /no     deny");

  return out.join("\n");
}

function extractToolNameFromReason(reason) {
  const normalized = normalizeText(reason);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("tool:")) {
    return normalized.slice(5).trim();
  }
  return normalized;
}

function buildApprovalPromptSignature(approval) {
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const commandTokens = Array.isArray(approval?.commandTokens)
    ? approval.commandTokens.map((token) => normalizeCommandArgument(token)).filter(Boolean)
    : [];
  return JSON.stringify({
    kind: normalizeText(approval?.kind),
    reason: reasonText,
    command: commandText,
    commandTokens,
    responseTemplate: approval?.responseTemplate || null,
  });
}

function buildApprovalResponsePayload(approval, commandName) {
  const requestId = approval?.requestId;
  if (requestId == null || String(requestId).trim() === "") {
    return null;
  }
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    const responseByCommand = approval?.responseTemplate?.responseByCommand;
    const effectiveCommandName = commandName === "always" ? "yes" : commandName;
    const result = responseByCommand && typeof responseByCommand === "object"
      ? (responseByCommand[commandName] || responseByCommand[effectiveCommandName])
      : null;
    if (!result || typeof result !== "object") {
      return null;
    }
    return { requestId, result };
  }
  const decision = commandName === "no" ? "decline" : "accept";
  return { requestId, decision };
}

function buildApprovalResponseText(approval, commandName, approvalResponse) {
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    if (commandName === "always" && isApprovalAcceptResponse(approvalResponse)) {
      return "💡 Auto-approve enabled for this MCP tool in the current workspace.";
    }
    if (commandName === "yes") {
      return "✅ This request has been approved.";
    }
    return "❌ This request has been cancelled.";
  }
  return commandName === "always"
    ? "💡 Auto-approve enabled for this command prefix in the current workspace."
    : (commandName === "yes" ? "✅ This request has been approved." : "❌ This request has been denied.");
}

function isApprovalAcceptResponse(approvalResponse) {
  if (!approvalResponse || typeof approvalResponse !== "object") {
    return false;
  }
  if (approvalResponse.decision === "accept") {
    return true;
  }
  return normalizeText(approvalResponse.result?.action) === "accept";
}

function buildElicitationApprovalPromptText(approval) {
  const elicitation = approval?.elicitation || {};
  const messageText = normalizeText(elicitation?.message);
  const commandText = normalizeText(approval?.command);
  const approvalKind = normalizeText(elicitation?.approvalKind);
  const out = [];
  out.push(`🔐 【Approval】${normalizeText(approval?.reason) || "MCP request"}`);
  if (messageText) {
    out.push(`📋 ${messageText.split("\n")[0]}`);
  }
  if (commandText) {
    const commandLines = commandText.split("\n").map((line) => normalizeText(line)).filter(Boolean);
    if (commandLines.length) {
      out.push(`⌨️ ${commandLines[0]}`);
      if (commandLines.length > 1) {
        out.push(commandLines.slice(1).map((line) => `  ${line}`).join("\n"));
      }
    }
  }

  const toolDescription = normalizeText(elicitation?.toolDescription);
  if (toolDescription && approvalKind === "mcp_tool_call") {
    out.push("━━━━━━━━━━━━━");
    out.push(`🧾 ${toolDescription}`);
  }

  const supportedCommands = new Set(
    Array.isArray(approval?.responseTemplate?.supportedCommands)
      ? approval.responseTemplate.supportedCommands
      : []
  );
  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    allow once");
  }
  if (supportedCommands.has("always") || (supportedCommands.has("yes") && approval?.kind === "mcp_tool_call")) {
    out.push("👉 /always auto-allow");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     cancel this request");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ This Codex MCP request cannot be answered from WeChat yet.");
  }

  return out.join("\n");
}

function buildReminderSystemTrigger(reminder, config = {}) {
  const reminderText = String(reminder?.text || "").trim();
  const userName = String(config?.userName || "").trim() || "the user";
  return `Due reminder for ${userName}: ${reminderText}`;
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function isAutoApprovedStateDirOperation(approval, config = {}) {
  const stateDir = normalizeText(config?.stateDir);
  if (!stateDir) {
    return false;
  }

  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  return filePaths.every((filePath) => isPathWithinRoot(filePath, stateDir));
}

function sortInboundUpdateMessages(messages) {
  return Array.isArray(messages)
    ? messages.slice().sort(compareRawInboundUpdateMessages)
    : [];
}

function compareRawInboundUpdateMessages(left, right) {
  const leftTime = resolveRawInboundMessageTimeMs(left);
  const rightTime = resolveRawInboundMessageTimeMs(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.message_id);
  const rightMessageId = parseMessageIdForOrdering(right?.message_id);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  const leftSeq = parseNumericOrderValue(left?.seq);
  const rightSeq = parseNumericOrderValue(right?.seq);
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return String(left?.client_id || "").localeCompare(String(right?.client_id || ""));
}

function resolveRawInboundMessageTimeMs(message) {
  const createdAtMs = parseNumericOrderValue(message?.create_time_ms);
  if (createdAtMs > 0) {
    return createdAtMs;
  }
  const createdAtSeconds = parseNumericOrderValue(message?.create_time);
  return createdAtSeconds > 0 ? createdAtSeconds * 1000 : 0;
}

function comparePendingInboundMessages(left, right) {
  const leftTime = Date.parse(String(left?.receivedAt || "")) || 0;
  const rightTime = Date.parse(String(right?.receivedAt || "")) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.messageId);
  const rightMessageId = parseMessageIdForOrdering(right?.messageId);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  return String(left?.text || "").localeCompare(String(right?.text || ""));
}

function parseMessageIdForOrdering(value) {
  const numeric = parseNumericOrderValue(value);
  return numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function parseNumericOrderValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const DEFERRED_REPLY_NOTICE = "由于微信 context_token 的限制，上轮对话里有一部分内容当时没能送达；这次用户再次发来消息、context_token 刷新后，先把遗留内容补上。如果这种情况反复出现，可发送 /chunk <数字>（例如 /chunk 50）调大最小合并字符数，减少消息分片。";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";

function formatDeferredSystemReplyText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return DEFERRED_REPLY_NOTICE;
  }
  if (normalized.startsWith(DEFERRED_REPLY_NOTICE)) {
    return normalized;
  }
  return `${DEFERRED_REPLY_NOTICE}\n\n${normalized}`;
}

function formatDeferredSystemReplyBatch(replies) {
  const grouped = groupDeferredReplies(replies);
  if (!grouped.plain.length && !grouped.system.length) {
    return DEFERRED_REPLY_NOTICE;
  }
  const parts = [
    DEFERRED_REPLY_NOTICE,
  ];
  if (grouped.plain.length) {
    parts.push("", DEFERRED_PLAIN_REPLY_HEADER, grouped.plain.join("\n\n"));
  }
  if (grouped.system.length) {
    parts.push("", DEFERRED_SYSTEM_REPLY_HEADER, grouped.system.join("\n\n"));
  }
  return parts.join("\n");
}

function groupDeferredReplies(replies) {
  const grouped = { plain: [], system: [] };
  for (const reply of Array.isArray(replies) ? replies : []) {
    const normalizedText = String(reply?.text || "").trim();
    if (!normalizedText) {
      continue;
    }
    if (reply?.kind === "system_reply") {
      grouped.system.push(normalizedText);
      continue;
    }
    grouped.plain.push(normalizedText);
  }
  return grouped;
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return formatBeijingDateTime(parsed);
}

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}
