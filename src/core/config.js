const fs = require("fs");
const path = require("path");
const { parseStrictBoolean } = require("./bounded-json");
const { envFlagEnabled } = require("./env-flag");
const { normalizeNightlyMode } = require("../continuity/nightly-mode");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_STATE_DIR"));
  const configDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_CONFIG_DIR"));
  const workspaceRoot = resolveConfiguredPath(
    readTextEnv("CYBERBOSS_WORKSPACE") || readTextEnv("CYBERBOSS_WORKSPACE_ROOT")
  );
  const promptFile = resolveConfiguredPath(
    readTextEnv("CYBERBOSS_PROMPT_FILE") || readTextEnv("CYBERBOSS_INSTRUCTIONS_FILE")
  );
  // 聊天资产的基座：日记、聊天原文、表情包、收到的媒体。
  //
  // 这四类是「她的东西」，而 stateDir 装的是「机器的东西」（pid、会话槽、轮询
  // 游标、writer 锁）——换台机器就该丢掉的那些。两者同居一个目录，备份与迁机
  // 时分不开，她自己也够不着（stateDir 在 runtime\ 下，是 FRAMEWORK 禁区）。
  //
  // 不设置时缺省等于 stateDir，各派生路径与设这行之前逐字节一致；生产只需设一
  // 行 env 就整体切换（仓库纪律：新能力默认关、关闭时逐字兼容）。
  const chatAssetsDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_CHAT_ASSETS_DIR")) || stateDir;
  const diaryDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_DIARY_DIR")) || joinIfBase(chatAssetsDir, "diary");
  // 三类聊天资产各自的独立根：聊天原文、收到的媒体、表情包。`chatAssetsDir` 只能把
  // 四类整体指向一处，而 manifest 要把它们分头安置（raw / ledger\media / Fluffy 的
  // stickers）。不设这三行时各自回落到 chatAssetsDir 的现有派生，与加它们之前逐字节
  // 一致；设某一行只搬那一类，互不牵连（仓库纪律：新能力默认关、关闭时逐字兼容）。
  const conversationsDir =
    resolveConfiguredPath(readTextEnv("CYBERBOSS_CONVERSATIONS_DIR")) || joinIfBase(chatAssetsDir, "conversations");
  const mediaDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_MEDIA_DIR")) || joinIfBase(chatAssetsDir, "media");
  // 表情包这一根同时管住素材/索引/标签（见下方 stickerAssetsDir 等）——出口与素材必须
  // 同根，否则播种闸（sticker-service `ensureStickerCatalogFilesSync` 以 stickersDir 是否
  // 存在为准）会在出口新建、素材留旧处时早退，表情库瘸掉。模板种子仍留仓库 templates\。
  const stickersDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_STICKERS_DIR")) || joinIfBase(chatAssetsDir, "stickers");
  // 系统触发提示词的可编辑覆盖目录（一个 sourceType 一个 md）。不设或读不到就
  // 用内置文本，见 `core/trigger-prompts.js`。
  const triggerPromptsDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_TRIGGER_PROMPTS_DIR"));
  const sourceLabel = readTextEnv("CYBERBOSS_SOURCE_LABEL");
  const memoryDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_MEMORY_DIR") || joinIfBase(stateDir, "memory"));
  // The agent's process may be deliberately narrower than the workspace used
  // for bindings, source discovery, and MCP configuration.
  const agentCwd = resolveConfiguredPath(readTextEnv("CYBERBOSS_AGENT_CWD")) || memoryDir;
  const operationsFile = resolveConfiguredPath(readTextEnv("CYBERBOSS_OPERATIONS_FILE"));
  const continuityDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_CONTINUITY_DIR"));
  const localWhisperEnabled = readStrictBoolEnv("CYBERBOSS_LOCAL_WHISPER_ENABLED", false);
  const localWhisperModel = readLocalWhisperModelEnv(localWhisperEnabled);

  return {
    mode,
    argv,
    stateDir,
    configDir,
    workspaceId: readTextEnv("CYBERBOSS_WORKSPACE_ID") || "default",
    workspaceRoot,
    promptFile,
    userName: readTextEnv("CYBERBOSS_USER_NAME") || "User",
    userGender: readTextEnv("CYBERBOSS_USER_GENDER") || "female",
    allowedUserIds: readListEnv("CYBERBOSS_ALLOWED_USER_IDS"),
    channel: readTextEnv("CYBERBOSS_CHANNEL"),
    runtime: readTextEnv("CYBERBOSS_RUNTIME"),
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: joinIfBase(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: joinIfBase(stateDir, "accounts"),
    reminderQueueFile: joinIfBase(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: joinIfBase(stateDir, "system-message-queue.json"),
    activityPauseFile: joinIfBase(stateDir, "activity-pause.json"),
    // Absolute path to the watchdog's health log (<watchdog_owner_dir>/watchdog.log),
    // read-only, for the /status watchdog liveness field. Unset => /status reports
    // "unconfigured" rather than guessing. Not derived from stateDir: the watchdog
    // owner dir comes from the release descriptor / deployment, so it is supplied
    // explicitly via env.
    watchdogLogFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_WATCHDOG_LOG")) || "",
    deferredSystemReplyQueueFile: joinIfBase(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: joinIfBase(stateDir, "checkin-config.json"),
    sleepWindowFile: joinIfBase(stateDir, "sleep-window.json"),
    conversationDir: conversationsDir,
    telegramBotToken: readTextEnv("CYBERBOSS_TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserIds: readListEnv("CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS"),
    telegramStateFile: joinIfBase(stateDir, "telegram-state.json"),
    voiceKitDir: resolveConfiguredPath(readTextEnv("CYBERBOSS_VOICE_KIT_DIR")),
    voiceMediaDir: joinIfBase(mediaDir, "voice"),
    photoMediaDir: joinIfBase(mediaDir, "photos"),
    mediaInboxMaxBytes: readBoundedIntEnv("CYBERBOSS_MEDIA_INBOX_MAX_BYTES", 20 * 1024 * 1024, 1, 500 * 1024 * 1024),
    localWhisperEnabled,
    localWhisperPythonCommand: readTextEnv("CYBERBOSS_LOCAL_WHISPER_PYTHON") || "python",
    localWhisperModel,
    localWhisperDevice: readTextEnv("CYBERBOSS_LOCAL_WHISPER_DEVICE") || "cpu",
    localWhisperComputeType: readTextEnv("CYBERBOSS_LOCAL_WHISPER_COMPUTE_TYPE") || "int8",
    localWhisperTimeoutMs: readBoundedIntEnv("CYBERBOSS_LOCAL_WHISPER_TIMEOUT_MS", 120000, 1000, 900000),
    localWhisperMaxInputBytes: readBoundedIntEnv("CYBERBOSS_LOCAL_WHISPER_MAX_INPUT_BYTES", 20 * 1024 * 1024, 1, 500 * 1024 * 1024),
    localWhisperMaxAudioSeconds: readBoundedIntEnv("CYBERBOSS_LOCAL_WHISPER_MAX_AUDIO_SECONDS", 180, 1, 3600),
    localWhisperMaxOutputChars: readBoundedIntEnv("CYBERBOSS_LOCAL_WHISPER_MAX_OUTPUT_CHARS", 4000, 1, 100000),
    localWhisperMaxStderrChars: readBoundedIntEnv("CYBERBOSS_LOCAL_WHISPER_MAX_STDERR_CHARS", 4000, 1, 100000),
    voiceSttProvider: readTextEnv("CYBERBOSS_VOICE_STT_PROVIDER"),
    voiceSttApiKey: readTextEnv("CYBERBOSS_VOICE_STT_API_KEY"),
    voiceSttBaseUrl: readTextEnv("CYBERBOSS_VOICE_STT_BASE_URL"),
    voiceSttModel: readTextEnv("CYBERBOSS_VOICE_STT_MODEL"),
    voiceSttLanguage: readTextEnv("CYBERBOSS_VOICE_STT_LANGUAGE"),
    voiceTtsProvider: readTextEnv("CYBERBOSS_VOICE_TTS_PROVIDER"),
    voiceTtsApiKey: readTextEnv("CYBERBOSS_ELEVENLABS_API_KEY") || readTextEnv("CYBERBOSS_VOICE_TTS_API_KEY"),
    voiceTtsVoiceId: readTextEnv("CYBERBOSS_ELEVENLABS_VOICE_ID") || readTextEnv("CYBERBOSS_VOICE_TTS_VOICE_ID"),
    voiceTtsModelId: readTextEnv("CYBERBOSS_ELEVENLABS_MODEL_ID") || readTextEnv("CYBERBOSS_VOICE_TTS_MODEL_ID"),
    voiceTtsBaseUrl: readTextEnv("CYBERBOSS_VOICE_TTS_BASE_URL"),
    sleepScheduleFile: joinIfBase(stateDir, "sleep-schedule.json"),
    desireStateFile: joinIfBase(stateDir, "desire-state.json"),
    currentStateOverrideFile: joinIfBase(stateDir, "context-current-state.md"),
    memoryContextOverrideFile: joinIfBase(stateDir, "context-memory-override.md"),
    desireHistoryFile: joinIfBase(stateDir, "desire-history.jsonl"),
    desireThoughtsFile: joinIfBase(stateDir, "desire-thoughts.json"),
    projectToolContextFile: joinIfBase(stateDir, "project-tool-runtime-context.json"),
    weixinInstructionsFile: promptFile,
    memoryDir,
    agentCwd,
    continuityDir,
    reentryFile: joinIfBase(continuityDir, "reentry.md"),
    contextTraceFile: joinIfBase(continuityDir, "trace", "context_trace.jsonl"),
    recallLogFile: joinIfBase(continuityDir, "recall_log.jsonl"),
    writerLeaseFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_WRITER_LEASE_FILE")),
    continuityBranch: readTextEnv("CYBERBOSS_CONTINUITY_BRANCH"),
    continuityWorktree: resolveConfiguredPath(readTextEnv("CYBERBOSS_CONTINUITY_WORKTREE")),
    continuityBaseSha: readTextEnv("CYBERBOSS_CONTINUITY_BASE_SHA"),
    reviewArtifactsEnabled: readStrictBoolEnv("CYBERBOSS_REVIEW_ARTIFACTS_ENABLED", false),
    handoffDispatchEnabled: readStrictBoolEnv("CYBERBOSS_HANDOFF_DISPATCH_ENABLED", false),
    subjectSigningEnabled: readStrictBoolEnv("CYBERBOSS_SUBJECT_SIGNING_ENABLED", false),
    // `/new` opens a window she asked for; this decides whether the window
    // speaks first instead of waiting to be pulled. Off by default.
    windowOpenGreetingEnabled: readStrictBoolEnv("CYBERBOSS_WINDOW_OPEN_GREETING_ENABLED", false),
    triggerPromptsDir,
    legacyCandidateBindingEnabled: readStrictBoolEnv("CYBERBOSS_LEGACY_CANDIDATE_BINDING_ENABLED", false),
    claudeTranscriptDir: resolveConfiguredPath(readTextEnv("CYBERBOSS_CLAUDE_TRANSCRIPT_DIR")),
    reentryAuthoringMode: readTextEnv("CYBERBOSS_REENTRY_AUTHORING_MODE") || "ai_direct",
    // 慢层注入面（E1）：三项独立开关默认关，开着才在开窗时小预算缝入（与 reentry
    // 同层，见 core/slow-layer-loader.js）。开关经 env-flag.js 统一真值判定（=1 开）。
    // portrait 缺省跟 memoryDir（生产即 04-memory\ai_self_portrait.md）；agreements 与
    // wandering 住在资产区的兄弟目录（目录名含全角括号，不做路径猜测），必须显式
    // 给 env，没给 = 该项静默跳过（fail-open）。本进程对三份文件只读。
    injectAgreements: envFlagEnabled("CYBERBOSS_INJECT_AGREEMENTS"),
    injectPortrait: envFlagEnabled("CYBERBOSS_INJECT_PORTRAIT"),
    injectWandering: envFlagEnabled("CYBERBOSS_INJECT_WANDERING"),
    injectTimeline: envFlagEnabled("CYBERBOSS_INJECT_TIMELINE"),
    agreementsFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_AGREEMENTS_FILE")),
    aiPortraitFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_AI_PORTRAIT_FILE")) || joinIfBase(memoryDir, "ai_self_portrait.md"),
    wanderingFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_WANDERING_FILE")),
    relationshipTimelineFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_RELATIONSHIP_TIMELINE_FILE")) || joinIfBase(memoryDir, "relationship_timeline.md"),
    memoryStateFile: joinIfBase(memoryDir, "state.md"),
    memoryPendingPromisesFile: joinIfBase(memoryDir, "pending-promises.md"),
    memoryVectorFile: joinIfBase(memoryDir, "vectors.jsonl"),
    weixinOperationsFile: operationsFile,
    includeOperationsPrompt: readBoolEnv("CYBERBOSS_INCLUDE_OPERATIONS_PROMPT"),
    includeLegacyMemoryRelays: readBoolEnv("CYBERBOSS_INCLUDE_LEGACY_MEMORY_RELAYS"),
    legacyMemoryRetrieval: readBoolEnv("CYBERBOSS_MEMORY_RETRIEVAL"),
    legacyMemoryBackgroundWrite: readBoolEnv("CYBERBOSS_MEMORY_BACKGROUND_WRITE"),
    legacyMemoryReplyTransform: readBoolEnv("CYBERBOSS_MEMORY_REPLY_TRANSFORM"),
    stickersDir,
    stickerAssetsDir: joinIfBase(stickersDir, "assets"),
    stickersIndexFile: joinIfBase(stickersDir, "index.json"),
    stickerTagsFile: joinIfBase(stickersDir, "tags.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    diaryDir,
    sourceLabel,
    locationStoreFile: joinIfBase(stateDir, "locations.json"),
    locationStateFile: joinIfBase(stateDir, "location-state.json"),
    locationEventStoreFile: joinIfBase(stateDir, "location-events.json"),
    locationV2Enabled: resolveLocationV2Enabled(),
    locationHost: readTextEnv("CYBERBOSS_LOCATION_HOST") || "0.0.0.0",
    locationPort: readIntEnv("CYBERBOSS_LOCATION_PORT") || 4318,
    locationToken: readTextEnv("CYBERBOSS_LOCATION_TOKEN"),
    amapKey: readTextEnv("CYBERBOSS_AMAP_KEY") || readTextEnv("CYBERBOSS_AMAP_WEATHER_KEY"),
    locationHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readIntEnv("CYBERBOSS_LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_PLACE_RADIUS_METERS") || 150,
    locationPoiRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_POI_RADIUS_METERS") || 300,
    locationStayMergeRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readIntEnv("CYBERBOSS_LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    locationBatteryCriticalThreshold: readIntEnv("CYBERBOSS_LOCATION_BATTERY_CRITICAL_THRESHOLD") || 10,
    locationLongStayHours: readIntEnv("CYBERBOSS_LOCATION_LONG_STAY_HOURS") || 12,
    locationEventCooldownMinutes: readIntEnv("CYBERBOSS_LOCATION_EVENT_COOLDOWN_MINUTES") || 30,
    weatherProvider: readTextEnv("CYBERBOSS_WEATHER_PROVIDER") || "amap",
    amapWeatherKey: readTextEnv("CYBERBOSS_AMAP_WEATHER_KEY"),
    weatherAdcode: readTextEnv("CYBERBOSS_WEATHER_ADCODE"),
    weatherCity: readTextEnv("CYBERBOSS_WEATHER_CITY"),
    weatherAddress: readTextEnv("CYBERBOSS_WEATHER_ADDRESS"),
    // Open-Meteo location (city geocoded when lat/lon absent) and alert thresholds.
    weatherCountry: readTextEnv("CYBERBOSS_WEATHER_COUNTRY"),
    weatherLat: readTextEnv("CYBERBOSS_WEATHER_LAT"),
    weatherLon: readTextEnv("CYBERBOSS_WEATHER_LON"),
    weatherRainProbPct: readIntEnv("CYBERBOSS_WEATHER_RAIN_PROB_PCT"),
    weatherTempDeltaC: readIntEnv("CYBERBOSS_WEATHER_TEMP_DELTA_C"),
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readOptionalBoolEnv("CYBERBOSS_ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: joinIfBase(stateDir, "sync-buffers"),
    codexEndpoint: readTextEnv("CYBERBOSS_CODEX_ENDPOINT"),
    codexCommand: readTextEnv("CYBERBOSS_CODEX_COMMAND"),
    codexModel: readTextEnv("CYBERBOSS_CODEX_MODEL"),
    codexModelProvider: readTextEnv("CYBERBOSS_CODEX_MODEL_PROVIDER"),
    codexNativeImageInput: readOptionalBoolEnv("CYBERBOSS_CODEX_NATIVE_IMAGE_INPUT"),
    visionMode: readTextEnv("CYBERBOSS_VISION_MODE") || "auto",
    visionProvider: readTextEnv("CYBERBOSS_VISION_PROVIDER") || "openai-compatible",
    visionApiBaseUrl: readTextEnv("CYBERBOSS_VISION_API_BASE_URL"),
    visionApiKey: readTextEnv("CYBERBOSS_VISION_API_KEY"),
    visionModel: readTextEnv("CYBERBOSS_VISION_MODEL"),
    visionTimeoutMs: readIntEnv("CYBERBOSS_VISION_TIMEOUT_MS") || 30_000,
    visionQwenApiBaseUrl: readTextEnv("CYBERBOSS_VISION_QWEN_API_BASE_URL"),
    visionQwenApiKey: readTextEnv("CYBERBOSS_VISION_QWEN_API_KEY")
      || readCsvValue(resolveConfiguredPath(readTextEnv("CYBERBOSS_VISION_QWEN_API_KEY_FILE")), "apiKey"),
    visionQwenModel: readTextEnv("CYBERBOSS_VISION_QWEN_MODEL"),
    visionQwenTimeoutMs: readIntEnv("CYBERBOSS_VISION_QWEN_TIMEOUT_MS") || 90_000,
    desireDriven: resolveDesireDriven(),
    desireLoopMinimalEnabled: readStrictBoolEnv("CYBERBOSS_DESIRE_LOOP_MINIMAL_ENABLED", false),
    desireCoupling: resolveFeatureGate("CYBERBOSS_DESIRE_COUPLING"),
    desireBaselineDrift: resolveFeatureGate("CYBERBOSS_DESIRE_BASELINE_DRIFT"),
    heartbeatAutonomy: resolveFeatureGate("CYBERBOSS_HEARTBEAT_AUTONOMY"),
    desireSelfDrive: resolveFeatureGate("CYBERBOSS_DESIRE_SELF_DRIVE"),
    desireScheduleFile: joinIfBase(stateDir, "desire-schedule.json"),
    desireActiveFile: joinIfBase(stateDir, "desire-checkin-active.json"),
    desirePlanFile: joinIfBase(stateDir, "desire-checkin-plan.json"),
    // 她在 checkin 里自填的下次唤醒时间（自主节奏）：绝对时间戳，poller 分片
    // 轮询时读到就覆盖默认 cadence，用后即清。
    desireWakeOverrideFile: joinIfBase(stateDir, "desire-wake-override.json"),
    desireTelemetry: resolveFeatureGate("CYBERBOSS_DESIRE_TELEMETRY"),
    desireTelemetryFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_DESIRE_TELEMETRY_FILE")) || joinIfBase(stateDir, "desire-usage.jsonl"),
    consolidationTriggerEnabled: envFlagEnabled("CYBERBOSS_CONSOLIDATION_TRIGGER_ENABLED"),
    consolidationHour: readBoundedIntEnv("CYBERBOSS_CONSOLIDATION_HOUR", 21, 0, 23),
    consolidationMinute: readBoundedIntEnv("CYBERBOSS_CONSOLIDATION_MINUTE", 30, 0, 59),
    reflectTriggerEnabled: envFlagEnabled("CYBERBOSS_REFLECT_TRIGGER_ENABLED"),
    reflectIntervalDays: readBoundedIntEnv("CYBERBOSS_REFLECT_INTERVAL_DAYS", 3, 1, 30),
    reflectHour: readBoundedIntEnv("CYBERBOSS_REFLECT_HOUR", 20, 0, 23),
    reflectMinute: readBoundedIntEnv("CYBERBOSS_REFLECT_MINUTE", 30, 0, 59),
    subjectBeatStateFile: joinIfBase(continuityDir, ".jobs", "subject-beat-state.json"),
    pipelineScheduleEnabled: envFlagEnabled("CYBERBOSS_PIPELINE_SCHEDULE_ENABLED"),
    pipelineIntervalMinutes: readBoundedIntEnv("CYBERBOSS_PIPELINE_INTERVAL_MINUTES", 60, 5, 1_440),
    memoryReceiptEnabled: envFlagEnabled("CYBERBOSS_MEMORY_RECEIPT_ENABLED"),
    nightlyCloseoutEnabled: readStrictBoolEnv("CYBERBOSS_NIGHTLY_CLOSEOUT_ENABLED", false),
    nightlyMode: normalizeNightlyMode(readTextEnv("CYBERBOSS_NIGHTLY_MODE")),
    nightlyCloseoutHour: readBoundedIntEnv("CYBERBOSS_NIGHTLY_CLOSEOUT_HOUR", 4, 0, 23),
    nightlyCloseoutMinute: readBoundedIntEnv("CYBERBOSS_NIGHTLY_CLOSEOUT_MINUTE", 30, 0, 59),
    automationTimezone: readTimezoneEnv("CYBERBOSS_AUTOMATION_TIMEZONE", "Australia/Sydney"),
    slowLayerTotalBudget: readBoundedIntEnv("CYBERBOSS_SLOW_LAYER_TOTAL_BUDGET", 1_000, 800, 4_000),
    canonLivenessEnabled: readStrictBoolEnv("CYBERBOSS_CANON_LIVENESS_ENABLED", false),
    canonLivenessThresholdHours: readBoundedIntEnv("CYBERBOSS_CANON_LIVENESS_THRESHOLD_HOURS", 48, 0, 8_760),
    recallLivenessEnabled: readStrictBoolEnv("CYBERBOSS_RECALL_LIVENESS_ENABLED", false),
    recallLivenessThresholdHours: readBoundedIntEnv("CYBERBOSS_RECALL_LIVENESS_THRESHOLD_HOURS", 48, 0, 8_760),
    livenessStartupGraceMinutes: readBoundedIntEnv("CYBERBOSS_LIVENESS_STARTUP_GRACE_MINUTES", 30, 0, 10_080),
    livenessAlertCooldownHours: readBoundedIntEnv("CYBERBOSS_LIVENESS_ALERT_COOLDOWN_HOURS", 24, 0, 8_760),
    livenessRecoveryEnabled: readStrictBoolEnv("CYBERBOSS_LIVENESS_RECOVERY_ENABLED", true),
    closeoutLivenessStateFile: joinIfBase(continuityDir, ".jobs", "closeout-liveness-state.json"),
    closeoutRetryStateFile: joinIfBase(continuityDir, ".jobs", "closeout-retry-state.json"),
    closeoutAutomationLeaseFile: joinIfBase(continuityDir, ".jobs", "closeout-automation.lease"),
    closeoutLivenessLeaseFile: joinIfBase(continuityDir, ".jobs", "closeout-liveness.lease"),
    canonEpisodesFile: joinIfBase(continuityDir, "episodes.jsonl"),
    desireThoughtMax: readIntEnv("CYBERBOSS_DESIRE_THOUGHT_MAX")
      || readIntEnv("TWIN_DESIRE_THOUGHT_MAX")
      || 80,
    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("CYBERBOSS_CLAUDE_MODEL") || "",
    claudeModelProvider: readTextEnv("CYBERBOSS_CLAUDE_MODEL_PROVIDER") || "anthropic",
    claudeContextWindow: readIntEnv("CYBERBOSS_CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudePermissionMode: readTextEnv("CYBERBOSS_CLAUDE_PERMISSION_MODE") || "default",
    claudeDisableVerbose: readBoolEnv("CYBERBOSS_CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readListEnv("CYBERBOSS_CLAUDE_EXTRA_ARGS"),
    claudeConfigDir: resolveConfiguredPath(readTextEnv("CYBERBOSS_CLAUDE_CONFIG_DIR")),
    // Raw operator JSON, inline or from a file. It is deliberately NOT parsed
    // here: parsing happens in the Telegram profile router, which is fail-closed
    // and throws on any defect, so a malformed mapping blocks startup instead of
    // degrading into a more permissive legacy launch.
    claudeLaunchProfilesJson: readLaunchProfilesSource(),
    // 文件路径本身也要暴露：/model 与 /effort 现在把选择写回 profile（Owner 2026-08-11
    // 裁定 (a)），而写回需要知道写哪个文件。只有走 _FILE 的部署才有这个能力；
    // 用 _JSON 内联配置的部署拿到空串，命令会如实报"没有可写的 profile 文件"而不是偷偷失败。
    claudeLaunchProfilesFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE")),
    telegramProfileMappingJson: readRawEnv("CYBERBOSS_TELEGRAM_PROFILE_MAPPING_JSON"),
    claudeLaunchProfileBaseDir: resolveConfiguredPath(
      readTextEnv("CYBERBOSS_CLAUDE_LAUNCH_PROFILE_BASE_DIR"),
    ),
    // Separate, explicit approvals. A launch profile can never set either of
    // these; they are deployment decisions.
    claudeAllowAuthBackendOverride: readExactBoolEnv("CYBERBOSS_CLAUDE_ALLOW_AUTH_BACKEND_OVERRIDE"),
    claudeAllowCloudCredentialInheritance: readExactBoolEnv(
      "CYBERBOSS_CLAUDE_ALLOW_CLOUD_CREDENTIAL_INHERITANCE",
    ),
    // Declares CLI flags this deployment's Claude binary supports beyond the
    // verified set. Only the known-unverified flags may be declared.
    claudeCliCapabilitiesJson: readRawEnv("CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON"),
    claudeSessionSlotsFile: joinIfBase(stateDir, "claude-session-slots.json"),
    claudeMaxProcesses: readIntEnv("CYBERBOSS_CLAUDE_MAX_PROCESSES"),
    sessionsFile: joinIfBase(stateDir, "sessions.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBoolEnv("CYBERBOSS_ENABLE_CHECKIN"),
  };
}

// Upper bound on the launch-profile file. The profile set is a handful of
// objects; anything approaching this is a misconfiguration, and reading it
// before the router's own bounded parse would be the one unbounded read on the
// startup path.
const LAUNCH_PROFILES_FILE_MAX_BYTES = 256 * 1024;

/**
 * The launch profiles document, from either `..._JSON` (inline) or
 * `..._FILE` (a path).
 *
 * Both set is a configuration error, not a precedence question: an operator who
 * edits the file while a stale inline copy silently wins would be running a
 * profile they cannot see. Every failure here stops startup.
 */
function readLaunchProfilesSource() {
  const inline = readRawEnv("CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON");
  const filePath = resolveConfiguredPath(readTextEnv("CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE"));
  if (inline && filePath) {
    throw new Error(
      "CYBERBOSS_CLAUDE_LAUNCH_PROFILES_JSON and CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE cannot both be set",
    );
  }
  if (!filePath) return inline;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error("CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE does not exist or is not readable");
  }
  if (!stat.isFile()) {
    throw new Error("CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE must point at a file");
  }
  if (stat.size > LAUNCH_PROFILES_FILE_MAX_BYTES) {
    throw new Error("CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE exceeds the size limit");
  }
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error("CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE does not exist or is not readable");
  }
  // An editor-written JSON file may carry a BOM; JSON.parse would reject it.
  const cleaned = text.replace(/^﻿/, "");
  if (!cleaned.trim()) {
    throw new Error("CYBERBOSS_CLAUDE_LAUNCH_PROFILES_FILE is empty");
  }
  return cleaned;
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// Raw (untrimmed-of-content) environment text. Only whitespace around the value
// is removed; the payload is handed to a bounded parser unmodified.
function readRawEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

// Exact boolean: only 1/0/true/false. Stricter than the existing
// readStrictBoolEnv (which also accepts yes/no/on/off) and used for the
// security-relevant profile opt-ins, where a near-miss must fail rather than
// resolve to a permissive default.
function readExactBoolEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return false;
  }
  return parseStrictBoolean(value, { label: name });
}

function resolveConfiguredPath(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return "";
  }
  const resolved = path.resolve(normalized);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function joinIfBase(base, ...parts) {
  const normalizedBase = typeof base === "string" ? base.trim() : "";
  return normalizedBase ? path.join(normalizedBase, ...parts) : "";
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readStrictBoolEnv(name, fallback) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`${name} must be an explicit boolean (true/false, 1/0, yes/no, or on/off); received: ${value}`);
}

function readBoundedIntEnv(name, fallback, minimum, maximum) {
  const value = readTextEnv(name);
  if (!value) return fallback;
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}; received: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}; received: ${value}`);
  }
  return parsed;
}

function readLocalWhisperModelEnv(enabled) {
  const configured = readTextEnv("CYBERBOSS_LOCAL_WHISPER_MODEL");
  if (!enabled) return configured;
  if (!configured || !path.isAbsolute(configured)) {
    throw new Error("CYBERBOSS_LOCAL_WHISPER_MODEL must be an existing local absolute directory when local Whisper is enabled");
  }
  let stat;
  try { stat = fs.statSync(configured); } catch { stat = null; }
  if (!stat?.isDirectory()) {
    throw new Error("CYBERBOSS_LOCAL_WHISPER_MODEL must be an existing local absolute directory when local Whisper is enabled");
  }
  return fs.realpathSync(configured);
}

function readTimezoneEnv(name, fallback) {
  const value = readTextEnv(name) || fallback;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
  } catch {
    throw new Error(`${name} must be a valid IANA timezone; received: ${value}`);
  }
  return value;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readCsvValue(filePath, key) {
  if (!filePath || !key) return "";
  try {
    const line = fs.readFileSync(filePath, "utf8").split(/\r?\n/).find((item) => item.startsWith(`${key},`));
    return line ? line.slice(key.length + 1).trim() : "";
  } catch {
    return "";
  }
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("CYBERBOSS_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("CYBERBOSS_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("CYBERBOSS_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

function resolveLocationV2Enabled() {
  const explicit = readOptionalBoolEnv("CYBERBOSS_LOCATION_V2_ENABLED");
  return typeof explicit === "boolean" ? explicit : true;
}

function resolveDesireDriven() {
  const explicit = readOptionalBoolEnv("CYBERBOSS_DESIRE_DRIVEN");
  if (typeof explicit === "boolean") {
    return explicit;
  }
  const legacy = readOptionalBoolEnv("TWIN_DESIRE_DRIVEN");
  return typeof legacy === "boolean" ? legacy : false;
}

function resolveFeatureGate(envName) {
  const explicit = readOptionalBoolEnv(envName);
  return typeof explicit === "boolean" ? explicit : false;
}

module.exports = { readConfig, resolveConfiguredPath };
