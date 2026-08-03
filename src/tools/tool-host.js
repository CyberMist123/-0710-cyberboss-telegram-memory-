const { WhereaboutsToolHost } = require("whereabouts-mcp");
const {
  STICKER_DESC_GUIDANCE,
  STICKER_DESC_FIELD_DESCRIPTION,
  STICKER_TAG_GUIDANCE,
} = require("../services/sticker-service");
const { resolveAppTimezone } = require("../utils/app-timezone");
const { formatAppTime } = require("../utils/beijing-time");
const { route1DispatchEnabled } = require("../orchestration/route1-dispatch");
const {
  catalogEnabled, subjectSigningEnabled, route2GateEnabled, resolveToolset, buildManifest, findSchema, assertCapabilityLease,
  RESIDENT_NAMES, THEME_DEFINITIONS, CATALOG_INPUT_SCHEMA, catalogError,
} = require("./tool-catalog-manifest");

class ProjectToolHost {
  constructor({
    services,
    runtimeContextStore,
    toolset = null,
    authorizationCeiling = "",
    chatSelfEscalation = false,
    onSelfEscalation = null,
    route2Lease = null,
  }) {
    this.services = services;
    this.runtimeContextStore = runtimeContextStore;
    this.extraToolHosts = createExtraToolHosts(services);
    this.toolset = toolset;
    this.authorizationCeiling = normalizeAuthorizationCeiling(authorizationCeiling);
    this.chatSelfEscalation = chatSelfEscalation === true;
    this.onSelfEscalation = typeof onSelfEscalation === "function" ? onSelfEscalation : null;
    this.selfEscalatedTools = new Set();
    this.route2Lease = route2Lease && typeof route2Lease === "object" ? Object.freeze({ ...route2Lease }) : null;
  }

  catalogState() {
    const toolset = resolveToolset(this.toolset);
    return { toolset, entries: buildManifest({ projectTools: registeredProjectTools(), aliases: TOOL_ALIASES, extraHosts: this.extraToolHosts, deprecatedNames: DEPRECATED_HIDDEN_TOOL_NAMES })
      .map((entry) => ({ ...entry, authorized: !toolset || toolset.members.has(entry.alias_of || entry.id) })) };
  }

  maxResultBytes(toolName) {
    if (!route2GateEnabled()) return null;
    const alias = TOOL_ALIASES[toolName];
    const canonical = alias?.name || toolName;
    const entry = this.catalogState().entries.find((candidate) => !candidate.alias_of && candidate.id === canonical);
    return Number.isInteger(entry?.max_result_bytes) && entry.max_result_bytes > 0 ? entry.max_result_bytes : null;
  }

