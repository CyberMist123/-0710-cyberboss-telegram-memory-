const { createTelegramChannelAdapter } = require("../adapters/channel/telegram");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { createTimelineIntegration } = require("../integrations/timeline");
const { ChannelFileService } = require("../services/channel-file-service");
const { DiaryService } = require("../services/diary-service");
const { ReminderService } = require("../services/reminder-service");
const { createTelegramSendService } = require("../services/telegram-service");
const { MediaInboxService } = require("../services/media-inbox-service");
const { StickerService } = require("../services/sticker-service");
const { SystemMessageService } = require("../services/system-message-service");
const { TimelineService } = require("../services/timeline-service");
const { VoiceService } = require("../services/voice-service");
const { createWeatherService } = require("../services/weather-service");
const { MemoryLookupService } = require("../services/memory-lookup-service");
const { MemoryNoteService } = require("../services/memory-note-service");
const { GithubService } = require("../services/github-service");
const { createAmapClient } = require("../location/amap-client");
const { LocationEventStore } = require("../location/event-store");
const { createPlaceResolver } = require("../location/place-resolver");
const { createLocationSentinel } = require("../location/sentinel");
const { createLocationStateEngine, LocationStateStore } = require("../location/state-engine");
const { RuntimeContextStore } = require("./runtime-context-store");
const { ProjectToolHost } = require("./tool-host");
const { SubjectCapabilityRegistry, SubjectCandidateService } = require("../continuity/subject-signing");
const { SubjectSigningIpcClient } = require("../continuity/subject-signing-ipc");
const { WhereaboutsService } = require("whereabouts-mcp");
const { Route1DispatchIpcClient, route1DispatchEnabled } = require("../orchestration/route1-dispatch");
const { route2GateEnabled } = require("./tool-catalog-manifest");

// The tool-mcp-server child builds its own tooling and passes no adapter, so
// this default is the only channel decision that path makes. Hardcoding WeChat
// here sent every channel-bound tool (sticker send, channel file send, the
// sticker save receipt) out the WeChat exit while the deployment ran on
// Telegram, which surfaced as `No saved WeChat account was found`. The child
// gets the deployment env forwarded via CYBERBOSS_ENV_FILE, so `config.channel`
// is populated there just like in the main app.
function createConfiguredChannelAdapter(config) {
  if (normalizeChannel(config?.channel) === "telegram") {
    return createTelegramChannelAdapter(config);
  }
  return createWeixinChannelAdapter(config);
}

