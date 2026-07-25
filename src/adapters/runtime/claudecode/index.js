const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ClaudeCodeProcessClient } = require("./process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("./events");
const { ensureClaudeProjectMcpConfig } = require("./project-settings");
const { SessionSlotStore, buildSessionSlotKey } = require("./session-slot");
const { ProcessRegistry, buildProcessKey } = require("./process-registry");
const { fingerprintLaunchProfile, profileLogicalIdentity } = require("./launch-profile");
const {
  buildLegacyRouteLane,
  buildSystemRouteLane,
} = require("../../../core/route-lane");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { ClaudeCodeIpcServer } = require("./ipc-server");
const {
  finalizeOpeningContext,
  loadContextGates,
  prepareOpeningContext,
  prepareOrdinaryContext,
  prepareRefreshContext,
} = require("../../../core/hard-context");
const CLAUDE_RESUME_SESSION_TIMEOUT_MS = 8000;

function createClaudeCodeRuntimeAdapter(config) {
  const stateDir = normalizeText(config.stateDir);
  if (!stateDir) {
    throw new Error("CYBERBOSS_STATE_DIR is required for the Claude runtime adapter.");
  }
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "claudecode" });
  // Claude transcripts are keyed by session slot (workspace + route lane +
  // profile fingerprint), never by the continuity binding alone. The legacy
  // SessionStore keeps binding-level state and receives a mirrored write so
  // reverse threadId -> binding lookups elsewhere keep working, but a resume id
  // is only ever *read* from the slot store, which is what makes it impossible
  // for lane B to `--resume` lane A's session.
  const sessionSlotStore = new SessionSlotStore({
    filePath: config.claudeSessionSlotsFile
      || (stateDir ? path.join(stateDir, "claude-session-slots.json") : ""),
  });
  const processRegistry = new ProcessRegistry({
    maxProcesses: Number.isSafeInteger(config.claudeMaxProcesses) && config.claudeMaxProcesses > 0
      ? config.claudeMaxProcesses
      : undefined,
  });
  const launchProfileBaseDir = normalizeText(config.claudeLaunchProfileBaseDir)
    || normalizeText(config.configDir)
    || stateDir;
  const allowAuthBackendOverride = config.claudeAllowAuthBackendOverride === true;
  const allowCloudCredentialInheritance = config.claudeAllowCloudCredentialInheritance === true;
  const pendingModelByWorkspaceRoot = new Map();
  const configuredModel = normalizeText(config.claudeModel);
  const configuredAgentCwd = normalizeText(config.agentCwd);
  let globalListener = null;
  const ipcSocketPath = path.join(
    stateDir,
    "claudecode-runtime.sock",
  );
  const ipcServer = new ClaudeCodeIpcServer({
    stateDir,
  });

  hydrateRuntimeModelsFromClaudeProjects();

  ipcServer.on("clientMessage", (msg) => {
    if (msg?.type === "sendUserMessage" && msg?.workspaceRoot) {
      void handleIpcSendUserMessage(msg);
    }
    if (msg?.type === "respondApproval" && msg?.workspaceRoot) {
      void handleIpcRespondApproval(msg);
    }
  });

  function resolveModel(model = "") {
    return configuredModel || normalizeText(model);
  }

  function findBindingForWorkspaceRoot(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    for (const [bindingKey, binding] of Object.entries(sessionStore.listBindings())) {
      if (normalizeText(binding?.activeWorkspaceRoot) === normalizedWorkspaceRoot) {
        return { bindingKey, binding };
      }
      if (sessionStore.listWorkspaceRoots(bindingKey).includes(normalizedWorkspaceRoot)) {
        return { bindingKey, binding };
      }
    }
    return null;
  }

  async function ensureClientForIpcWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    // The shared-open IPC console attaches to whatever process is already live
    // for the workspace. It never creates a lane of its own and never selects a
    // profile, so it cannot pull a profiled lane's session into a bare launch.
    const existing = processRegistry.listEntries().find(
      (entry) => entry.workspaceRoot === normalizedWorkspaceRoot && entry.client?.alive,
    );
    if (existing) {
      return existing.client;
    }
    const bindingEntry = findBindingForWorkspaceRoot(normalizedWorkspaceRoot);
    const bindingKey = bindingEntry?.bindingKey || "";
    if (!bindingKey) {
      return null;
    }
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, normalizedWorkspaceRoot);
    const route = resolveRouteContext({
      bindingKey,
      workspaceRoot: normalizedWorkspaceRoot,
      lane: null,
      launchProfile: null,
      model: runtimeParams.model || "",
    });
    const attached = await attachProcessToSession(route, { threadId: route.storedThreadId });
    return attached?.client || null;
  }

  /**
   * Resolve the full route identity for one runtime call.
   *
   * lane        -> delivery/serialization identity (from the channel)
   * profile     -> validated launch profile selected for that lane, or null
   * sessionSlot -> workspace + lane + profile fingerprint
   * processKey  -> sessionSlot + launch fingerprint + cwd/config identity
   */
  function resolveRouteContext({
    bindingKey = "",
    workspaceRoot = "",
    lane = null,
    launchProfile = null,
    model = "",
  } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const effectiveLane = lane && lane.laneKey
      ? lane
      : buildLegacyRouteLane({ provider: "runtime", bindingKey: bindingKey || normalizedWorkspaceRoot || "default" });
    const profileFingerprint = fingerprintLaunchProfile(launchProfile, {
      baseDir: launchProfileBaseDir,
      allowAuthBackendOverride,
    });
    const sessionSlotKey = buildSessionSlotKey({
      runtimeId: "claudecode",
      workspaceRoot: normalizedWorkspaceRoot,
      laneKey: effectiveLane.laneKey,
      profileFingerprint,
    });
    const agentCwd = resolveAgentCwd(configuredAgentCwd, normalizedWorkspaceRoot);
    const configIdentity = [
      normalizeText(config.claudeConfigDir),
      normalizeText(config.claudePermissionMode || "default"),
      normalizeText(config.claudeCommand || "claude"),
    ].join("|");

    // A stored session id is only ever read from this slot. The legacy store is
    // consulted exactly once, for the profile-free lane, so an upgrade keeps
    // resuming the session it already had instead of opening a new transcript.
    let storedThreadId = sessionSlotStore.getThreadId(sessionSlotKey);
    if (!storedThreadId && profileFingerprint === "legacy" && bindingKey) {
      storedThreadId = normalizeThreadId(
        sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot),
      );
    }

    return {
      bindingKey,
      workspaceRoot: normalizedWorkspaceRoot,
      lane: effectiveLane,
      launchProfile: launchProfile || null,
      profileFingerprint,
      profileId: profileLogicalIdentity(launchProfile),
      sessionSlotKey,
      storedThreadId,
      agentCwd,
      configIdentity,
      model: resolveModel(model),
    };
  }

  function storeSlotThreadId(route, threadId, metadata = {}) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId || !route?.sessionSlotKey) {
      return;
    }
    sessionSlotStore.setThreadId(route.sessionSlotKey, normalizedThreadId);
    if (route.bindingKey && route.workspaceRoot) {
      // Mirror into the binding-level store so threadId -> binding lookups
      // elsewhere continue to resolve. This mirror is never used as a resume
      // source; resume ids come from the slot store only.
      sessionStore.setThreadIdForWorkspace(
        route.bindingKey,
        route.workspaceRoot,
        normalizedThreadId,
        metadata,
      );
    }
  }

  function clearSlotThreadId(route) {
    if (!route?.sessionSlotKey) {
      return;
    }
    sessionSlotStore.clear(route.sessionSlotKey);
    if (route.profileFingerprint === "legacy" && route.bindingKey && route.workspaceRoot) {
      sessionStore.clearThreadIdForWorkspace(route.bindingKey, route.workspaceRoot);
    }
  }

  async function handleIpcSendUserMessage(msg) {
    try {
      const client = await ensureClientForIpcWorkspace(msg.workspaceRoot);
      if (!client?.alive) {
        ipcServer.broadcast({
          type: "stderr",
          text: `[shared-open] no active ClaudeCode client for workspace ${msg.workspaceRoot}`,
        });
        return;
      }
      await client.sendUserMessage({ text: msg.text || "" });
    } catch (error) {
      ipcServer.broadcast({
        type: "stderr",
        text: `[shared-open] failed to send message: ${error.message || String(error)}`,
      });
    }
  }

  async function handleIpcRespondApproval(msg) {
    try {
      const client = await ensureClientForIpcWorkspace(msg.workspaceRoot);
      if (!client?.alive) {
        ipcServer.broadcast({
          type: "stderr",
          text: `[shared-open] no active ClaudeCode client for workspace ${msg.workspaceRoot}`,
        });
        return;
      }
      await client.sendResponse(msg.requestId, { decision: msg.decision });
    } catch (error) {
      ipcServer.broadcast({
        type: "stderr",
        text: `[shared-open] failed to respond to approval: ${error.message || String(error)}`,
      });
    }
  }

  function computeProcessKey(route) {
    return buildProcessKey({
      sessionSlotKey: route.sessionSlotKey,
      // The launch fingerprint is derived from the profile identity here; the
      // process client recomputes the *effective* fingerprint at spawn time and
      // stores it, so a change in either produces a different key.
      launchFingerprint: route.profileFingerprint,
      cwd: route.agentCwd,
      configIdentity: route.configIdentity,
    });
  }

  function createProcessClient(route, processKey) {
    const { workspaceRoot } = route;
    const projectSettings = ensureClaudeProjectMcpConfig({
      workspaceRoot,
      cyberbossHome: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
    });
    console.log(
      `[claudecode-runtime] workspace=${workspaceRoot} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`
    );
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      commandPrefixArgs: config.claudeCommandPrefixArgs || [],
      cwd: route.agentCwd,
      env: filterClaudeCodeEnv(process.env),
      model: route.model,
      permissionMode: config.claudePermissionMode || "default",
      disableVerbose: Boolean(config.claudeDisableVerbose),
      extraArgs: config.claudeExtraArgs || [],
      mcpConfigPaths: [projectSettings.configPath],
      launchProfile: route.launchProfile,
      launchProfileBaseDir,
      allowAuthBackendOverride,
      allowCloudCredentialInheritance,
      onLaunchTelemetry: config.onClaudeLaunchTelemetry,
      ipcServer,
      workspaceRoot,
      laneKey: route.lane.laneKey,
      sessionSlotKey: route.sessionSlotKey,
      processKey,
    });

    client.onMessage((event, raw) => {
      rememberObservedModelForWorkspace(workspaceRoot, extractClaudeMessageModel(raw));
      if (event.type === "session.id") {
        // Bound to this client's own slot only. The pre-v2 code walked every
        // binding whose activeWorkspaceRoot matched, which is how one lane's
        // session id could be written over another lane's.
        storeSlotThreadId(route, event.sessionId);
        return;
      }
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped?.payload && !mapped.payload.workspaceRoot) {
        mapped.payload.workspaceRoot = workspaceRoot;
      }
      if (mapped?.payload) {
        mapped.payload.laneKey = route.lane.laneKey;
        mapped.payload.sessionSlotKey = route.sessionSlotKey;
        mapped.payload.processKey = processKey;
      }
      if (mapped?.type === "runtime.approval.requested") {
        processRegistry.rememberApproval(mapped.payload.requestId, {
          processKey,
          sessionSlotKey: route.sessionSlotKey,
          laneKey: route.lane.laneKey,
        });
      }
      if (mapped?.type === "runtime.turn.failed") {
        processRegistry.delete(processKey);
      }
      if (mapped && globalListener) {
        globalListener(mapped, raw);
      }
    });
    return client;
  }

  /**
   * Attach a live process to the session for this route.
   *
   * Everything that starts, stops or resumes a child for one process key runs
   * inside that key's lock, so a burst of inbound turns in one lane cannot race
   * itself, and no other lane's key is touched.
   */
  async function attachProcessToSession(route, { threadId = "" } = {}) {
    if (!route?.workspaceRoot) {
      throw new Error("workspaceRoot is required");
    }
    const processKey = computeProcessKey(route);
    const normalizedThreadId = normalizeThreadId(threadId);

    return processRegistry.withLock(processKey, async () => {
      let entry = processRegistry.get(processKey);
      let client = entry?.client || null;

      if (client?.usable && normalizeText(client.model) !== route.model) {
        await closeProcessKey(processKey);
        client = null;
      }

      if (client?.usable && normalizedThreadId && clientMatchesThread(client, normalizedThreadId)) {
        return { client, threadId: normalizedThreadId, processKey };
      }

      if (client?.usable && !normalizedThreadId) {
        // Starting a brand new session in this slot: the slot's own process is
        // retired first. Other slots keep running.
        await closeProcessKey(processKey);
        client = null;
      }

      if (client?.usable && normalizedThreadId && !clientMatchesThread(client, normalizedThreadId)) {
        await closeProcessKey(processKey);
        client = null;
      }

      if (!client?.usable) {
        if (client) {
          await closeProcessKey(processKey);
        }
        client = createProcessClient(route, processKey);
        processRegistry.set(processKey, {
          client,
          sessionSlotKey: route.sessionSlotKey,
          laneKey: route.lane.laneKey,
          launchFingerprint: route.profileFingerprint,
          cwd: route.agentCwd,
        });
        const registered = processRegistry.get(processKey);
        if (registered) {
          registered.workspaceRoot = route.workspaceRoot;
          registered.bindingKey = route.bindingKey;
        }
        await client.connect(normalizedThreadId);
      }

      await retireIdleStaleProcesses(route, processKey);

      return { client, threadId: normalizedThreadId || normalizeThreadId(client.sessionId), processKey };
    });
  }

  /**
   * A hot profile-mapping change moves a slot to a new process key. The old
   * process is only closed when it is idle: a lane that is mid-turn keeps its
   * child until that turn finishes.
   */
  async function retireIdleStaleProcesses(route, currentProcessKey) {
    for (const stale of processRegistry.listStaleEntriesForSlot(route.sessionSlotKey, currentProcessKey)) {
      if (ProcessRegistry.isEntryBusy(stale)) {
        continue;
      }
      processRegistry.delete(stale.processKey);
      await stale.client?.close().catch(() => {});
    }
    for (const evictable of processRegistry.pickEvictableEntries()) {
      if (evictable.processKey === currentProcessKey) {
        continue;
      }
      processRegistry.delete(evictable.processKey);
      await evictable.client?.close().catch(() => {});
    }
  }

  async function closeProcessKey(processKey) {
    const entry = processRegistry.delete(processKey);
    if (!entry?.client) {
      return;
    }
    await entry.client.close();
  }

  async function closeRouteProcess(route) {
    const processKey = computeProcessKey(route);
    return processRegistry.withLock(processKey, () => closeProcessKey(processKey));
  }
  return {
    describe() {
      return {
        id: "claudecode",
        kind: "runtime",
        command: config.claudeCommand || "claude",
        sessionsFile: config.sessionsFile,
        ipcSocketPath,
        model: configuredModel,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      globalListener = listener;
      return () => {
        if (globalListener === listener) {
          globalListener = null;
        }
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities({ model = "" } = {}) {
      const effectiveModel = resolveModel(model);
      return {
        nativeImageInput: false,
        toolImageRead: hasClaudeImageFileRead(effectiveModel),
      };
    },
    async initialize() {
      hydrateRuntimeModelsFromClaudeProjects();
      await ipcServer.start();
      return {
        command: config.claudeCommand || "claude",
        models: [],
        ipcSocketPath,
      };
    },
    async close() {
      for (const entry of processRegistry.listEntries()) {
        processRegistry.delete(entry.processKey);
        await entry.client?.close().catch(() => {});
      }
      await ipcServer.close();
    },
    async startFreshThreadDraft({ workspaceRoot, bindingKey = "", lane = null, launchProfile = null }) {
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile });
      await closeRouteProcess(route);
      clearSlotThreadId(route);
      return { workspaceRoot };
    },
    async respondApproval({ requestId, decision, result = null }) {
      // Approvals are answered by the process that raised them, never by
      // "whichever client happens to be alive".
      const record = processRegistry.resolveApproval(requestId);
      const client = record ? processRegistry.getClient(record.processKey) : null;
      if (!client?.alive) {
        processRegistry.forgetApproval(requestId);
        throw new Error("no active claudecode session to respond to approval");
      }
      const responsePayload = result && typeof result === "object" ? result : { decision };
      await client.sendResponse(requestId, responsePayload);
      processRegistry.forgetApproval(requestId);
      return {
        requestId,
        ...(result && typeof result === "object"
          ? { result: responsePayload }
          : { decision: decision === "accept" ? "accept" : "decline" }),
      };
    },
    async cancelTurn({ threadId, turnId, workspaceRoot, bindingKey = "", lane = null, launchProfile = null }) {
      // Cancel resolves to exactly one process. Without a session id and
      // without a lane there is nothing safe to cancel, so nothing is closed --
      // the pre-v2 behaviour of closing every client for a workspace root is
      // what let one topic stop another topic's run.
      const entry = processRegistry.findEntryByThreadId(threadId);
      if (entry) {
        await processRegistry.withLock(entry.processKey, () => closeProcessKey(entry.processKey));
        return { threadId, turnId };
      }
      if (workspaceRoot && (lane || bindingKey)) {
        const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile });
        await closeRouteProcess(route);
      }
      return { threadId, turnId };
    },
    async resumeThread({
      threadId, workspaceRoot, model = "", resumeOrigin = "implicit_restore",
      bindingKey = "", lane = null, launchProfile = null,
    }) {
      if (!workspaceRoot) {
        return { threadId, resumed: true, resumeOrigin, empty: false };
      }
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, model });
      // Only this slot's own stored session id may be resumed.
      const resumeId = normalizeThreadId(threadId) === route.storedThreadId
        ? route.storedThreadId
        : (normalizeThreadId(threadId) && !route.storedThreadId ? normalizeThreadId(threadId) : route.storedThreadId);
      const attached = await attachProcessToSession(route, { threadId: resumeId });
      return { threadId: attached.threadId, resumed: true, resumeOrigin, empty: false };
    },
    async runBackgroundTurn({ workspaceRoot, text, model = "" }) {
      const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
      if (!normalizedWorkspaceRoot) throw new Error("workspaceRoot is required");
      const projectSettings = ensureClaudeProjectMcpConfig({
        workspaceRoot: normalizedWorkspaceRoot,
        cyberbossHome: process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
      });
      // Explicitly isolated: its own system lane, no launch profile, no entry in
      // the process registry and no session slot. It can neither inherit a
      // Telegram lane's profile nor leave a session id another lane could
      // resume.
      const backgroundLane = buildSystemRouteLane("background-author");
      const client = new ClaudeCodeProcessClient({
        command: config.claudeCommand || "claude",
        commandPrefixArgs: config.claudeCommandPrefixArgs || [],
        cwd: resolveAgentCwd(configuredAgentCwd, normalizedWorkspaceRoot),
        env: filterClaudeCodeEnv(process.env),
        model: resolveModel(model),
        permissionMode: config.claudePermissionMode || "default",
        disableVerbose: Boolean(config.claudeDisableVerbose),
        extraArgs: config.claudeExtraArgs || [],
        mcpConfigPaths: [projectSettings.configPath],
        launchProfile: null,
        ipcServer: null,
        workspaceRoot: normalizedWorkspaceRoot,
        laneKey: backgroundLane.laneKey,
        sessionSlotKey: "",
        processKey: "",
      });
      try {
        await client.connect("");
        const completion = waitForIsolatedCompletion(client);
        await client.sendUserMessage({ text, threadId: "" });
        return await completion;
      } finally {
        await client.close().catch(() => {});
      }
    },
    async compactThread({ threadId, workspaceRoot, model = "", bindingKey = "", lane = null, launchProfile = null }) {
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, model });
      const { client, threadId: activeThreadId } = await attachProcessToSession(route, {
        threadId: normalizeThreadId(threadId) || route.storedThreadId,
      });
      await client.sendUserMessage({ text: "/compact", threadId: activeThreadId });
      return { threadId: activeThreadId, turnId: client.pendingTurnId };
    },
    async refreshThreadInstructions({
      threadId, workspaceRoot, model = "", reason = "refresh",
      bindingKey = "", lane = null, launchProfile = null,
    }) {
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, model });
      const { client, threadId: activeThreadId } = await attachProcessToSession(route, {
        threadId: normalizeThreadId(threadId) || route.storedThreadId,
      });
      const continuity = prepareRefreshContext({ config, reason });
      const refreshText = buildInstructionRefreshText(config, continuity);
      await client.sendUserMessage({ text: refreshText, threadId: activeThreadId });
      return { threadId: activeThreadId, continuity: { ...continuity, total_chars: countVisibleChars(refreshText) } };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({
      bindingKey, workspaceRoot, text, metadata = {}, model = "",
      lane = null, launchProfile = null,
    }) {
      const desiredModel = resolveModel(model);
      const route = resolveRouteContext({
        bindingKey, workspaceRoot, lane, launchProfile, model: desiredModel,
      });
      // The resume id comes from this slot only. Another lane's session id is
      // simply not reachable from here, which is the structural guarantee that
      // lane B can never be launched with `--resume <session A>`.
      let threadId = route.storedThreadId;
      if (desiredModel) {
        sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
          model: desiredModel,
          modelProvider: "",
        });
      }
      const contextFingerprint = computeHardContextFingerprint(config);
      const appliedFingerprint = sessionSlotStore.getContextFingerprint(route.sessionSlotKey)
        || (route.profileFingerprint === "legacy"
          ? sessionStore.getContextFingerprintForWorkspace(bindingKey, workspaceRoot)
          : "");
      const previousReentry = threadId ? sessionStore.getReentryInjection(threadId) : null;
      const reentryNowEnabled = loadContextGates(config).reentry;
      const legacyOffMismatch = Boolean(threadId && !appliedFingerprint && !reentryNowEnabled && previousReentry?.reentry_injected);
      const contextChanged = Boolean(threadId && ((appliedFingerprint && appliedFingerprint !== contextFingerprint) || legacyOffMismatch));
      if (contextChanged) {
        await closeRouteProcess(route);
        clearSlotThreadId(route);
        threadId = "";
      }
      let openingTurn = !threadId;
      let openingReason = contextChanged ? "context_changed" : "new_thread";
      let attached;
      try {
        attached = await attachProcessToSession(route, { threadId });
      } catch (error) {
        if (!threadId) {
          throw error;
        }
        clearSlotThreadId(route);
        threadId = "";
        openingTurn = true;
        openingReason = "thread_recreated";
        attached = await attachProcessToSession(route, { threadId: "" });
      }
      const { client, threadId: activeThreadId } = attached;
      const outboundThreadId = activeThreadId || threadId;
      let outboundText = text;
      let continuity = prepareOrdinaryContext(text);
      if (openingTurn) {
        const openingContext = prepareOpeningContext({
          config,
          sessionStore,
          threadId: outboundThreadId,
          reason: openingReason,
        });
        let fallback = false;
        try {
          outboundText = buildOpeningTurnText(config, text, openingContext);
        } catch (error) {
          fallback = true;
          outboundText = text;
          console.warn(`[continuity] opening builder failed: ${error.message || String(error)}`);
        }
        continuity = finalizeOpeningContext(openingContext, {
          sessionStore,
          threadId: outboundThreadId,
          outboundText,
          fallback,
        });
      }
      if (outboundThreadId) {
        storeSlotThreadId(route, outboundThreadId, metadata);
      }
      // The CLI can exit between two turns of the same lane. One relaunch of
      // this slot's own process is attempted; other lanes are untouched.
      let activeClient = client;
      try {
        await activeClient.sendUserMessage({ text: outboundText, threadId: outboundThreadId });
      } catch (error) {
        if (activeClient.usable) {
          throw error;
        }
        const reattached = await attachProcessToSession(route, { threadId: outboundThreadId });
        activeClient = reattached.client;
        await activeClient.sendUserMessage({ text: outboundText, threadId: outboundThreadId });
      }
      const returnedThreadId = outboundThreadId || normalizeThreadId(
        await activeClient.waitForSessionId({ timeoutMs: CLAUDE_RESUME_SESSION_TIMEOUT_MS })
      );
      if (!returnedThreadId) {
        throw new Error("claudecode did not report a session id");
      }
      if (continuity?.reentry?.text) {
        sessionStore.markReentryInjected(returnedThreadId, continuity.reentry);
      }
      storeSlotThreadId(route, returnedThreadId, metadata);
      sessionSlotStore.setContextFingerprint(route.sessionSlotKey, contextFingerprint);
      if (route.profileFingerprint === "legacy") {
        sessionStore.setContextFingerprintForWorkspace(bindingKey, workspaceRoot, contextFingerprint);
      }
      rememberModelForBinding(bindingKey, workspaceRoot, pendingModelByWorkspaceRoot.get(normalizeText(workspaceRoot)));
      return {
        threadId: returnedThreadId,
        turnId: activeClient.pendingTurnId,
        sessionSlotKey: route.sessionSlotKey,
        laneKey: route.lane.laneKey,
        processKey: attached.processKey,
        profileId: route.profileId,
        continuity,
      };
    },
    // Exposed for tests and diagnostics. Contains keys, never route contents.
    describeRouting() {
      return {
        processCount: processRegistry.size(),
        slotCount: sessionSlotStore.listSlotKeys().length,
      };
    },
    __internals: {
      processRegistry,
      sessionSlotStore,
      resolveRouteContext,
      computeProcessKey,
    },
  };

  function hydrateRuntimeModelsFromClaudeProjects() {
    for (const binding of sessionStore.listBindings()) {
      const workspaceRoots = new Set([
        normalizeText(binding.activeWorkspaceRoot),
        ...sessionStore.listWorkspaceRoots(binding.bindingKey),
      ].filter(Boolean));
      for (const workspaceRoot of workspaceRoots) {
        const threadId = sessionStore.getThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
        const model = readLatestClaudeProjectModel({
          claudeConfigDir: config.claudeConfigDir,
          workspaceRoot,
          threadId,
        });
        rememberModelForBinding(binding.bindingKey, workspaceRoot, model);
      }
    }
  }

  function rememberObservedModelForWorkspace(workspaceRoot, model) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const normalizedModel = normalizeClaudeRuntimeModel(model);
    if (!normalizedWorkspaceRoot || !normalizedModel) {
      return;
    }
    let remembered = false;
    for (const binding of sessionStore.listBindings()) {
      if (normalizeText(binding.activeWorkspaceRoot) === normalizedWorkspaceRoot) {
        rememberModelForBinding(binding.bindingKey, normalizedWorkspaceRoot, normalizedModel);
        remembered = true;
      }
    }
    if (!remembered) {
      pendingModelByWorkspaceRoot.set(normalizedWorkspaceRoot, normalizedModel);
    }
  }

  function rememberModelForBinding(bindingKey, workspaceRoot, model) {
    const normalizedModel = normalizeClaudeRuntimeModel(model);
    if (!bindingKey || !normalizeText(workspaceRoot) || !normalizedModel) {
      return;
    }
    const current = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    if (normalizeText(current.model) === normalizedModel) {
      return;
    }
    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: normalizedModel,
      modelProvider: "",
    });
  }
}

