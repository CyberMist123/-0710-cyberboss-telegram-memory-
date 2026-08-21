const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { createTelegramChannelAdapter } = require("../adapters/channel/telegram");
const { DEFAULT_MIN_WEIXIN_CHUNK, MAX_MIN_WEIXIN_CHUNK } = require("../adapters/channel/weixin/config-store");
const { persistIncomingWeixinAttachments } = require("../adapters/channel/weixin/media-receive");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const {
  createTelegramProfileRouter,
} = require("../adapters/runtime/claudecode/telegram-profile-router");
const {
  buildLaneScopeKey,
  buildLegacyRouteLane,
  buildSlBranchLane,
  buildSystemRouteLane,
  rebuildLaneFromDescriptor,
  resolveInboundRouteLane,
} = require("./route-lane");
const {
  RoutingCounters,
  laneToken,
  profileToken,
  sanitizeRoutingTelemetry,
  slotToken,
} = require("./route-telemetry");
const {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildMergedInboundPrepared,
  carrySubjectProvenance,
  clonePreparedInboundMessage,
  isPlainTextPreparedMessage,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
} = require("./inbound-turn");
const { resolveVisionContext } = require("../services/vision-context");
const { resolveExternalMcpServerConfigs } = require("../tools/external-mcp-config");
const {
  buildWeixinHelpText,
} = require("./command-registry");
const {
  DEFAULT_EFFORT,
  EFFORT_VALUES,
  normalizeEffort,
  resolveEffortLevel,
} = require("../adapters/runtime/claudecode/process-client");
const { readSessionContextUsage } = require("../adapters/runtime/claudecode/session-transcript");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { StreamDelivery, createSystemReplyPolicy, resolveSystemReplyDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { ContextTraceRecorder, hashThreadId } = require("./context-trace");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { writeActivityPauseState, isActivityPaused } = require("./activity-pause-state");
const { readWatchdogHealth, formatWatchdogStatusLine } = require("./watchdog-health");
const { TurnGateStore } = require("./turn-gate-store");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const { ConversationRecorder } = require("../services/conversation-recorder");
const { saveArchive, listArchives, loadArchive, recordReentry, QUOTE_BEGIN, QUOTE_END } = require("../services/sl-archive");
const { createSubjectRoute, windowIdFromNativeSessionId } = require("../continuity/subject-route");
const {
  SubjectCapabilityRegistry,
} = require("../continuity/subject-signing");
const { SubjectSigningBroker } = require("../continuity/subject-signing-ipc");
const { HandoffDispatcher } = require("../continuity/handoff-dispatcher");
const { HandoffAckLedger } = require("../continuity/handoff-ack");
const {
  formatSubjectMemoryHandoff,
  injectSubjectMemoryHandoff,
  parseSubjectMemoryHandoffAck,
} = require("../continuity/handoff-context");
const { resolveStateMediaReference } = require("../services/media-inbox-service");
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
const { CloseoutLivenessAutomation, MAX_ALERT_DELIVERY_ATTEMPTS } = require("../app/closeout-liveness");
const { SubjectBeatScheduler } = require("../app/subject-beat-scheduler");
const { PipelineScheduler } = require("../app/pipeline-scheduler");
const { persistReportedDesireState } = require("./desire-state-persistence");
const { loadContextGates } = require("./hard-context");
const { createProjectTooling } = require("../tools/create-project-tooling");
const { formatAppDateTime, formatAppShortLocal } = require("../utils/app-time");
const { describeAppTimezone } = require("../utils/app-timezone");
const { resolveMemoryRetrievalPlan } = require("./memory-resolver");
const { parseMemoryCommand } = require("./memory-command-router");
const { validateDraftAgainstMemory, rewriteDraftToMatchMemory } = require("./memory-validator");
const { buildRecentStateMemoryLines } = require("../location/recent-state-memory");
const { recordCanaryReceipt } = require("../orchestration/canary-receipt");
const { Route1DispatchController, route1DispatchEnabled } = require("../orchestration/route1-dispatch");
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const MAX_ROUTE2_ORIGINS = 64;
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
    // The registry has always collected diagnostics into an in-process array
    // that nothing ever read, and its `onDiagnostic` hook was never wired -- so
    // every refusal to issue a capability was invisible from outside the
    // process. Surface the first occurrence of each code: enough to name the
    // cause in the log, quiet enough that per-turn codes (`non_subject_lane`
    // fires on every non-tg turn) cannot flood it.
    const seenSigningDiagnostics = new Set();
    this.subjectCapabilityRegistry = new SubjectCapabilityRegistry({
      enabled: config.subjectSigningEnabled === true,
      onDiagnostic: (event) => {
        const code = event?.code || "subject_signing_failed";
        if (seenSigningDiagnostics.has(code)) return;
        seenSigningDiagnostics.add(code);
        console.warn(`[subject-signing] ${code} (first occurrence this process)`);
      },
    });
    this.subjectCapabilityByRunKey = new Map();
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      subjectCandidateOwner: true,
      subjectCapabilityRegistry: this.subjectCapabilityRegistry,
      subjectSigningContext: {
        resolve: ({ threadId, turnId } = {}) => this.subjectCapabilityByRunKey.get(
          buildRunKey(threadId, turnId),
        ) || null,
      },
    });
    this.projectServices = projectTooling.services;
    this.projectToolHost = projectTooling.toolHost;
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.subjectSigningBroker = new SubjectSigningBroker({
      enabled: config.subjectSigningEnabled === true,
      subjectCandidateService: this.projectServices.subjectCandidate,
      subjectCapabilityByRunKey: this.subjectCapabilityByRunKey,
      runtimeContextStore: this.runtimeContextStore,
      subjectProfileIds: config.subjectProfileIds,
    });
    this.runtimeAdapter = createRuntimeAdapter(config);
    // Fail-closed: a malformed profile mapping throws here and startup stops.
    // There is deliberately no fallback to a more permissive legacy profile.
    // With both environment variables unset the router reports every lane as
    // unmapped and dispatch keeps its pre-v2 behaviour exactly.
    this.telegramProfileRouter = config.telegramProfileRouter
      || createTelegramProfileRouter({
        profilesJson: config.claudeLaunchProfilesJson || "",
        mappingJson: config.telegramProfileMappingJson || "",
        // Explicit only: no current-working-directory fallback, so a relative profile path
        // cannot resolve differently depending on where the bridge was started.
        baseDir: config.claudeLaunchProfileBaseDir || config.configDir || config.stateDir,
        allowAuthBackendOverride: config.claudeAllowAuthBackendOverride === true,
        cliCapabilitiesJson: config.claudeCliCapabilitiesJson || "",
      });
    this.routingCounters = new RoutingCounters();
    this.embeddingService = null;
    this.memoryService = null;
    if (this.legacyMemoryPipelineEnabled) {
      this.createEmbeddingService();
      this.createMemoryService({ ensureFiles: true });
    }
    this.memoryBgState = { lastMineAtMs: Date.now(), userMsgCountSinceMine: 0, userCharsSinceMine: 0, buffer: [] };
    this.threadStateStore = new ThreadStateStore();
    this.contextTraceRecorder = new ContextTraceRecorder({ filePath: config.contextTraceFile });
    this.contextTraceRunState = new Map();
    this.route1DispatchController = route1DispatchEnabled()
      ? new Route1DispatchController({
          runtimeAdapter: this.runtimeAdapter,
          stateDir: config.stateDir,
          trace: (entry) => this.contextTraceRecorder.record({ route1_dispatch: entry }),
          workspaces: config.route1Workspaces,
        })
      : null;
    this.runtimeAdapter.onRoute1DispatchRequest?.((args, context) => (
      this.route1DispatchController?.dispatch(args, context)
      || Promise.reject(Object.assign(new Error("route1_dispatch_disabled"), { code: "route1_dispatch_disabled" }))
    ));
    this.runtimeAdapter.onRoute1TaskQueryRequest?.((action, args, context) => {
      if (action === "status") return this.route1DispatchController?.taskStatus(args, context);
      return this.route1DispatchController?.taskResult(args, context);
    });
    // Route 2/3 escalation origin, keyed by the turn that asks. The child's tool
    // context carries `turnId` but neither a lane nor a launch profile, so an
    // escalation that re-derived the route from the child's flat fields resolved
    // a session slot key that matched nothing and failed `route2_window_id_required`
    // on every call, from every lane. The route lives here, recorded at the same
    // point Route 1 records its own origin turn.
    this.route2OriginByTurnId = new Map();
    this.runtimeAdapter.onRoute2EscalateRequest?.((args, context) => {
      const origin = this.route2OriginByTurnId.get(normalizeText(context?.turnId));
      if (!origin) {
        return Promise.reject(Object.assign(
          new Error("route2_origin_turn_unknown"),
          { code: "route2_origin_turn_unknown" },
        ));
      }
      return this.runtimeAdapter.grantRoute2Lease({
        bindingKey: origin.bindingKey,
        workspaceRoot: origin.workspaceRoot,
        lane: origin.lane,
        launchProfile: origin.launchProfile,
        senderId: origin.senderId,
        taskId: normalizeText(args?.taskId),
        tier: args?.tier,
        ttlMs: args?.ttlMs,
        // Deliberately no `plan` and no `override`. The gate is a cost router,
        // not a permission gate (D33): the wide face comes from the profile's
        // own `escalatedBuiltInTools` once the lease is active.
      });
    });
    // After a Route 2/3 escalation's deferred relaunch actually lands, auto-open
    // her next turn (wide face) so she can continue without the Owner having to
    // send a message. Same self-triggered system-turn path as the hourly tick.
    this.runtimeAdapter.onEscalationRelaunched?.((origin = {}) => {
      this.enqueueRoute2ContinueFailOpen?.(origin);
    });
    this.runtimeAdapter.onSubjectSigningRequest?.((request) => (
      this.subjectSigningBroker.submit(request)
    ));
    this.handoffDeliveryByRunKey = new Map();
    this.handoffDispatcher = config.handoffDispatchEnabled === true
      ? new HandoffDispatcher({
          continuityDir: config.continuityDir,
          enabled: true,
          leaseDetails: handoffLeaseDetails(config),
        })
      : null;
    this.handoffAckLedger = config.handoffDispatchEnabled === true
      ? new HandoffAckLedger({
          continuityDir: config.continuityDir,
          enabled: true,
          leaseDetails: handoffLeaseDetails(config),
        })
      : null;
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.turnGateStore = new TurnGateStore();
    this.conversationRecorder = config.conversationDir ? new ConversationRecorder({
      dirPath: config.conversationDir,
      automationTimezone: config.automationTimezone,
    }) : null;
    this.pendingInboundByScope = new Map();
    this.pendingImageInboundByScope = new Map();
    this.telegramPendingInboundByMessageId = new Set();
    this.turnBoundaryScopeKeys = new Set();
    this.systemMessageDispatcher = null;
    this.closeoutLivenessAutomation = null;
    this.subjectBeatScheduler = null;
    this.pipelineScheduler = null;
    // 每条 lane 上"子进程实际拿到的" model/effort，按 laneKey 记。
    //
    // 为什么必须单独记：/status 与 /model 走的是 windowOverride → configuredModel
    // 这条梯子，读的全是**存储的意图**，没有一环去问运行中的子进程实际在用什么。
    // 两边一旦分叉（覆盖被清掉、而进程还活着），显示就会一直撒谎——2026-08-06
    // 到 08-11 这五天，面板报 fable-5，实际跑的是 opus-4-6，Owner 全程不知情。
    // 进程的启动参数只有 announceProcessLaunch 拿得到，这里把它留住。
    // 内存态即可：bridge 重启会连子进程一起杀掉，记录跟着失效才是对的。
    this.liveLaunchByLane = new Map();
    // After `/sl_load` with no name we show a numbered roster and remember it
    // briefly, so she can pick with a bare number ("1") instead of typing a name.
    this.slLoadPending = new Map();
    // Active 回档净房 pointer, keyed by bindingKey. While set, this chat's inbound
    // turns route into the clean SL branch session instead of the live mainline
    // chat, so a load is a real revisit-in-isolation. `/return` or `/new` clears
    // it. In-memory only: a bridge restart drops you back to the mainline, which
    // is the safe default (a restarted process has no live branch child anyway).
    this.slBranchByBinding = new Map();
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
    this.desireUsageByRunKey = new Map();
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

  createDesireService() {
    if (!this.desireService) {
      const { DesireService } = require("../services/desire-service");
      this.desireService = new DesireService(this.config);
    }
    return this.desireService;
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
    console.log(`[cyberboss] account=${account.accountId}`);
    console.log(`[cyberboss] baseUrl=${account.baseUrl || "(none)"}`);
    console.log(`[cyberboss] workspaceRoot=${this.config.workspaceRoot}`);
    const appTimezone = describeAppTimezone();
    console.log(`[cyberboss] timezone=${appTimezone.timezone} source=${appTimezone.source}`);
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

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const automationSenderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      sessionStore,
    });
    const automationWorkspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: account.accountId,
      senderId: automationSenderId,
      sessionStore,
    });
    // 八维菜单里的「想整理」要落到一条排队消息上，而排队要账号/发件人/工作区。
    // 调度器各自持有一份，回复回调里拿不到，所以在这里留一份给它用。
    this.automationTargets = {
      accountId: account.accountId,
      senderId: automationSenderId,
      workspaceRoot: automationWorkspaceRoot,
    };
    this.closeoutLivenessAutomation = new CloseoutLivenessAutomation({
      config: this.config,
      queueStore: this.systemMessageQueue,
      runtimeAdapter: this.runtimeAdapter,
      accountId: account.accountId,
      senderId: automationSenderId,
      workspaceRoot: automationWorkspaceRoot,
    });
    if (this.closeoutLivenessAutomation.start()) {
      console.log("[automation] closeout/liveness owner started");
    }
    this.subjectBeatScheduler = new SubjectBeatScheduler({
      config: this.config,
      queueStore: this.systemMessageQueue,
      accountId: account.accountId,
      senderId: automationSenderId,
      workspaceRoot: automationWorkspaceRoot,
    });
    if (this.subjectBeatScheduler.start()) {
      console.log("[automation] subject beat scheduler started");
    }
    this.pipelineScheduler = new PipelineScheduler({
      config: this.config,
      queueStore: this.systemMessageQueue,
      accountId: account.accountId,
      senderId: automationSenderId,
      workspaceRoot: automationWorkspaceRoot,
    });
    if (this.pipelineScheduler.start()) {
      console.log("[automation] pipeline scheduler started");
    }

    const shutdown = createShutdownController(async () => {
      this.clearPendingImageInboundTimers();
      await this.closeoutLivenessAutomation?.stop();
      await this.subjectBeatScheduler?.stop();
      await this.pipelineScheduler?.stop();
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
              try {
                recordCanaryReceipt({
                  stateDir: this.config.stateDir,
                  text: normalized.text,
                  updateId: update?.update_id,
                  messageId: normalized.messageId,
                  threadKey: normalized.threadKey,
                });
              } catch (error) {
                this.logTelegramDebug(`canary receipt write failed error=${error instanceof Error ? error.message : String(error)}`);
              }
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

  /**
   * Route lane for an inbound message. Telegram lanes carry the topic id;
   * every other channel gets a legacy lane keyed by the continuity binding so
   * its behaviour is unchanged.
   */
  resolveRouteLane(message, bindingKey) {
    return resolveRouteLaneFor(message, bindingKey);
  }

  /**
   * Scope key for the turn gate, pending buffers, debounce timers and reply
   * target. Two Telegram topics in the same chat produce different keys, so
   * they never share a gate and never merge into one turn.
   */
  buildRouteScopeKey(lane, bindingKey, workspaceRoot) {
    return routeScopeKeyFor(lane, bindingKey, workspaceRoot);
  }

  /**
   * Launch profile selected for a lane, or null. Only Telegram foreground lanes
   * are eligible; system, background and closeout lanes never reach here.
   */
  resolveLaunchProfileForLane(lane) {
    // A回档净房 (kind "sl") wears the SAME persona as the chat it branched from,
    // so profile selection keys off its base tg lane -- never off the branch key,
    // which the router does not know. Without this it would fall back to legacy
    // and the branch would "wear the wrong skin".
    const profileLane = lane?.kind === "sl" ? lane.baseLane : lane;
    if (!profileLane || profileLane.kind !== "tg" || !this.telegramProfileRouter?.isEnabled?.()) {
      return null;
    }
    if (this.runtimeAdapter?.describe?.().id !== "claudecode") {
      return null;
    }
    const selection = this.telegramProfileRouter.select(profileLane);
    this.recordRoutingTelemetry({
      event: "telegram_profile_select",
      outcome: selection.status,
      laneToken: laneToken(lane),
      laneKind: lane.kind,
      topicShape: lane.messageThreadId === null ? "default" : "topic",
      profileToken: profileToken(selection.profileId),
    });
    return selection.launchProfile || null;
  }

  recordRoutingTelemetry(event) {
    let sanitized;
    try {
      sanitized = sanitizeRoutingTelemetry(event);
    } catch (error) {
      console.warn(`[route-telemetry] dropped an event: ${error.message}`);
      return;
    }
    this.routingCounters?.increment(`${sanitized.event}:${sanitized.outcome || "ok"}`);
    if (typeof this.config?.onRoutingTelemetry === "function") {
      try {
        this.config.onRoutingTelemetry(sanitized);
      } catch {}
    }
  }

  /**
   * Outbound Telegram thread id for a message. Every reply, typing indicator,
   * media send, error and status for a topic must carry it.
   */
  static resolveOutboundThreadIdFor(message) {
    if (!message || message.provider !== "telegram") {
      return null;
    }
    const value = Object.hasOwn(message, "messageThreadId")
      ? message.messageThreadId
      : message.telegram?.messageThreadId;
    return value === undefined || value === "" ? null : value;
  }

  async handlePreparedMessage(normalized, { allowCommands }) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    let lane = resolveRouteLaneFor(normalized, bindingKey);
    if (normalized.provider !== "telegram") {
      this.streamDelivery.setReplyTarget(bindingKey, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
    }

    const command = parseChannelCommand(normalized.text);

    // 回档净房: while a load is active for this chat, her ordinary turns route into
    // the clean branch session, not the live mainline chat. Commands are exempt --
    // they parse below and run on the mainline (so /return, /status etc. always
    // reach the real chat), but a non-command turn follows the pointer.
    if (!command && normalized.provider === "telegram") {
      const slBranchLane = this.resolveActiveSlBranchLane(bindingKey);
      if (slBranchLane) {
        lane = slBranchLane;
      }
    }
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }

    // A bare-number reply right after `/sl_load` (no name) picks from the roster.
    // Any other message clears the pending prompt and flows on as normal chat.
    if (allowCommands && await this.tryConsumeSlLoadSelection(normalized)) {
      return;
    }

    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    if (!prepared) {
      return;
    }

    if (shouldBatchImageOnlyInbound(prepared)) {
      this.enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared, lane });
      return;
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot, lane) && isPlainTextPreparedMessage(prepared)) {
      const merged = await this.flushPendingImageInboundBatch({
        bindingKey,
        workspaceRoot,
        lane,
        trailingPrepared: prepared,
      });
      if (merged) {
        return;
      }
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot, lane)) {
      await this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot, lane });
    }

    if (normalized.provider === "telegram") {
      await this.dispatchTelegramPreparedInbound({ bindingKey, workspaceRoot, prepared, lane, messageId: normalized.messageId });
      return;
    }

    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared, lane });
  }

  /**
   * The session/slot/process the *current* route owns.
   *
   * Every command, approval and status reply resolves through here. It never
   * falls back to the binding's most recent session: on a runtime that has no
   * lane-aware surface (codex) it degrades to the binding lookup explicitly,
   * and on claudecode a lane with no session simply reports none.
   */
  resolveRouteSession(args) {
    return resolveRouteSessionFor(this, args);
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false, lane = null, anyLane = false } = {}) {
    const scopeKey = routeScopeKeyFor(lane, bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isScopePending
      ? this.turnGateStore.isScopePending(scopeKey)
      : this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    // Workspace-wide jobs yield to whichever lane currently holds a turn: the
    // lanes are isolated from each other, but they share one working directory.
    if (anyLane && typeof this.turnGateStore.isAnyScopePendingForWorkspace === "function"
      && this.turnGateStore.isAnyScopePendingForWorkspace(workspaceRoot)) {
      return true;
    }
    const threadId = resolveRouteSessionFor(this, { bindingKey, workspaceRoot, lane }).threadId;
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  async dispatchPreparedTurn({
    bindingKey, workspaceRoot, prepared, lane = null, gateLane, pendingOperation = null,
  }) {
    const effectiveLane = lane || resolveRouteLaneFor(prepared, bindingKey);
    // `gateLane` lets a caller serialize on a different scope than the one it
    // runs under. System turns use it to keep the pre-v2 workspace-level gate
    // while still getting an independent session and process.
    const effectiveGateLane = gateLane === undefined ? effectiveLane : gateLane;
    const scopeKey = routeScopeKeyFor(effectiveGateLane, bindingKey, workspaceRoot);
    const messageThreadId = CyberbossApp.resolveOutboundThreadIdFor(prepared);
    const pendingScopeKey = this.turnGateStore.beginScope
      ? this.turnGateStore.beginScope(scopeKey)
      : this.turnGateStore.begin(bindingKey, workspaceRoot);
    await this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
      ...outboundThreadIdField(prepared),
    }).catch(() => {});

    let handoffTurn = null;
    let route1Notice = null;
    try {
      const turnParams = this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const model = turnParams.model;
      const runtimeTurn = await this.buildRuntimeTurn({ prepared, model });
      try {
        handoffTurn = this.prepareHandoffForSubjectTurnFailOpen?.({
          bindingKey,
          workspaceRoot,
          prepared,
          lane: effectiveLane,
        }) || null;
      } catch (error) {
        console.warn(`[continuity] handoff injection preparation failed: ${error?.message || String(error)}`);
        handoffTurn = null;
      }
      try {
        const noticeRouteSession = resolveRouteSessionFor(this, {
          bindingKey,
          workspaceRoot,
          lane: effectiveLane,
          normalized: prepared,
        });
        const noticeRoute = buildCurrentSubjectRouteIdentity({
          app: this,
          bindingKey,
          prepared,
          lane: effectiveLane,
          routeSession: noticeRouteSession,
        });
        route1Notice = this.route1DispatchController?.prepareRoute1CompletionNotice({ currentRoute: noticeRoute }) || null;
        if (route1Notice?.block) runtimeTurn.text = `${route1Notice.block}\n\n${runtimeTurn.text}`;
      } catch (error) {
        this.route1DispatchController?.cancelRoute1CompletionNotice?.(route1Notice);
        route1Notice = null;
        console.warn(`[route1] completion notice skipped: ${error?.message || String(error)}`);
      }
      if (handoffTurn?.block) {
        try {
          runtimeTurn.text = injectSubjectMemoryHandoff(runtimeTurn.text, handoffTurn.block);
        } catch (error) {
          this.failHandoffDeliveryFailOpen?.(handoffTurn, {
            reason: "handoff_injection_failed",
            retryable: true,
            error,
          });
          handoffTurn = null;
        }
      }
      const launchProfile = this.resolveLaunchProfileForLane?.(effectiveLane) || null;
      const sendTurn = typeof this.runtimeAdapter.sendTurn === "function"
        ? this.runtimeAdapter.sendTurn.bind(this.runtimeAdapter)
        : this.runtimeAdapter.sendTextTurn.bind(this.runtimeAdapter);
      const turn = await sendTurn({
        bindingKey,
        workspaceRoot,
        text: runtimeTurn.text,
        attachments: runtimeTurn.attachments,
        model,
        effort: turnParams.effort,
        lane: effectiveLane,
        launchProfile,
        windowOverride: turnParams.windowOverride || null,
        senderId: prepared.senderId || "",
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.senderId,
          provider: prepared.provider,
          chatId: prepared.chatId || prepared.telegram?.chatId || "",
          messageId: prepared.messageId || prepared.telegram?.messageId || "",
          channelSource: prepared.provider,
        },
        // Fires after this turn's identity is fixed and before the payload is
        // written to the child. See `registerSubjectTurnContextFailOpen`.
        beforeWrite: (identity) => this.registerSubjectTurnContextFailOpen?.({
          bindingKey,
          workspaceRoot,
          prepared,
          lane: effectiveLane,
          messageThreadId,
          identity,
        }),
      });
      // T0 fix: a context rebuild retires the running thread mid-conversation.
      // That must never again happen silently -- tell the user which fingerprint
      // input changed and which thread was retired, so /switch <id> force can
      // take them back if the change was unintended.
      if (turn?.continuity?.context_change && effectiveLane?.kind !== "sys") {
        const changeDetail = turn.continuity.context_change;
        const changedInputs = Array.isArray(changeDetail.changed) && changeDetail.changed.length
          ? changeDetail.changed.join(", ")
          : "unknown";
        const retiredThreadId = normalizeText(changeDetail.previousThreadId);
        await this.channelAdapter.sendText({
          userId: prepared.senderId,
          text: [
            `⚠️ 上下文已重建：${changedInputs} 发生变更，这条消息起是新线程。`,
            ...(retiredThreadId
              ? [`旧线程：${retiredThreadId}`, `如需接回旧上下文：/switch ${retiredThreadId} force`]
              : []),
          ].join("\n"),
          contextToken: prepared.contextToken,
          ...outboundThreadIdField(prepared),
        }).catch(() => {});
      }
      const route1TurnIdentity = this.route1DispatchController
        ? buildCurrentSubjectRouteIdentity({
          app: this,
          bindingKey,
          prepared,
          lane: effectiveLane,
          routeSession: {
            laneKey: turn.laneKey || effectiveLane?.laneKey,
            sessionSlotKey: turn.sessionSlotKey,
            threadId: turn.threadId,
            profileId: turn.profileId,
            profileFingerprint: turn.profileFingerprint,
            messageThreadId: effectiveLane?.messageThreadId ?? null,
          },
        })
        : null;
      let route1OriginRoute = null;
      if (route1TurnIdentity) {
        try {
          route1OriginRoute = createSubjectRoute({
            ...route1TurnIdentity,
            author_turn_id: turn.turnId,
            source_entry_ids: [normalizeText(prepared.subjectSourceEntryId) || turn.turnId],
          });
        } catch (error) {
          console.warn(`[route1] origin snapshot skipped: ${error?.message || String(error)}`);
        }
      }
      // Route 1 works on a repository: every task is cut as a git worktree from
      // `base_sha`, and `allowed_paths` are repo-relative. The chat's own
      // workspace root is the product tree (`cyberlink`), which is not a git
      // repo at all -- dispatching against it fails at worktree provisioning no
      // matter how correct the task spec is. The engineering profile's `cwd` is
      // the repo it is meant to work in, so that is the workspace a dispatched
      // task inherits.
      const workEngineeringProfile = this.telegramProfileRouter?.getProfile?.("work-engineering") || null;
      this.route1DispatchController?.registerTurn({
        turnId: turn.turnId,
        workspaceRoot: normalizeText(workEngineeringProfile?.cwd) || workspaceRoot,
        launchProfile: workEngineeringProfile,
        routeIdentity: route1TurnIdentity,
        originRoute: route1OriginRoute,
      });
      // Route 1 dispatches to the *work* profile; Route 2/3 stays in this very
      // window, so it needs this turn's own lane and profile, not that one.
      this.rememberRoute2Origin?.(turn.turnId, {
        bindingKey,
        workspaceRoot,
        lane: effectiveLane,
        launchProfile,
        senderId: prepared.senderId || "",
      });
      const route1NoticeTrace = route1Notice?.block
        ? { task_id: route1Notice.taskId, chars: route1Notice.block.length }
        : undefined;
      this.route1DispatchController?.completeRoute1CompletionNotice?.(route1Notice);
      route1Notice = null;
      this.issueSubjectCapabilityForTurnFailOpen?.({
        bindingKey,
        workspaceRoot,
        prepared,
        lane: effectiveLane,
        turn,
      });
      let traceResult = false;
      try {
        traceResult = this.recordContextTrace?.(
          turn.threadId,
          turn.turnId,
          turn.continuity,
          runtimeTurn.memoryContext,
          handoffTurn?.trace,
          route1NoticeTrace,
        );
      } catch (error) {
        console.warn(`[continuity] context trace failed: ${error?.message || String(error)}`);
        traceResult = false;
      }
      let deliveredHandoff = null;
      if (handoffTurn) {
        const traceRecorded = await Promise.resolve(traceResult).catch(() => false);
        deliveredHandoff = this.completeHandoffDeliveryFailOpen?.(handoffTurn, { traceRecorded }) || null;
        handoffTurn = null;
        if (deliveredHandoff && turn.turnId) {
          this.handoffDeliveryByRunKey?.set?.(
            buildRunKey(turn.threadId, turn.turnId),
            deliveredHandoff,
          );
        }
      }
      this.runtimeContextStore?.setActiveContext?.(buildActiveContextPayload({
        runtimeId: this.runtimeAdapter.describe().id,
        includeTurnId: this.config.subjectSigningEnabled === true || Boolean(this.route1DispatchController),
        bindingKey,
        workspaceRoot,
        prepared,
        lane: effectiveLane,
        messageThreadId,
        turn,
      }));
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      // The reply target carries the originating topic, so a reply, a media
      // send, an error or a status can only land back in the lane that asked.
      // Shape is unchanged for a lane with no topic, so non-Telegram delivery
      // is byte-for-byte identical to pre-v2.
      const replyTarget = {
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
        ...(messageThreadId === null || messageThreadId === undefined
          ? {}
          : { messageThreadId }),
      };
      this.streamDelivery.setReplyTargetForThread?.(turn.threadId, replyTarget);
      this.recordRoutingTelemetry?.({
        event: "lane_turn_dispatched",
        outcome: "ok",
        laneToken: laneToken(effectiveLane),
        laneKind: effectiveLane?.kind || "unknown",
        topicShape: messageThreadId === null ? "default" : "topic",
        slotToken: slotToken(turn.sessionSlotKey || ""),
        profileToken: profileToken(turn.profileId || ""),
      });
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
      this.route1DispatchController?.cancelRoute1CompletionNotice?.(route1Notice);
      route1Notice = null;
      if (handoffTurn) {
        this.failHandoffDeliveryFailOpen?.(handoffTurn, {
          reason: "runtime_turn_not_delivered",
          retryable: true,
          error,
        });
        handoffTurn = null;
      }
      if (this.turnGateStore.releaseScopeKey) {
        this.turnGateStore.releaseScopeKey(scopeKey);
      } else {
        this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      }
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      if (pendingOperation?.kind === "desire_checkin") {
        const { appendDesireTelemetry } = require("./desire-telemetry");
        appendDesireTelemetry({
          enabled: this.config.desireTelemetry,
          filePath: this.config.desireTelemetryFile,
          eventId: pendingOperation.eventId,
          eventType: "desire_checkin",
          reusedSession: pendingOperation.reusedSession,
          durationMs: Date.now() - pendingOperation.startedAt,
          outcome: "error",
        });
        this.releaseDesireMarker(pendingOperation);
      }
      await this.channelAdapter.sendText({
        userId: prepared.senderId,
        text: `❌ Request failed\n${messageText}`,
        contextToken: prepared.contextToken,
        ...outboundThreadIdField(prepared),
      }).catch(() => {});
      return false;
    }
  }

  async resolveMemoryContextForPrepared(prepared) {
    const runtimeConfig = this.config || {};
    const text = String(prepared?.originalText || prepared?.text || "").trim();
    if (!text) {
      return { lines: [] };
    }
    if (!loadContextGates(runtimeConfig).memory_context) {
      return { lines: [], slots: [], mode: "gated_off" };
    }
    const manualOverrideLines = readManualMemoryContextLines(runtimeConfig.memoryContextOverrideFile);
    if (manualOverrideLines.length) {
      return { lines: manualOverrideLines, slots: [], mode: "manual_override" };
    }
    const locationLines = typeof this.resolveRecentLocationStateMemoryLines === "function"
      ? this.resolveRecentLocationStateMemoryLines()
      : [];
    this.projectServices?.locationStateStore?.recordMemoryInjection?.({
      lines: locationLines,
      source: "location_v2",
      used: Boolean(runtimeConfig.locationV2Enabled),
      text,
    });
    if (runtimeConfig.legacyMemoryRetrieval === false) {
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
    const targetedMemoryLines = curated.length ? curated : recentMemoryLines;
    return {
      lines: dedupeMemoryContextLines([...pendingPromiseLines, ...targetedMemoryLines, ...locationLines]),
      slots: retrievalPlan.retrievalSlots,
      mode: retrievalPlan.mode,
    };
  }

  // Losing this turn's memory is acceptable; losing the turn is not. Any
  // failure inside memory resolution degrades to an empty context instead of
  // taking the dispatch down with it.
  async resolveMemoryContextFailOpen(prepared) {
    const resolveMemoryContext = typeof this.resolveMemoryContextForPrepared === "function"
      ? this.resolveMemoryContextForPrepared
      : CyberbossApp.prototype.resolveMemoryContextForPrepared;
    try {
      return await resolveMemoryContext.call(this, prepared);
    } catch (error) {
      console.warn(`[cyberboss] memory context resolution failed: ${error?.message || String(error)}`);
      return { lines: [], slots: [], mode: "error" };
    }
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
      // Telegram still bypasses the generic resolveVisionContext path. D30 only
      // allows prevalidated CMX attachment context outside the plaintext channel
      // envelope; media references remain inside the envelope.
      const resolveFailOpen = typeof this.resolveMemoryContextFailOpen === "function"
        ? this.resolveMemoryContextFailOpen
        : CyberbossApp.prototype.resolveMemoryContextFailOpen;
      const memoryContext = await resolveFailOpen.call(this, prepared);
      return {
        text: formatTelegramRuntimeText(prepared, {
          stateDir: this.config?.stateDir,
          memoryContext,
        }),
        attachments: [],
        memoryContext,
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

  prepareHandoffForSubjectTurnFailOpen({ bindingKey, workspaceRoot, prepared, lane } = {}) {
    if (!this.handoffDispatcher || prepared?.provider === "system") return null;
    try {
      const routeSession = resolveRouteSessionFor(this, {
        bindingKey,
        workspaceRoot,
        lane,
        normalized: prepared,
      });
      const currentRoute = buildCurrentSubjectRouteIdentity({
        app: this,
        bindingKey,
        prepared,
        lane,
        routeSession,
      });
      const begun = this.handoffDispatcher.beginSubjectTurn({ currentRoute });
      if (begun.status !== "ready") return null;
      if (!normalizeText(this.contextTraceRecorder?.filePath)) {
        this.handoffDispatcher.markFailed(begun.token, {
          reason: "context_trace_unavailable",
          retryable: true,
        });
        return null;
      }
      try {
        const block = formatSubjectMemoryHandoff({
          envelope: begun.envelope,
          deliveryId: begun.token.delivery_id,
        });
        return {
          token: begun.token,
          block,
          trace: {
            type: "subject_memory_handoff",
            handoff_id: begun.token.handoff_id,
            route_match: begun.token.route_match,
            chars: block.length,
            result: "injected",
          },
        };
      } catch (error) {
        this.handoffDispatcher.markFailed(begun.token, {
          reason: "handoff_assembly_failed",
          retryable: true,
        });
        console.warn(`[continuity] handoff assembly failed: ${error?.message || String(error)}`);
        return null;
      }
    } catch (error) {
      console.warn(`[continuity] handoff dispatch skipped: ${error?.message || String(error)}`);
      return null;
    }
  }

  /**
   * Register this turn with the subject signing broker *before* the user
   * message reaches the child.
   *
   * `SubjectSigningBroker.submit` resolves the active runtime context by route
   * token, requires `turnActive === true`, and then reads both thread id and
   * turn id straight out of that record to find the capability. So the child
   * cannot submit anything until this pair exists -- and the child starts work
   * the instant the write lands, not when `sendTurn` resolves. Registering
   * afterwards left a window where `memory_candidate_submit` failed with
   * `subject_signing_turn_inactive` / `subject_signing_turn_unknown` for no
   * reason the logs could explain.
   *
   * Returns false when the identity is not complete enough to register, which
   * today means only one case: a brand-new session, whose thread id the child
   * has not reported yet. That turn keeps the old post-send registration.
   */
  registerSubjectTurnContextFailOpen({
    bindingKey, workspaceRoot, prepared, lane, messageThreadId, identity,
  } = {}) {
    const threadId = normalizeText(identity?.threadId);
    const turnId = normalizeText(identity?.turnId);
    if (!threadId || !turnId) return false;
    const turn = { ...identity, threadId, turnId };
    this.issueSubjectCapabilityForTurnFailOpen?.({
      bindingKey,
      workspaceRoot,
      prepared,
      lane,
      turn,
    });
    this.runtimeContextStore?.setActiveContext?.(buildActiveContextPayload({
      runtimeId: this.runtimeAdapter?.describe?.().id || "",
      includeTurnId: this.config?.subjectSigningEnabled === true || Boolean(this.route1DispatchController),
      bindingKey,
      workspaceRoot,
      prepared,
      lane,
      messageThreadId,
      turn,
    }));
    return true;
  }

  issueSubjectCapabilityForTurnFailOpen({ bindingKey, prepared, lane, turn } = {}) {
    if (!this.subjectCapabilityRegistry?.enabled) return null;
    if (prepared?.provider !== "telegram" || lane?.kind !== "tg") {
      this.subjectCapabilityRegistry.recordDiagnostic?.("non_subject_lane");
      return null;
    }
    try {
      const subjectTurnId = normalizeText(turn?.turnId);
      const sourceEntryId = normalizeText(prepared?.subjectSourceEntryId);
      // Called twice per turn by design: once from the pre-write seam (so the
      // broker is ready before the child can call a tool) and once after
      // `sendTurn` resolves (which still covers a brand-new session, whose
      // thread id does not exist yet at seam time, and any runtime adapter
      // without the seam). Issuing a second capability for a turn that already
      // has one would leave two records for one turn, so the first one wins.
      if (subjectTurnId && turn?.threadId
        && this.subjectCapabilityByRunKey?.has?.(buildRunKey(turn.threadId, subjectTurnId))) {
        return this.subjectCapabilityByRunKey.get(buildRunKey(turn.threadId, subjectTurnId))?.capability || null;
      }
      // Fail-open, but never silent. This branch swallowed the only symptom of a
      // real defect: the provenance is attached to the inbound message as a
      // non-enumerable property, and every rebuild of that message used to drop
      // it, so `sourceEntryId` was always empty and no capability was ever
      // issued. The child then died at `subject_signing_turn_unknown` -- a code
      // that points at the lookup, not at the cause. Distinct codes so the next
      // one of these is a log read, not an excavation.
      if (!subjectTurnId) {
        this.subjectCapabilityRegistry.recordDiagnostic?.("subject_turn_id_missing");
        return null;
      }
      if (!sourceEntryId) {
        this.subjectCapabilityRegistry.recordDiagnostic?.("subject_source_entry_id_missing");
        return null;
      }
      const currentIdentity = buildCurrentSubjectRouteIdentity({
        app: this,
        bindingKey,
        prepared,
        lane,
        routeSession: {
          laneKey: turn?.laneKey || lane?.laneKey,
          sessionSlotKey: turn?.sessionSlotKey,
          threadId: turn?.threadId,
          profileId: turn?.profileId,
          profileFingerprint: turn?.profileFingerprint,
          messageThreadId: lane?.messageThreadId ?? null,
        },
      });
      const subjectRoute = createSubjectRoute({
        ...currentIdentity,
        author_turn_id: subjectTurnId,
        source_entry_ids: [sourceEntryId],
      });
      const capability = this.subjectCapabilityRegistry.issue({ subjectTurnId, subjectRoute });
      if (capability) {
        this.subjectCapabilityByRunKey.set(
          buildRunKey(turn.threadId, subjectTurnId),
          {
            capability,
            subject_route: subjectRoute,
            source_ref: buildSubjectSourceRef({
              sourceEntryId,
              evidence: prepared?.subjectSourceEvidence,
            }),
          },
        );
      }
      return capability;
    } catch (error) {
      this.subjectCapabilityRegistry.recordDiagnostic?.(
        error?.code || "capability_issue_failed",
      );
      return null;
    }
  }

  completeHandoffDeliveryFailOpen(handoffTurn, { traceRecorded } = {}) {
    if (!handoffTurn?.token || !this.handoffDispatcher) return null;
    try {
      if (traceRecorded !== true) {
        this.handoffDispatcher.markFailed(handoffTurn.token, {
          reason: "context_trace_write_failed_after_injection",
          retryable: false,
        });
        return null;
      }
      return this.handoffDispatcher.markDelivered(handoffTurn.token);
    } catch (error) {
      console.warn(`[continuity] handoff delivery ledger failed: ${error?.message || String(error)}`);
      return null;
    }
  }

  failHandoffDeliveryFailOpen(handoffTurn, { reason, retryable, error } = {}) {
    if (!handoffTurn?.token || !this.handoffDispatcher) return null;
    try {
      return this.handoffDispatcher.markFailed(handoffTurn.token, { reason, retryable });
    } catch (ledgerError) {
      console.warn(
        `[continuity] handoff failure ledger failed: ${ledgerError?.message || String(ledgerError)}`
        + (error ? `; original=${error?.message || String(error)}` : ""),
      );
      return null;
    }
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared, lane = null }) {
    const effectiveLane = lane || resolveRouteLaneFor(prepared, bindingKey);
    if (prepared?.provider === "telegram") {
      return this.dispatchTelegramPreparedInbound({
        bindingKey, workspaceRoot, prepared, lane: effectiveLane, messageId: prepared?.messageId || "",
      });
    }
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot, { lane: effectiveLane })) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared, lane: effectiveLane });
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared, lane: effectiveLane });
  }

  hasPendingImageInbound(bindingKey, workspaceRoot, lane = null) {
    return this.pendingImageInboundByScope.has(
      routeScopeKeyFor(lane, bindingKey, workspaceRoot),
    );
  }

  enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared, lane = null }) {
    const effectiveLane = lane || resolveRouteLaneFor(prepared, bindingKey);
    const scopeKey = routeScopeKeyFor(effectiveLane, bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    // Keyed by lane scope: an image burst in one topic can never be merged with
    // an image burst in another topic, and neither debounce timer touches the
    // other's draft.
    const current = this.pendingImageInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      lane: effectiveLane,
      messages: [],
      timer: null,
    };
    current.messages.push(clonePreparedInboundMessage(prepared));
    this.pendingImageInboundByScope.set(scopeKey, current);
    this.schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, INBOUND_IMAGE_BATCH_IDLE_MS, effectiveLane);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
      ...outboundThreadIdField(prepared),
    }).catch(() => {});
  }

  schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = INBOUND_IMAGE_BATCH_IDLE_MS, lane = null) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    const effectiveLane = lane || draft.lane || null;
    draft.timer = setTimeout(() => {
      void this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot, lane: effectiveLane }).catch((error) => {
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

  async flushPendingImageInboundBatch({ bindingKey = "", workspaceRoot = "", lane = null, trailingPrepared = null } = {}) {
    const scopeKey = routeScopeKeyFor(lane, bindingKey, workspaceRoot);
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
        lane: draft.lane || null,
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
      lane: draft.lane || null,
      prepared,
    });

    if (remainingMessages.length) {
      await this.flushPendingImageInboundBatch({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        lane: draft.lane || null,
      });
    }

    return true;
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared, lane = null }) {
    const effectiveLane = lane || resolveRouteLaneFor(prepared, bindingKey);
    const scopeKey = routeScopeKeyFor(effectiveLane, bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    // One buffer per lane. Messages from two topics are never merged into a
    // single turn even when they arrive while the same workspace is busy.
    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      lane: effectiveLane,
      messages: [],
    };
    current.messages.push({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      chatId: prepared.chatId ?? prepared.telegram?.chatId ?? "",
      ...outboundThreadIdField(prepared),
      messageId: prepared.messageId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      originalText: prepared.originalText,
      text: prepared.text,
      attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
      attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
      attachmentVisionContexts: Array.isArray(prepared.attachmentVisionContexts) ? prepared.attachmentVisionContexts : [],
      receivedAt: prepared.receivedAt,
    });
    this.pendingInboundByScope.set(scopeKey, current);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
      ...outboundThreadIdField(prepared),
    }).catch(() => {});
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot, lane = null) {
    return this.pendingInboundByScope.has(routeScopeKeyFor(lane, bindingKey, workspaceRoot));
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", lane = null, ignoreBoundary = false } = {}) {
    const targetScopeKey = bindingKey || lane
      ? routeScopeKeyFor(lane, bindingKey, workspaceRoot)
      : "";
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];

    for (const [scopeKey, draft] of scopeEntries) {
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      const draftLane = draft.lane || null;
      if (this.isTurnDispatchBlocked(draft.bindingKey, draft.workspaceRoot, { ignoreBoundary, lane: draftLane })) {
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
          lane: draftLane,
          messageId: pendingDispatch.prepared.messageId || "",
        });
        continue;
      }
      this.pendingInboundByScope.delete(scopeKey);
      const dispatched = await this.dispatchPreparedTurn({
        bindingKey: pendingDispatch.prepared.bindingKey,
        workspaceRoot: pendingDispatch.prepared.workspaceRoot,
        lane: draftLane,
        prepared: {
          workspaceId: pendingDispatch.prepared.workspaceId,
          accountId: pendingDispatch.prepared.accountId,
          senderId: pendingDispatch.prepared.senderId,
          chatId: pendingDispatch.prepared.chatId ?? "",
          messageThreadId: pendingDispatch.prepared.messageThreadId ?? null,
          contextToken: pendingDispatch.prepared.contextToken,
          provider: pendingDispatch.prepared.provider,
          originalText: pendingDispatch.prepared.originalText,
          text: pendingDispatch.prepared.text,
          attachments: pendingDispatch.prepared.attachments,
          attachmentFailures: pendingDispatch.prepared.attachmentFailures,
          attachmentVisionContexts: pendingDispatch.prepared.attachmentVisionContexts,
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
          lane: draftLane,
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
        // `...queued[0]` is an enumerable spread, which silently drops the
        // non-enumerable subject provenance (subjectSourceEntryId /
        // subjectSourceEvidence) the recorder attached. Without it no signing
        // capability is issued and her memory_candidate_submit dies at
        // `subject_signing_turn_unknown` -- the exact failure that stranded the
        // "你也不是人啊" draft. Carry it back onto the rebuilt message.
        prepared: carrySubjectProvenance({
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          ...queued[0],
        }, queued[0]),
        remainingMessages: [],
      };
    }

    const latest = queued[queued.length - 1];
    // originalText first: that is the field every downstream reader prefers
    // (assembleRuntimeTurnText, formatTelegramRuntimeText). `text` stays as the
    // fallback because not every inbound path fills originalText in.
    const blocks = queued
      .map((message) => String(message.originalText || message.text || "").trim())
      .filter(Boolean);
    const mergedText = [
      "Multiple newer user messages arrived while you were still handling the previous turn.",
      "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them.",
      "",
      blocks.join("\n\n"),
    ].join("\n").trim();

    return {
      // Carry the newest message's subject provenance onto the merged batch:
      // `...latest` is an enumerable spread and drops the non-enumerable
      // provenance, same leak as the single-message branch above.
      prepared: carrySubjectProvenance({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        ...latest,
        // Fix (2026-08-12): `...latest` carries the NEWEST message's
        // originalText, and readers prefer originalText over text, so setting
        // only `text` threw away every earlier queued message -- send three
        // while a turn is running and only the third arrived. Write the merged
        // batch to both fields, the way buildMergedInboundPrepared does.
        originalText: mergedText,
        text: mergedText,
        // Same leak, same cause: only the newest message's attachments survived,
        // so photos and voice notes ahead of it were dropped without a trace.
        attachments: queued.flatMap((message) => (Array.isArray(message.attachments) ? message.attachments : [])),
        attachmentFailures: queued.flatMap((message) => (Array.isArray(message.attachmentFailures) ? message.attachmentFailures : [])),
        attachmentVisionContexts: queued
          .flatMap((message) => (Array.isArray(message.attachmentVisionContexts) ? message.attachmentVisionContexts : []))
          .slice(0, 10),
      }, latest),
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
        ...outboundThreadIdField(normalized),
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
        ...outboundThreadIdField(normalized),
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
          this.requeueFailedSystemMessage(message, "turn_busy");
        } else if (message?.sourceType === "liveness_alert") {
          this.closeoutLivenessAutomation?.markAlertDelivered(message);
        }
      } catch (error) {
        this.requeueFailedSystemMessage(message, error?.message || String(error));
      }
    }
  }

  requeueFailedSystemMessage(message, errorText) {
    if (message?.sourceType !== "liveness_alert") {
      this.systemMessageDispatcher?.requeue(message);
      return true;
    }
    const attempts = Number(message?.deliveryAttempts || 0) + 1;
    const maxAttempts = Number(message?.maxDeliveryAttempts || MAX_ALERT_DELIVERY_ATTEMPTS);
    if (message?.sourceType === "liveness_alert" && attempts >= maxAttempts) {
      this.closeoutLivenessAutomation?.markAlertDeliveryFailed(message, errorText);
      console.error(`[automation] liveness alert delivery abandoned after ${attempts} attempts: ${errorText}`);
      return false;
    }
    this.systemMessageDispatcher?.requeue({
      ...message,
      deliveryAttempts: attempts,
      lastDeliveryError: String(errorText || "delivery_failed").slice(0, 500),
    });
    return true;
  }


  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.pendingInboundByScope?.size > 0) {
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
    const systemLane = buildSystemRouteLane("system-message");
    const desireLane = message?.sourceType === "desire_checkin"
      ? resolveTelegramLaneForSystemMessage(this, bindingKey, workspaceRoot)
      : null;
    // 回档净房: a `/sl_load` turn is delivered into the clean SL branch session
    // (fresh, isolated, wearing the chat persona), NOT the background system lane.
    // Its reply reaches her chat the same way desire's does, minus the shell.
    const slBranchLane = message?.sourceType === "sl_load" && message.slBranch
      ? this.safeBuildSlBranchLane(message.slBranch)
      : null;
    const lane = slBranchLane || desireLane || systemLane;
    // Queued system turns yield to any lane that is mid-turn in this workspace.
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot, { anyLane: true })) {
      return false;
    }
    // A回档净房 turn serializes on its own branch lane (an independent revisit),
    // while background system turns keep the pre-v2 binding-level gate.
    const dispatched = await this.dispatchPreparedTurn({
      bindingKey,
      workspaceRoot,
      prepared,
      lane,
      gateLane: slBranchLane ? undefined : (desireLane || null),
      pendingOperation: message?.sourceType === "desire_checkin"
        ? {
            kind: "desire_checkin",
            eventId: message.id,
            markerOwner: message.markerOwner,
            markerEventId: message.markerEventId,
            startedAt: Date.now(),
            reusedSession: Boolean(resolveRouteSessionFor(this, {
              bindingKey, workspaceRoot, lane,
            }).threadId),
          }
        : (this.config?.desireLoopMinimalEnabled === true && message?.desireState
          ? buildPendingSystemDesireOperation(this, message, message.desireState)
          : null),
    });
    // Count a read only once the archive has actually been dispatched into the
    // branch -- never at enqueue -- so a load that never lands is never tallied.
    if (slBranchLane && dispatched && message?.slBranch?.slId) {
      try {
        const { localDateKey } = require("../utils/business-day");
        const recorded = recordReentry({
          slDir: this.config.slDir,
          name: message.slBranch.slId,
          note: normalizeText(message.slBranch.note),
          dateKey: localDateKey(Date.now(), this.config.automationTimezone),
        });
        console.log(`[sl_load] delivered ${message.slBranch.branchId} read=${recorded.reads || "?"}`);
      } catch (error) {
        console.warn(`[sl_load] reentry count skipped: ${error?.message || String(error)}`);
      }
    }
    return dispatched;
  }

  // A回档净房 lane rebuilt from a queued message's descriptor. Never throws into
  // the dispatch path -- a malformed descriptor just declines the branch and the
  // caller falls back to the ordinary system lane.
  safeBuildSlBranchLane(descriptor) {
    try {
      return buildSlBranchLane(descriptor);
    } catch (error) {
      console.warn(`[sl_load] branch lane rebuild failed: ${error?.message || String(error)}`);
      return null;
    }
  }

  async dispatchChannelCommand(normalized, command) {
    if (this.route1DispatchController) {
      if (command.name === "stop-tasks-and-answer-now") {
        this.handleRoute1InterruptCommand(normalized, "soft");
        return;
      }
      if (command.name === "force-stop-now") {
        this.handleRoute1InterruptCommand(normalized, "hard");
        return;
      }
      if (command.name === "continue-tasks") {
        await this.handleRoute1ContinueCommand(normalized);
        return;
      }
    }
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
      case "restart":
        await this.handleRestartCommand(normalized);
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
      case "probe":
        await this.handleProbeCommand(normalized);
        return;
      case "sl_save":
        await this.handleSlSaveCommand(normalized, command);
        return;
      case "sl_load":
        await this.handleSlLoadCommand(normalized, command);
        return;
      case "sl_list":
        await this.handleSlListCommand(normalized);
        return;
      case "return":
      case "exit_sl":
        await this.handleReturnCommand(normalized);
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
      case "effort":
        await this.handleEffortCommand(normalized, command);
        return;
      case "pause_heartbeat":
        await this.handleActivityPauseCommand(normalized, command, true);
        return;
      case "continue_heartbeat":
        await this.handleActivityPauseCommand(normalized, command, false);
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
      case "ai_profile":
        await this.handleAiProfileCommand(normalized);
        return;
      case "profile":
        // With the T06 gate off, preserve the former unknown-command response
        // byte-for-byte instead of exposing a dormant command surface.
        if (this.telegramProfileRouter?.isActivePointerEnabled?.()) {
          await this.handleProfileCommand(normalized, command);
          return;
        }
        // Fall through to the baseline help response.
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
          ...outboundThreadIdField(normalized),
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
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot, this.config)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within CYBERBOSS_WORKSPACE.",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
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
      ...outboundThreadIdField(normalized),
    });
  }

  // Single resolution ladder for a window-scoped runtime param (model / effort):
  // window override when enabled → the value stored for this workspace → "".
  // /model, /effort and /status must all read through here. /status used to skip
  // the ladder entirely and print `describe().model`, which is the profile's
  // configured default and always non-empty — so it kept reporting the default
  // after /model had switched the live child (2026-08-06 Owner report).
  resolveWindowScopedRuntimeParam(kind, { bindingKey, workspaceRoot, lane, senderId }) {
    const launchProfile = this.resolveLaunchProfileForLane?.(lane) || null;
    const windowState = this.runtimeAdapter.getWindowOverride?.({
      bindingKey, workspaceRoot, lane, launchProfile, senderId: senderId || "",
    });
    if (windowState?.enabled) {
      return {
        value: windowState.value?.[kind]
          || windowState.trace?.entries?.find((entry) => entry.kind === kind)?.effective_value
          || "",
        fromWindow: true,
      };
    }
    return {
      value: this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot)[kind] || "",
      fromWindow: false,
    };
  }

  // Tell the Owner when a fresh child takes over her lane (Owner 2026-08-07).
  // Escalation and TTL recovery both swap the process mid-conversation and used
  // to be invisible. Chat lane only: a Route 1 worker runs under a different
  // launch profile and is not her window, so it must never announce itself here.
  // Fail-open throughout — a missed notice must not disturb the lane.
  async announceProcessLaunch(payload) {
    try {
      const laneKey = normalizeText(payload?.laneKey);
      const threadId = normalizeText(payload?.threadId);
      if (!laneKey || !threadId) {
        return;
      }
      // 先记账再判断要不要通知：这是全局唯一能看到"进程实际启动参数"的地方，
      // 不管是不是她的窗口都该记下来，/status 要靠它说真话。
      // 可选链：这条通知是 fail-open 的，记账失败绝不能把通知本身吞掉。
      this.liveLaunchByLane?.set(laneKey, {
        model: normalizeText(payload?.model),
        effort: normalizeText(payload?.effort),
        at: new Date().toISOString(),
      });
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
      // 只对她真正聊天的那条 lane 出声。system lane 跑的是 reflect/consolidation
      // 这类后台轮次，它也用同一个 profile，于是从前也会发一条通知过去——
      // Owner 2026-08-10 看到"两条通知、两个模型"就是这么来的，那条是噪音。
      // （记账在上面已经做过了，这里只管要不要打扰她。）
      // 按"排除 system lane"来判，而不是"必须长得像 tg lane"：lane key 的形态
      // 不止一种（v2 / legacy / 测试夹具），用白名单会把正常的窗口一起哑掉。
      if (String(laneKey).includes("|sys|")) {
        return;
      }
      const chatProfileId = normalizeText(this.telegramProfileRouter?.select?.(laneKey)?.profileId);
      const launchedProfileId = normalizeText(payload?.profileId);
      // No chat profile resolvable for this lane, or a different profile than the
      // one this lane chats with: not her window. Say nothing.
      if (!chatProfileId || !launchedProfileId || chatProfileId !== launchedProfileId) {
        return;
      }
      const lines = [
        "♻️ 新的子进程接管了这条 lane",
        `🤖 model: ${normalizeText(payload?.model) || "(default)"}`,
        `⚡ effort: ${resolveEffortLevel(normalizeText(payload?.effort))}`,
        payload?.resumed ? "🧵 已 --resume 原会话，上下文没有丢" : "🧵 新会话",
      ];
      await this.channelAdapter.sendText({
        userId: senderId,
        text: lines.join("\n"),
        contextToken: this.channelAdapter.getKnownContextTokens?.()[senderId] || "",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cyberboss] process launch notice failed: ${message}`);
    }
  }

  // Read the live context usage for a thread out of the runtime's own session
  // transcript. claudecode only; returns null whenever it cannot be established,
  // so every caller keeps its previous fallback.
  resolveSessionContextUsage({ runtimeName, threadId, lane }) {
    if (runtimeName !== "claudecode" || !threadId) {
      return null;
    }
    const configRoot = this.resolveLaunchProfileForLane?.(lane)?.configRoot
      || process.env.CLAUDE_CONFIG_DIR
      || "";
    if (!configRoot) {
      return null;
    }
    const usage = readSessionContextUsage({ configRoot, sessionId: threadId });
    return usage ? { ...usage, runtimeId: runtimeName } : null;
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    const threadId = resolveRouteSessionFor(this, { bindingKey, workspaceRoot, lane: commandLane, normalized }).threadId;
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    // The in-memory reading exists only from the moment the child last answered
    // something, and it does not survive a bot restart — after one, /status showed
    // nothing until the Owner sent another message. Claude Code's own session
    // transcript does survive, and a relaunch is `--resume` of that same
    // transcript, so its last recorded usage is what the *current* child is
    // carrying. Prefer it; fall back to the in-memory reading when it cannot be
    // read (other runtimes, no profile, unreadable file).
    const context = this.resolveSessionContextUsage({ runtimeName, threadId, lane: commandLane })
      || (threadState?.context?.runtimeId === runtimeName
        ? threadState.context
        : this.threadStateStore.getLatestContext(runtimeName));
    const configuredModel = this.resolveWindowScopedRuntimeParam("model", {
      bindingKey, workspaceRoot, lane: commandLane, senderId: normalized.senderId,
    }).value || this.runtimeAdapter.describe().model || "";
    // Same ladder as /effort, so the two can never disagree the way /model and
    // /status did. Falls back to the env default rather than printing nothing.
    const configuredEffort = resolveEffortLevel(this.resolveWindowScopedRuntimeParam("effort", {
      bindingKey, workspaceRoot, lane: commandLane, senderId: normalized.senderId,
    }).value);
    // 上面那条梯子给的是**配置意图**。真正在跑的是子进程启动时拿到的参数，
    // 两者会分叉（覆盖被清掉但进程还活着）。分叉时以实际为准，并把差异显式说出来
    // ——沉默地报配置值，正是把 Owner 蒙了五天的那个 bug。
    const live = this.liveLaunchByLane?.get(normalizeText(commandLane?.laneKey)) || null;
    const effectiveModel = normalizeText(live?.model) || configuredModel;
    const effectiveEffort = live?.effort ? resolveEffortLevel(live.effort) : configuredEffort;
    const modelDrift = Boolean(normalizeText(live?.model)) && normalizeText(live.model) !== configuredModel;
    const effortDrift = Boolean(normalizeText(live?.effort)) && resolveEffortLevel(live.effort) !== configuredEffort;

    // One icon per line, each one meaning something different — the old block ran
    // 🤖 three times over runtime/model/provider, so nothing stood out. `provider`
    // is gone entirely (Owner 2026-08-07): it restated the runtime and was
    // "(default)" in every real reading.
    const lines = [
      `📁 workspace: ${workspaceRoot}`,
      // Empty thread/status are honest cold-start values, not bugs: render them as
      // plain language while leaving the underlying value tokens intact.
      `🧵 thread: ${threadId || "(none · 尚未绑定线程)"}`,
      `${threadStatusIcon(threadState?.status)} status: ${describeThreadStatus(threadState?.status)}`,
      `🧠 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
      `⚡ effort: ${effectiveEffort}`,
    ];
    if (modelDrift || effortDrift) {
      // 只在真分叉时出现：正在跑的进程和配置不是一回事，重启后会跳回配置值。
      const drifted = [
        modelDrift ? `model ${configuredModel || "(default)"}` : "",
        effortDrift ? `effort ${configuredEffort}` : "",
      ].filter(Boolean).join(" · ");
      lines.push(`⚠️ 上面是这个进程实际在跑的；配置里写的是 ${drifted}，下次重启按配置走`);
    }
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    // Watchdog liveness (read-only, fail-open). Surfaces the battery-policy silent
    // stop; shows "unknown · log not configured" until CYBERBOSS_WATCHDOG_LOG points
    // at the real health log on the production machine.
    lines.push(formatWatchdogStatusLine(readWatchdogHealth(this.config?.watchdogLogFile || "")));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    });
  }

  // AI-Profile: hidden, read-only capability directory (Owner 2026-08-04). Lists
  // the AI's 【mcp】【tool】 (real data) and 【skill】 (暂缺 — no enumerator exists;
  // building the catalog skill category collides with the unstarted D25-A design,
  // see the design ticket). Pure read — no writer, no network.
  async handleAiProfileCommand(normalized) {
    const lines = ["🧩 AI-Profile（只读能力目录）", ""];

    // 【mcp】: external MCP servers configured for the runtime child. Read-only env
    // read that mirrors the legacy list the claudecode adapter feeds
    // resolveClaudeExternalMcpServerConfigs (project-settings.js) plus
    // CYBERBOSS_EXTRA_MCP_SERVERS. Names/commands only — no server spawn.
    lines.push("【mcp】");
    let mcpServers = [];
    try {
      mcpServers = resolveExternalMcpServerConfigs({
        legacy: [{
          nameEnv: "CYBERBOSS_MUSIC_MCP_NAME",
          commandEnv: "CYBERBOSS_MUSIC_MCP_COMMAND",
          argsEnv: "CYBERBOSS_MUSIC_MCP_ARGS",
          defaultName: "netease_music_mcp",
        }],
      });
    } catch {
      mcpServers = [];
    }
    if (mcpServers.length) {
      for (const server of mcpServers) {
        lines.push(`  · ${server.name}${server.command ? ` — ${server.command}` : ""}`);
      }
    } else {
      lines.push("  （暂无外部 MCP 服务器）");
    }
    lines.push("");

    // 【tool】: in-process project tools from the read-only catalog. Drops aliases,
    // hidden and deprecated entries (mirrors displayableCatalogEntries). memory-topic
    // tools are folded in — they are tools too.
    lines.push("【tool】");
    let toolEntries = [];
    try {
      const entries = this.projectToolHost?.catalogState?.().entries || [];
      toolEntries = entries.filter((entry) =>
        !entry.alias_of && !entry.hidden && !entry.deprecated
        && (entry.category === "tool" || entry.category === "memory"));
    } catch {
      toolEntries = [];
    }
    if (toolEntries.length) {
      for (const entry of toolEntries) {
        const purpose = entry.purpose ? ` — ${entry.purpose}` : "";
        const risk = entry.risk ? ` [${entry.risk}]` : "";
        lines.push(`  · ${entry.id}${purpose}${risk}`);
      }
    } else {
      lines.push("  （暂无工具）");
    }
    lines.push("");

    lines.push("【skill】");
    lines.push("  暂缺（无枚举源；catalog skill 类为空占位，见设计单 skill-enumerator-design）");

    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    // `/new` means "back to a fresh mainline window", so it also leaves any回档净房.
    const leftBranch = this.clearSlBranch?.(bindingKey);
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({
        bindingKey,
        workspaceRoot,
        senderId: normalized.senderId || "",
        lane: resolveRouteLaneFor(normalized, bindingKey),
        launchProfile: this.resolveLaunchProfileForLane?.(resolveRouteLaneFor(normalized, bindingKey)) || null,
      });
    }
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    // Show what the fresh window will run (model / effort), the same way /status
    // does, so she can confirm the settings without a second command. The thread
    // itself opens on her next message, so there is no thread id or context usage
    // to report yet -- say so plainly rather than printing a stale one. Fail-open:
    // a failed status line must never cost her the /new.
    // Optional-chained like enqueueWindowOpenGreetingFailOpen below: the command
    // is also driven by bare fixtures that carry only the methods under test, and
    // a hard `this.`-call would fail the whole /new instead of just dropping the
    // status tail.
    const statusTail = this.describeFreshThreadSettingsFailOpen?.(normalized, {
      bindingKey, workspaceRoot,
    }) || [];
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        `✅ Switched to a fresh thread draft${leftBranch ? "（已退出回档净房，回到主线）" : ""}\nworkspace: ${workspaceRoot}`,
        ...statusTail,
      ].join("\n"),
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    });
    // Optional-called: `handleNewCommand` is driven by fixtures that assemble a
    // plain object carrying only the prototype methods under test, and a hard
    // `this.`-call here fails the whole command rather than just the greeting.
    this.enqueueWindowOpenGreetingFailOpen?.(normalized, workspaceRoot);
  }

  // The model / effort the fresh window will launch with, plus a plain note that
  // the thread and its context usage do not exist until her next message. Reuses
  // the same runtime-param ladder /status reads, so /new and /status agree. Never
  // throws: a status-tail failure returns nothing and the /new still lands.
  describeFreshThreadSettingsFailOpen(normalized, { bindingKey, workspaceRoot }) {
    try {
      const commandLane = resolveRouteLaneFor(normalized, bindingKey);
      const model = this.resolveWindowScopedRuntimeParam("model", {
        bindingKey, workspaceRoot, lane: commandLane, senderId: normalized.senderId,
      }).value || this.runtimeAdapter.describe?.().model || "";
      const effort = resolveEffortLevel(this.resolveWindowScopedRuntimeParam("effort", {
        bindingKey, workspaceRoot, lane: commandLane, senderId: normalized.senderId,
      }).value);
      return [
        `🤖 model: ${normalizeText(model) || "(default)"}`,
        `⚡ effort: ${effort}`,
        "🧵 thread: (fresh · 你下一条消息开新线程)",
        "📦 context: (fresh · 新线程还没有用量)",
      ];
    } catch (error) {
      console.warn(`[cyberboss] /new status tail skipped: ${error?.message || String(error)}`);
      return [];
    }
  }

  /**
   * Let the new window speak first.
   *
   * Only `/new` reaches here, and `/new` is something she typed -- that is the
   * whole gate on "is this a new window". Process restarts, TTL recycling and
   * route2 escalation all open fresh sessions too, and a greeting on any of
   * those would be noise she never asked for.
   *
   * The turn itself is the existing system-message path (the same one the
   * hourly desire tick uses), so the opening context is injected exactly as it
   * would be for any first turn: she reads before she speaks without anyone
   * having to orchestrate it.
   *
   * Fail-open: a greeting that cannot be queued must not cost her the `/new`.
   */
  enqueueWindowOpenGreetingFailOpen(normalized, workspaceRoot) {
    if (this.config.windowOpenGreetingEnabled !== true) return null;
    try {
      // `/pause_heartbeat` means "stop speaking to me on your own". A greeting
      // is exactly that, so it honours the same latch. Night-skip deliberately
      // does not apply: she typed the command, the hour is her business.
      if (isActivityPaused(this.config.activityPauseFile)) return null;
      const senderId = normalizeText(normalized?.senderId);
      if (!senderId || !workspaceRoot || !this.systemMessageQueue) return null;
      return this.systemMessageQueue.enqueue({
        id: `window-open:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        accountId: this.activeAccountId || normalized.accountId,
        senderId,
        workspaceRoot,
        // The store rejects an empty body outright, so the trigger needs one
        // even though `window_open` carries its whole instruction in the
        // dispatcher. It lands under "Trigger:" at the end of that block.
        text: "她刚敲了 /new，这是这个窗口的第一轮。",
        sourceType: "window_open",
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(`[cyberboss] window-open greeting skipped: ${error?.message || String(error)}`);
      return null;
    }
  }

  /**
   * Auto-continue after a Route 2/3 escalation relaunch.
   *
   * The wide tool face only opens on a fresh child, and the relaunch is deferred
   * to the turn boundary (retiring it mid-turn would kill the very reply that
   * asked for it). Without this, that fresh turn would wait for an inbound
   * message — i.e. the Owner. This enqueues a one-shot self-trigger so she opens
   * the wide-face turn herself and continues the work she escalated for.
   *
   * Deliberately NOT gated on /pause_heartbeat: this completes an action she
   * herself initiated (the escalation), not a proactive reach-out. Deduped so a
   * burst of relaunch signals cannot stack multiple continuations. Fail-open.
   */
  enqueueRoute2ContinueFailOpen(origin = {}) {
    try {
      const senderId = normalizeText(origin?.senderId);
      const workspaceRoot = normalizeText(origin?.workspaceRoot);
      const accountId = this.activeAccountId || normalizeText(origin?.accountId);
      if (!senderId || !workspaceRoot || !accountId || !this.systemMessageQueue) return null;
      if (this.systemMessageQueue.hasPendingForAccount?.(accountId, {
        shouldInclude: (message) => message?.sourceType === "route2_continue",
      })) {
        return null;
      }
      return this.systemMessageQueue.enqueue({
        id: `route2-continue:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        accountId,
        senderId,
        workspaceRoot,
        // The store rejects an empty body; the real instruction lives in the
        // dispatcher's route2_continue branch. This lands under "Trigger:".
        text: "升级后的宽工具面已就绪。",
        sourceType: "route2_continue",
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn(`[cyberboss] route2 continue skipped: ${error?.message || String(error)}`);
      return null;
    }
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    const threadId = resolveRouteSessionFor(this, { bindingKey, workspaceRoot, lane: commandLane, normalized }).threadId;
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
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
      const commandLane = resolveRouteLaneFor(normalized, bindingKey);
      const refreshed = await this.runtimeAdapter.refreshThreadInstructions({
        lane: commandLane,
        launchProfile: this.resolveLaunchProfileForLane?.(commandLane) || null,
        senderId: normalized.senderId || "",

        threadId,
        workspaceRoot,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
        effort: runtimeParams.effort,
        reason: "reread",
      });
      this.recordContextTrace?.(threadId, refreshed?.turnId || "", refreshed?.continuity);
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Reread failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      }).catch(() => {});
    }
  }

  // Retire this chat's child process while keeping the conversation. The next
  // message relaunches it with the current model / effort / profile, so a /model
  // or /effort change she made takes hold without dropping the thread. Unlike
  // /reread this injects no instruction-refresh turn.
  async handleRestartCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    if (typeof this.runtimeAdapter.restartLaneChild !== "function") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 This runtime does not support /restart.",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }
    try {
      const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const result = await this.runtimeAdapter.restartLaneChild({
        bindingKey,
        workspaceRoot,
        lane: commandLane,
        launchProfile: this.resolveLaunchProfileForLane?.(commandLane) || null,
        senderId: normalized.senderId || "",
        model: runtimeParams.model,
        effort: runtimeParams.effort,
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: [
          result?.retired ? "🔄 已重启这条对话的进程" : "🔄 这条对话当前没有在跑的子进程",
          "会话保留;下一条消息会用最新的 model / effort / profile。",
          ...(runtimeParams.model ? [`model: ${runtimeParams.model}`] : []),
          ...(runtimeParams.effort ? [`effort: ${resolveEffortLevel(runtimeParams.effort)}`] : []),
        ].join("\n"),
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Restart failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
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
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    const threadId = resolveRouteSessionFor(this, { bindingKey, workspaceRoot, lane: commandLane, normalized }).threadId;
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      const commandLane = resolveRouteLaneFor(normalized, bindingKey);
      await this.runtimeAdapter.compactThread({
        lane: commandLane,
        launchProfile: this.resolveLaunchProfileForLane?.(commandLane) || null,
        senderId: normalized.senderId || "",

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
        ...outboundThreadIdField(normalized),
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      }).catch(() => {});
    }
  }

  async handleSwitchCommand(normalized, command) {
    const argTokens = normalizeCommandArgument(command.args).split(/\s+/).filter(Boolean);
    // `/switch <threadId> force` is the deliberate escape hatch: adopting a
    // thread the slot does not currently own. The plain form still refuses on
    // mismatch and points here, so force is always a second, explicit step.
    const forceRequested = argTokens.length > 1
      && ["force", "--force"].includes(argTokens[argTokens.length - 1].toLowerCase());
    const effectiveArgs = forceRequested ? argTokens.slice(0, -1).join(" ") : normalizeCommandArgument(command.args);
    const isBack = effectiveArgs.toLowerCase() === "back";

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();

    let targetThreadId;
    if (isBack) {
      // /switch back: return to the thread that was active before the current one
      // (the undo for /new and /switch). The store records that pointer whenever
      // the active thread changes; resuming it re-records the outgoing thread, so
      // repeated /switch back toggles between the two.
      targetThreadId = sessionStore.getPreviousThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!targetThreadId) {
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: "💡 No previous thread to return to.",
          contextToken: normalized.contextToken,
          ...outboundThreadIdField(normalized),
        });
        return;
      }
    } else {
      targetThreadId = normalizeThreadId(effectiveArgs);
      if (!targetThreadId) {
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: "💡 Usage: /switch <threadId>  (or /switch back to return to the previous thread)",
          contextToken: normalized.contextToken,
          ...outboundThreadIdField(normalized),
        });
        return;
      }
    }

    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    let resumed;
    try {
      const commandLane = resolveRouteLaneFor(normalized, bindingKey);
      resumed = await this.runtimeAdapter.resumeThread({
        lane: commandLane,
        launchProfile: this.resolveLaunchProfileForLane?.(commandLane) || null,
        senderId: normalized.senderId || "",

        threadId: targetThreadId,
        workspaceRoot,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
        effort: runtimeParams.effort,
        resumeOrigin: "user_switch",
        // Never forced for /switch back: the previous-thread pointer is a
        // stored value, not something the user typed and double-checked.
        force: forceRequested && !isBack,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Switch failed; the requested thread was not replaced.\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      }).catch(() => {});
      return;
    }
    if (resumed?.empty === true) {
      if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
        await this.runtimeAdapter.startFreshThreadDraft({
        bindingKey,
        workspaceRoot,
        senderId: normalized.senderId || "",
        lane: resolveRouteLaneFor(normalized, bindingKey),
        launchProfile: this.resolveLaunchProfileForLane?.(resolveRouteLaneFor(normalized, bindingKey)) || null,
      });
      }
      sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `✅ Empty thread selected; the next message will start a fresh thread.\nworkspace: ${workspaceRoot}`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }
    if (resumed?.resumed === false) {
      // The adapter refused the requested thread (only this lane's own stored
      // session is resumable). Do NOT change the stored thread and do NOT claim
      // success -- report the refusal honestly.
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: resumed?.refused === "slot_mismatch" && !isBack
          ? `⚠️ Switch refused: this lane currently owns a different session, so the requested thread was not adopted.\nIf you are sure (e.g. recovering after a context rebuild), repeat with:\n/switch ${targetThreadId} force`
          : `⚠️ Switch refused: the requested thread can't be adopted in this lane (only the current session is resumable). Current thread unchanged.`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      }).catch(() => {});
      return;
    }
    sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resumed?.threadId || targetThreadId,
    );
    try {
      const commandLane = resolveRouteLaneFor(normalized, bindingKey);
      const refreshed = await this.runtimeAdapter.refreshThreadInstructions({
        lane: commandLane,
        launchProfile: this.resolveLaunchProfileForLane?.(commandLane) || null,
        senderId: normalized.senderId || "",

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
      ...outboundThreadIdField(normalized),
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    const threadId = resolveRouteSessionFor(this, { bindingKey, workspaceRoot, lane: commandLane, normalized }).threadId;
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      bindingKey,
      senderId: normalized.senderId || "",
      lane: resolveRouteLaneFor(normalized, bindingKey),
      launchProfile: this.resolveLaunchProfileForLane?.(resolveRouteLaneFor(normalized, bindingKey)) || null,
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    });
  }

  handleRoute1InterruptCommand(normalized, level) {
    let interrupt;
    try {
      interrupt = level === "hard"
        ? this.route1DispatchController.hardInterrupt()
        : this.route1DispatchController.softInterrupt();
    } catch (error) {
      console.warn(`[route1] ${level} interrupt failed: ${error?.message || String(error)}`);
      interrupt = { acknowledgement: "收到", formal: Promise.resolve("工程车急停状态暂时取不到；当前聊天不受影响。") };
    }
    const target = {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    };
    // D25-C acknowledgement is deliberately sent before observing the worker
    // promise. The formal status is a later, independent delivery.
    void this.channelAdapter.sendText({ ...target, text: interrupt.acknowledgement }).catch(() => {});
    void Promise.resolve(interrupt.formal)
      .then((text) => this.channelAdapter.sendText({ ...target, text }))
      .catch(() => {});
  }

  async handleRoute1ContinueCommand(normalized) {
    let result;
    try {
      result = this.route1DispatchController.continueTasks();
    } catch (error) {
      console.warn(`[route1] continue failed: ${error?.message || String(error)}`);
      result = { resumed: [] };
    }
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `已恢复工程派活。resumed=${result.resumed.join(",") || "none"}`,
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    }).catch(() => {});
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    if (!rangeInput) {
      const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⏰ Current check-in interval is ${Math.round(currentRange.minIntervalMs / 60000)}-${Math.round(currentRange.maxIntervalMs / 60000)} minutes.`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /checkin <min>-<max>",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
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
      ...outboundThreadIdField(normalized),
    });
  }

  // /probe：手动激发一次八维自查（主动态）。无视夜跳窗口与定时节奏，随时可测。
  // checkin 提示词已是主动态，她会记录八维，此刻想做什么（发消息/刷论坛/整理）就去做。
  async handleProbeCommand(normalized) {
    const targets = this.automationTargets;
    if (!this.systemMessageQueue || !targets?.accountId || !targets?.senderId || !targets?.workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "❌ 暂时激发不了八维自查：自动化目标还没就绪（poller 可能刚起，稍等再试）。",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }
    const { buildDesireTriggerText, fetchWeatherBriefSafe, decideWeatherLine } = require("../app/hourly-desire-poller");
    const id = `probe:${crypto.randomUUID()}`;
    // /probe 与真 checkin 一致地带上天气行（便于随时验证）。手动探针不写「今日已投递」
    // 守卫（传空 stateFile），每次预警日都可显示，不影响自动那跳的每日一次幂等。
    const probeBrief = this.config.weatherInjectEnabled ? await fetchWeatherBriefSafe(this.config) : null;
    const probeWeather = decideWeatherLine({
      config: { ...this.config, weatherInjectStateFile: "" },
      weatherBrief: probeBrief,
    });
    const probeTrigger = buildDesireTriggerText(this.config);
    this.systemMessageQueue.enqueue({
      id,
      accountId: targets.accountId,
      senderId: targets.senderId,
      workspaceRoot: targets.workspaceRoot,
      text: probeWeather.line ? `${probeTrigger}\n\n${probeWeather.line}` : probeTrigger,
      sourceType: "desire_checkin",
      createdAt: new Date().toISOString(),
    });
    console.log(`[probe] manual desire checkin queued id=${id}`);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: "🧪 已激发一次八维自查（主动态）。她会回顾八维、更新状态；此刻想做点什么——给你发条消息、刷 X / Reddit / 长毛象、整理记忆——就会去做。稍等片刻。",
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    });
  }

  async handleSlSaveCommand(normalized, command) {
    const reply = (text) =>
      this.channelAdapter.sendText({
        userId: normalized.senderId,
        text,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
    if (!this.config.slDir) {
      await reply("❌ SL 存档没配置（CYBERBOSS_SL_DIR 未设）。");
      return;
    }
    const { name, fields } = parseSlSaveArgs(command.args);
    // No end anchor is fine now: /sl_save alone saves up to the latest line.
    // A time-stamped fallback keeps unnamed auto-saves from colliding.
    const hhmm = new Date().toISOString().slice(11, 16).replace(":", "");
    const slName = deriveSlName(name, fields.end, `存档${hhmm}`);
    let result;
    try {
      result = saveArchive({
        slDir: this.config.slDir,
        conversationsDir: this.config.conversationDir,
        name: slName,
        note: fields.note || "",
        guide: fields.guide || "",
        endAnchor: fields.end,
        startAnchor: fields.start || "",
        timezone: this.config.automationTimezone,
        labels: { user: this.config.slUserLabel, ai: this.config.slAiLabel },
      });
    } catch (error) {
      await reply(`❌ 存档出错：${error?.message || String(error)}`);
      return;
    }
    if (!result.ok) {
      await reply(slSaveErrorText(result));
      return;
    }
    const indexNote = result.indexUpdated ? "" : "\n⚠️ sl-index.md 没更到（缺文件或没有表格），存档文件已建好。";
    await reply(
      `💾 已存档 ${result.slId}\n` +
        `剧情时间：${result.storyTime}\n` +
        `收录 ${result.rowCount} 条对话（她 + fable，跳过工具流水）。${indexNote}`,
    );
  }

  async handleSlLoadCommand(normalized, command) {
    const reply = (text) =>
      this.channelAdapter.sendText({
        userId: normalized.senderId,
        text,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
    if (!this.config.slDir) {
      await reply("❌ SL 存档没配置（CYBERBOSS_SL_DIR 未设）。");
      return;
    }
    const { name, note } = parseSlLoadArgs(command.args);
    // No name -> show a numbered roster and arm a brief pending selection, so she
    // can pick with a bare number reply. She asked for exactly this ("回复 1 就行").
    if (!name) {
      const listed = listArchives(this.config.slDir);
      if (!listed.ok || !listed.rows.length) {
        await reply("📂 还没有存档点。用 /sl_save 存第一段。");
        return;
      }
      this.armSlLoadSelection(normalized, listed.rows.map((row) => row.slId));
      await reply(this.formatSlArchiveRoster(listed.rows, "读哪个？直接回数字（如 1）就行；也可以 /sl_load 档名。"));
      return;
    }
    // A bare number selects by position in the /sl_list order.
    if (/^\d+$/u.test(name)) {
      const listed = listArchives(this.config.slDir);
      const row = listed.ok ? listed.rows[Number(name) - 1] : null;
      if (!row) {
        await reply(`❌ 没有第 ${name} 个存档点。先 /sl_list 看有几个。`);
        return;
      }
      await this.executeSlLoad(normalized, row.slId, note);
      return;
    }
    await this.executeSlLoad(normalized, name, note);
  }

  // The 08-sl key for a brief pending selection: per account + sender, so one
  // chat's "1" never resolves another's roster.
  slLoadSelectionKey(normalized) {
    return `${normalizeText(normalized?.accountId)} ${normalizeText(normalized?.senderId)}`;
  }

  armSlLoadSelection(normalized, slIds) {
    if (!Array.isArray(slIds) || !slIds.length) return;
    this.slLoadPending.set(this.slLoadSelectionKey(normalized), {
      slIds,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
  }

  // Called at the top of the inbound path. A bare number while a roster is armed
  // loads that archive; anything else clears the pending selection and lets the
  // message flow on as normal chat. Returns true only when it consumed the turn.
  async tryConsumeSlLoadSelection(normalized) {
    if (!(this.slLoadPending instanceof Map)) return false;
    const key = this.slLoadSelectionKey(normalized);
    const pending = this.slLoadPending.get(key);
    if (!pending) return false;
    if (Date.now() > pending.expiresAt) {
      this.slLoadPending.delete(key);
      return false;
    }
    const text = normalizeText(normalized?.text);
    if (!/^\d+$/u.test(text)) {
      // She moved on -- a normal message cancels the selection prompt.
      this.slLoadPending.delete(key);
      return false;
    }
    const index = Number(text);
    if (index < 1 || index > pending.slIds.length) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ 只有 1–${pending.slIds.length}。回这个范围里的数字，或直接说话取消。`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return true;
    }
    this.slLoadPending.delete(key);
    await this.executeSlLoad(normalized, pending.slIds[index - 1], "");
    return true;
  }

  formatSlArchiveRoster(rows, tail = "") {
    const lines = [`📂 存档点（共 ${rows.length} 个）：`];
    rows.forEach((row, i) => {
      lines.push(`${i + 1}. ${row.slId}｜${row.storyTime}｜读档 ${row.reads} 次`);
      if (row.noteSummary) lines.push(`   ${row.noteSummary}`);
    });
    if (tail) lines.push("", tail);
    return lines.join("\n");
  }

  // ---- 回档净房 pointer -----------------------------------------------------
  //
  // While a pointer is set for a binding, that chat's inbound turns route into
  // the clean SL branch session. Set on `/sl_load`, cleared by `/return` (or
  // `/new`). The stored descriptor is everything `buildSlBranchLane` needs to
  // rebuild the exact same lane -- same branchId -> same fresh session -- for
  // every subsequent turn until she leaves.

  setSlBranch(bindingKey, descriptor) {
    if (!bindingKey || !descriptor?.branchId) return;
    this.slBranchByBinding.set(bindingKey, descriptor);
  }

  clearSlBranch(bindingKey) {
    return this.slBranchByBinding.delete(bindingKey);
  }

  resolveActiveSlBranchLane(bindingKey) {
    const descriptor = this.slBranchByBinding?.get?.(bindingKey);
    if (!descriptor) return null;
    try {
      return buildSlBranchLane(descriptor);
    } catch {
      // A descriptor we can no longer turn into a lane is dead weight; drop it
      // so she falls back to the mainline rather than getting stuck.
      this.slBranchByBinding.delete(bindingKey);
      return null;
    }
  }

  // Shared load core: open a fresh clean-room branch session, inject ONLY the
  // archive (no今天上下文, no八维, no SYSTEM ACTION MODE shell), point this chat at
  // it, and confirm. The read count is bumped on dispatch (see dispatchSystemMessage),
  // not here, so a load that never reaches the branch is never counted.
  // Used by /sl_load <name>, /sl_load <number>, and the bare-number selection.
  async executeSlLoad(normalized, nameOrSlId, note = "") {
    const reply = (text) =>
      this.channelAdapter.sendText({
        userId: normalized.senderId,
        text,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
    const loaded = loadArchive({ slDir: this.config.slDir, name: nameOrSlId });
    if (!loaded.ok) {
      await reply(slLoadErrorText(loaded));
      return false;
    }
    const targets = this.automationTargets;
    if (!this.systemMessageQueue || !targets?.accountId || !targets?.senderId || !targets?.workspaceRoot) {
      await reply("❌ 暂时读不了档：注入目标还没就绪（poller 可能刚起，稍等再试）。存档没动。");
      return false;
    }
    // The branch wears the SAME persona as the chat she typed from, so profile
    // selection needs that chat's Telegram lane. A non-tg surface (WeChat, tests)
    // has no clean-room lane -- fall back to the mainline chat lane there so the
    // load still lands, just without isolation.
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const chatLane = resolveRouteLaneFor(normalized, bindingKey);
    if (chatLane?.kind !== "tg") {
      await reply("❌ 读档净房目前只在 Telegram 端开（当前通道不支持）。存档没动。");
      return false;
    }
    // Fresh branchId per load -> a brand-new isolated session every time (she
    // asked for 每次全新, not 续读). The pointer keeps this chat on that branch
    // until /return or /new.
    const nextRead = loaded.reads + 1;
    const branchId = `${loaded.slId}#${crypto.randomUUID().slice(0, 8)}`;
    const slBranch = {
      slId: loaded.slId,
      branchId,
      note,
      accountId: chatLane.accountId,
      chatId: chatLane.chatId,
      messageThreadId: chatLane.messageThreadId,
    };
    this.setSlBranch(bindingKey, slBranch);
    this.systemMessageQueue.enqueue({
      id: `sl_load:${crypto.randomUUID()}`,
      accountId: targets.accountId,
      senderId: targets.senderId,
      workspaceRoot: targets.workspaceRoot,
      text: buildSlLoadInjection(loaded, nextRead),
      sourceType: "sl_load",
      slBranch,
      createdAt: new Date().toISOString(),
    });
    console.log(`[sl_load] armed clean-room branch ${branchId} read=${nextRead}`);
    await reply(`📖 读档 ${loaded.slId}：已开一个干净的回档净房，只装这段存档、不带今天。稍等接话——按存档的引导指令走。聊完 /return 回来。`);
    return true;
  }

  // Leave a回档净房 and return to the mainline chat. A no-op (with a gentle note)
  // when she is not in one, so /return is always safe to type.
  async handleReturnCommand(normalized) {
    const reply = (text) =>
      this.channelAdapter.sendText({
        userId: normalized.senderId,
        text,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const descriptor = this.slBranchByBinding?.get?.(bindingKey);
    if (!descriptor) {
      await reply("你现在就在主线，没有在读档净房里。");
      return;
    }
    this.clearSlBranch(bindingKey);
    await reply(`↩️ 回到主线（离开回档净房 ${descriptor.slId}）。刚才那段读档留在它自己的窗里，没并进主线。`);
  }

  async handleSlListCommand(normalized) {
    const reply = (text) =>
      this.channelAdapter.sendText({
        userId: normalized.senderId,
        text,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
    if (!this.config.slDir) {
      await reply("❌ SL 存档没配置（CYBERBOSS_SL_DIR 未设）。");
      return;
    }
    const result = listArchives(this.config.slDir);
    if (!result.ok) {
      await reply("❌ 读不到存档目录。");
      return;
    }
    if (!result.rows.length) {
      await reply("📂 还没有存档点。用 /sl_save 存第一段。");
      return;
    }
    await reply(this.formatSlArchiveRoster(result.rows, "读档：/sl_load 数字（如 1）或 /sl_load 档名。"));
  }

  async handleActivityPauseCommand(normalized, command, paused) {
    // Renamed to single-token /pause_heartbeat and /continue_heartbeat (Owner
    // 2026-08-04): the command name now carries the meaning, so there is no
    // "activity" argument to validate.
    try {
      writeActivityPauseState(this.config.activityPauseFile, paused);
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Autonomous activity was not changed because its state could not be saved.\n${error?.message || String(error)}`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const text = paused
      ? [
          "⏸️ Autonomous activity paused.",
          "Paused: Desire hourly ticks, scheduled check-ins, consolidation/Reflect beats, closeout/liveness scheduling, and delivery of their queued proactive messages.",
          "Still active: window chat and user-set reminders.",
        ].join("\n")
      : [
          "▶️ Autonomous activity resumed.",
          "Resumed: Desire hourly ticks, scheduled check-ins, consolidation/Reflect beats, closeout/liveness scheduling, and delivery of their queued proactive messages.",
          "Still active throughout: window chat and user-set reminders.",
        ].join("\n");
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
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
        ...outboundThreadIdField(normalized),
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${MAX_MIN_WEIXIN_CHUNK}.`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Minimum merge chunk set to ${updated} characters. Shorter fragments will be merged into one message up to this size.`,
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    const threadId = resolveRouteSessionFor(this, { bindingKey, workspaceRoot, lane: commandLane, normalized }).threadId;
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
    if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no pending approval request right now.",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
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
      ...outboundThreadIdField(normalized),
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
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    const currentModel = this.resolveWindowScopedRuntimeParam("model", {
      bindingKey, workspaceRoot, lane: commandLane, senderId: normalized.senderId,
    }).value;

    if (!query) {
      // Prefer a populated session catalog (e.g. codex); otherwise fall back to
      // the runtime's advertised models (claudecode surfaces its 3-model menu here).
      const suggestedModels = (catalog?.models?.length ? catalog.models : (this.runtimeAdapter.describe().models || []));
      // 同 /status：先说进程实际在跑的，配置值只在分叉时作为对照出现。
      const configuredHere = currentModel || this.runtimeAdapter.describe().model || "";
      const liveHere = normalizeText(this.liveLaunchByLane?.get(normalizeText(commandLane?.laneKey))?.model);
      const lines = [
        `Current model: ${liveHere || configuredHere || "(default)"}`,
      ];
      if (liveHere && liveHere !== configuredHere) {
        lines.push(`⚠️ 这是当前进程实际在跑的；配置里写的是 ${configuredHere || "(default)"}，下次重启按配置走`);
      }
      if (suggestedModels.length) {
        lines.push(`Available models: ${suggestedModels.map((item) => item.model).join(", ")}`);
      } else {
        lines.push("Available models: (not available)");
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const runtimeDescription = this.runtimeAdapter.describe();
    const runtimeId = runtimeDescription.id || "runtime";
    const sessionModels = Array.isArray(catalog?.models) ? catalog.models : [];
    const runtimeModels = Array.isArray(runtimeDescription.models) ? runtimeDescription.models : [];
    const matchingModels = sessionModels.length ? sessionModels : runtimeModels;
    let matched = require("../adapters/runtime/codex/model-catalog").findModelByQuery(matchingModels, query);
    if (!matched && runtimeId !== "codex" && !sessionModels.length && !runtimeModels.length) {
      matched = { model: query };
    }
    if (!matched) {
      const available = matchingModels.map((item) => {
        const aliases = Array.isArray(item?.aliases)
          ? item.aliases.map((alias) => normalizeCommandArgument(alias)).filter(Boolean)
          : [];
        return aliases.length
          ? `${item.model} (aliases: ${aliases.join(", ")})`
          : item.model;
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: [
          "❌ Model not found",
          query,
          ...(available.length ? [`Available models: ${available.join(", ")}`] : []),
        ].join("\n"),
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const windowResult = this.runtimeAdapter.setWindowOverride?.({
      bindingKey,
      workspaceRoot,
      lane: commandLane,
      launchProfile: this.resolveLaunchProfileForLane?.(commandLane) || null,
      senderId: normalized.senderId || "",
      patch: { model: matched.model, modelSource: "command", modelScope: "window" },
    });
    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    // 同时写回 profile：窗口覆盖按 slot 存，slot 一轮换就没了（Owner 08-06 设的
    // opus-4-6 正是这样悄悄掉回缺省的）。profile 才是启动时的真相源。
    const persisted = this.persistProfileRuntimeParam(commandLane, { model: matched.model });
    const restarted = await this.autoRestartLaneForRuntimeParam(commandLane, {
      bindingKey, workspaceRoot, senderId: normalized.senderId,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "✅ Model switched",
        windowResult?.applied ? "scope: window" : `workspace: ${workspaceRoot}`,
        `model: ${matched.model}`,
        ...describeProfilePersistence(persisted),
        ...(restarted ? ["🔄 进程已重启，下一条消息即用新模型"] : []),
      ].join("\n"),
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    });
  }

  // After /model or /effort, retire this lane's child so the change takes hold on
  // her next message without a manual /restart. Fail-open: a failed restart must
  // not fail the command -- the choice is already stored, and the normal
  // relaunch-on-change path still applies it on the next turn.
  async autoRestartLaneForRuntimeParam(commandLane, { bindingKey, workspaceRoot, senderId }) {
    try {
      if (typeof this.runtimeAdapter.restartLaneChild !== "function") {
        return null;
      }
      const runtimeParams = this.runtimeAdapter.getSessionStore()
        .getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      return await this.runtimeAdapter.restartLaneChild({
        bindingKey,
        workspaceRoot,
        lane: commandLane,
        launchProfile: this.resolveLaunchProfileForLane?.(commandLane) || null,
        senderId: senderId || "",
        model: runtimeParams.model,
        effort: runtimeParams.effort,
      });
    } catch (error) {
      console.warn(`[cyberboss] auto-restart after runtime param change skipped: ${error?.message || String(error)}`);
      return null;
    }
  }

  // 把 model/effort 落到该 lane 所属的 launch profile 上。失败只回报，不抛——
  // 命令本身已经把窗口覆盖设好了，写不进 profile 顶多是"重启后会掉"，
  // 不该让整条命令炸掉。
  persistProfileRuntimeParam(lane, patch) {
    try {
      const { persistProfileRuntimeParams } = require("../adapters/runtime/claudecode/profile-runtime-params");
      const profileId = normalizeText(this.resolveLaunchProfileForLane?.(lane)?.profileId);
      return persistProfileRuntimeParams({
        filePath: this.config?.claudeLaunchProfilesFile,
        profileId,
        patch,
      });
    } catch (error) {
      return { saved: false, reason: `persist_threw:${error?.message || "unknown"}` };
    }
  }

  async handleProfileCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    const requested = normalizeCommandArgument(command.args);
    const current = this.telegramProfileRouter.select(commandLane);

    if (!requested) {
      const routeSession = resolveRouteSessionFor(this, {
        bindingKey, workspaceRoot, lane: commandLane, normalized,
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: [
          `Current profile: ${current.profileId || "(unmapped)"}`,
          `effective source: ${current.effectiveSource || "mapping"}`,
          `scope: ${current.effectiveScope || "lane"}`,
          `window_id: ${routeSession.threadId || "(new on next turn)"}`,
        ].join("\n"),
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const switched = this.telegramProfileRouter.switchProfile(commandLane, requested);
    if (!switched || switched.status === "unknown_profile" || switched.status === "unmapped") {
      const retained = switched?.selection || current;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: [
          `❌ Profile not found: ${requested}`,
          `active profile: ${retained.profileId || "(unmapped)"}`,
          `effective source: ${retained.effectiveSource || "mapping"}`,
          `scope: ${retained.effectiveScope || "lane"}`,
        ].join("\n"),
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const effective = switched.selection;
    const routeSession = resolveRouteSessionFor(this, {
      bindingKey, workspaceRoot, lane: commandLane, normalized,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        switched.status === "unchanged" ? "✅ Profile already active" : "✅ Profile switched",
        `profile: ${effective.profileId}`,
        `effective source: ${effective.effectiveSource}`,
        `scope: ${effective.effectiveScope}`,
        `window_id: ${routeSession.threadId || "(new on next turn)"}`,
      ].join("\n"),
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
    });
  }

  /**
   * Inspect or switch the reasoning effort the Claude Code child is launched
   * with, for this binding's workspace only.
   *
   * Stored beside the binding's model in the same runtime-params record, so the
   * choice survives a restart. The next turn notices the change, retires this
   * slot's child and relaunches it with `--resume`, so the thread is kept.
   */
  async handleEffortCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const requested = normalizeCommandArgument(command.args);
    const commandLane = resolveRouteLaneFor(normalized, bindingKey);
    const launchProfile = this.resolveLaunchProfileForLane?.(commandLane) || null;

    if (!requested) {
      const resolvedEffort = this.resolveWindowScopedRuntimeParam("effort", {
        bindingKey, workspaceRoot, lane: commandLane, senderId: normalized.senderId,
      });
      const storedEffort = resolvedEffort.value;
      const envEffort = normalizeEffort(process.env.CYBERBOSS_CLAUDE_EFFORT);
      let source = "default";
      if (normalizeEffort(storedEffort)) {
        source = resolvedEffort.fromWindow ? "this window" : "this chat";
      } else if (envEffort) {
        source = "CYBERBOSS_CLAUDE_EFFORT";
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: [
          `Current effort: ${resolveEffortLevel(storedEffort)}`,
          `Source: ${source}`,
          `Available levels: ${EFFORT_VALUES.join(", ")} (default: ${DEFAULT_EFFORT})`,
        ].join("\n"),
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const matched = normalizeEffort(requested);
    if (!matched) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 Usage: /effort ${EFFORT_VALUES.join("|")}`,
        contextToken: normalized.contextToken,
        ...outboundThreadIdField(normalized),
      });
      return;
    }

    const windowResult = this.runtimeAdapter.setWindowOverride?.({
      bindingKey,
      workspaceRoot,
      lane: commandLane,
      launchProfile,
      senderId: normalized.senderId || "",
      patch: { effort: matched, effortSource: "command", effortScope: "window" },
    });
    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      effort: matched,
    });
    const persistedEffort = this.persistProfileRuntimeParam(commandLane, { effort: matched });
    const restarted = await this.autoRestartLaneForRuntimeParam(commandLane, {
      bindingKey, workspaceRoot, senderId: normalized.senderId,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "✅ Effort switched",
        windowResult?.applied ? "scope: window" : `workspace: ${workspaceRoot}`,
        `effort: ${matched}`,
        ...describeProfilePersistence(persistedEffort),
        ...(restarted ? ["🔄 进程已重启，下一条消息即用新档位"] : []),
      ].join("\n"),
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
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
      ...outboundThreadIdField(normalized),
    });
    await this.channelAdapter.sendFile({
      userId: normalized.senderId,
      filePath: path.join(__dirname, "../../assets/star-guide.jpg"),
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
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
          try {
            recordCanaryReceipt({
              stateDir: this.config.stateDir,
              text: normalized.text,
              updateId: update?.update_id,
              messageId: normalized.messageId,
              threadKey: normalized.threadKey,
            });
          } catch (error) {
            this.logTelegramDebug(`canary receipt write failed error=${error instanceof Error ? error.message : String(error)}`);
          }
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
      const mediaLog = (message) => this.logTelegramDebug(message);
      if (normalized?.telegram?.media && this.projectServices?.mediaInbox) {
        await this.projectServices.mediaInbox
          .processInboundMedia({ normalized, channelAdapter: this.telegramChannelAdapter, log: mediaLog })
          .catch((error) => {
            this.logTelegramDebug(`media inbound failed messageId=${normalized.messageId} error=${error instanceof Error ? error.message : String(error)}`);
          });
      }
      if (normalized?.telegram?.voice && this.projectServices?.voice) {
        await this.projectServices.voice
          .processInboundVoice({ normalized, log: mediaLog })
          .catch((error) => {
            this.logTelegramDebug(`voice inbound failed messageId=${normalized.messageId} error=${error instanceof Error ? error.message : String(error)}`);
          });
      }
      this.recordInboundMessage(normalized);
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

  async dispatchTelegramPreparedInbound({ bindingKey, workspaceRoot, prepared, lane = null, messageId = "" }) {
    const effectiveLane = lane || resolveRouteLaneFor(prepared, bindingKey);
    this.logTelegramDebug(`dispatchTelegramPreparedInbound messageId=${messageId} senderId=${prepared?.senderId || ""}`);
    // Never busy-wait here: this method runs inside the single poller loop, and
    // blocking it stalls getUpdates, reminders, and system-message flushes.
    // If a turn is already running, buffer the message; the runtime.turn.completed
    // handler flushes pending inbound messages (merging concurrent ones into a
    // single ordered batch) as soon as the previous turn finishes.
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot, { lane: effectiveLane })) {
      this.logTelegramDebug(`dispatch blocked, buffered messageId=${messageId}`);
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared, lane: effectiveLane });
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared, lane: effectiveLane });
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
    const baselineHelp = buildWeixinHelpText();
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: this.telegramProfileRouter?.isActivePointerEnabled?.()
        ? `${baselineHelp}\n/profile, /profile <profileId>`
        : baselineHelp,
      contextToken: normalized.contextToken,
      ...outboundThreadIdField(normalized),
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
      ...outboundThreadIdField(normalized),
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
      return rewritten.text;
    }
    const validation = validateDraftAgainstMemory(candidate, resolved);
    if (validation.ok) {
      return candidate;
    }
    console.warn(
      `[memory] blocked conflicting reply thread=${state.threadId} conflicts=${validation.conflicts.map((item) => item.key).join(",")}`
    );
    const fallback = "我先确认一下，免得我把前面的约定说反。";
    return fallback;
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  /**
   * Record the escalation origin for one turn. Bounded: a turn that never asks
   * for the wide face still leaves an entry, so the map is trimmed oldest-first
   * rather than allowed to grow for the process lifetime.
   */
  rememberRoute2Origin(turnId, origin) {
    const id = normalizeText(turnId);
    if (!id || !origin?.workspaceRoot) return;
    this.route2OriginByTurnId.set(id, origin);
    while (this.route2OriginByTurnId.size > MAX_ROUTE2_ORIGINS) {
      const oldest = this.route2OriginByTurnId.keys().next().value;
      if (oldest === undefined) break;
      this.route2OriginByTurnId.delete(oldest);
    }
  }

  async handleRuntimeEvent(event) {
    if (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed") {
      this.route2OriginByTurnId?.delete(normalizeText(event?.payload?.turnId));
    }
    if (this.route1DispatchController
      && (event?.type === "runtime.turn.completed" || event?.type === "runtime.turn.failed")) {
      // The claudecode adapter releases the foreground process/workspace hold
      // before emitting this event to app.js, so a queued worker can start now.
      this.route1DispatchController.releaseTurn(event?.payload?.turnId);
    }
    if (event?.type === "runtime.route2.cost") {
      await this.contextTraceRecorder.record({
        threadId: event.payload.threadId,
        turnId: event.payload.turnId,
        route2_cost: event.payload,
      });
      return;
    }
    if (event?.type === "runtime.context.updated") {
      this.desireUsageByRunKey.set(buildRunKey(event?.payload?.threadId, event?.payload?.turnId), event.payload);
    }
    if (event?.type === "runtime.process.launched") {
      await this.announceProcessLaunch(event.payload);
      return;
    }
    const failureReplyTarget = event?.type === "runtime.turn.failed"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event?.payload?.threadId,
          turnId: event?.payload?.turnId,
        })
      : null;
    if (event?.payload?.threadId) {
      const linkedForTrace = resolveEventRoute(this, event);
      const replyTargetForTrace = this.streamDelivery.resolveReplyTargetForRun({
        threadId: event?.payload?.threadId,
        turnId: event?.payload?.turnId,
      });    }
    await this.streamDelivery.handleRuntimeEvent(event);
    if (!event) {
      return;
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      await this.synchronizeRecallTrace(event.payload.threadId, event.payload.turnId);
      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      this.subjectCapabilityRegistry?.expireTurn?.(event.payload.turnId);
      this.subjectCapabilityByRunKey?.delete?.(completedRunKey);
      const deliveredHandoff = this.handoffDeliveryByRunKey?.get?.(completedRunKey) || null;
      this.handoffDeliveryByRunKey?.delete?.(completedRunKey);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      const usage = this.desireUsageByRunKey.get(completedRunKey) || {};
      this.desireUsageByRunKey.delete(completedRunKey);
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      if (event.type === "runtime.turn.completed") {
        this.handleCompletedRuntimeTurn(pendingOperation, event?.payload, deliveredHandoff);
      }
      if (pendingOperation?.kind === "desire_checkin") {
        const { appendDesireTelemetry } = require("./desire-telemetry");
        const linkedForTelemetry = resolveEventRoute(this, event);
        const model = linkedForTelemetry
          ? this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(linkedForTelemetry.bindingKey, linkedForTelemetry.workspaceRoot).model
          : "";
        appendDesireTelemetry({
          enabled: this.config.desireTelemetry,
          filePath: this.config.desireTelemetryFile,
          eventId: pendingOperation.eventId,
          model,
          reusedSession: pendingOperation.reusedSession,
          usage,
          durationMs: Date.now() - pendingOperation.startedAt,
          outcome: event.type === "runtime.turn.completed" ? "success" : "error",
        });
        this.releaseDesireMarker(pendingOperation);
      }
      const sessionStore = this.runtimeAdapter.getSessionStore();
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      // The runtime event is self-describing: it carries its own binding,
      // workspace, lane, slot and process, so nothing is inferred. The binding
      // reverse lookup only serves a pre-v2 event that predates those fields,
      // and it never supplies a lane.
      const eventLane = event?.payload?.laneKey ? { laneKey: event.payload.laneKey } : null;
      const linked = resolveEventRoute(this, event);
      const scopeKey = linked?.workspaceRoot
        ? routeScopeKeyFor(eventLane, linked.bindingKey, linked.workspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        if (event.payload.sessionSlotKey) {
          this.runtimeContextStore?.clearActiveTurn?.(event.payload.sessionSlotKey);
        }
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
            lane: eventLane,
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
            ...outboundThreadIdField(pendingOperation),
          }).catch(() => {});
        }
        const shouldKeepTyping = linked?.bindingKey && linked?.workspaceRoot
          ? (
            this.turnGateStore.isScopePending(scopeKey)
            || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot, eventLane)
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
    const linked = resolveEventRoute(this, event);
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
        threadId: event.payload.threadId,
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
        threadId: event.payload.threadId,
        approval: event.payload,
      }).catch(() => {});
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
  }

  async stopTypingForThread(threadId) {
    // Session-scoped first: the session id names exactly one lane, so the
    // typing indicator is cleared in the topic that raised it. The binding
    // lookup is only a fallback for pre-v2 sessions with no recorded lane.
    const target = (typeof this.streamDelivery?.resolveReplyTargetForRun === "function"
      ? this.streamDelivery.resolveReplyTargetForRun({ threadId })
      : null)
      || (() => {
        const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
        return linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
      })();
    if (!target) {
      return;
    }
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
      ...outboundThreadIdField({ provider: "telegram", messageThreadId: target.messageThreadId ?? null }),
    }).catch(() => {});
  }

  recordInboundMessage(normalized) {
    if (!this.conversationRecorder || !normalized) {
      return null;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const lane = resolveRouteLaneFor(normalized, bindingKey);
    const routeSession = resolveRouteSessionFor(this, {
      bindingKey, workspaceRoot, lane, normalized,
    });
    const recorded = this.conversationRecorder.record({
      type: "user",
      timestamp: normalizeIsoTime(normalized.receivedAt) || new Date().toISOString(),
      threadId: routeSession.threadId,
      workspaceRoot,
      route: buildRecorderRouteSnapshot({ bindingKey, lane, routeSession }),
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
    // Attached here, not at the call sites: the two inbound entry points are
    // per-channel (`handleIncomingMessage` for weixin, `handleTelegramMessage`
    // for telegram) and only the weixin one ever carried this block, so on the
    // channel that actually runs in production the provenance was never taken
    // and every subject turn died at `subject_source_entry_id_missing`.
    // Recording is the one step both entry points share.
    attachSubjectProvenance(this.config, normalized, recorded);
    return recorded;
  }

  recordRuntimeEvent(event) {
    if (!this.conversationRecorder || !event || typeof event !== "object") {
      return;
    }
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const threadId = normalizeText(payload.threadId);
    const eventRoute = resolveEventRoute(this, event);
    const workspaceRoot = normalizeText(payload.workspaceRoot)
      || normalizeText(eventRoute?.workspaceRoot);
    const subjectSigning = this.subjectCapabilityByRunKey?.get?.(
      buildRunKey(threadId, normalizeText(payload.turnId)),
    );
    this.conversationRecorder.record({
      type: String(event.type || "").trim(),
      timestamp: normalizeIsoTime(payload.timestamp) || new Date().toISOString(),
      threadId,
      turnId: normalizeText(payload.turnId),
      workspaceRoot,
      route: buildRecorderRouteSnapshot({
        bindingKey: eventRoute?.bindingKey,
        lane: eventRoute,
        routeSession: {
          ...eventRoute,
          threadId,
        },
      }),
      text: typeof payload.text === "string" ? payload.text : "",
      meta: subjectSigning?.subject_route
        ? { ...payload, subject_route: subjectSigning.subject_route }
        : payload,
    });
    if (event.type === "runtime.turn.started") {
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
    }
  }

  async sendFailureToThread(threadId, text, fallbackTarget = null) {
    // Session-scoped first, then the caller's explicit fallback. The binding
    // reverse lookup is last and only reaches a pre-v2 session.
    const target = normalizeReplyTarget(
      typeof this.streamDelivery?.resolveReplyTargetForRun === "function"
        ? this.streamDelivery.resolveReplyTargetForRun({ threadId })
        : null,
    )
      || normalizeReplyTarget(fallbackTarget)
      || normalizeReplyTarget((() => {
        const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
        return linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
      })());
    if (!target) {
      return;
    }
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: normalizeText(text) || "❌ Execution failed",
      contextToken: target.contextToken,
      ...outboundThreadIdField(target),
    }).catch(() => {});
  }

  async sendApprovalPrompt({ bindingKey, approval, threadId = "" }) {
    // Session-scoped target first: an approval prompt must appear in the topic
    // whose turn raised it, never in whichever topic the binding last replied
    // to. The binding target is only a fallback for a pre-v2 session.
    const target = (threadId && typeof this.streamDelivery?.resolveReplyTargetForRun === "function"
      ? this.streamDelivery.resolveReplyTargetForRun({ threadId })
      : null)
      || this.resolveReplyTargetForBinding(bindingKey);
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
      ...outboundThreadIdField(target),
    }).catch(() => {});
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: buildApprovalPromptText(approval),
      contextToken: target.contextToken,
      ...outboundThreadIdField(target),
      preserveBlock: true,
    });
    console.log(
      `[cyberboss] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  /**
   * Restore saved sessions at startup, one lane at a time.
   *
   * Iterates *session slots*, never bindings. Each slot carries its own route
   * descriptor, so the lane and its profile are rebuilt exactly as they were;
   * a slot whose descriptor cannot be rebuilt is skipped rather than restored
   * as a bare legacy process holding the binding's most recent session.
   */
  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();

    // Binding-level reply targets are still primed: they are a delivery
    // fallback for pre-v2 sessions, not a session authority.
    for (const binding of sessionStore.listBindings()) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }
      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }
    }

    if (typeof this.runtimeAdapter.listRestorableSlots !== "function") {
      return;
    }

    let skipped = 0;
    let superseded = 0;
    for (const slot of this.runtimeAdapter.listRestorableSlots()) {
      const lane = rebuildLaneFromDescriptor(slot.route);
      if (!lane) {
        skipped += 1;
        continue;
      }
      // Restore must relaunch with the binding's chosen model and effort.
      // Leaving them empty made every process restart fall back to the CLI's
      // default model -- a silent model swap mid-relationship.
      const runtimeParams = slot.route.bindingKey && slot.route.workspaceRoot
        ? sessionStore.getRuntimeParamsForWorkspace(slot.route.bindingKey, slot.route.workspaceRoot)
        : {};
      const restored = await this.runtimeAdapter.resumeSessionSlot({
        sessionSlotKey: slot.sessionSlotKey,
        lane,
        launchProfile: this.resolveLaunchProfileForLane?.(lane) || null,
        model: runtimeParams.model || "",
        effort: runtimeParams.effort || "",
        senderId: slot.route.laneKind === "tg" ? slot.route.chatId : "",
      }).catch(() => null);
      if (!restored?.resumed) {
        // A slot whose profile fingerprint no longer matches the lane's current
        // profile is history, not a failure: every profile change strands the
        // previous slot, and those pile up. Count them apart so the startup
        // warning only names slots that genuinely failed to restore.
        if (restored?.refused === "slot_mismatch") {
          superseded += 1;
        } else {
          skipped += 1;
        }
        continue;
      }
      // Re-arm the lane's reply target so a reply from a restored session lands
      // back in its own topic.
      if (slot.route.laneKind === "tg" && slot.route.chatId) {
        this.streamDelivery.setReplyTargetForThread?.(restored.threadId, {
          userId: slot.route.chatId,
          contextToken: `telegram:${slot.route.chatId}`,
          provider: "telegram",
          messageThreadId: slot.route.messageThreadId ?? null,
        });
      }
    }
    if (superseded) {
      console.log(`[cyberboss] left ${superseded} superseded session slot(s) dormant during startup restore (profile changed since they were recorded)`);
    }
    if (skipped) {
      console.warn(`[cyberboss] skipped ${skipped} session slot(s) during startup restore`);
    }
  }

  recordContextTrace(
    threadId,
    turnId,
    continuity = {},
    memoryContext = undefined,
    handoffTrace = undefined,
    route1NoticeTrace = undefined,
  ) {
    const context = continuity && typeof continuity === "object" ? continuity : {};
    // Fold the turn's memory-context outcome into the trace row, so the trace
    // explains memory_context the same way it explains reentry/current_state.
    // Callers that carry no turn (opening refresh) pass nothing and their rows
    // keep their existing shape.
    let blocks = context.blocks;
    let skipped = context.skipped;
    if (memoryContext && typeof memoryContext === "object") {
      blocks = Array.isArray(blocks) ? [...blocks] : [];
      skipped = Array.isArray(skipped) ? [...skipped] : [];
      const memoryLines = (Array.isArray(memoryContext.lines) ? memoryContext.lines : [])
        .filter((line) => typeof line === "string" && line.trim());
      const memoryMode = typeof memoryContext.mode === "string" ? memoryContext.mode.trim() : "";
      if (memoryLines.length) {
        blocks.push({
          type: "memory_context",
          loaded: true,
          reason: memoryMode || "resolved",
          chars: memoryLines.join("\n").length,
        });
      } else {
        skipped.push({ type: "memory_context", reason: memoryMode || "empty" });
      }
    }
    if (handoffTrace && typeof handoffTrace === "object") {
      blocks = Array.isArray(blocks) ? [...blocks] : [];
      blocks.push({
        type: "subject_memory_handoff",
        loaded: true,
        reason: "exact_route",
        handoff_id: normalizeText(handoffTrace.handoff_id),
        route_match: normalizeText(handoffTrace.route_match),
        chars: Math.max(0, Number(handoffTrace.chars) || 0),
        result: normalizeText(handoffTrace.result) || "injected",
      });
    }
    if (route1NoticeTrace && typeof route1NoticeTrace === "object") {
      blocks = Array.isArray(blocks) ? [...blocks] : [];
      blocks.push({
        type: "route1_completion_notice",
        loaded: true,
        reason: "exact_route",
        task_id: normalizeText(route1NoticeTrace.task_id),
        chars: Math.max(0, Number(route1NoticeTrace.chars) || 0),
        result: "injected",
      });
    }
    const ts = new Date().toISOString();
    const runKey = buildRunKey(threadId, turnId);
    if (runKey) this.contextTraceRunState.set(runKey, { ts });
    return this.contextTraceRecorder.record({
      ts,
      threadId,
      turnId,
      opening: context.opening === true,
      blocks,
      skipped,
      fallback: context.fallback,
      total_chars: context.total_chars,
      recall_calls: [],
      ...(context.window_override ? { window_override: context.window_override } : {}),
    });
  }

  async synchronizeRecallTrace(threadId, turnId) {
    const runKey = buildRunKey(threadId, turnId);
    const state = this.contextTraceRunState.get(runKey);
    if (!state) return false;
    this.contextTraceRunState.delete(runKey);
    const rows = readJsonlSafe(this.config.recallLogFile);
    const threadHash = hashThreadId(threadId);
    const startedAt = Date.parse(state.ts) || 0;
    const recallCalls = rows
      .filter((row) => row?.session === threadHash && row?.trigger === "user_pull" && (Date.parse(row.ts) || 0) > startedAt)
      .map((row) => ({ trigger: "user_pull", results_count: Array.isArray(row.hit_ids) ? row.hit_ids.length : 0 }));
    if (!recallCalls.length) return false;
    return await this.contextTraceRecorder.mergeRecallCalls({ threadId, turnId, recallCalls });
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
      const text = extractJsonObjectText(replyText);
      if (!text) { console.log(`[desire] handleSystemReplySent non-JSON text thread=${threadId}`); return; }
      const parsed = JSON.parse(text);
      const state = parsed?.desire_state;
      if (state && this.config.desireStateFile) {
        const drives = normalizeDesireDrives(state?.drives);
        const intent = normalizeDesireIntent(state?.intent);
        // Provenance for the history ledger: a checkin that ran on her live
        // chat thread (D44) is a different kind of row from one that ran in
        // the context-free solo window — the 520 panel shows which.
        let contextLane = "";
        const reportingThreadId = normalizeText(threadId);
        if (reportingThreadId) {
          try {
            const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(reportingThreadId);
            if (linked?.bindingKey && linked?.workspaceRoot) {
              const chatThreadId = normalizeText(
                this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(linked.bindingKey, linked.workspaceRoot),
              );
              contextLane = chatThreadId === reportingThreadId ? "chat" : "solo";
            } else {
              // A thread no binding mirror knows is by definition not her
              // chat thread: a solo/system window.
              contextLane = "solo";
            }
          } catch {
            contextLane = "";
          }
        }
        persistReportedDesireState({
          state: { ...state, drives, intent },
          stateFile: this.config.desireStateFile,
          historyFile: this.config.desireHistoryFile,
          contextLane,
        });
      }
      // 自主唤醒节奏：她在 checkin 里自填 next_wake_minutes（5–240），写入
      // override 时间戳，poller 下一分片读到就用它替换默认 cadence（替换而非
      // 叠加：她一旦排了节奏，原定的固定 55 分钟那一拍整条让位）。不填就照旧。
      if (state && this.config.desireWakeOverrideFile) {
        const nextWake = Math.round(Number(state?.next_wake_minutes));
        if (Number.isFinite(nextWake) && nextWake >= 5 && nextWake <= 240) {
          try {
            const { writeWakeOverride } = require("../app/hourly-desire-poller");
            writeWakeOverride(this.config.desireWakeOverrideFile, Date.now() + nextWake * 60_000);
            console.log(`[desire] next_wake set by her: ${nextWake}min`);
          } catch (error) {
            console.warn(`[desire] next_wake write failed: ${error?.message || String(error)}`);
          }
        }
      }
      this.maybeQueueConsolidationFromDesireReply(state);
    } catch {}
  }

  // 整理的**触发时机**并进八维菜单（Owner 2026-08-09 修订），但整理**本身**
  // 必须在独处窗口里做。八维这一轮跑在她的聊天 lane 上、看得见刚才的对话；
  // 带着它翻档案就是「情绪当场入账」，正是防漂移闸要挡的事。
  // 所以这里只把「她说想整理」转成一条 consolidation 排队消息——那条仍走
  // system lane，没有聊天上下文。
  maybeQueueConsolidationFromDesireReply(state) {
    if (state?.want_consolidation !== true) return { queued: false, reason: "not_requested" };
    const targets = this.automationTargets;
    if (!this.systemMessageQueue || !targets?.accountId || !targets?.senderId || !targets?.workspaceRoot) {
      return { queued: false, reason: "target_unavailable" };
    }
    if (this.systemMessageQueue.hasPendingForAccount(targets.accountId, {
      shouldInclude: (message) => message?.sourceType === "consolidation",
    })) {
      return { queued: false, reason: "overlap" };
    }
    const id = `desire-consolidation:${crypto.randomUUID()}`;
    this.systemMessageQueue.enqueue({
      id,
      accountId: targets.accountId,
      senderId: targets.senderId,
      workspaceRoot: targets.workspaceRoot,
      text: DESIRE_CONSOLIDATION_TEXT,
      sourceType: "consolidation",
      createdAt: new Date().toISOString(),
    });
    console.log(`[desire] consolidation requested from checkin, queued id=${id}`);
    return { queued: true, id };
  }

  handleCompletedRuntimeTurn(pendingOperation, payload = {}, deliveredHandoff = null) {
    // Ack recording is fail-open and order-independent from desire settlement,
    // so it must not force this long-standing synchronous contract to async:
    // callers (and their tests) settle desire state in the same tick.
    try {
      const ackRecording = this.recordHandoffAckFromTurnFailOpen?.(payload, deliveredHandoff);
      if (typeof ackRecording?.catch === "function") ackRecording.catch(() => {});
    } catch {}
    const saveResult = this.maybeSaveDesireStateFromTurnText(payload?.text || "");
    if (this.config?.desireLoopMinimalEnabled === true && saveResult?.ok === false) {
      console.error(`[desire] skip loop settlement after invalid desire report thread=${normalizeText(payload?.threadId) || threadIdOrUnknown(payload)} turn=${normalizeText(payload?.turnId) || ""} textLength=${String(payload?.text || "").length}`);
      return;
    }
    try {
      this.maybeCloseDesireLoopForPendingOperation(pendingOperation, payload);
    } catch (error) {
      console.error(`[desire] loop settlement failed thread=${normalizeText(payload?.threadId) || threadIdOrUnknown(payload)} turn=${normalizeText(payload?.turnId) || ""} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async recordHandoffAckFromTurnFailOpen(payload = {}, deliveredHandoff = null) {
    if (!this.handoffAckLedger || !deliveredHandoff) return null;
    const ack = parseSubjectMemoryHandoffAck(payload?.text || "");
    if (!ack) return null;
    try {
      return this.handoffAckLedger.record({
        ack,
        expectedDelivery: deliveredHandoff,
        subjectTurnId: payload?.turnId,
      });
    } catch (error) {
      console.warn(`[continuity] handoff ack skipped: ${error?.message || String(error)}`);
      return null;
    }
  }

  maybeCloseDesireLoopForPendingOperation(pendingOperation, payload = {}) {
    if (!pendingOperation || pendingOperation.kind !== "system_desire") {
      return null;
    }
    if (this.config?.desireLoopMinimalEnabled !== true) {
      return null;
    }
    if (pendingOperation.drivenBehaviorEnabled !== true) {
      return null;
    }
    const runtimeId = normalizeText(this.runtimeAdapter?.describe?.().id)
      || normalizeText(this.streamDelivery?.systemReplyPolicy?.runtimeId);
    const delivery = resolveSystemReplyDelivery(payload?.text || "", createSystemReplyPolicy(runtimeId));
    if (delivery?.kind !== "send_message") {
      return null;
    }
    const action = normalizeText(pendingOperation.wantAction);
    if (!action || action === "none") {
      return null;
    }
    const availableActions = resolveDesireAvailableActionsSafe(this);
    if (!availableActions.includes(action)) {
      return null;
    }
    const desireService = this.desireService || this.createDesireService?.() || null;
    if (!desireService || typeof desireService.markSatisfied !== "function") {
      return null;
    }
    hydrateDesireServiceFromReportedState(desireService, pendingOperation.reportedState);
    let result = desireService.markSatisfied(action, { availableActions, persist: false });
    if (shouldPulseSelfExperienceForAction(action) && typeof desireService.pulseSelfExperience === "function") {
      const driveKey = normalizeText(pendingOperation.driveKey) || sourceDriveKeyForAction(action);
      if (driveKey) {
        result = desireService.pulseSelfExperience({ driveKey, availableActions, persist: false });
      }
    }
    const reportedState = buildReportedDesireStateFromSnapshot(result, pendingOperation.reportedState);
    // Settlement is bookkeeping, not a report: it may rewrite the state file
    // but never appends to desire-history.jsonl (Owner ruling 2026-07-29).
    const persistResult = persistReportedDesireState({
      state: reportedState,
      stateFile: this.config.desireStateFile,
      appendHistory: false,
    });
    if (persistResult?.saved !== true && persistResult?.reason !== "duplicate_report") {
      throw new Error(`persist_reported_state_failed:${persistResult?.reason || "unknown"}`);
    }
    return result;
  }

  releaseDesireMarker(pendingOperation) {
    if (!pendingOperation?.markerOwner || !pendingOperation?.markerEventId) return;
    try {
      const { releaseActiveMarker } = require("../app/hourly-desire-poller");
      releaseActiveMarker(this.config.desireActiveFile, {
        owner: pendingOperation.markerOwner,
        eventId: pendingOperation.markerEventId,
      });
    } catch {}
  }

  maybeSaveDesireStateFromTurnText(text) {
    if (!text || !this.config.desireStateFile) return { ok: true, saved: false, reason: "empty_text" };
    try {
      const trimmed = extractJsonObjectText(text);
      if (!trimmed) return { ok: true, saved: false, reason: "no_json" };
      const parsed = JSON.parse(trimmed);
      const state = parsed?.desire_state;
      if (!state || !Array.isArray(state?.drives)) return { ok: true, saved: false, reason: "no_desire_state" };
      const drives = normalizeDesireDrives(state.drives);
      const intent = normalizeDesireIntent(state?.intent);
      const result = persistReportedDesireState({
        state: { ...state, drives, intent },
        stateFile: this.config.desireStateFile,
        historyFile: this.config.desireHistoryFile,
      });
      return { ok: true, ...result };
    } catch {
      return {
        ok: false,
        reason: "invalid_desire_json",
      };
    }
  }
}