function normalizeChannel(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function createProjectTooling(config, options = {}) {
  const sessionStore = options.sessionStore || new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const channelAdapter = options.channelAdapter || createConfiguredChannelAdapter(config);
  const timelineIntegration = options.timelineIntegration || createTimelineIntegration(config);
  const runtimeContextStore = options.runtimeContextStore || new RuntimeContextStore({
    filePath: config.projectToolContextFile,
  });
  const amapClient = createAmapClient({
    key: config.amapKey,
  });
  const locationEventStore = new LocationEventStore({
    filePath: config.locationEventStoreFile,
  });
  const locationStateStore = new LocationStateStore({
    filePath: config.locationStateFile,
  });
  const channelFile = new ChannelFileService({ config, channelAdapter, sessionStore });
  const subjectCandidateOwner = options.subjectCandidateOwner === true;
  const subjectCapabilityRegistry = subjectCandidateOwner
    ? (options.subjectCapabilityRegistry || new SubjectCapabilityRegistry({
        enabled: config.subjectSigningEnabled === true,
      }))
    : null;
  // One IPC client serves both seams; route 1 dispatch and route 2 escalation
  // are gated independently, so either flag alone is enough to need it.
  const ipcClient = (route1DispatchEnabled() || route2GateEnabled())
    ? new Route1DispatchIpcClient({ stateDir: config.stateDir })
    : null;
  const route1Client = route1DispatchEnabled() ? ipcClient : null;
  const services = {
    ...(route1Client ? { route1Dispatch: route1Client, route1TaskQuery: route1Client } : {}),
    ...(route2GateEnabled() && ipcClient ? { route2Escalate: ipcClient } : {}),
    diary: new DiaryService({ config }),
    reminder: new ReminderService({ config, sessionStore }),
    system: new SystemMessageService({ config, sessionStore }),
    telegram: createTelegramSendService({ config, runtimeContextStore }),
    voice: new VoiceService({ config }),
    mediaInbox: new MediaInboxService({ config }),
    channelFile,
    sticker: new StickerService({ config, channelAdapter, sessionStore, channelFileService: channelFile }),
    timeline: new TimelineService({ config, timelineIntegration, sessionStore }),
    weather: createWeatherService({ config }),
    memoryLookup: new MemoryLookupService({ continuityDir: config.continuityDir }),
    // issue #74：Self-note 的第二个 writer。lease 文件必须和 History writer 用的
    // 同一个（`CYBERBOSS_WRITER_LEASE_FILE`，缺省 `<continuityDir>/.jobs/…`），
    // 否则两把锁互不排斥，等于没有锁。
    memoryNote: new MemoryNoteService({
      continuityDir: config.continuityDir,
      writerLeaseFile: config.writerLeaseFile,
    }),
    ...(subjectCandidateOwner ? {
      subjectCandidate: options.subjectCandidate || new SubjectCandidateService({
        continuityDir: config.continuityDir,
        registry: subjectCapabilityRegistry,
        enabled: config.subjectSigningEnabled === true,
      }),
    } : {}),
    ...(!subjectCandidateOwner && config.subjectSigningEnabled === true ? {
      subjectSigningBroker: options.subjectSigningBroker || new SubjectSigningIpcClient({
        stateDir: config.stateDir,
      }),
    } : {}),
    subjectSigningContext: options.subjectSigningContext || { resolve() { return null; } },
    github: new GithubService({ ghPath: config.ghPath }),
    locationConfig: {
      v2Enabled: config.locationV2Enabled === true,
    },
    amapClient,
    locationEventStore,
    locationStateStore,
    placeResolver: createPlaceResolver({
      geocoder: amapClient,
      knownPlaces: config.locationKnownPlaces,
      placeRadiusMeters: config.locationKnownPlaceRadiusMeters,
    }),
    locationStateEngine: createLocationStateEngine({
      longStayHours: config.locationLongStayHours,
      batteryCriticalThreshold: config.locationBatteryCriticalThreshold,
    }),
    locationSentinel: createLocationSentinel({
      eventStore: locationEventStore,
      cooldownMinutes: config.locationEventCooldownMinutes,
      maxEventsPerHourByType: {
        ArrivedPlace: 8,
        LeftPlace: 8,
        MajorMovement: 8,
        BatteryCritical: 2,
        LongStay: 2,
      },
    }),
    whereabouts: new WhereaboutsService({
      config: {
        storeFile: config.locationStoreFile,
        host: config.locationHost,
        port: config.locationPort,
        token: config.locationToken,
        historyLimit: config.locationHistoryLimit,
        movementEventLimit: config.locationMovementEventLimit,
        batteryHistoryLimit: config.locationBatteryHistoryLimit,
        knownPlaces: config.locationKnownPlaces,
        knownPlaceRadiusMeters: config.locationKnownPlaceRadiusMeters,
        stayMergeRadiusMeters: config.locationStayMergeRadiusMeters,
        stayBreakConfirmRadiusMeters: config.locationStayBreakConfirmRadiusMeters,
        stayBreakConfirmSamples: config.locationStayBreakConfirmSamples,
        majorMoveThresholdMeters: config.locationMajorMoveThresholdMeters,
      },
    }),
  };
  const toolHost = new ProjectToolHost({
    services,
    runtimeContextStore,
    toolset: options.toolset || null,
    authorizationCeiling: options.authorizationCeiling || "",
    chatSelfEscalation: options.chatSelfEscalation === true,
    onSelfEscalation: options.onSelfEscalation,
    route2Lease: options.route2Lease || null,
  });
  return {
    services,
    toolHost,
    runtimeContextStore,
  };
}

module.exports = { createProjectTooling };