function computeHardContextFingerprint(config = {}) {
  const gates = loadContextGates(config);
  const files = {
    prompt: fileContentHash(config.weixinInstructionsFile),
    operations: config.includeOperationsPrompt ? fileContentHash(config.weixinOperationsFile) : "off",
    reentry: gates.reentry ? fileContentHash(config.reentryFile) : "off",
    current_state_override: gates.current_state ? fileContentHash(config.currentStateOverrideFile) : "off",
  };
  return crypto.createHash("sha256").update(JSON.stringify({
    reentry: gates.reentry,
    current_state: gates.current_state,
    files,
  }), "utf8").digest("hex");
}

function fileContentHash(filePath = "") {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return "missing";
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(normalizedPath)).digest("hex");
  } catch {
    return "missing";
  }
}

function filterClaudeCodeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== "CLAUDECODE") {
      out[key] = value;
    }
  }
  return out;
}

function resolveAgentCwd(agentCwd, workspaceRoot) {
  return normalizeText(agentCwd) || normalizeText(workspaceRoot);
}

module.exports = { createClaudeCodeRuntimeAdapter, resolveAgentCwd };

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function extractClaudeMessageModel(raw) {
  return normalizeClaudeRuntimeModel(raw?.message?.model);
}

function normalizeClaudeRuntimeModel(model) {
  const normalized = normalizeText(model);
  if (!normalized || normalized === "<synthetic>") {
    return "";
  }
  return normalized;
}