  listTools() {
    if (catalogEnabled()) {
      const { entries } = this.catalogState();
      const catalogTools = [buildCatalogDirectoryTool(entries)];
      const resident = RESIDENT_NAMES.map((name) => PROJECT_TOOLS.find((tool) => tool.name === name)).filter(Boolean).map(buildCatalogToolEntry);
      return [...catalogTools, ...resident];
    }
    const builtIn = registeredProjectTools()
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
    const spec = registeredProjectTools().find((candidate) => candidate.name === resolvedToolName);
    const extraHost = this.extraToolHosts.find((host) => hostSupportsToolName(host, toolName));
    const normalizedArgs = args && typeof args === "object" ? { ...args } : {};
    if (toolName === "cyberboss_catalog" && normalizedArgs.handle !== undefined) {
      assertAuthorizedSchema(this.authorizationCeiling, normalizedArgs.handle);
    } else if (toolName !== "cyberboss_catalog") {
      assertAuthorizedCall(this.authorizationCeiling, resolvedToolName);
      assertCapabilityLease(this.route2Lease, resolvedToolName);
    }
    if (catalogEnabled()) {
      if (toolName === "cyberboss_catalog") {
        validateSchema(CATALOG_INPUT_SCHEMA, normalizedArgs, toolName, "input");
        const { entries } = this.catalogState();
        if (normalizedArgs.theme !== undefined && normalizedArgs.handle !== undefined) {
          throw catalogError("catalog_invalid_request", "theme and handle are mutually exclusive");
        }
        if (normalizedArgs.handle !== undefined) {
          const category = String(normalizedArgs.handle).split("/", 1)[0];
          const entry = findSchema({
            entries,
            category,
            handle: normalizedArgs.handle,
            capabilityLease: this.route2Lease,
            allowSelfEscalation: this.chatSelfEscalation,
          });
          const sourceName = entry.alias_of || entry.id;
          const source = registeredProjectTools().find((candidate) => candidate.name === sourceName)
            || this.extraToolHosts.flatMap((host) => host.listTools()).find((candidate) => candidate.name === sourceName);
          if (!source) throw catalogError("catalog_unknown_handle", normalizedArgs.handle);
          if (!entry.authorized) this.recordSelfEscalation(sourceName, toolsetId(this.catalogState().toolset));
          return { text: `Schema loaded: ${entry.schema_handle}`, data: { entry, inputSchema: source.inputSchema } };
        }
        if (normalizedArgs.theme !== undefined) {
          const definition = THEME_DEFINITIONS.find((item) => item.name === normalizedArgs.theme);
          if (!definition) throw catalogError("catalog_unknown_theme", normalizedArgs.theme);
          const themed = displayableCatalogEntries(entries).filter((entry) => entry.theme === definition.name);
          return { text: `${definition.name} catalog`, data: themed };
        }
        const themes = buildThemeIndex(entries);
        return {
          text: themes.map((item) => `${item.name}(${item.count})   ${item.description}`).join("\n"),
          data: themes,
        };
      }
      if (!spec && !extraHost) throw new Error(`Unknown tool: ${toolName}`);
      const { toolset } = this.catalogState();
      if (toolset && !toolset.members.has(resolvedToolName)) {
        if (!this.chatSelfEscalation) throw catalogError("catalog_tool_not_in_toolset", resolvedToolName);
        this.recordSelfEscalation(resolvedToolName, toolset.id);
      }
    }
    if (alias?.command && !normalizedArgs.command) {
      normalizedArgs.command = alias.command;
    }
    if (spec) {
      validateSchema(spec.inputSchema, normalizedArgs, resolvedToolName, "input");
      const resolvedContext = this.resolveContext(context);
      const result = await spec.handler({
        services: this.services,
        args: normalizedArgs,
        context: resolvedContext,
      });
      if (resolvedToolName === "route1_dispatch" && result?.data?.self_confirmed === true) {
        this.recordSelfEscalation("route1_dispatch", toolsetId(this.catalogState().toolset));
      }
      return result;
    }
    if (extraHost) return await extraHost.invokeTool(toolName, normalizedArgs);
    throw new Error(`Unknown tool: ${toolName}`);
  }

  recordSelfEscalation(toolName, toolset) {
    if (this.selfEscalatedTools.has(toolName)) return;
    this.selfEscalatedTools.add(toolName);
    this.onSelfEscalation?.({
      type: "toolset_self_escalation",
      toolset,
      tool: toolName,
      source: "self_escalation",
      scope: "window",
      approval_required: false,
    });
  }

  resolveContext(context = {}) {
    const explicitWorkspaceRoot = normalizeText(context.workspaceRoot);
    const explicitRuntimeId = normalizeText(context.runtimeId);
    const explicitRouteToken = normalizeText(context.routeToken);
    this.runtimeContextStore.load?.();
    const active = this.runtimeContextStore.resolveActiveContext({
      workspaceRoot: explicitWorkspaceRoot,
      runtimeId: explicitRuntimeId,
      routeToken: explicitRouteToken,
    }) || {};
    return {
      runtimeId: explicitRuntimeId || normalizeText(active.runtimeId),
      workspaceRoot: explicitWorkspaceRoot || normalizeText(active.workspaceRoot),
      routeToken: explicitRouteToken || normalizeText(active.routeToken),
      laneKey: normalizeText(context.laneKey) || normalizeText(active.laneKey),
      // Propagated so a tool that sends outbound can refuse rather than guess.
      ambiguousRoute: active.ambiguous === true,
      activeLaneCount: Number(active.activeLaneCount) || 0,
      threadId: normalizeText(context.threadId) || normalizeText(active.threadId),
      bindingKey: normalizeText(context.bindingKey) || normalizeText(active.bindingKey),
      turnId: normalizeText(context.turnId) || normalizeText(active.turnId),
      accountId: normalizeText(context.accountId) || normalizeText(active.accountId),
      senderId: normalizeText(context.senderId) || normalizeText(active.senderId),
      provider: normalizeText(context.provider) || normalizeText(active.provider),
    };
  }
}

