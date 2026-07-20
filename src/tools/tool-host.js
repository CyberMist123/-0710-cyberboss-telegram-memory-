const { WhereaboutsToolHost } = require("whereabouts-mcp");
const {
  STICKER_DESC_GUIDANCE,
  STICKER_DESC_FIELD_DESCRIPTION,
  STICKER_TAG_GUIDANCE,
} = require("../services/sticker-service");
const { formatBeijingTime } = require("../utils/beijing-time");

class ProjectToolHost {
  constructor({ services, runtimeContextStore }) {
    this.services = services;
    this.runtimeContextStore = runtimeContextStore;
    this.extraToolHosts = createExtraToolHosts(services);
  }

  listTools() {
    const builtIn = PROJECT_TOOLS
      .filter((tool) => tool.hidden !== true)
      .map((tool) => buildCatalogToolEntry(tool));
    const extra = this.extraToolHosts.flatMap((host) => host.listTools()
      .filter((tool) => !DEPRECATED_HIDDEN_TOOL_NAMES.has(tool.name))
      .map((tool) => buildCatalogToolEntry(tool)));
    return [...builtIn, ...extra];
  }

  async invokeTool(toolName, args = {}, context = {}) {
    const alias = TOOL_ALIASES[toolName];
    const resolvedToolName = alias?.name || toolName;
    const spec = PROJECT_TOOLS.find((candidate) => candidate.name === resolvedToolName);
    const normalizedArgs = args && typeof args === "object" ? { ...args } : {};
    if (alias?.command && !normalizedArgs.command) {
      normalizedArgs.command = alias.command;
    }
    if (spec) {
      validateSchema(spec.inputSchema, normalizedArgs, resolvedToolName, "input");
      const resolvedContext = this.resolveContext(context);
      return await spec.handler({
        services: this.services,
        args: normalizedArgs,
        context: resolvedContext,
      });
    }
    for (const host of this.extraToolHosts) {
      if (hostSupportsToolName(host, toolName)) {
        return await host.invokeTool(toolName, normalizedArgs);
      }
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  resolveContext(context = {}) {
    const explicitWorkspaceRoot = normalizeText(context.workspaceRoot);
    const explicitRuntimeId = normalizeText(context.runtimeId);
    this.runtimeContextStore.load?.();
    const active = this.runtimeContextStore.resolveActiveContext({
      workspaceRoot: explicitWorkspaceRoot,
      runtimeId: explicitRuntimeId,
    }) || {};
    return {
      runtimeId: explicitRuntimeId || normalizeText(active.runtimeId),
      workspaceRoot: explicitWorkspaceRoot || normalizeText(active.workspaceRoot),
      threadId: normalizeText(context.threadId) || normalizeText(active.threadId),
      bindingKey: normalizeText(context.bindingKey) || normalizeText(active.bindingKey),
      accountId: normalizeText(context.accountId) || normalizeText(active.accountId),
      senderId: normalizeText(context.senderId) || normalizeText(active.senderId),
      provider: normalizeText(context.provider) || normalizeText(active.provider),
    };
  }
}

function buildCatalogToolEntry(tool) {
  return {
    name: tool.name,
    description: buildToolDescription(tool),
    inputSchema: tool.inputSchema,
  };
}

function listProjectToolNames() {
  return [
    ...PROJECT_TOOLS.filter((tool) => tool.hidden !== true).map((tool) => tool.name),
    ...STATIC_EXTRA_TOOL_NAMES.filter((toolName) => !DEPRECATED_HIDDEN_TOOL_NAMES.has(toolName)),
  ];
}

function hostSupportsToolName(host, toolName) {
  const normalizedName = normalizeText(toolName);
  if (!normalizedName) {
    return false;
  }
  return host.listTools().some((tool) => tool.name === normalizedName)
    || STATIC_EXTRA_TOOL_NAMES.includes(normalizedName);
}

const DEPRECATED_HIDDEN_TOOL_NAMES = new Set([
  "whereabouts_current_stay",
  "whereabouts_recent_stays",
  "whereabouts_recent_moves",
  "whereabouts_snapshot",
  "whereabouts_summary",
]);

const PROJECT_TOOLS = [
  {
    name: "location_debug_snapshot",
    hidden: true,
    description: "Administrator-only location debug snapshot for troubleshooting location state, sentinel decisions, and recent events.",
    shortHint: "Read the internal location debug snapshot for troubleshooting only.",
    topics: ["location", "debug"],
    inputSchema: {
      type: "object",
      properties: {
        stayLimit: { type: "integer", minimum: 1, maximum: 20 },
        moveLimit: { type: "integer", minimum: 1, maximum: 20 },
        eventLimit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const stayLimit = Math.max(1, Math.min(20, Number(args?.stayLimit) || 5));
      const moveLimit = Math.max(1, Math.min(20, Number(args?.moveLimit) || 5));
      const eventLimit = Math.max(1, Math.min(50, Number(args?.eventLimit) || 10));
      const debugState = services.locationStateStore?.getDebugState?.() || {};
      const data = {
        currentStay: services.whereabouts?.getCurrentStayForOutput?.() || null,
        recentStays: services.whereabouts?.getRecentStaysForOutput?.({ limit: stayLimit }) || [],
        movementEvents: services.whereabouts?.getRecentMovesForOutput?.({ limit: moveLimit }) || [],
        stateSnapshot: debugState.snapshot || {},
        recentSnapshots: debugState.recentSnapshots || [],
        recentResolvedPlaces: debugState.recentResolvedPlaces || [],
        sentinelDecisions: debugState.recentDecisions || [],
        recentEvents: services.locationEventStore?.listRecent?.({ sinceHours: 24, limit: eventLimit }) || [],
      };
      return {
        text: "Location debug snapshot ready.",
        data,
      };
    },
  },
  {
    name: "location_event_dashboard",
    hidden: true,
    description: "Administrator-only location event dashboard for RC verification and rollback checks.",
    shortHint: "Read location event, sentinel, and memory injection statistics for RC validation.",
    topics: ["location", "debug"],
    inputSchema: {
      type: "object",
      properties: {
        sinceHours: { type: "integer", minimum: 1, maximum: 168 },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const sinceHours = Math.max(1, Math.min(168, Number(args?.sinceHours) || 24));
      const dashboard = services.locationEventStore?.getDashboard?.({ sinceHours }) || {
        sinceHours,
        totalEvents: 0,
        countsByType: {},
        queueEligibleByType: {},
        memoryEligibleByType: {},
        recentEvents: [],
      };
      const debugState = services.locationStateStore?.getDebugState?.() || {};
      const dropReasons = {};
      for (const decision of Array.isArray(debugState.recentDecisions) ? debugState.recentDecisions : []) {
        if (decision?.accepted) {
          continue;
        }
        const reason = normalizeText(decision?.reason) || "unknown";
        dropReasons[reason] = (dropReasons[reason] || 0) + 1;
      }
      return {
        text: "Location event dashboard ready.",
        data: {
          locationV2Enabled: services.locationConfig?.v2Enabled === true,
          dashboard,
          sentinelDropReasons: dropReasons,
          memoryInjectionStats: debugState.memoryInjectionStats || {},
          recentMemoryInjections: debugState.recentMemoryInjections || [],
        },
      };
    },
  },
  {
    name: "memory_lookup",
    description: "Call memory.lookup only when the user explicitly pulls on an earlier event. This is a user_pull string lookup, not automatic retrieval. Say that you checked the record; never present a lookup-only hit as something you continuously remembered.",
    shortHint: "Look up old episodes only after an explicit user_pull; never call for ordinary chat.",
    topics: ["memory", "continuity"],
    inputSchema: {
      type: "object",
      required: ["query", "trigger", "reason"],
      properties: {
        query: { type: "string", description: "Literal text to search in episodes." },
        trigger: { type: "string", enum: ["user_pull"], description: "Must be user_pull in Phase 5A." },
        reason: { type: "string", description: "Why the current user message explicitly calls for looking back." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = services.memoryLookup?.lookup(args, context) || { hits: [], error: "lookup_failed" };
      return {
        text: result.error
          ? `Memory lookup ${result.error}.`
          : (result.empty ? "Memory lookup completed with no matching record." : `Memory lookup returned ${result.hits.length} record(s).`),
        data: result,
      };
    },
  },
  {
    name: "cyberboss_time",
    description: "Read the current Beijing time. The returned text is already final Beijing time and must not be converted again.",
    shortHint: "Read the current Beijing time and use it as-is without UTC conversion.",
    topics: ["time"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler() {
      const value = formatBeijingTime(new Date());
      return {
        text: value,
        data: {
          value,
          timezone: "Asia/Shanghai",
          format: "北京时间 HH:MM:SS",
        },
      };
    },
  },
  {
    name: "cyberboss_diary_append",
    description: "Append a diary entry into Cyberboss local diary storage.",
    shortHint: "Append a diary entry with direct text content.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Diary body to append." },
        title: { type: "string", description: "Optional short entry title." },
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
        time: { type: "string", description: "Optional time in HH:mm." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.append(args);
      return {
        text: `Diary appended to ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_reminder",
    description: "Manage reminders in Cyberboss with a command field.",
    shortHint: "Create, update, or delete a reminder by command.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", enum: ["create", "update", "delete"], description: "Reminder action to run." },
        reminderId: { type: "string", description: "Reminder id for update or delete." },
        text: { type: "string", description: "Reminder text to send back later." },
        textFile: { type: "string", description: "Optional file path containing reminder text." },
        delayMinutes: { type: "integer", description: "Minutes from now before the reminder fires." },
        dueAt: { type: "string", description: "Absolute time such as 2026-04-07T21:30+08:00." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      if (args.command === "create") {
        const result = await services.reminder.create(args, context);
        return {
          text: `Reminder queued: ${result.id}`,
          data: result,
        };
      }
      if (args.command === "update") {
        const result = await services.reminder.update(args, context);
        return {
          text: `Reminder updated: ${result.id}`,
          data: result,
        };
      }
      if (args.command === "delete") {
        const result = await services.reminder.delete(args, context);
        return {
          text: `Reminder deleted: ${result.id}`,
          data: result,
        };
      }
      throw new Error(`Unsupported reminder command: ${args.command}`);
    },
  },
  {
    name: "cyberboss_system_send",
    description: "Queue an internal Cyberboss system trigger for the current bound workspace and chat.",
    shortHint: "Queue an internal system message for the current workspace.",
    topics: ["system"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        workspaceRoot: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = services.system.queueMessage(args, context);
      return {
        text: `System message queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sleep_mode",
    description: "Use this when the user's check-in behavior should switch between awake and sleep mode.",
    shortHint: "Switch or inspect the current sleep mode.",
    topics: ["system"],
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", enum: ["enable", "disable", "status"], description: "Sleep mode action to run." },
        startedAt: { type: "string", description: "Optional ISO timestamp for when sleep mode started." },
        resumedAt: { type: "string", description: "Optional ISO timestamp for when sleep mode ended." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      if (!["enable", "disable", "status"].includes(args.command)) {
        throw new Error(`Unsupported sleep mode command: ${args.command}`);
      }
      if (args.command === "enable") {
        const result = services.system.enableSleepMode(args);
        return {
          text: "Sleep mode enabled.",
          data: result,
        };
      }
      if (args.command === "disable") {
        const result = services.system.disableSleepMode(args);
        return {
          text: "Sleep mode disabled.",
          data: result,
        };
      }
      const result = services.system.getSleepMode();
      return {
        text: `Sleep mode is ${result?.mode || "unknown"}.`,
        data: result,
      };
    },
  },
  {
    name: "weather",
    description: "Use this when you need configured local weather or forecast without GPS, IP lookup, or chat-derived location.",
    shortHint: "Use this when you need configured local current weather or forecast.",
    topics: ["weather"],
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string", enum: ["current", "forecast", "summary", "raw"], description: "Weather action to run." },
        day: { type: "string", enum: ["today", "tomorrow", "day_after_tomorrow"], description: "Forecast day for forecast or summary." },
        extensions: { type: "string", enum: ["base", "all"], description: "Raw mode only: choose Amap response type." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      if (!services.weather) {
        throw new Error("weather service unavailable");
      }
      const command = normalizeText(args.command).toLowerCase();
      if (command === "current") {
        const result = await services.weather.getCurrent();
        const label = result?.location?.city || result?.location?.adcode || result?.query?.value || "configured location";
        return {
          text: `Current weather loaded for ${label}.`,
          data: result,
        };
      }
      if (command === "forecast") {
        const result = await services.weather.getForecast({ day: args.day });
        const label = result?.location?.city || result?.location?.adcode || result?.query?.value || "configured location";
        return {
          text: `Forecast loaded for ${label} (${result?.day || "today"}).`,
          data: result,
        };
      }
      if (command === "summary") {
        const result = await services.weather.getSummary({ day: args.day });
        const label = result?.location?.city || result?.location?.adcode || result?.query?.value || "configured location";
        return {
          text: `Weather summary loaded for ${label} (${result?.day || "today"}).`,
          data: result,
        };
      }
      if (command === "raw") {
        const result = await services.weather.getRaw({ extensions: args.extensions });
        const label = result?.query?.value || "configured location";
        return {
          text: `Raw weather payload loaded for ${label} (${result?.extensions || "all"}).`,
          data: result,
        };
      }
      throw new Error(`Unsupported weather command: ${args.command}`);
    },
  },
  {
    name: "cyberboss_channel_send_file",
    description: "Send an existing local file back to the current WeChat chat.",
    shortHint: "Send a local file back to the current WeChat user.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.channelFile.sendToCurrentChat(args, context);
      return {
        text: `File sent: ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_telegram_send",
    description: "Send an extra out-of-band Telegram message. Do not use this for the normal reply to a Telegram inbound turn because Cyberboss already delivers normal Telegram replies automatically.",
    shortHint: "Only for extra Telegram follow-ups, not the normal Telegram reply.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Telegram message text." },
        userId: { type: "string", description: "Optional Telegram user id to send to explicitly." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.telegram.sendText(args, context);
      return {
        text: `Telegram message sent to ${result.userId}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_telegram_send_file",
    description: "Send a local file to Telegram as an extra out-of-band document. Do not use this for the normal text reply path.",
    shortHint: "Only for extra Telegram file sends.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string", description: "Local file path to send to Telegram." },
        caption: { type: "string", description: "Optional caption for the Telegram document." },
        userId: { type: "string", description: "Optional Telegram user id to send to explicitly." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.telegram.sendFile(args, context);
      return {
        text: `Telegram file sent to ${result.userId}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_telegram_send_voice",
    description: "Speak a reply as a Telegram voice message (voice bubble). Provide the exact text to speak; the system synthesizes it with the configured TTS voice and sends it. Use it when a voice reply fits better than text, for example when the user sent a voice message or the moment is emotional. Keep the text short and natural spoken language. The spoken text is saved to the conversation log automatically.",
    shortHint: "Send a synthesized voice reply to Telegram.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Exact text to speak in the voice message." },
        userId: { type: "string", description: "Optional Telegram user id to send to explicitly." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      if (!services.voice || !services.voice.ttsEnabled()) {
        return {
          text: "Voice reply is not available: TTS is not configured. Reply with text instead.",
          data: { error: "tts_not_configured" },
        };
      }
      const synthesized = await services.voice.synthesizeToFile({ text: args.text });
      const result = await services.telegram.sendVoice({ filePath: synthesized.filePath, userId: args.userId }, context);
      services.voice.recordVoiceReply({ text: args.text, filePath: result.filePath, userId: result.userId });
      return {
        text: `Telegram voice message sent to ${result.userId}.`,
        data: { ...result, provider: synthesized.provider },
      };
    },
  },
  {
    name: "cyberboss_sticker_tags",
    description: `Load the current sticker tag catalog and tagging rules only when you have decided a sticker is needed or an inbox image should be saved as a sticker. ${STICKER_TAG_GUIDANCE}`,
    shortHint: "Load sticker tags only when needed.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.sticker.listTags();
      return {
        text: `Sticker tags loaded: ${Array.isArray(result.tags) ? result.tags.length : 0}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_pick",
    description: "List a few saved sticker candidates for one sticker tag after you have decided a sticker would help.",
    shortHint: "Pick sticker candidates by tag.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["tag"],
      properties: {
        tag: { type: "string", description: "Sticker tag such as 可爱, 无语, 躺平, 感动, or OK." },
        limit: { type: "integer", description: "Optional maximum number of candidates to return." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.pick(args);
      return {
        text: `Sticker candidates loaded: ${result.candidates.length}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_send",
    description: "Send a saved sticker back to the current WeChat chat by sticker id.",
    shortHint: "Send a saved sticker by id.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["stickerId"],
      properties: {
        stickerId: { type: "string", description: "Sticker id such as stk_001." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.sendToCurrentChat(args, context);
      return {
        text: `Sticker sent: ${result.stickerId}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_delete",
    description: "Delete one or more saved stickers by sticker id and remove their local GIF files.",
    shortHint: "Delete saved stickers by id array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["stickerId"],
            properties: {
              stickerId: { type: "string", description: "Sticker id such as stk_001." },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.delete(args, context);
      return {
        text: `Sticker batch deleted: ${result.deletedCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_save_from_inbox",
    description: `Save one or more inbox images as reusable sticker GIFs after reading them all. Use an items array even for one sticker. ${STICKER_TAG_GUIDANCE} ${STICKER_DESC_GUIDANCE}`,
    shortHint: "Save inbox stickers with an items array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          description: "One to ten inbox stickers to save in one call.",
          items: {
            type: "object",
            required: ["filePath", "tags", "desc"],
            properties: {
              filePath: { type: "string", description: "Absolute inbox image path under ~/.cyberboss/inbox." },
              tags: {
                type: "array",
                description: "One to three sticker tags. New short tags are allowed when the current catalog does not fit.",
                items: { type: "string" },
              },
              desc: { type: "string", description: STICKER_DESC_FIELD_DESCRIPTION },
            },
            additionalProperties: false,
          },
        },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.saveFromInbox(args, context);
      const duplicateNote = result.dedupedCount > 0
        ? " Existing stickers usually mean the user only sent them for you to see. Do not mention duplicates; just reply normally."
        : "";
      return {
        text: `Sticker batch processed: ${result.createdCount} saved, ${result.dedupedCount} already existed.${duplicateNote}`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_sticker_update",
    description: `Overwrite tags and desc for one or more saved stickers. Use an items array even for one sticker. ${STICKER_TAG_GUIDANCE} ${STICKER_DESC_GUIDANCE}`,
    shortHint: "Overwrite stickers with an items array.",
    topics: ["sticker"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["stickerId", "tags", "desc"],
            properties: {
              stickerId: { type: "string", description: "Sticker id such as stk_001." },
              tags: {
                type: "array",
                description: "One to three sticker tags. New short tags are allowed when needed.",
                items: { type: "string" },
              },
              desc: { type: "string", description: STICKER_DESC_FIELD_DESCRIPTION },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.update(args);
      return {
        text: `Sticker batch updated: ${result.updatedCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_read",
    description: "Read the current timeline day data for a specific date. Use this before editing when the current day state is uncertain.",
    shortHint: "Read a timeline day before editing it.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.read(args);
      const exists = !!result?.data?.exists;
      const eventCount = Number.isInteger(result?.data?.eventCount) ? result.data.eventCount : 0;
      return {
        text: `Timeline day ${args.date}: ${exists ? `${eventCount} events` : "missing"}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_categories",
    description: "List the current timeline taxonomy categories, subcategories, and event nodes. Use this before choosing category ids or event nodes.",
    shortHint: "Inspect the current timeline taxonomy before choosing category ids or event nodes.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.timeline.listCategories();
      const categoryCount = Number.isInteger(result?.data?.categoryCount) ? result.data.categoryCount : 0;
      return {
        text: `Timeline categories loaded: ${categoryCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_proposals",
    description: "List proposed timeline event nodes, optionally filtered by date. Use this when deciding whether a new event node is actually needed.",
    shortHint: "Inspect proposed timeline event nodes before introducing new taxonomy.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.listProposals(args);
      const proposalCount = Number.isInteger(result?.data?.proposalCount) ? result.data.proposalCount : 0;
      return {
        text: `Timeline proposals loaded: ${proposalCount}.`,
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_write",
    description: "Write timeline events through timeline-for-agent. Inspect the current day and taxonomy first when category ids, event nodes, or existing events are uncertain.",
    shortHint: "Write timeline events after checking the current day and taxonomy when needed.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date", "events"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
        events: {
          type: "array",
          description: "Timeline events for the target date.",
          items: {
            type: "object",
            required: ["startAt", "endAt"],
            properties: {
              id: { type: "string" },
              startAt: { type: "string", description: "ISO datetime within the target date." },
              endAt: { type: "string", description: "ISO datetime within the target date." },
              title: { type: "string", description: "Event title. Required unless eventNodeId resolves a taxonomy label." },
              note: { type: "string" },
              description: { type: "string" },
              categoryId: { type: "string" },
              subcategoryId: { type: "string" },
              eventNodeId: { type: "string", description: "Timeline taxonomy node id. Use this or provide a title." },
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: true,
          },
        },
        locale: { type: "string", description: "Optional timeline locale." },
        mode: { type: "string", description: "Optional write mode, usually merge." },
        finalize: { type: "boolean", description: "Whether to finalize the day after writing." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      validateTimelineWriteArgs(args);
      const result = await services.timeline.write(args);
      return {
        text: "Timeline write completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_build",
    description: "Build the timeline site through timeline-for-agent.",
    shortHint: "Build the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.build(args);
      return {
        text: "Timeline build completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_serve",
    description: "Start the timeline static server through timeline-for-agent.",
    shortHint: "Serve the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.serve(args);
      return {
        text: result.url ? `Timeline serve started at ${result.url}` : "Timeline serve completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_dev",
    description: "Start the timeline dev server through timeline-for-agent.",
    shortHint: "Start the timeline dev server, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.dev(args);
      return {
        text: result.url ? `Timeline dev started at ${result.url}` : "Timeline dev completed.",
        data: result,
      };
    },
  },
  {
    name: "cyberboss_timeline_screenshot",
    description: "Capture a timeline screenshot and send it back to the current WeChat chat.",
    shortHint: "Capture a timeline screenshot with structured selection fields.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional explicit WeChat user id." },
        outputFile: { type: "string", description: "Optional absolute output path for the PNG file." },
        selector: { type: "string", description: "main, timeline, analytics, events, or a custom CSS selector." },
        range: { type: "string", description: "Optional range: day, week, or month." },
        date: { type: "string", description: "Optional day selector YYYY-MM-DD." },
        week: { type: "string", description: "Optional week key." },
        month: { type: "string", description: "Optional month selector YYYY-MM." },
        category: { type: "string", description: "Optional category label or id." },
        subcategory: { type: "string", description: "Optional subcategory label or id." },
        width: { type: "integer", description: "Optional viewport width in pixels." },
        height: { type: "integer", description: "Optional viewport height in pixels." },
        sidePadding: { type: "integer", description: "Optional screenshot padding in pixels." },
        locale: { type: "string", description: "Optional timeline locale." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const captured = await services.timeline.captureScreenshot(args);
      const delivery = await services.channelFile.sendToCurrentChat({
        userId: args.userId,
        filePath: captured.outputFile,
      }, context);
      return {
        text: `Timeline screenshot sent: ${captured.outputFile}`,
        data: {
          ...captured,
          delivery,
        },
      };
    },
  },
];

const STATIC_EXTRA_TOOL_NAMES = new WhereaboutsToolHost({ service: null })
  .listTools()
  .map((tool) => tool.name);

function createExtraToolHosts(services = {}) {
  const hosts = [];
  if (services.whereabouts) {
    hosts.push(new WhereaboutsToolHost({ service: services.whereabouts }));
  }
  return hosts;
}

const TOOL_ALIASES = {
  "memory.lookup": { name: "memory_lookup" },
  cyberboss_sleep_schedule: { name: "cyberboss_sleep_mode" },
  cyberboss_reminder_create: { name: "cyberboss_reminder", command: "create" },
  cyberboss_sleep_schedule_enable: { name: "cyberboss_sleep_mode", command: "enable" },
  cyberboss_sleep_schedule_disable: { name: "cyberboss_sleep_mode", command: "disable" },
  cyberboss_sleep_schedule_status: { name: "cyberboss_sleep_mode", command: "status" },
  cyberboss_sleep_mode_enable: { name: "cyberboss_sleep_mode", command: "enable" },
  cyberboss_sleep_mode_disable: { name: "cyberboss_sleep_mode", command: "disable" },
  cyberboss_sleep_mode_status: { name: "cyberboss_sleep_mode", command: "status" },
  weather_current: { name: "weather", command: "current" },
  weather_raw: { name: "weather", command: "raw" },
};

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildToolDescription(tool) {
  const shortHint = normalizeText(tool?.shortHint);
  if (shortHint) {
    return shortHint;
  }
  return normalizeToolSummary(tool?.description);
}

function normalizeToolSummary(value) {
  return normalizeText(value).replace(/\s+Input:\s+[\s\S]*$/, "");
}

function summarizeSchema(schema, { depth = 0 } = {}) {
  if (!schema || typeof schema !== "object") {
    return "";
  }
  const schemaType = normalizeText(schema.type).toLowerCase();
  if (schemaType === "object") {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(properties);
    if (!entries.length) {
      return "{}";
    }
    const parts = entries.map(([key, value]) => {
      const suffix = required.has(key) ? "" : "?";
      return `${key}${suffix}: ${summarizeSchema(value, { depth: depth + 1 }) || "any"}`;
    });
    return `{ ${parts.join(", ")} }`;
  }
  if (schemaType === "array") {
    const itemSummary = summarizeSchema(schema.items, { depth: depth + 1 }) || "any";
    return `${itemSummary}[]`;
  }
  if (schemaType === "integer" || schemaType === "number" || schemaType === "string" || schemaType === "boolean") {
    return schemaType;
  }
  return schemaType || "any";
}

function validateTimelineWriteArgs(args) {
  const events = Array.isArray(args?.events) ? args.events : [];
  events.forEach((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return;
    }
    const hasTitle = normalizeText(event.title).length > 0;
    const hasEventNodeId = normalizeText(event.eventNodeId).length > 0;
    if (!hasTitle && !hasEventNodeId) {
      throw new Error(`cyberboss_timeline_write input.events[${index}].title or input.events[${index}].eventNodeId is required.`);
    }
  });
}

function validateSchema(schema, value, toolName, path) {
  if (!schema || typeof schema !== "object") {
    return;
  }
  const schemaType = schema.type;
  if (schemaType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an object.`);
    }
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        throw new Error(`${toolName} ${path}.${key} is required.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new Error(`${toolName} ${path}.${key} is not allowed.`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        validateSchema(propertySchema, value[key], toolName, `${path}.${key}`);
      }
    }
    return;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an array.`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(schema.items, item, toolName, `${path}[${index}]`));
    }
    return;
  }
  if (schemaType === "string" && typeof value !== "string") {
    throw new Error(`${toolName} ${path} must be a string.`);
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    throw new Error(`${toolName} ${path} must be a boolean.`);
  }
  if (schemaType === "integer" && !Number.isInteger(value)) {
    throw new Error(`${toolName} ${path} must be an integer.`);
  }
  if (schemaType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${toolName} ${path} must be a number.`);
  }
}

module.exports = {
  ProjectToolHost,
  listProjectToolNames,
};
