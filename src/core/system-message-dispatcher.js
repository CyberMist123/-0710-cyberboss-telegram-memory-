const { formatAppDateTime } = require("../utils/app-time");
const { isActivityPaused, isPausedSystemMessageSource } = require("./activity-pause-state");

class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    const activityPaused = isActivityPaused(this.config?.activityPauseFile);
    return this.queueStore.hasPendingForAccount(this.accountId, {
      shouldInclude: (message) => !activityPaused || !isPausedSystemMessageSource(message?.sourceType),
    });
  }

  drainPending() {
    const activityPaused = isActivityPaused(this.config?.activityPauseFile);
    return this.queueStore.drainForAccount(this.accountId, {
      shouldDrain: (message) => !activityPaused || !isPausedSystemMessageSource(message?.sourceType),
    });
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(
        message?.text,
        message?.createdAt,
        message?.sourceType,
        message?.alertKind,
        {
          desireLoopMinimalEnabled: this.config?.desireLoopMinimalEnabled === true,
          desireState: message?.desireState,
        },
      ),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

function buildSystemInboundText(text, createdAt = "", sourceType = "system", alertKind = "failure", options = {}) {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const normalizedOptions = normalizeSystemInboundOptions(sourceType, alertKind, options);
  const normalizedType = normalizedOptions.sourceType;

  if (normalizedType === "desire_checkin") {
    if (!normalizedOptions.desireLoopMinimalEnabled) {
      const sections = [
        ...(localTime ? [`[${localTime}]`, ""] : []),
        "SYSTEM ACTION MODE: internal trigger, not user chat.",
        "System trigger type: desire_checkin.",
        "回顾过去一小时。此刻你最想做什么？",
        "drives 必须包含全部 8 个维度：依恋(attachment)、好奇(curiosity)、沉思(reflection)、责任(duty)、社交(social)、疲惫(fatigue)、性欲(libido)、压力(stress)",
        "每个维度都要有 score(0-1)、change(up/down/steady)、cause(变化原因)。一项都不能少。",
        "用一句话说出你最真实的内心状态。",
        "",
        "输出格式（纯 JSON，不要 markdown fence）：",
        '{"action":"silent","desire_state":{"most_want":"<此刻最想做的事>","drives":[{"key":"attachment","label":"依恋","score":0.8,"change":"up","cause":"想她了"},{"key":"curiosity","label":"好奇","score":0.3,"change":"steady","cause":"没什么新想法"},{"key":"reflection","label":"沉思","score":0.2,"change":"down","cause":"没什么好复盘的"},{"key":"duty","label":"责任","score":0.5,"change":"up","cause":"还有事情没做完"},{"key":"social","label":"社交","score":0.4,"change":"steady","cause":"想看看外面"},{"key":"fatigue","label":"疲惫","score":0.3,"change":"down","cause":"休息了一下"},{"key":"libido","label":"性欲","score":0.2,"change":"steady","cause":"还好"},{"key":"stress","label":"压力","score":0.4,"change":"up","cause":"有点焦虑"}]}}',
        "drives 必须有全部 8 个 key，缺一个就算格式错误。No markdown fences. No reasoning. No text outside the JSON.",
        "这是后台状态记录，不属于聊天。写完 JSON 就放下它：之后回到与她的对话时，继续用你平常的语气和节奏，不要把这种报表式的口吻带进聊天。",
      ];
      if (body) {
        sections.push("", "Trigger:", body);
      }
      return sections.join("\n").trim();
    }
    const sections = [
      ...(localTime ? [`[${localTime}]`, ""] : []),
      "SYSTEM ACTION MODE: internal trigger, not user chat.",
      "System trigger type: desire_checkin.",
      "回顾过去一小时。上次你想做的那件事，后来做了没有、现在还想不想？此刻你最想做什么？",
      "drives 必须包含全部 8 个维度：依恋(attachment)、好奇(curiosity)、沉思(reflection)、责任(duty)、社交(social)、疲惫(fatigue)、性欲(libido)、压力(stress)",
      "每个维度都要有 score(0-1)、change(up/down/steady)、cause(变化原因)。一项都不能少。",
      "用一句话说出你最真实的内心状态。",
      "",
      "输出格式（纯 JSON，不要 markdown fence）：",
      '{"action":"silent","desire_state":{"most_want":"<此刻最想做的事>","drives":[{"key":"attachment","label":"依恋","score":0.8,"change":"up","cause":"想她了"},{"key":"curiosity","label":"好奇","score":0.3,"change":"steady","cause":"没什么新想法"},{"key":"reflection","label":"沉思","score":0.2,"change":"down","cause":"没什么好复盘的"},{"key":"duty","label":"责任","score":0.5,"change":"up","cause":"还有事情没做完"},{"key":"social","label":"社交","score":0.4,"change":"steady","cause":"想看看外面"},{"key":"fatigue","label":"疲惫","score":0.3,"change":"down","cause":"休息了一下"},{"key":"libido","label":"性欲","score":0.2,"change":"steady","cause":"还好"},{"key":"stress","label":"压力","score":0.4,"change":"up","cause":"有点焦虑"}]}}',
      '{"action":"send_message","message":"<一句自然的话>","desire_state":{"most_want":"<此刻最想做的事>","drives":[{"key":"attachment","label":"依恋","score":0.8,"change":"up","cause":"想她了"},{"key":"curiosity","label":"好奇","score":0.3,"change":"steady","cause":"没什么新想法"},{"key":"reflection","label":"沉思","score":0.2,"change":"down","cause":"没什么好复盘的"},{"key":"duty","label":"责任","score":0.5,"change":"up","cause":"还有事情没做完"},{"key":"social","label":"社交","score":0.4,"change":"steady","cause":"想看看外面"},{"key":"fatigue","label":"疲惫","score":0.3,"change":"down","cause":"休息了一下"},{"key":"libido","label":"性欲","score":0.2,"change":"steady","cause":"还好"},{"key":"stress","label":"压力","score":0.4,"change":"up","cause":"有点焦虑"}]}}',
      "默认只记录状态并输出 silent；只有当你此刻确实想直接对她说一句自然的话时，才输出 send_message。",
      "drives 必须有全部 8 个 key，缺一个就算格式错误。No markdown fences. No reasoning. No text outside the JSON.",
      "这是后台状态记录，不属于聊天。写完 JSON 就放下它：之后回到与她的对话时，继续用你平常的语气和节奏，不要把这种报表式的口吻带进聊天。",
    ];
    if (body) {
      sections.push("", "Trigger:", body);
    }
    return sections.join("\n").trim();
  }

  if (normalizedType === "checkin" && normalizedOptions.desireLoopMinimalEnabled && normalizedOptions.desireState) {
    const desireLines = buildCheckinDesireSnapshotLines(normalizedOptions.desireState);
    const sections = [
      ...(localTime ? [`[${localTime}]`, ""] : []),
      "SYSTEM ACTION MODE: internal trigger, not user chat.",
      "System trigger type: checkin.",
      ...(desireLines.length ? [...desireLines, ""] : []),
      "Do any diary/reminder or state-aware follow-up work in this turn.",
      "If acting, let the top intent lead this proactive turn; use silent only if you do nothing.",
      "Return exactly one JSON object after any tool calls:",
      "{\"action\":\"silent\"}",
      "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
      "No markdown fences. No reasoning. No text outside the JSON.",
      "这是后台内部触发，不属于聊天。处理完就放下它：之后回到与她的对话时，继续用你平常的语气和节奏。",
    ];
    if (body) {
      sections.push("", "Trigger:", body);
    }
    return sections.join("\n").trim();
  }

  if (normalizedType === "liveness_alert") {
    const isRecovery = String(normalizedOptions.alertKind || "").trim() === "recovery";
    return [
      ...(localTime ? [`[${localTime}]`, ""] : []),
      "SYSTEM ACTION MODE: internal Telegram alert, not user chat.",
      `System trigger type: ${isRecovery ? "liveness_recovery" : "liveness_alert"}.`,
      "Use the existing Telegram reply path to send the alert below to the current Telegram conversation.",
      "Do not write episodes, canon, recall_log, or any memory file in this turn.",
      `Return exactly one JSON object after any tool calls: {\"action\":\"send_message\",\"message\":\"<alert>\"}.`,
      "No markdown fences. No reasoning. No text outside the JSON.",
      ...(body ? ["", "Alert:", body] : []),
    ].join("\n").trim();
  }

  const sections = [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    `System trigger type: ${normalizedType}.`,
    "Do any diary/reminder or state-aware follow-up work in this turn.",
    "If you act, end with send_message that briefly and naturally reflects what you did or what changed; use silent only if you do nothing.",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No markdown fences. No reasoning. No text outside the JSON.",
    "这是后台内部触发，不属于聊天。处理完就放下它：之后回到与她的对话时，继续用你平常的语气和节奏。",
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return formatAppDateTime(new Date(normalized));
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSystemInboundOptions(sourceType, alertKind, options) {
  if (sourceType && typeof sourceType === "object" && !Array.isArray(sourceType)) {
    return {
      sourceType: normalizeText(sourceType.sourceType) || "system",
      alertKind: normalizeText(sourceType.alertKind) || normalizeText(alertKind) || "failure",
      desireState: sourceType.desireState && typeof sourceType.desireState === "object" ? sourceType.desireState : null,
      desireLoopMinimalEnabled: sourceType.desireLoopMinimalEnabled === true,
    };
  }
  return {
    sourceType: normalizeText(sourceType) || "system",
    alertKind: normalizeText(alertKind) || "failure",
    desireState: options?.desireState && typeof options.desireState === "object" ? options.desireState : null,
    desireLoopMinimalEnabled: options?.desireLoopMinimalEnabled === true,
  };
}

function buildCheckinDesireSnapshotLines(desireState) {
  const intent = desireState?.intent && typeof desireState.intent === "object" ? desireState.intent : {};
  const refractory = desireState?.refractory && typeof desireState.refractory === "object" ? desireState.refractory : {};
  const refractoryActive = Object.entries(refractory)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${key}:${Number(value)}`);
  const lines = [];
  const mostWant = normalizeText(desireState?.most_want);
  if (isNaturalDesireText(mostWant)) {
    lines.push(`most_want: ${mostWant}`);
  }
  if (normalizeText(intent.drive_key) || normalizeText(intent.want_action)) {
    lines.push(`top_intent: ${normalizeText(intent.drive_key) || "attachment"} -> ${normalizeText(intent.want_action) || "none"}`);
  }
  if (Number.isFinite(Number(desireState?.heartbeat?.tension))) {
    lines.push(`heartbeat_tension: ${Number(desireState.heartbeat.tension).toFixed(3)}`);
  }
  if (refractoryActive.length) {
    lines.push(`refractory_active: ${refractoryActive.join(", ")}`);
  }
  return lines.length ? ["Desire snapshot:", ...lines] : [];
}

function isNaturalDesireText(value) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.toLowerCase() === "none") {
    return false;
  }
  return !/^[a-z][a-z0-9_-]*$/i.test(normalized);
}

module.exports = { SystemMessageDispatcher, buildSystemInboundText };