function toolsetId(toolset) { return toolset?.id || ""; }

const AUTHORIZATION_CEILINGS = Object.freeze({
  "work-memory-readonly@1": Object.freeze(new Set(["memory_note", "memory_candidate_submit"])),
});

function normalizeAuthorizationCeiling(value) {
  const id = normalizeText(value);
  if (!id) return "";
  if (!Object.hasOwn(AUTHORIZATION_CEILINGS, id)) throw authorizationError("g3_authorization_ceiling_unknown");
  return id;
}

function assertAuthorizedSchema(ceiling, handle) {
  if (!ceiling) return;
  const canonical = String(handle || "").split("/", 2)[1] || "";
  if (AUTHORIZATION_CEILINGS[ceiling].has(canonical)) {
    throw authorizationError("g3_schema_not_authorized");
  }
}

function assertAuthorizedCall(ceiling, toolName) {
  if (ceiling && AUTHORIZATION_CEILINGS[ceiling].has(toolName)) {
    throw authorizationError("g3_call_not_authorized");
  }
}

function authorizationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
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
    ...registeredProjectTools().filter((tool) => tool.hidden !== true).map((tool) => tool.name),
    ...STATIC_EXTRA_TOOL_NAMES.filter((toolName) => !DEPRECATED_HIDDEN_TOOL_NAMES.has(toolName)),
  ];
}

function registeredProjectTools(env = process.env) {
  return PROJECT_TOOLS.filter((tool) => {
    if (tool.name === "memory_candidate_submit") return subjectSigningEnabled(env);
    if (tool.name === "route1_dispatch") return route1DispatchEnabled(env);
    return true;
  });
}

function displayableCatalogEntries(entries) {
  return entries.filter((entry) => !entry.alias_of && entry.hidden !== true);
}

function buildThemeIndex(entries) {
  const displayable = displayableCatalogEntries(entries);
  return THEME_DEFINITIONS.map((definition) => ({
    name: definition.name,
    description: definition.description,
    count: displayable.filter((entry) => entry.theme === definition.name).length,
  }));
}