function readLatestClaudeProjectModel({ claudeConfigDir = "", workspaceRoot = "", threadId = "" } = {}) {
  const transcriptPath = resolveClaudeProjectTranscriptPath({ claudeConfigDir, workspaceRoot, threadId });
  if (!transcriptPath) {
    return "";
  }
  let raw = "";
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const model = normalizeClaudeRuntimeModel(parsed?.message?.model);
      if (model) {
        return model;
      }
    } catch {
      // ignore malformed transcript lines
    }
  }
  return "";
}

function resolveClaudeProjectTranscriptPath({ claudeConfigDir = "", workspaceRoot = "", threadId = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedWorkspaceRoot || !normalizedThreadId) {
    return "";
  }
  const baseDir = normalizeText(claudeConfigDir);
  if (!baseDir) {
    return "";
  }
  return path.join(baseDir, "projects", encodeClaudeProjectPath(normalizedWorkspaceRoot), `${normalizedThreadId}.jsonl`);
}

function encodeClaudeProjectPath(workspaceRoot) {
  return normalizeText(workspaceRoot).replace(/[\\/:\s]+/g, "-");
}

function hasClaudeImageFileRead(model) {
  const normalized = normalizeText(model).toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "sonnet"
    || normalized === "opus"
    || normalized === "haiku"
    || /\b(?:sonnet|opus|haiku)\b/.test(normalized)
    || /^claude-(?:3|4)(?:\b|-)/.test(normalized);
}

function clientMatchesThread(client, threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || !client?.alive) {
    return false;
  }
  return normalizeThreadId(client.sessionId) === normalizedThreadId
    || normalizeThreadId(client.resumeSessionId) === normalizedThreadId;
}

function countVisibleChars(value) {
  return Array.from(String(value || "").replace(/\s/gu, "")).length;
}

function waitForIsolatedCompletion(client, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, text = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(error);
      else resolve(text);
    };
    const unsubscribe = client.onMessage((event) => {
      if (event?.type === "turn.completed") finish(null, event.text || "");
      if (event?.type === "process.error") finish(new Error(event.error || "background runtime failed"));
      if (event?.type === "process.close") finish(new Error("background runtime closed before completion"));
    });
    const timer = setTimeout(() => finish(new Error("background runtime timed out")), timeoutMs);
  });
}
