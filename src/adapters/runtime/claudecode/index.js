const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ClaudeCodeProcessClient, normalizeEffort } = require("./process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("./events");
const {
  ensureClaudeProjectMcpConfig,
  ensureRouteScopedMcpConfig,
} = require("./project-settings");
const {
  SessionSlotStore,
  buildLegacyMigrationKey,
  buildSessionSlotKey,
  isLegacyMigrationEligible,
} = require("./session-slot");
const { ProcessRegistry, buildProcessKey } = require("./process-registry");
const { fingerprintLaunchProfile, profileLogicalIdentity } = require("./launch-profile");
const { resolveCliCapabilities } = require("./cli-capabilities");
const { runG3LaunchPreflight } = require("./g3-preflight");
const { applyHarnessOverlay, resolveWindowOverride, windowOverrideEnabled } = require("./window-override");
const {
  buildLegacyRouteLane,
  buildSystemRouteLane,
} = require("../../../core/route-lane");
const {
  DEFAULT_ACCESS,
  WorkspaceLockManager,
  normalizeAccessMode,
} = require("../../../core/workspace-lock");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText, loadInstructionFile } = require("../shared-instructions");
const { ClaudeCodeIpcServer } = require("./ipc-server");
const {
  finalizeOpeningContext,
  loadContextGates,
  prepareOpeningContext,
  prepareOrdinaryContext,
  prepareRefreshContext,
} = require("../../../core/hard-context");
const CLAUDE_RESUME_SESSION_TIMEOUT_MS = 8000;

/**
 * A turn whose write to the child failed after the attempt began.
 *
 * The distinction that matters: if the client was known-unusable *before* the
 * write, nothing was sent and a relaunch is safe. Once the write has been
 * attempted, delivery cannot be proven either way, so the turn must surface as
 * a failure rather than be replayed into a possible duplicate execution.
 */
class IndeterminateTurnWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "IndeterminateTurnWriteError";
    this.code = "indeterminate_turn_write";
    this.indeterminate = true;
  }
}