function buildCatalogDirectoryTool(entries) {
  return {
    name: "cyberboss_catalog",
    description: `Browse ${THEME_DEFINITIONS.length} intention themes or load one exact tool schema by handle.`,
    inputSchema: CATALOG_INPUT_SCHEMA,
  };
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
    name: "route1_dispatch",
    description: "Create and queue one bounded Route 1 engineering task; execution starts only after the current chat turn releases its lock.",
    shortHint: "派一台异步单飞工程车；必要时用本窗口的一次性令牌自确认。",
    topics: ["engineering", "dispatch"],
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string" },
        allowed_paths: { type: "array", items: { type: "string" } },
        forbidden_paths: { type: "array", items: { type: "string" } },
        base_sha: { type: "string" },
        acceptance_tests: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } } },
            required: ["name", "command", "args"],
            additionalProperties: false,
          },
        },
        timeout_ms: { type: "integer", minimum: 1, maximum: 3600000 },
        approval_policy: { type: "string", enum: ["never", "on-request", "untrusted"] },
        task_materials: { type: "array", items: { type: "object" } },
        confirm_token: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      if (!services.route1Dispatch) throw new Error("route1_dispatch_unavailable");
      const result = await services.route1Dispatch.dispatch(args, context);
      return { text: result.text || result.status, data: result };
    },
  },
  {
    name: "github_repo_create",
    description: "Create a GitHub repository through the locally authenticated gh CLI.",
    shortHint: "Create a GitHub repository using the logged-in gh CLI.",
    topics: ["github", "repository"],
    inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, private: { type: "boolean" }, clone: { type: "boolean" } }, required: ["name"], additionalProperties: false },
    async handler({ services, args }) { return services.github.createRepository(args); },
  },
  {
    name: "github_file_upload",
    description: "Create or update one repository file through the GitHub contents API.",
    shortHint: "Upload one file to a GitHub repository.",
    topics: ["github", "repository"],
    inputSchema: { type: "object", properties: { repository: { type: "string" }, path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, branch: { type: "string" }, sha: { type: "string" } }, required: ["repository", "path", "content", "message"], additionalProperties: false },
    async handler({ services, args }) { return services.github.uploadFile(args); },
  },
  {
    name: "github_issue_open",
    description: "Open a GitHub issue through the locally authenticated gh CLI.",
    shortHint: "Open a GitHub issue.",
    topics: ["github", "issue"],
    inputSchema: { type: "object", properties: { repository: { type: "string" }, title: { type: "string" }, body: { type: "string" }, labels: { type: "array", items: { type: "string" } } }, required: ["repository", "title"], additionalProperties: false },
    async handler({ services, args }) { return services.github.openIssue(args); },
  },
  {
    name: "github_pr_open",
    description: "Open a GitHub pull request through the locally authenticated gh CLI.",
    shortHint: "Open a GitHub pull request.",
    topics: ["github", "pull request"],
    inputSchema: { type: "object", properties: { repository: { type: "string" }, title: { type: "string" }, body: { type: "string" }, head: { type: "string" }, base: { type: "string" }, draft: { type: "boolean" } }, required: ["repository", "title", "head"], additionalProperties: false },
    async handler({ services, args }) { return services.github.openPullRequest(args); },
  },
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
    name: "memory_note",
    description: "Append a bounded private Self-note for a future Reflect; it never becomes ordinary chat context.",
    shortHint: "Append one private self-note.", topics: ["memory", "continuity"],
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 1000 }, quote: { type: "string", maxLength: 500 } }, additionalProperties: false },
    async handler({ services, args }) { const result = services.memoryNote?.note(args) || { error: "note_unavailable" }; return { text: result.error ? `Memory note ${result.error}.` : "Memory note appended.", data: result }; },
  },
  {
    name: "memory_candidate_submit",
    description: "Submit subject-authored candidate prose through the current turn's one-time signing capability.",
    shortHint: "Submit one subject-authored memory candidate from the current turn.",
    topics: ["memory", "continuity"],
    inputSchema: {
      type: "object",
      required: ["type", "body", "origin", "source_ref"],
      properties: {
        type: { type: "string", enum: ["episode", "self_note", "reentry_draft", "details"] },
        body: { type: "string" },
        origin: { type: "string", enum: ["live_subject", "closeout_materials_then_subject", "subject_rewrite"] },
        source_ref: {
          type: "object",
          required: ["content_sha256"],
          properties: {
            content_sha256: { type: "string" },
            file: { type: "string" },
            window: { type: "string" },
          },
          additionalProperties: false,
        },
        material_pack_id: { type: "string" },
        material_pack: { type: "object" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const signing = services.subjectSigningContext?.resolve?.(context) || null;
      const subjectRoute = signing?.subject_route;
      const result = services.subjectCandidate.createSubjectCandidate({
        ...args,
        capability_id: signing?.capability?.capability_id,
        subject_turn_id: signing?.capability?.subject_turn_id || subjectRoute?.author_turn_id,
        subject_route: subjectRoute,
        source_ref: {
          ...args.source_ref,
          source_entry_ids: Array.isArray(subjectRoute?.source_entry_ids)
            ? subjectRoute.source_entry_ids
            : [],
        },
      });
      return { text: `Memory candidate ${result.status}.`, data: result };
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
    description: "Read the current local time in the configured application timezone. The returned text is final and must not be converted again.",
    shortHint: "Read the configured local time and use it as-is without UTC conversion.",
    topics: ["time"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler() {
      const value = formatAppTime(new Date());
      return {
        text: value,
        data: {
          value,
          timezone: resolveAppTimezone(),
          format: "本地时间 HH:MM:SS",
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
  "memory.note": { name: "memory_note" },
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
  // Read-only catalog exports for offline metering.  They do not alter host
  // discovery or invocation semantics.
  PROJECT_TOOLS,
  STATIC_EXTRA_TOOL_NAMES,
  TOOL_ALIASES,
  DEPRECATED_HIDDEN_TOOL_NAMES,
  createExtraToolHosts,
  registeredProjectTools,
  buildThemeIndex,
  buildCatalogDirectoryTool,
  ProjectToolHost,
  listProjectToolNames,
};