// 与 subject-beat-scheduler 的 consolidation 节拍同一句话：不管是定时敲门
// 还是她自己从八维菜单里要的，进到那个安静窗口时看到的开场都一样。
const DESIRE_CONSOLIDATION_TEXT = "到整理节拍了。";

const DRIVE_KEY_ALIASES = {
  responsibility: "duty",
  sexuality: "libido",
};
const DRIVE_LABELS = {
  attachment: "依恋",
  curiosity: "好奇",
  reflection: "沉思",
  duty: "责任",
  social: "社交",
  fatigue: "疲惫",
  libido: "性欲",
  stress: "压力",
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

// The authoritative `source_ref` for a subject candidate submitted during this
// turn. A subject turn cites exactly one source entry — the inbound message the
// recorder just wrote — so the content hash over "the cited lines joined by
// newline" collapses to that single line's digest, which is what Review
// recomputes in `locateSourceEntriesById`. Returns null when the recorder gave
// us no evidence; the broker then fails the submit rather than inventing
// provenance.
function buildSubjectSourceRef({ sourceEntryId, evidence } = {}) {
  const entryId = normalizeText(sourceEntryId);
  const file = normalizeText(evidence?.file);
  const sha256 = normalizeText(evidence?.sha256);
  if (!entryId || !file || !/^[0-9a-f]{64}$/u.test(sha256)) return null;
  return {
    file,
    source_entry_ids: [entryId],
    source_entry_hashes: [{ entry_id: entryId, sha256 }],
    content_sha256: sha256,
  };
}

// Desire 八维报告经常被模型包在 ```json fence 或 "json:" 前缀里；
// 以前直接 startsWith("{") 判定会把这些合法报告全部丢掉，
// 导致 desire-state / desire-history 长期只有零星数据。
function extractJsonObjectText(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const unfenced = normalized
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim()
    .replace(/^json\s*:\s*/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return "";
  return unfenced.slice(start, end + 1);
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

function buildPendingSystemDesireOperation(app, message, desireState) {
  const availableActions = resolveDesireAvailableActionsSafe(app);
  let intent = {};
  const desireService = app?.desireService || app?.createDesireService?.() || null;
  if (desireService && typeof desireService.getState === "function") {
    hydrateDesireServiceFromReportedState(desireService, desireState);
    const snapshot = desireService.getState({ availableActions });
    intent = snapshot?.intent && typeof snapshot.intent === "object" ? snapshot.intent : {};
  } else if (desireState?.intent && typeof desireState.intent === "object") {
    intent = desireState.intent;
  }
  return {
    kind: "system_desire",
    sourceType: normalizeText(message?.sourceType) || "system",
    drivenBehaviorEnabled: app?.config?.desireDriven === true,
    driveKey: normalizeText(intent.drive_key) || "attachment",
    wantAction: normalizeText(intent.want_action) || "none",
    reportedState: desireState && typeof desireState === "object" ? desireState : null,
  };
}

function hydrateDesireServiceFromReportedState(desireService, reportedState) {
  if (!desireService || !reportedState || typeof reportedState !== "object") {
    return;
  }
  const drives = Array.isArray(reportedState.drives) ? reportedState.drives : [];
  for (const drive of drives) {
    const key = normalizeText(drive?.key);
    if (!VALID_DRIVE_KEYS.has(key)) {
      continue;
    }
    desireService.state.drive[key] = clampDriveScore(drive?.score);
  }
}

function buildReportedDesireStateFromSnapshot(snapshot, previousState) {
  const previousByKey = new Map(
    (Array.isArray(previousState?.drives) ? previousState.drives : [])
      .map((drive) => [normalizeText(drive?.key), drive]),
  );
  const drives = Object.keys(DRIVE_LABELS).map((key) => {
    const score = clampDriveScore(snapshot?.drive?.[key]);
    const previous = previousByKey.get(key);
    return {
      ...(previous || {
        label: DRIVE_LABELS[key],
        change: "steady",
        cause: "",
      }),
      key,
      score,
    };
  });
  return {
    most_want: normalizeText(previousState?.most_want),
    drives,
    intent: snapshot?.intent && typeof snapshot.intent === "object"
      ? {
          drive_key: normalizeText(snapshot.intent.drive_key),
          want_action: normalizeText(snapshot.intent.want_action),
          reason: normalizeText(snapshot.intent.reason),
        }
      : null,
    heartbeat: snapshot?.heartbeat && typeof snapshot.heartbeat === "object"
      ? { tension: Number(snapshot.heartbeat.tension) || 0 }
      : null,
    refractory: snapshot?.refractory && typeof snapshot.refractory === "object"
      ? snapshot.refractory
      : null,
    driven_behavior_enabled: snapshot?.driven_behavior_enabled === true,
  };
}

function clampDriveScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function threadIdOrUnknown(payload) {
  return normalizeText(payload?.threadId) || "(unknown)";
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

// /status thread status, rendered as "<token> · <人话>". The raw token is kept so
// the line stays greppable and matches ThreadStateStore's vocabulary; the gloss is
// there because "idle" read as a comment on the Owner rather than on the lane
// (2026-08-06 Owner report). Unknown tokens pass through untranslated rather than
// being flattened into a wrong gloss.
const THREAD_STATUS_GLOSS = {
  idle: "空闲",
  running: "运行中",
  waiting_approval: "等你批准",
  failed: "上一轮失败",
};

// The status line carries its own state as the icon, so the state is legible
// before the words are read. Unknown tokens keep the neutral one.
const THREAD_STATUS_ICON = {
  idle: "💤",
  running: "🟢",
  waiting_approval: "✋",
  failed: "❌",
};

function describeThreadStatus(status) {
  const token = typeof status === "string" ? status.trim() : "";
  if (!token) {
    return `idle · ${THREAD_STATUS_GLOSS.idle}`;
  }
  const gloss = THREAD_STATUS_GLOSS[token];
  return gloss ? `${token} · ${gloss}` : token;
}

function threadStatusIcon(status) {
  const token = typeof status === "string" ? status.trim() : "";
  return THREAD_STATUS_ICON[token || "idle"] || "📊";
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

// The model-facing Telegram envelope.
//
// Plaintext, and deliberately so: this is the format the deployed bridge has
// always spoken. Wrapping the same message in base64url made a 23-character
// Chinese line arrive as 423 characters, obliged the model to decode every turn,
// and was explained by no prompt material anywhere in the project -- a cost paid
// on every message for a boundary that the escaping below already holds.
//
// Attachments are a separate matter and stay hardened: only state-media
// references that resolve under the authoritative media root are emitted, and an
// absolute path never reaches the model.
function formatTelegramRuntimeText(prepared, { stateDir = "", memoryContext = null } = {}) {
  const chatId = normalizeText(prepared?.chatId || prepared?.telegram?.chatId);
  const messageId = normalizeText(prepared?.messageId || prepared?.telegram?.messageId);
  const userId = normalizeText(prepared?.senderId || prepared?.telegram?.userId);
  const username = normalizeText(prepared?.telegram?.username);
  const sentAt = normalizeText(prepared?.receivedAt);
  // sent_at is UTC; add a Sydney-local twin so a clockless reader can't misread it.
  const sentAtLocal = sentAt ? formatAppShortLocal(sentAt) : "";
  const body = escapeTelegramChannelBody(String(prepared?.originalText || prepared?.text || "").trim());
  const mediaLines = buildTelegramMediaBridgeLines(prepared?.attachments, stateDir);
  const visionContextLines = buildTelegramAttachmentVisionContextLines(prepared?.attachmentVisionContexts);
  const openTag = [
    '<channel source="telegram"',
    chatId ? `chat_id="${escapeXmlAttribute(chatId)}"` : "",
    messageId ? `message_id="${escapeXmlAttribute(messageId)}"` : "",
    userId ? `user_id="${escapeXmlAttribute(userId)}"` : "",
    username ? `username="${escapeXmlAttribute(username)}"` : "",
    sentAt ? `sent_at="${escapeXmlAttribute(sentAt)}"` : "",
    sentAtLocal ? `sent_at_local="${escapeXmlAttribute(sentAtLocal)}"` : "",
  ].filter(Boolean).join(" ") + ">";
  return [
    ...buildTelegramMemoryContextLines(memoryContext),
    ...visionContextLines,
    openTag,
    body,
    ...mediaLines,
    "</channel>",
  ].join("\n");
}

// Memory context rides above the envelope, never inside it: the <channel>
// block stays byte-for-byte what the deployed bridge speaks (DECISIONS.md D9),
// and what the user typed is never interleaved with what the bridge
// remembered. No memory means no block at all -- the payload is then identical
// to the pre-memory format.
function buildTelegramMemoryContextLines(memoryContext) {
  const lines = (Array.isArray(memoryContext?.lines) ? memoryContext.lines : [])
    .map((line) => normalizeText(line))
    .filter(Boolean);
  if (!lines.length) return [];
  return [
    "<memory_context>",
    ...lines.map((line) => `- ${escapeMemoryContextLine(line)}`),
    "</memory_context>",
  ];
}

// One memory = one line, and a hostile stored line cannot close the block
// early. Mirrors escapeTelegramChannelBody: only the sequence that would end
// the block is touched.
function escapeMemoryContextLine(value) {
  return String(value || "")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/<(\/memory_context\s*)>/gi, "&lt;$1&gt;");
}

function buildTelegramAttachmentVisionContextLines(value) {
  const blocks = Array.isArray(value) ? value.slice(0, 10) : [];
  const lines = [];
  let remainingChars = 12_000;
  for (const block of blocks) {
    const text = String(block || "").trim();
    if (!text || text.length > 6_000 || text.length > remainingChars) continue;
    if (!/^<attachment_vision_context provider="(?:cmx-recognize|qwen-vision)" trust="untrusted" (?:state="[a-z0-9_-]+"|model="[A-Za-z0-9._-]+")>\n[\s\S]*\n<\/attachment_vision_context>$/.test(text)) continue;
    lines.push(...text.split(/\r?\n/));
    remainingChars -= text.length;
  }
  return lines;
}

function buildTelegramMediaBridgeLines(attachments, stateDir) {
  if (!Array.isArray(attachments) || !normalizeText(stateDir)) return [];
  return attachments.flatMap((attachment) => {
    const reference = normalizeText(attachment?.stateMediaRef);
    if (!reference || !resolveStateMediaReference(stateDir, reference)) return [];
    const kind = normalizeText(attachment.kind || attachment.type) || "file";
    const contentType = normalizeText(attachment.contentType);
    const fileName = normalizeText(attachment.fileName);
    return [[
      `<media kind="${escapeXmlAttribute(kind)}"`,
      contentType ? ` content_type="${escapeXmlAttribute(contentType)}"` : "",
      fileName ? ` file_name="${escapeXmlAttribute(fileName)}"` : "",
      ` reference="${escapeXmlAttribute(reference)}" />`,
    ].join("")];
  });
}

// The one sequence that could end the envelope early and turn the rest of a
// user's message into bridge markup. Nothing else is touched: the point of the
// plaintext envelope is that what the user typed is what the model reads.
function escapeTelegramChannelBody(value) {
  return String(value || "").replace(/<(\/channel\s*)>/gi, "&lt;$1&gt;");
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

module.exports = { CyberbossApp, createRuntimeAdapter, buildSubjectSourceRef };

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

// Parse `/sl_save <档名> 末句：「…」 [首句：「…」] [备注：…] [引导：…]`.
// `command.args` has already collapsed internal whitespace to single spaces, so
// values are single-line; each labeled field runs from its `：` to the next
// known label (or end). Chinese or ASCII colons and 「」/quote wrappers accepted.
const SL_FIELD_LABEL = /(末句|首句|备注|引导|end|start|note|guide)\s*[：:]/;

function parseSlSaveArgs(args) {
  const text = String(args || "").trim();
  if (!text) return { name: "", fields: {} };
  // The name is everything up to the first field label, so it may contain spaces
  // and punctuation (deriveSlName sanitizes it later). When the text starts with a
  // field label there is simply no name -- the name auto-derives from the anchor.
  let name = "";
  let rest = text;
  const labelAt = text.search(SL_FIELD_LABEL);
  if (labelAt > 0) {
    name = text.slice(0, labelAt).trim();
    rest = text.slice(labelAt);
  } else if (labelAt < 0) {
    // No field label at all: the whole thing is the name (end anchor missing).
    name = text;
    rest = "";
  }
  const fields = {};
  const labelRe = /(末句|首句|备注|引导|end|start|note|guide)\s*[：:]\s*/g;
  const marks = [];
  let match;
  while ((match = labelRe.exec(rest)) !== null) {
    marks.push({ key: canonicalSlField(match[1]), labelStart: match.index, valueStart: labelRe.lastIndex });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const stop = i + 1 < marks.length ? marks[i + 1].labelStart : rest.length;
    const value = rest.slice(marks[i].valueStart, stop).trim().replace(/^[「"']|[」"']$/g, "").trim();
    if (value && !fields[marks[i].key]) fields[marks[i].key] = value;
  }
  return { name, fields };
}

// Turn whatever she typed for the archive name into one the filename layer will
// accept (word chars + CJK, <=40), instead of rejecting her outright. Angle
// brackets, quotes, spaces and punctuation are stripped rather than refused. When
// nothing usable remains -- she gave no name, or only symbols -- the name derives
// from the end anchor's first words, so /sl_save never fails on the name alone.
function deriveSlName(rawName, endAnchor, fallback = "存档") {
  const clean = (value) => String(value || "").replace(/[^\w一-鿿]+/gu, "").slice(0, 40);
  return clean(rawName) || clean(endAnchor).slice(0, 16) || clean(fallback) || "存档";
}

function canonicalSlField(label) {
  switch (label) {
    case "末句":
    case "end":
      return "end";
    case "首句":
    case "start":
      return "start";
    case "备注":
    case "note":
      return "note";
    case "引导":
    case "guide":
      return "guide";
    default:
      return label;
  }
}

// Parse `/sl_load <档名> [备注：…]`. First token is the archive name (sl_id, 短名,
// or file stem); an optional 备注/note runs to the end.
function parseSlLoadArgs(args) {
  const text = String(args || "").trim();
  const head = text.match(/^(\S+)\s*([\s\S]*)$/);
  if (!head) return { name: "", note: "" };
  const noteMatch = /(备注|note)\s*[：:]\s*([\s\S]*)$/.exec(head[2]);
  return { name: head[1], note: noteMatch ? noteMatch[2].trim() : "" };
}

function buildSlLoadInjection(loaded, nextRead) {
  const parts = [
    `【SL 读档 · ${loaded.slId}（第 ${nextRead} 次读档）】`,
    "这是一次回档：下面是一段被存起来的历史对话，不是此刻新发生的事。先读「给读档的你」，再看段落原文，然后按存档的引导指令接着走。",
    "",
    loaded.informedHeader,
    "",
    QUOTE_BEGIN,
    loaded.quoteBlock,
    QUOTE_END,
  ];
  const guide = loaded.frontmatter && loaded.frontmatter["引导指令"];
  if (guide) parts.push("", `引导指令：${guide}`);
  return parts.join("\n");
}

function slLoadErrorText(result) {
  switch (result?.error) {
    case "sl-dir-unset":
      return "❌ SL 存档没配置（CYBERBOSS_SL_DIR 未设）。";
    case "name-missing":
      return "❌ 少了档名。/sl_load <档名>";
    case "not-found":
      return "❌ 没找到这个存档。/sl_list 看有哪些档。";
    case "ambiguous-name":
      return `❌ 档名不唯一，命中多个：${(result.matches || []).join("、")}。用完整 sl_id 再试。`;
    case "read-failed":
      return "❌ 存档文件读不出来。";
    case "sl-dir-unreadable":
      return "❌ 存档目录读不到。";
    default:
      return `❌ 读档失败：${result?.error || "未知原因"}。`;
  }
}

function slSaveErrorText(result) {
  switch (result?.error) {
    case "sl-dir-unset":
      return "❌ SL 存档没配置（CYBERBOSS_SL_DIR 未设）。";
    case "conversations-dir-unset":
      return "❌ 06-raw 目录没配置，定位不了对话。";
    case "bad-name":
      return "❌ 档名只能用中英文、数字、下划线（≤40 字）。";
    case "end-anchor-missing":
      return "❌ 少了末句。/sl_save <档名> 末句：「原话」";
    case "no-rows":
      return "❌ 最近几天没找到对话记录。";
    case "end-anchor-not-found":
      return "❌ 末句没在最近对话里找到。换成那句里更独特的几个字，或加「首句」缩小范围。";
    case "start-anchor-not-found":
      return "❌ 首句没在末句之前找到。检查一下首句原话。";
    case "duplicate-id":
      return `❌ 已经有同名存档 ${result.slId || ""} 了，换个档名。`;
    default:
      return `❌ 存档失败：${result?.error || "未知原因"}。`;
  }
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

function readManualMemoryContextLines(filePath = "") {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) return [];
  try {
    const content = fs.readFileSync(normalizedPath, "utf8").trim();
    if (!content) return [];
    return dedupeMemoryContextLines(content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)).slice(0, 30);
  } catch {
    return [];
  }
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

/**
 * The session/slot/process the *current* route owns.
 *
 * Every command, approval and status reply resolves through here. It never
 * falls back to the binding's most recent session: on a runtime with no
 * lane-aware surface (codex) it degrades to the binding lookup explicitly, and
 * on claudecode a lane with no session simply reports none.
 *
 * Module-level so class methods can be borrowed onto lightweight objects.
 */
function resolveRouteSessionFor(app, { bindingKey, workspaceRoot, lane = null, normalized = null } = {}) {
  const effectiveLane = lane || (normalized ? resolveRouteLaneFor(normalized, bindingKey) : null);
  if (typeof app.runtimeAdapter?.resolveRouteSession === "function") {
    return app.runtimeAdapter.resolveRouteSession({
      bindingKey,
      workspaceRoot,
      lane: effectiveLane,
      launchProfile: app.resolveLaunchProfileForLane?.(effectiveLane) || null,
      senderId: normalized?.senderId || "",
    });
  }
  return {
    sessionSlotKey: "",
    laneKey: effectiveLane?.laneKey || "",
    messageThreadId: effectiveLane?.messageThreadId ?? null,
    threadId: app.runtimeAdapter?.getSessionStore?.().getThreadIdForWorkspace?.(bindingKey, workspaceRoot) || "",
    processKey: "",
    processAlive: false,
    profileId: "legacy",
  };
}

function resolveTelegramLaneForSystemMessage(app, bindingKey, workspaceRoot) {
  if (app.config?.channel !== "telegram") return null;
  try {
    const listed = typeof app.runtimeAdapter?.listRestorableSlots === "function"
      ? app.runtimeAdapter.listRestorableSlots()
      : [];
    const slots = Array.isArray(listed) ? listed : [];
    const slot = slots.find((item) => item?.route?.bindingKey === bindingKey && item?.route?.workspaceRoot === workspaceRoot && item?.route?.laneKind === "tg");
    return slot ? rebuildLaneFromDescriptor(slot.route) : null;
  } catch {
    return null;
  }
}

// Route identity for a runtime event.
//
// v2 events carry bindingKey / workspaceRoot / laneKey / sessionSlotKey /
// processKey / messageThreadId directly, so nothing has to be inferred. The
// binding reverse lookup below only serves an event emitted before those fields
// existed (a session restored from pre-v2 state), and it never supplies a lane.
function resolveEventRoute(app, event) {
  const payload = event?.payload || {};
  if (payload.bindingKey && payload.workspaceRoot) {
    return {
      bindingKey: payload.bindingKey,
      workspaceRoot: payload.workspaceRoot,
      laneKey: payload.laneKey || "",
      sessionSlotKey: payload.sessionSlotKey || "",
      processKey: payload.processKey || "",
      messageThreadId: payload.messageThreadId ?? null,
      profileId: payload.profileId || "",
    };
  }
  const linked = app.runtimeAdapter.getSessionStore().findBindingForThreadId(payload.threadId);
  return linked?.bindingKey ? { ...linked, laneKey: "", sessionSlotKey: "", processKey: "" } : null;
}

// The active runtime context for a turn in flight. Module-level for the same
// reason as `attachSubjectProvenance` below: `dispatchPreparedTurn` is driven
// by fixtures that assemble a plain object carrying only the prototype methods
// they need, so a `this.`-method dependency added here fails those turns
// outright rather than visibly.
//
// Built in one place because two callers now write it -- the pre-write seam and
// the post-send registration -- and a drift between them would hand the signing
// broker two different views of the same turn.
function buildActiveContextPayload({
  runtimeId = "",
  includeTurnId = false,
  bindingKey = "",
  workspaceRoot = "",
  prepared = {},
  lane = null,
  messageThreadId,
  turn = {},
} = {}) {
  return {
    workspaceRoot,
    runtimeId,
    threadId: turn.threadId,
    bindingKey,
    accountId: prepared.accountId,
    senderId: prepared.senderId,
    provider: prepared.provider,
    chatId: prepared.chatId || prepared.telegram?.chatId || "",
    messageThreadId,
    // Keyed per session slot, so two topics running at once each read back
    // their own outbound target instead of a workspace singleton.
    routeToken: turn.routeToken || turn.sessionSlotKey || "",
    laneKey: turn.laneKey || lane?.laneKey || "",
    processKey: turn.processKey || "",
    ...(includeTurnId && turn.turnId ? { turnId: turn.turnId } : {}),
  };
}

// Subject provenance for the turn being recorded. A module-level function
// rather than a method: the inbound recorder is exercised by fixtures that call
// `CyberbossApp.prototype.recordInboundMessage` against a plain stub, and a
// `this.`-method dependency would make every one of those fixtures grow a
// method it does not otherwise need.
function attachSubjectProvenance(config, normalized, recorded) {
  if (config?.subjectSigningEnabled !== true || !normalized || !recorded?.id) {
    return normalized;
  }
  Object.defineProperty(normalized, "subjectSourceEntryId", {
    value: recorded.id,
    enumerable: false,
    configurable: true,
  });
  // The provenance of a subject candidate is what the recorder just wrote,
  // not what the model says it is. Capturing it here — where the file and
  // the exact bytes are known — is what lets `memory_candidate_submit`
  // drop `source_ref` from its input schema entirely.
  Object.defineProperty(normalized, "subjectSourceEvidence", {
    value: recorded.sourceFile && recorded.sourceLineSha256
      ? { file: recorded.sourceFile, sha256: recorded.sourceLineSha256 }
      : null,
    enumerable: false,
    configurable: true,
  });
  return normalized;
}

function buildRecorderRouteSnapshot({ bindingKey = "", lane = null, routeSession = null } = {}) {
  const session = routeSession && typeof routeSession === "object" ? routeSession : {};
  const route = {
    bindingKey,
    laneKey: session.laneKey || lane?.laneKey,
    sessionSlotKey: session.sessionSlotKey,
    profileId: session.profileId,
    windowId: windowIdFromNativeSessionId(session.threadId),
  };
  if (Object.hasOwn(session, "messageThreadId")) {
    route.messageThreadId = session.messageThreadId;
  } else if (lane && Object.hasOwn(lane, "messageThreadId")) {
    route.messageThreadId = lane.messageThreadId;
  }
  return route;
}

function buildCurrentSubjectRouteIdentity({
  app,
  bindingKey = "",
  prepared = null,
  lane = null,
  routeSession = null,
} = {}) {
  const session = routeSession && typeof routeSession === "object" ? routeSession : {};
  const runtimeId = normalizeText(app?.runtimeAdapter?.describe?.().id);
  const nativeThreadId = normalizeText(session.threadId);
  const messageThreadId = Object.hasOwn(session, "messageThreadId")
    ? session.messageThreadId
    : (lane?.messageThreadId ?? prepared?.messageThreadId ?? prepared?.telegram?.messageThreadId ?? null);
  return {
    provider: normalizeText(prepared?.provider),
    continuity_binding: {
      workspace_id: normalizeText(prepared?.workspaceId),
      account_id: normalizeText(prepared?.accountId),
      sender_id: normalizeText(prepared?.senderId),
      binding_key: normalizeText(bindingKey),
    },
    route_lane: {
      lane_key: normalizeText(session.laneKey || lane?.laneKey),
      chat_id: normalizeText(lane?.chatId || prepared?.chatId || prepared?.telegram?.chatId),
      message_thread_id: messageThreadId === null || messageThreadId === undefined
        ? null
        : normalizeText(String(messageThreadId)),
    },
    session: {
      runtime_id: runtimeId,
      session_slot_key: normalizeText(session.sessionSlotKey),
      runtime_thread_id: nativeThreadId,
      profile_id: normalizeText(session.profileId),
      profile_fingerprint: normalizeText(session.profileFingerprint),
      window_id: windowIdFromNativeSessionId(nativeThreadId),
    },
  };
}

function handoffLeaseDetails(config = {}) {
  return {
    model: config.runtime === "claudecode"
      ? normalizeText(config.claudeModel) || "configured-claude"
      : normalizeText(config.codexModel) || "configured-codex",
    phase: "g2-5",
    branch: normalizeText(config.continuityBranch) || "runtime",
    worktree: normalizeText(config.continuityWorktree)
      || normalizeText(config.workspaceRoot)
      || normalizeText(config.continuityDir)
      || "runtime",
    base_sha: normalizeText(config.continuityBaseSha) || "0".repeat(40),
  };
}

// Module-level so the class methods can be borrowed onto lightweight objects
// (as the test-suite does) without dragging the whole app in.
function resolveRouteLaneFor(message, bindingKey) {
  try {
    return resolveInboundRouteLane(message, { bindingKey })
      || buildLegacyRouteLane({ provider: message?.provider, bindingKey });
  } catch {
    // A Telegram message whose ids are present but non-canonical must not be
    // routed on a guess. The channel adapter already drops these; this is the
    // second line of defence for internally constructed messages.
    return buildLegacyRouteLane({ provider: message?.provider, bindingKey });
  }
}

// Turn gate / pending buffer / debounce / reply-target scope. Lane-scoped for
// Telegram, binding-scoped otherwise.
function routeScopeKeyFor(lane, bindingKey, workspaceRoot) {
  return buildLaneScopeKey(lane, workspaceRoot) || buildScopeKey(bindingKey, workspaceRoot);
}

// Outbound Telegram topic field. Omitted entirely when there is no topic, so a
// non-Telegram payload keeps exactly the shape it had before v2.
// 把"写没写进 profile"如实说给她听。写成功要说清楚何时生效（不是立刻——
// 子进程握着自己的启动参数，要等下次拉起）；写失败要说清楚后果（重启后会掉），
// 而不是含糊一句成功了事。
function describeProfilePersistence(result) {
  if (result?.saved) {
    return [`已写入 profile「${result.profileId}」，持久生效（当前进程仍是旧值，下次重启后换过来）`];
  }
  const reason = normalizeText(result?.reason);
  if (reason === "profiles_file_not_configured") {
    return ["⚠️ 本次只对当前窗口生效：这套部署用内联 profile，没有可写的文件"];
  }
  return [`⚠️ 本次只对当前窗口生效，重启后会掉回缺省（写 profile 失败：${reason || "unknown"}）`];
}

function outboundThreadIdField(source) {
  const value = CyberbossApp.resolveOutboundThreadIdFor(source);
  return value === null || value === undefined ? {} : { messageThreadId: value };
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
  return formatAppDateTime(parsed);
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

function readJsonlSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}