function isWriteFailure(error) {
  const code = error?.code || "";
  return code === "EPIPE"
    || code === "ERR_STREAM_DESTROYED"
    || code === "ERR_STREAM_WRITE_AFTER_END"
    || /not running|EPIPE|write after end/i.test(error?.message || "");
}

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
    turnTimeoutMs: config.claudeTurnTimeoutMs,
  });
  // Lanes keep independent sessions and processes; only concurrent access to
  // one filesystem workspace is serialized. read+read runs concurrently, a
  // writer is exclusive, and the lock is held for the whole turn.
  const workspaceLocks = new WorkspaceLockManager({ timeoutMs: config.claudeWorkspaceLockTimeoutMs });
  const launchProfileBaseDir = normalizeText(config.claudeLaunchProfileBaseDir)
    || normalizeText(config.configDir)
    || stateDir;
  const cliCapabilities = resolveCliCapabilities({ declaredJson: config.claudeCliCapabilitiesJson || "" });
  const allowAuthBackendOverride = config.claudeAllowAuthBackendOverride === true;
  const allowCloudCredentialInheritance = config.claudeAllowCloudCredentialInheritance === true;
  const pendingModelByWorkspaceRoot = new Map();

  // Snapshot of the pre-v2 binding-level session ids, taken once at
  // construction *before* any lane can mirror a new session id into
  // sessions.json. The one-shot legacy migration reads only from this snapshot,
  // so a later lane's write can never be mistaken for the pre-upgrade session.
  const legacySessionSnapshot = snapshotLegacySessions();

  function snapshotLegacySessions() {
    const snapshot = new Map();
    for (const binding of sessionStore.listBindings()) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }
      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const threadId = normalizeThreadId(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizeText(workspaceRoot)),
        );
        if (threadId) {
          snapshot.set(`${bindingKey}\u0000${normalizeText(workspaceRoot)}`, threadId);
        }
      }
    }
    return snapshot;
  }
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

  /**
   * Resolve the process an IPC (shared-open) message addresses.
   *
   * Fail closed. The console must name a process explicitly -- by processKey,
   * sessionId or laneKey. "The first live process in this workspace" is not an
   * identity: with several lanes running it is a coin flip, and it was a way to
   * reach a profiled lane's session from an unprofiled console.
   *
   * @returns {{client: object}|{error: string}}
   */
  function resolveIpcTarget(msg = {}) {
    const processKey = normalizeText(msg.processKey);
    if (processKey) {
      const entry = processRegistry.get(processKey);
      return entry?.client?.usable
        ? { client: entry.client }
        : { error: `no live claudecode process for processKey ${truncateId(processKey)}` };
    }

    const sessionId = normalizeThreadId(msg.sessionId || msg.threadId);
    if (sessionId) {
      const entry = processRegistry.findEntryByThreadId(sessionId);
      return entry?.client?.usable
        ? { client: entry.client }
        : { error: "no live claudecode process for that session id" };
    }

    const laneKey = normalizeText(msg.laneKey);
    if (laneKey) {
      const matches = processRegistry.listEntries().filter(
        (entry) => entry.laneKey === laneKey && entry.client?.usable,
      );
      if (matches.length === 1) {
        return { client: matches[0].client };
      }
      return {
        error: matches.length
          ? "laneKey matches more than one live process"
          : "no live claudecode process for that lane",
      };
    }

    const normalizedWorkspaceRoot = normalizeText(msg.workspaceRoot);
    if (normalizedWorkspaceRoot) {
      const matches = processRegistry.listEntries().filter(
        (entry) => entry.workspaceRoot === normalizedWorkspaceRoot && entry.client?.usable,
      );
      if (matches.length === 1) {
        // Unambiguous: exactly one live process in this workspace.
        return { client: matches[0].client };
      }
      return {
        error: matches.length
          ? `workspace has ${matches.length} live processes; specify processKey, sessionId or laneKey`
          : "no live claudecode process for that workspace",
      };
    }

    return { error: "IPC message must carry processKey, sessionId, laneKey or workspaceRoot" };
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
    // Per-binding reasoning effort. Unlike `model` there is no deployment-wide
    // override that outranks it: the chat's own /effort choice is the most
    // specific level, and the env default only applies when it is absent.
    effort = "",
    windowOverride = null,
    // Required for the one-shot legacy migration: only a Telegram private
    // chat's default lane (chatId === the binding's own senderId) qualifies.
    senderId = "",
  } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const effectiveLane = lane && lane.laneKey
      ? lane
      : buildLegacyRouteLane({ provider: "runtime", bindingKey: bindingKey || normalizedWorkspaceRoot || "default" });
    const profileFingerprint = fingerprintLaunchProfile(launchProfile, {
      baseDir: launchProfileBaseDir,
      allowAuthBackendOverride,
      capabilities: cliCapabilities,
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

    const routeDescriptor = {
      bindingKey,
      workspaceRoot: normalizedWorkspaceRoot,
      laneKey: effectiveLane.laneKey,
      laneKind: effectiveLane.kind,
      provider: effectiveLane.provider,
      accountId: effectiveLane.accountId,
      chatId: effectiveLane.chatId,
      messageThreadId: effectiveLane.messageThreadId ?? null,
      profileId: profileLogicalIdentity(launchProfile),
      profileFingerprint,
    };

    // The slot is the ONLY runtime authority for a resume id. sessions.json is
    // never consulted here; the single exception is the one-shot migration
    // below, which reads a snapshot taken before any lane could write to it and
    // records a marker so it can never be applied twice.
    let storedThreadId = sessionSlotStore.getThreadId(sessionSlotKey);
    if (!storedThreadId
      && bindingKey
      && normalizedWorkspaceRoot
      && isLegacyMigrationEligible({ lane: effectiveLane, profileFingerprint, senderId })) {
      const migrationKey = buildLegacyMigrationKey({ bindingKey, workspaceRoot: normalizedWorkspaceRoot });
      if (migrationKey && !sessionSlotStore.hasMigration(migrationKey)) {
        // Marked first and unconditionally: a migration that finds nothing must
        // still never be retried, or a later mirrored write would be adopted.
        sessionSlotStore.markMigration(migrationKey);
        const migrated = legacySessionSnapshot.get(`${bindingKey}\u0000${normalizedWorkspaceRoot}`) || "";
        if (migrated) {
          sessionSlotStore.setThreadId(sessionSlotKey, migrated, { route: routeDescriptor });
          storedThreadId = migrated;
        }
      }
    }

    const resolvedModel = resolveModel(model);
    const storedWindowOverride = sessionSlotStore.getWindowOverride(sessionSlotKey);
    const mutableOverride = resolveWindowOverride({
      ...(storedWindowOverride || {}),
      ...(windowOverride && typeof windowOverride === "object" ? windowOverride : {}),
      ...(resolvedModel && !storedWindowOverride?.model && !windowOverride?.model
        ? { model: resolvedModel, modelSource: "command" }
        : {}),
      ...(normalizeEffort(effort) && !storedWindowOverride?.effort && !windowOverride?.effort
        ? { effort: normalizeEffort(effort), effortSource: "command" }
        : {}),
    }, { profile: launchProfile, env: process.env });

    return {
      bindingKey,
      senderId: normalizeText(senderId),
      workspaceRoot: normalizedWorkspaceRoot,
      lane: effectiveLane,
      launchProfile: launchProfile || null,
      profileFingerprint,
      profileId: routeDescriptor.profileId,
      routeDescriptor,
      sessionSlotKey,
      storedThreadId,
      agentCwd,
      configIdentity,
      workspaceAccess: normalizeAccessMode(launchProfile?.workspaceAccess),
      model: mutableOverride?.model || resolvedModel,
      effort: mutableOverride?.effort || normalizeEffort(effort),
      mutableOverride,
    };
  }

  function storeSlotThreadId(route, threadId, metadata = {}) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId || !route?.sessionSlotKey) {
      return;
    }
    sessionSlotStore.setThreadId(route.sessionSlotKey, normalizedThreadId, {
      route: route.routeDescriptor,
    });
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
    // The binding mirror is only cleared for the lane that owns it, and only to
    // keep the reverse index tidy -- it is never read back as an authority.
    if (route.bindingKey && route.workspaceRoot
      && normalizeThreadId(sessionStore.getThreadIdForWorkspace(route.bindingKey, route.workspaceRoot))
        === normalizeThreadId(route.storedThreadId)) {
      sessionStore.clearThreadIdForWorkspace(route.bindingKey, route.workspaceRoot);
    }
  }

  async function handleIpcSendUserMessage(msg) {
    try {
      const target = resolveIpcTarget(msg);
      if (target.error) {
        ipcServer.broadcast({ type: "stderr", text: `[shared-open] ${target.error}` });
        return;
      }
      await target.client.sendUserMessage({ text: msg.text || "" });
    } catch (error) {
      ipcServer.broadcast({
        type: "stderr",
        text: `[shared-open] failed to send message: ${error.message || String(error)}`,
      });
    }
  }

  async function handleIpcRespondApproval(msg) {
    try {
      // An approval always belongs to the process that raised it. If the
      // registry does not own this requestId, it is refused outright.
      const owner = processRegistry.resolveApproval(msg.requestId);
      const target = owner
        ? { client: processRegistry.getClient(owner.processKey) }
        : resolveIpcTarget(msg);
      if (target.error || !target.client?.usable) {
        ipcServer.broadcast({
          type: "stderr",
          text: `[shared-open] ${target.error || "approval owner process is not live"}`,
        });
        return;
      }
      await target.client.sendResponse(msg.requestId, { decision: msg.decision });
      processRegistry.forgetApproval(msg.requestId);
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

  function createProcessClient(route, processKey, g3Preflight = null) {
    const { workspaceRoot } = route;
    const cyberbossHome = process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", "..");
    // The shared project config is still maintained (other runtimes read it),
    // but this child is launched against a per-slot config whose tool server
    // carries this lane's route token, so its outbound tool sends cannot be
    // captured by another lane's active context.
    ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome });
    const routeScoped = ensureRouteScopedMcpConfig({
      workspaceRoot,
      cyberbossHome,
      routeToken: route.sessionSlotKey,
      configDir: path.join(stateDir, "claude-mcp"),
      launchProfile: route.launchProfile,
      mutableOverride: route.mutableOverride,
    });
    const projectSettings = routeScoped
      || ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome });
    console.log(
      `[claudecode-runtime] workspace=${workspaceRoot} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`
    );
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      commandPrefixArgs: config.claudeCommandPrefixArgs || [],
      cwd: route.agentCwd,
      env: filterClaudeCodeEnv(process.env),
      model: route.model,
      effort: route.effort,
      permissionMode: config.claudePermissionMode || "default",
      disableVerbose: Boolean(config.claudeDisableVerbose),
      extraArgs: config.claudeExtraArgs || [],
      mcpConfigPaths: [projectSettings.configPath],
      launchProfile: route.launchProfile,
      mutableOverride: route.mutableOverride,
      launchProfileBaseDir,
      cliCapabilities,
      allowAuthBackendOverride,
      allowCloudCredentialInheritance,
      g3Preflight,
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
        // Self-describing identity. Downstream handlers resolve the lane, slot
        // and process straight from the event and never reverse-look-up a
        // binding, which is what removes the last cross-lane inference path.
        mapped.payload.bindingKey = route.bindingKey;
        mapped.payload.workspaceRoot = route.workspaceRoot;
        mapped.payload.laneKey = route.lane.laneKey;
        mapped.payload.sessionSlotKey = route.sessionSlotKey;
        mapped.payload.processKey = processKey;
        mapped.payload.messageThreadId = route.lane.messageThreadId ?? null;
        mapped.payload.profileId = route.profileId;
        mapped.payload.profileFingerprint = route.profileFingerprint;
        if (!mapped.payload.sessionId) {
          mapped.payload.sessionId = normalizeThreadId(client.sessionId);
        }
      }
      if (mapped?.type === "runtime.approval.requested") {
        processRegistry.rememberApproval(mapped.payload.requestId, {
          processKey,
          sessionSlotKey: route.sessionSlotKey,
          laneKey: route.lane.laneKey,
        });
      }
      // The turn slot and the workspace lock are held for the *whole* turn and
      // released here, on result, cancel or failure -- never when sendTurn
      // returns, which happens while the reply is still streaming.
      if (mapped?.type === "runtime.turn.completed"
        || mapped?.type === "runtime.turn.failed"
        || event.type === "process.close"
        || event.type === "process.error") {
        finishTurn(processKey);
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
      let g3Preflight = null;

      // Check the target before retiring a current process or registering a
      // replacement. A refused switch leaves the old slot/session untouched.
      if (!client?.usable && route.launchProfile) {
        g3Preflight = await runG3LaunchPreflight({
          profile: route.launchProfile,
          baseEnv: filterClaudeCodeEnv(process.env),
          baseCwd: route.agentCwd,
          extraArgs: config.claudeExtraArgs || [],
          baseDir: launchProfileBaseDir,
          capabilities: cliCapabilities,
          command: config.claudeCommand || "claude",
          commandPrefixArgs: config.claudeCommandPrefixArgs || [],
          authProbe: config.claudeG3AuthProbe,
          expectedLockPath: route.agentCwd,
        });
      }

      // Model and effort are launch flags, not turn parameters: changing either
      // means this slot's child is retired and relaunched. The stored session id
      // is passed straight back in as --resume, so the thread survives the swap.
      if (client?.usable
        && (normalizeText(client.model) !== route.model
          || normalizeEffort(client.effort) !== route.effort
          || normalizeText(client.mutableOverrideFingerprint) !== (route.mutableOverride?.fingerprint || "baseline"))) {
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
        client = createProcessClient(route, processKey, g3Preflight);
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
        try {
          await client.connect(normalizedThreadId);
        } catch (error) {
          // A failed launch must not leave a half-registered entry behind: the
          // registry row, any child that did start, the pending approvals and
          // the in-flight turn are all cleared before the error propagates.
          processRegistry.delete(processKey);
          await client.close().catch(() => {});
          throw error;
        }
        if (!client.usable) {
          processRegistry.delete(processKey);
          await client.close().catch(() => {});
          throw new Error("claudecode process exited during launch");
        }
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

  /** @type {Map<string, {turnToken: string, releaseWorkspace: Function}>} */
  const turnHolds = new Map();

  /**
   * Take the full-turn hold for a process: single-flight on the process key,
   * then the workspace lock in the profile's access mode.
   *
   * Order matters. The process slot is per key and is never awaited by whoever
   * holds the workspace lock, so this ordering cannot deadlock.
   */
  async function beginTurnHold(route, processKey) {
    const { turnToken } = await processRegistry.beginTurn(processKey);
    let releaseWorkspace = () => {};
    try {
      const access = route.workspaceAccess || DEFAULT_ACCESS;
      const handle = await workspaceLocks.acquire(route.agentCwd || route.workspaceRoot, access);
      releaseWorkspace = handle.release;
    } catch (error) {
      processRegistry.settleTurn(processKey, { turnToken });
      throw error;
    }
    turnHolds.set(processKey, { turnToken, releaseWorkspace });
    return turnToken;
  }

  function finishTurn(processKey) {
    const hold = turnHolds.get(processKey);
    if (!hold) {
      processRegistry.settleTurn(processKey, { force: true });
      return;
    }
    turnHolds.delete(processKey);
    hold.releaseWorkspace();
    processRegistry.settleTurn(processKey, { turnToken: hold.turnToken });
  }

  async function closeProcessKey(processKey) {
    finishTurn(processKey);
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
    async startFreshThreadDraft({ workspaceRoot, bindingKey = "", lane = null, launchProfile = null, senderId = "" }) {
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, senderId });
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
    async cancelTurn({ threadId, turnId, workspaceRoot, bindingKey = "", lane = null, launchProfile = null, senderId = "" }) {
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
        const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, senderId });
        await closeRouteProcess(route);
      }
      return { threadId, turnId };
    },
    async resumeThread({
      threadId, workspaceRoot, model = "", effort = "", resumeOrigin = "implicit_restore",
      bindingKey = "", lane = null, launchProfile = null, senderId = "",
    }) {
      if (!workspaceRoot) {
        return { threadId, resumed: true, resumeOrigin, empty: false };
      }
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, model, effort, senderId });
      // Only this slot's own stored session id may be resumed. A caller-supplied
      // id that does not match the slot is refused rather than adopted -- that
      // was the last path by which a binding-latest session could reach a lane.
      const requested = normalizeThreadId(threadId);
      if (requested && route.storedThreadId && requested !== route.storedThreadId) {
        return { threadId: route.storedThreadId, resumed: false, resumeOrigin, empty: false, refused: "slot_mismatch" };
      }
      if (requested && !route.storedThreadId) {
        return { threadId: "", resumed: false, resumeOrigin, empty: true, refused: "no_slot_session" };
      }
      const attached = await attachProcessToSession(route, { threadId: route.storedThreadId });
      return { threadId: attached.threadId, resumed: true, resumeOrigin, empty: false };
    },
    async runBackgroundTurn({ workspaceRoot, text, model = "", workspaceAccess = DEFAULT_ACCESS }) {
      const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
      if (!normalizedWorkspaceRoot) throw new Error("workspaceRoot is required");
      // System/background turns declare their access mode explicitly rather
      // than inheriting one; they default to `write`, which is what a closeout
      // or memory-authoring job actually does.
      const backgroundAccess = normalizeAccessMode(workspaceAccess);
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
        // No binding, no chat, so no /effort choice reaches this launch: it
        // stays at the CLI's own default rather than inheriting a level meant
        // for interactive turns.
        emitEffort: false,
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
      const workspaceHold = await workspaceLocks.acquire(
        resolveAgentCwd(configuredAgentCwd, normalizedWorkspaceRoot),
        backgroundAccess,
      );
      try {
        await client.connect("");
        const completion = waitForIsolatedCompletion(client);
        await client.sendUserMessage({ text, threadId: "" });
        return await completion;
      } finally {
        workspaceHold.release();
        await client.close().catch(() => {});
      }
    },
    async compactThread({ threadId, workspaceRoot, model = "", effort = "", bindingKey = "", lane = null, launchProfile = null, senderId = "" }) {
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, model, effort, senderId });
      const attached = await attachProcessToSession(route, {
        threadId: normalizeThreadId(threadId) || route.storedThreadId,
      });
      const { client, threadId: activeThreadId } = attached;
      await beginTurnHold(route, attached.processKey);
      try {
        await client.sendUserMessage({ text: "/compact", threadId: activeThreadId });
      } catch (error) {
        finishTurn(attached.processKey);
        throw error;
      }
      return { threadId: activeThreadId, turnId: client.pendingTurnId };
    },
    async refreshThreadInstructions({
      threadId, workspaceRoot, model = "", effort = "", reason = "refresh",
      bindingKey = "", lane = null, launchProfile = null, senderId = "",
    }) {
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, model, effort, senderId });
      const attached = await attachProcessToSession(route, {
        threadId: normalizeThreadId(threadId) || route.storedThreadId,
      });
      const { client, threadId: activeThreadId } = attached;
      const continuity = prepareRefreshContext({ config, reason });
      const refreshText = buildInstructionRefreshText(config, continuity);
      await beginTurnHold(route, attached.processKey);
      try {
        await client.sendUserMessage({ text: refreshText, threadId: activeThreadId });
      } catch (error) {
        finishTurn(attached.processKey);
        throw error;
      }
      return { threadId: activeThreadId, continuity: { ...continuity, total_chars: countVisibleChars(refreshText) } };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    getWindowOverride({ bindingKey = "", workspaceRoot = "", lane = null, launchProfile = null, senderId = "" } = {}) {
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, senderId });
      return {
        enabled: windowOverrideEnabled(),
        sessionSlotKey: route.sessionSlotKey,
        value: sessionSlotStore.getWindowOverride(route.sessionSlotKey) || {},
        trace: route.mutableOverride?.trace || null,
      };
    },
    setWindowOverride({
      bindingKey = "", workspaceRoot = "", lane = null, launchProfile = null, senderId = "", patch = {},
    } = {}) {
      if (!windowOverrideEnabled()) return { enabled: false, applied: false };
      const baseRoute = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, senderId });
      const current = sessionSlotStore.getWindowOverride(baseRoute.sessionSlotKey) || {};
      const next = { ...current, ...(patch && typeof patch === "object" ? patch : {}) };
      const resolved = resolveWindowOverride(next, { profile: launchProfile, env: process.env });
      sessionSlotStore.setWindowOverride(baseRoute.sessionSlotKey, next, { route: baseRoute.routeDescriptor });
      return {
        enabled: true,
        applied: true,
        sessionSlotKey: baseRoute.sessionSlotKey,
        value: next,
        trace: resolved.trace,
      };
    },
    async sendTurn({
      bindingKey, workspaceRoot, text, metadata = {}, model = "", effort = "",
      lane = null, launchProfile = null, senderId = "", windowOverride = null,
    }) {
      const desiredModel = resolveModel(model);
      const route = resolveRouteContext({
        bindingKey, workspaceRoot, lane, launchProfile, model: desiredModel, effort, senderId, windowOverride,
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
      const appliedFingerprint = sessionSlotStore.getContextFingerprint(route.sessionSlotKey);
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
        if (route.launchProfile?.schemaVersion === 3 && route.launchProfile.personaSource) {
          openingContext.roleCard = loadInstructionFile(route.launchProfile.personaSource, config);
        }
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
      if (route.mutableOverride) {
        outboundText = applyHarnessOverlay(outboundText, route.mutableOverride);
        continuity = { ...continuity, window_override: route.mutableOverride.trace };
      }
      if (outboundThreadId) {
        storeSlotThreadId(route, outboundThreadId, metadata);
      }
      // Take the full-turn hold before writing: single-flight on this process
      // key, then the workspace lock. Both are released by the event handler on
      // result, cancel or failure -- not when this function returns.
      let activeClient = client;
      let turnHeld = false;
      try {
        // Let any queued 'exit'/'close' event land before judging usability.
        // Without this drain a child that died moments ago still looks usable,
        // and the write below would fail as indeterminate instead of being
        // safely relaunched.
        await new Promise((resolve) => setImmediate(resolve));
        // A dead child is detected *before* the write. Relaunching here is
        // provably safe because nothing has been sent yet.
        if (!activeClient.usable) {
          const reattached = await attachProcessToSession(route, { threadId: outboundThreadId });
          activeClient = reattached.client;
        }
        await beginTurnHold(route, attached.processKey);
        turnHeld = true;
        // Re-check after waiting for the hold: the child may have exited while
        // this turn was queued behind another one.
        await new Promise((resolve) => setImmediate(resolve));
        if (!activeClient.usable) {
          const reattached = await attachProcessToSession(route, { threadId: outboundThreadId });
          activeClient = reattached.client;
        }
        await activeClient.sendUserMessage({ text: outboundText, threadId: outboundThreadId });
      } catch (error) {
        if (turnHeld) {
          finishTurn(attached.processKey);
        }
        if (error instanceof IndeterminateTurnWriteError) {
          throw error;
        }
        // The write itself failed. We cannot prove whether the child received
        // and began executing it, so the turn is NOT replayed: a silent replay
        // would risk executing the same tool calls twice.
        if (isWriteFailure(error)) {
          throw new IndeterminateTurnWriteError(
            "claudecode turn write failed with an indeterminate outcome; not replayed",
          );
        }
        throw error;
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
      rememberModelForBinding(bindingKey, workspaceRoot, pendingModelByWorkspaceRoot.get(normalizeText(workspaceRoot)));
      return {
        threadId: returnedThreadId,
        turnId: activeClient.pendingTurnId,
        sessionSlotKey: route.sessionSlotKey,
        routeToken: route.sessionSlotKey,
        laneKey: route.lane.laneKey,
        processKey: attached.processKey,
        profileId: route.profileId,
        workspaceAccess: route.workspaceAccess,
        windowOverride: route.mutableOverride?.trace || null,
        continuity,
      };
    },
    /**
     * The session, slot and process this route currently owns.
     *
     * This is the only supported way for a command handler to find "the current
     * thread": it resolves the *current* lane and profile, never the binding's
     * most recent session.
     */
    resolveRouteSession({ bindingKey = "", workspaceRoot = "", lane = null, launchProfile = null, senderId = "" } = {}) {
      const route = resolveRouteContext({ bindingKey, workspaceRoot, lane, launchProfile, senderId });
      const processKey = computeProcessKey(route);
      const entry = processRegistry.get(processKey);
      return {
        sessionSlotKey: route.sessionSlotKey,
        laneKey: route.lane.laneKey,
        messageThreadId: route.lane.messageThreadId ?? null,
        threadId: route.storedThreadId,
        processKey,
        processAlive: Boolean(entry?.client?.usable),
        profileId: route.profileId,
        profileFingerprint: route.profileFingerprint,
      };
    },
    /**
     * Slots that can be restored at startup, most recent first, each with its
     * own lane. Startup restore iterates this -- never the binding list -- so a
     * bare legacy process can never adopt the most recent binding session.
     */
    listRestorableSlots({ limit = 0 } = {}) {
      const slots = sessionSlotStore.listRestorableSlots()
        .filter((entry) => entry.route.laneKind !== "sys");
      const cap = Number.isSafeInteger(limit) && limit > 0
        ? limit
        : processRegistry.maxProcesses;
      if (slots.length > cap) {
        console.warn(
          `[claudecode-runtime] restoring ${cap} of ${slots.length} session slots (process capacity)`,
        );
      }
      return slots.slice(0, cap).map((entry) => ({
        sessionSlotKey: entry.slotKey,
        threadId: entry.threadId,
        route: entry.route,
      }));
    },
    /**
     * Resume exactly one slot by its own key. Refuses if the supplied session id
     * is not the one recorded for that slot.
     */
    async resumeSessionSlot({ sessionSlotKey, lane = null, launchProfile = null, model = "", senderId = "" }) {
      const slotKey = normalizeText(sessionSlotKey);
      const stored = slotKey ? sessionSlotStore.get(slotKey) : null;
      if (!stored?.threadId || !stored.route?.workspaceRoot) {
        return { resumed: false, refused: "unknown_slot" };
      }
      const route = resolveRouteContext({
        bindingKey: stored.route.bindingKey,
        workspaceRoot: stored.route.workspaceRoot,
        lane,
        launchProfile,
        model,
        senderId,
      });
      if (route.sessionSlotKey !== slotKey) {
        return { resumed: false, refused: "slot_mismatch" };
      }
      const attached = await attachProcessToSession(route, { threadId: route.storedThreadId });
      return {
        resumed: true,
        sessionSlotKey: slotKey,
        threadId: attached.threadId,
        processKey: attached.processKey,
      };
    },
    // Exposed for tests and diagnostics. Contains keys, never route contents.
    describeRouting() {
      return {
        processCount: processRegistry.size(),
        slotCount: sessionSlotStore.listSlotKeys().length,
        lockCount: processRegistry.lockCount(),
        activeTurns: processRegistry.activeTurnCount(),
        workspaceLocks: workspaceLocks.describe(),
      };
    },
    __internals: {
      processRegistry,
      sessionSlotStore,
      workspaceLocks,
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

module.exports = { IndeterminateTurnWriteError, createClaudeCodeRuntimeAdapter, resolveAgentCwd };

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function truncateId(value) {
  return String(value || "").slice(0, 8);
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
