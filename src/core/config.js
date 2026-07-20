const fs = require("fs");
const path = require("path");

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
  const timelineStateDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_TIMELINE_STATE_DIR")) || stateDir;
  const diaryDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_DIARY_DIR")) || joinIfBase(stateDir, "diary");
  const sourceLabel = readTextEnv("CYBERBOSS_SOURCE_LABEL");
  const memoryDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_MEMORY_DIR") || joinIfBase(stateDir, "memory"));
  // The agent's process may be deliberately narrower than the workspace used
  // for bindings, source discovery, and MCP configuration.
  const agentCwd = resolveConfiguredPath(readTextEnv("CYBERBOSS_AGENT_CWD")) || memoryDir;
  const operationsFile = resolveConfiguredPath(readTextEnv("CYBERBOSS_OPERATIONS_FILE"));
  const continuityDir = resolveConfiguredPath(readTextEnv("CYBERBOSS_CONTINUITY_DIR"));

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
    timelineCommand: readTextEnv("CYBERBOSS_TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: joinIfBase(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: joinIfBase(stateDir, "accounts"),
    reminderQueueFile: joinIfBase(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: joinIfBase(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: joinIfBase(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: joinIfBase(stateDir, "checkin-config.json"),
    conversationDir: joinIfBase(stateDir, "conversations"),
    telegramBotToken: readTextEnv("CYBERBOSS_TELEGRAM_BOT_TOKEN"),
    telegramAllowedUserIds: readListEnv("CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS"),
    telegramStateFile: joinIfBase(stateDir, "telegram-state.json"),
    voiceKitDir: resolveConfiguredPath(readTextEnv("CYBERBOSS_VOICE_KIT_DIR")),
    voiceMediaDir: joinIfBase(stateDir, "media", "voice"),
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
    timelineScreenshotQueueFile: joinIfBase(stateDir, "timeline-screenshot-queue.json"),
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
    claudeTranscriptDir: resolveConfiguredPath(readTextEnv("CYBERBOSS_CLAUDE_TRANSCRIPT_DIR")),
    reentryAuthoringMode: readTextEnv("CYBERBOSS_REENTRY_AUTHORING_MODE") || "ai_direct",
    memoryStateFile: joinIfBase(memoryDir, "state.md"),
    memoryPendingPromisesFile: joinIfBase(memoryDir, "pending-promises.md"),
    memoryVectorFile: joinIfBase(memoryDir, "vectors.jsonl"),
    weixinOperationsFile: operationsFile,
    includeOperationsPrompt: readBoolEnv("CYBERBOSS_INCLUDE_OPERATIONS_PROMPT"),
    includeLegacyMemoryRelays: readBoolEnv("CYBERBOSS_INCLUDE_LEGACY_MEMORY_RELAYS"),
    legacyMemoryRetrieval: readBoolEnv("CYBERBOSS_MEMORY_RETRIEVAL"),
    legacyMemoryBackgroundWrite: readBoolEnv("CYBERBOSS_MEMORY_BACKGROUND_WRITE"),
    legacyMemoryReplyTransform: readBoolEnv("CYBERBOSS_MEMORY_REPLY_TRANSFORM"),
    stickersDir: joinIfBase(stateDir, "stickers"),
    stickerAssetsDir: joinIfBase(stateDir, "stickers", "assets"),
    stickersIndexFile: joinIfBase(stateDir, "stickers", "index.json"),
    stickerTagsFile: joinIfBase(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    diaryDir,
    timelineStateDir,
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
    desireDriven: resolveDesireDriven(),
    desireCoupling: resolveFeatureGate("CYBERBOSS_DESIRE_COUPLING"),
    desireBaselineDrift: resolveFeatureGate("CYBERBOSS_DESIRE_BASELINE_DRIFT"),
    heartbeatAutonomy: resolveFeatureGate("CYBERBOSS_HEARTBEAT_AUTONOMY"),
    desireSelfDrive: resolveFeatureGate("CYBERBOSS_DESIRE_SELF_DRIVE"),
    desireScheduleFile: joinIfBase(stateDir, "desire-schedule.json"),
    desireActiveFile: joinIfBase(stateDir, "desire-checkin-active.json"),
    desirePlanFile: joinIfBase(stateDir, "desire-checkin-plan.json"),
    desireTelemetry: resolveFeatureGate("CYBERBOSS_DESIRE_TELEMETRY"),
    desireTelemetryFile: resolveConfiguredPath(readTextEnv("CYBERBOSS_DESIRE_TELEMETRY_FILE")) || joinIfBase(stateDir, "desire-usage.jsonl"),
    desireThoughtMax: readIntEnv("CYBERBOSS_DESIRE_THOUGHT_MAX")
      || readIntEnv("TWIN_DESIRE_THOUGHT_MAX")
      || 80,
    claudeCommand: readTextEnv("CYBERBOSS_CLAUDE_COMMAND") || "claude",
    claudeModel: readTextEnv("CYBERBOSS_CLAUDE_MODEL") || "",
    claudeContextWindow: readIntEnv("CYBERBOSS_CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudePermissionMode: readTextEnv("CYBERBOSS_CLAUDE_PERMISSION_MODE") || "default",
    claudeDisableVerbose: readBoolEnv("CYBERBOSS_CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readListEnv("CYBERBOSS_CLAUDE_EXTRA_ARGS"),
    claudeConfigDir: resolveConfiguredPath(readTextEnv("CYBERBOSS_CLAUDE_CONFIG_DIR")),
    sessionsFile: joinIfBase(stateDir, "sessions.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBoolEnv("CYBERBOSS_ENABLE_CHECKIN"),
  };
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

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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
