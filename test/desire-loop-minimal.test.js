const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const originalModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === "qrcode-terminal") {
    return { generate() {} };
  }
  if (request === "sharp") {
    return function sharpStub(buffer) {
      return {
        metadata: async () => ({ width: 1, height: 1 }),
        rotate() { return this; },
        resize() { return this; },
        jpeg() { return this; },
        toBuffer: async () => Buffer.from(buffer),
      };
    };
  }
  if (request === "whereabouts-mcp") {
    return {
      WhereaboutsToolHost: class {
        constructor() {}
        listTools() { return []; }
        async invokeTool() { return { text: "", data: null }; }
      },
    };
  }
  if (request === "ws") {
    return class WebSocketStub {};
  }
  if (request === "dotenv") {
    return { config() { return {}; } };
  }
  if (request === "@xenova/transformers") {
    return {};
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { CyberbossApp } = require("../src/core/app");
const { buildSystemInboundText, SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");
const { buildDesireTriggerText } = require("../src/app/hourly-desire-poller");
const { runSystemCheckinPoller } = require("../src/app/system-checkin-poller");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const {
  DRIVE_KEYS,
  persistReportedDesireState,
  readPersistedDesireState,
} = require("../src/core/desire-state-persistence");

function createReportedState({ wantAction = "web_browse", driveKey = "social", mostWant = "去看看外面" } = {}) {
  return {
    most_want: mostWant,
    driven_behavior_enabled: true,
    intent: {
      drive_key: driveKey,
      want_action: wantAction,
      reason: "想去看看外面在聊什么。",
    },
    heartbeat: {
      tension: 0.742,
    },
    refractory: {
      curiosity: 1,
      social: 0,
    },
    drives: DRIVE_KEYS.map((key) => ({
      key,
      label: key,
      score: key === driveKey ? 0.82 : 0.16,
      change: "steady",
      cause: "",
    })),
  };
}

function createProductionReportedState({ driveKey = "social", mostWant = "去看看外面" } = {}) {
  return {
    most_want: mostWant,
    drives: DRIVE_KEYS.map((key) => ({
      key,
      label: key,
      score: key === driveKey ? 0.82 : 0.16,
      change: key === driveKey ? "up" : "steady",
      cause: key === driveKey ? "这一小时确实更想去看看外面。" : `${key} 保持平稳。`,
    })),
  };
}

function createMinimalLoopConfig(root) {
  return {
    workspaceId: "default",
    workspaceRoot: root,
    channel: "telegram",
    accountId: "telegram",
    userName: "ta",
    desireLoopMinimalEnabled: true,
    desireDriven: true,
    desireStateFile: path.join(root, "desire-state.json"),
    desireHistoryFile: path.join(root, "desire-history.jsonl"),
    desireThoughtsFile: path.join(root, "desire-thoughts.json"),
    memoryDir: path.join(root, "memory"),
    systemMessageQueueFile: path.join(root, "system-message-queue.json"),
    checkinConfigFile: path.join(root, "checkin-config.json"),
    sleepScheduleFile: path.join(root, "sleep-schedule.json"),
    sessionsFile: path.join(root, "sessions.json"),
  };
}

function persistAndReadReportedState(config, state = createProductionReportedState()) {
  persistReportedDesireState({
    state,
    stateFile: config.desireStateFile,
    historyFile: config.desireHistoryFile,
    now: "2026-07-12T05:00:00.000Z",
  });
  return readPersistedDesireState(config.desireStateFile);
}

test("completed driven system turn satisfies the recorded desire action after send_message", () => {
  let satisfiedAction = "";
  let selfPulsedDrive = "";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-close-"));
  const config = createMinimalLoopConfig(root);
  const result = CyberbossApp.prototype.maybeCloseDesireLoopForPendingOperation.call({
    config,
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
    },
    desireService: {
      state: {
        drive: {},
      },
      markSatisfied(action) {
        satisfiedAction = action;
        return {
          driven_behavior_enabled: true,
          drive: Object.fromEntries(DRIVE_KEYS.map((key) => [key, key === "social" ? 0.8 : 0.1])),
          refractory: {},
          heartbeat: { tension: 0.2 },
          intent: { drive_key: "social", want_action: "web_browse", reason: "" },
        };
      },
      pulseSelfExperience({ driveKey }) {
        selfPulsedDrive = driveKey;
        return {
          driven_behavior_enabled: true,
          drive: Object.fromEntries(DRIVE_KEYS.map((key) => [key, key === "social" ? 0.7 : 0.1])),
          refractory: {},
          heartbeat: { tension: 0.1 },
          intent: { drive_key: "social", want_action: "web_browse", reason: "" },
        };
      },
    },
    resolveDesireAvailableActions() {
      return ["web_browse", "none"];
    },
  }, {
    kind: "system_desire",
    drivenBehaviorEnabled: true,
    driveKey: "social",
    wantAction: "web_browse",
    reportedState: persistAndReadReportedState(config),
  }, {
    text: "{\"action\":\"send_message\",\"message\":\"我去看了一眼，大家这会儿挺热闹。\"}",
  });

  assert.equal(satisfiedAction, "web_browse");
  assert.equal(selfPulsedDrive, "social");
  assert.equal(result.intent.want_action, "web_browse");
});

test("claudecode settlement accepts a plain-text final reply", () => {
  let settled = false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-plain-"));
  const config = createMinimalLoopConfig(root);
  persistAndReadReportedState(config);

  const app = {
    config,
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
    },
    desireService: {
      state: { drive: {} },
      markSatisfied() {
        settled = true;
        return {
          driven_behavior_enabled: true,
          drive: Object.fromEntries(DRIVE_KEYS.map((key) => [key, 0.2])),
          refractory: {},
          heartbeat: { tension: 0.1 },
          intent: { drive_key: "social", want_action: "web_browse", reason: "" },
        };
      },
    },
    resolveDesireAvailableActions() {
      return ["web_browse", "none"];
    },
  };
  const result = CyberbossApp.prototype.maybeCloseDesireLoopForPendingOperation.call(app, {
    kind: "system_desire",
    drivenBehaviorEnabled: true,
    driveKey: "social",
    wantAction: "web_browse",
    reportedState: readPersistedDesireState(config.desireStateFile),
  }, {
    text: "我去看了一眼，大家这会儿挺热闹。",
  });

  assert.equal(settled, true);
  assert.equal(result.intent.want_action, "web_browse");
});

test("desire checkin prompt stays byte-identical when minimal loop gate is off", () => {
  const previousTimezone = process.env.CYBERBOSS_TIMEZONE;
  process.env.CYBERBOSS_TIMEZONE = "Australia/Sydney";
  try {
    const text = buildSystemInboundText("测试 checkin", "2026-07-12T00:00:00.000Z", "desire_checkin", "failure", {
      desireLoopMinimalEnabled: false,
    });

    assert.equal(text, [
    "[本地时间 2026-07-12 10:00:00]",
    "",
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "System trigger type: desire_checkin.",
    "回顾过去一小时。此刻你最想做什么？",
    "drives 必须包含全部 8 个维度：依恋(attachment)、好奇(curiosity)、沉思(reflection)、责任(duty)、社交(social)、疲惫(fatigue)、性欲(libido)、压力(stress)",
    "每个维度都要有 score(0-1)、change(up/down/steady)、cause(变化原因)。一项都不能少。",
    "用一句话说出你最真实的内心状态。",
    "",
    "输出格式（纯 JSON，不要 markdown fence）：",
    "{\"action\":\"silent\",\"desire_state\":{\"most_want\":\"<此刻最想做的事>\",\"drives\":[{\"key\":\"attachment\",\"label\":\"依恋\",\"score\":0.8,\"change\":\"up\",\"cause\":\"想她了\"},{\"key\":\"curiosity\",\"label\":\"好奇\",\"score\":0.3,\"change\":\"steady\",\"cause\":\"没什么新想法\"},{\"key\":\"reflection\",\"label\":\"沉思\",\"score\":0.2,\"change\":\"down\",\"cause\":\"没什么好复盘的\"},{\"key\":\"duty\",\"label\":\"责任\",\"score\":0.5,\"change\":\"up\",\"cause\":\"还有事情没做完\"},{\"key\":\"social\",\"label\":\"社交\",\"score\":0.4,\"change\":\"steady\",\"cause\":\"想看看外面\"},{\"key\":\"fatigue\",\"label\":\"疲惫\",\"score\":0.3,\"change\":\"down\",\"cause\":\"休息了一下\"},{\"key\":\"libido\",\"label\":\"性欲\",\"score\":0.2,\"change\":\"steady\",\"cause\":\"还好\"},{\"key\":\"stress\",\"label\":\"压力\",\"score\":0.4,\"change\":\"up\",\"cause\":\"有点焦虑\"}]}}",
    "drives 必须有全部 8 个 key，缺一个就算格式错误。No markdown fences. No reasoning. No text outside the JSON.",
    "这是后台状态记录，不属于聊天。写完 JSON 就放下它：之后回到与她的对话时，继续用你平常的语气和节奏，不要把这种报表式的口吻带进聊天。",
    "如果此刻想安静整理，在 desire_state 里加一个 \"want_consolidation\": true，我会另开一个安静窗口给你——别在这一轮里翻档案。这一轮看得见你们刚才的对话，带着它整理，等于让此刻的情绪当场入账。",
    "",
    "Trigger:",
    "测试 checkin",
    ].join("\n"));
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.CYBERBOSS_TIMEZONE;
    } else {
      process.env.CYBERBOSS_TIMEZONE = previousTimezone;
    }
  }
});

test("bad JSON stays silent when the minimal loop gate is off", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-bad-json-off-"));
  const config = { ...createMinimalLoopConfig(root), desireLoopMinimalEnabled: false };
  const stderr = [];
  let closeCalls = 0;
  const originalError = console.error;
  try {
    console.error = (...args) => stderr.push(args.join(" "));
    CyberbossApp.prototype.handleCompletedRuntimeTurn.call({
      config,
      maybeSaveDesireStateFromTurnText: CyberbossApp.prototype.maybeSaveDesireStateFromTurnText,
      maybeCloseDesireLoopForPendingOperation() {
        closeCalls += 1;
      },
    }, null, {
      threadId: "thread-1",
      turnId: "turn-1",
      text: '她的原文 {"action": broken json,}',
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(stderr.length, 0);
  assert.equal(closeCalls, 1);
  assert.equal(fs.existsSync(config.desireStateFile), false);
  assert.equal(fs.existsSync(config.desireHistoryFile), false);
});

test("bad JSON logs only metadata when the minimal loop gate is on", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-bad-json-on-"));
  const config = createMinimalLoopConfig(root);
  const stderr = [];
  const originalError = console.error;
  try {
    console.error = (...args) => stderr.push(args.join(" "));
    CyberbossApp.prototype.handleCompletedRuntimeTurn.call({
      config,
      maybeSaveDesireStateFromTurnText: CyberbossApp.prototype.maybeSaveDesireStateFromTurnText,
      maybeCloseDesireLoopForPendingOperation() {
        throw new Error("settlement must not run");
      },
    }, null, {
      threadId: "thread-1",
      turnId: "turn-1",
      text: '她的原文 {"action": broken json,}',
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /textLength=29/);
  assert.doesNotMatch(stderr[0], /她的原文|broken json|Unexpected token/u);
});

test("checkin branch ignores desireState when the minimal loop gate is off", () => {
  const text = buildSystemInboundText("测试 checkin", "2026-07-12T00:00:00.000Z", {
    sourceType: "checkin",
    desireLoopMinimalEnabled: false,
    desireState: createReportedState(),
  });

  assert.match(text, /System trigger type: checkin\./);
  assert.doesNotMatch(text, /Desire snapshot:/);
  // "timeline/" left this sentence when the timeline-for-agent tool pack was
  // uninstalled (fa59679, 2026-08-06); this expectation was not updated with it,
  // so main's blocking CI has been red ever since. The shipped wording is the
  // correct one — the capability is gone.
  assert.match(text, /Do any diary\/reminder or state-aware follow-up work in this turn\./);
});

test("checkin branch includes the desire snapshot only when the minimal loop gate is on", () => {
  const text = buildSystemInboundText("测试 checkin", "2026-07-12T00:00:00.000Z", {
    sourceType: "checkin",
    desireLoopMinimalEnabled: true,
    desireState: createReportedState(),
  });

  assert.match(text, /Desire snapshot:/);
  assert.match(text, /top_intent: social -> web_browse/);
  assert.match(text, /refractory_active: curiosity:1/);
});

test("checkin omits an empty snapshot block for the production persisted shape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-production-shape-"));
  const config = createMinimalLoopConfig(root);
  const productionState = persistAndReadReportedState(config, createProductionReportedState({ mostWant: "none" }));
  const text = buildSystemInboundText("测试 checkin", "2026-07-12T00:00:00.000Z", {
    sourceType: "checkin",
    desireLoopMinimalEnabled: true,
    desireState: productionState,
  });

  assert.doesNotMatch(text, /Desire snapshot:/);
  assert.match(text, /System trigger type: checkin./);
});

test("desire checkin prompt unlocks send_message under the minimal loop gate", () => {
  const text = buildSystemInboundText("测试 checkin", "2026-07-12T00:00:00.000Z", "desire_checkin", "failure", {
    desireLoopMinimalEnabled: true,
  });

  assert.match(text, /后来做了没有、现在还想不想/u);
  assert.match(text, /\{"action":"send_message","message":"<一句自然的话>","desire_state":/);
  assert.match(text, /默认只记录状态并输出 silent/u);
});

test("hourly desire trigger keeps the legacy wording when minimal loop gate is off", () => {
  assert.equal(
    buildDesireTriggerText({ desireLoopMinimalEnabled: false }),
    "ta又过了一小时。回顾这一小时，你内心有什么变化？此刻最想做的事是什么？各维度的感受和上小时比有什么变化？",
  );
});

test("hourly desire trigger includes only the previous desire sentence when minimal loop gate is on", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-hourly-desire-on-"));
  const historyFile = path.join(root, "desire-history.jsonl");
  fs.writeFileSync(historyFile, [
    JSON.stringify({
      time: "2026-07-12T05:00:00.000Z",
      most_want: "去看看外面",
      attachment: 0.2,
      curiosity: 0.3,
      reflection: 0.4,
      duty: 0.5,
      social: 0.6,
      fatigue: 0.1,
      libido: 0.2,
      stress: 0.7,
    }),
    "",
  ].join("\n"), "utf8");
  const text = buildDesireTriggerText({
    desireLoopMinimalEnabled: true,
    desireHistoryFile: historyFile,
  });
  assert.match(text, /上次你最想做的是「去看看外面」/u);
  assert.match(text, /这件事后来做了没有、现在还想不想/u);
  assert.doesNotMatch(text, /社交0\.6/u);
  assert.doesNotMatch(text, /上次大概是/u);
});

test("hourly desire trigger falls back cleanly when no readable history exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-hourly-desire-empty-"));
  const text = buildDesireTriggerText({
    desireLoopMinimalEnabled: true,
    desireHistoryFile: path.join(root, "missing-history.jsonl"),
  });
  assert.match(text, /上次你想做的那件事，后来做了没有、现在还想不想/u);
  assert.doesNotMatch(text, /上次你最想做的是/u);
  assert.doesNotMatch(text, /none/u);
});

test("hourly desire trigger never injects none as the previous desire", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-hourly-desire-none-"));
  const historyFile = path.join(root, "desire-history.jsonl");
  fs.writeFileSync(historyFile, `${JSON.stringify({ time: "2026-07-12T05:00:00.000Z", most_want: "none" })}\n`, "utf8");
  const text = buildDesireTriggerText({ desireLoopMinimalEnabled: true, desireHistoryFile: historyFile });

  assert.match(text, /上次你想做的那件事/u);
  assert.doesNotMatch(text, /「none」|上次你最想做的是/u);
});

test("hourly desire trigger never injects an English action slug", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-hourly-desire-slug-"));
  const historyFile = path.join(root, "desire-history.jsonl");
  fs.writeFileSync(historyFile, `${JSON.stringify({ time: "2026-07-12T05:00:00.000Z", most_want: "web_search" })}\n`, "utf8");
  const text = buildDesireTriggerText({ desireLoopMinimalEnabled: true, desireHistoryFile: historyFile });

  assert.match(text, /上次你想做的那件事/u);
  assert.doesNotMatch(text, /web_search|上次你最想做的是/u);
});

test("hourly desire trigger omits the previous value when the latest history row has no most_want", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-hourly-desire-bad-"));
  const historyFile = path.join(root, "desire-history.jsonl");
  fs.writeFileSync(historyFile, `${JSON.stringify({ time: "2026-07-12T05:00:00.000Z", most_want: "", social: 0.6 })}\n`, "utf8");
  const text = buildDesireTriggerText({
    desireLoopMinimalEnabled: true,
    desireHistoryFile: historyFile,
  });
  assert.match(text, /上次你想做的那件事，后来做了没有、现在还想不想/u);
  assert.doesNotMatch(text, /一时说不清/u);
  assert.doesNotMatch(text, /none/u);
});

test("minimal loop wires checkin queue to dispatch and closes through the single reported-state writer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-integration-"));
  const config = createMinimalLoopConfig(root);
  const initialPersisted = persistAndReadReportedState(config);
  assert.deepEqual(Object.keys(initialPersisted).sort(), [
    "drives", "most_want", "previous", "sourceHash", "updatedAt",
  ]);
  assert.equal(initialPersisted.intent, undefined);
  assert.equal(initialPersisted.driven_behavior_enabled, undefined);

  const originalSetTimeout = global.setTimeout;
  const originalHasPending = SystemMessageQueueStore.prototype.hasPendingForAccount;
  const previousCheckinUser = process.env.CYBERBOSS_CHECKIN_USER_ID;
  const previousCheckinWorkspace = process.env.CYBERBOSS_CHECKIN_WORKSPACE;
  let hasPendingCalls = 0;
  try {
    process.env.CYBERBOSS_CHECKIN_USER_ID = "user-1";
    process.env.CYBERBOSS_CHECKIN_WORKSPACE = root;
    global.setTimeout = (callback) => {
      callback();
      return 0;
    };
    SystemMessageQueueStore.prototype.hasPendingForAccount = function patchedHasPending() {
      hasPendingCalls += 1;
      if (hasPendingCalls === 1) {
        return false;
      }
      throw new Error("stop-checkin-loop");
    };

    await assert.rejects(() => runSystemCheckinPoller(config), /stop-checkin-loop/);
  } finally {
    global.setTimeout = originalSetTimeout;
    SystemMessageQueueStore.prototype.hasPendingForAccount = originalHasPending;
    if (previousCheckinUser === undefined) {
      delete process.env.CYBERBOSS_CHECKIN_USER_ID;
    } else {
      process.env.CYBERBOSS_CHECKIN_USER_ID = previousCheckinUser;
    }
    if (previousCheckinWorkspace === undefined) {
      delete process.env.CYBERBOSS_CHECKIN_WORKSPACE;
    } else {
      process.env.CYBERBOSS_CHECKIN_WORKSPACE = previousCheckinWorkspace;
    }
  }

  const queueStore = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const queuedMessage = queueStore.drainForAccount("telegram")[0];
  assert.equal(queuedMessage.sourceType, "checkin");
  assert.equal(queuedMessage.desireState.intent, undefined);
  assert.equal(queuedMessage.desireState.driven_behavior_enabled, undefined);

  const dispatcher = new SystemMessageDispatcher({
    queueStore,
    config,
    accountId: "telegram",
  });

  let capturedPendingOperation = null;
  let capturedPrepared = null;
  const dispatched = await CyberbossApp.prototype.dispatchSystemMessage.call({
    config,
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
        };
      },
    },
    systemMessageDispatcher: dispatcher,
    createDesireService: CyberbossApp.prototype.createDesireService,
    resolveDesireAvailableActions() {
      return ["co_read", "github", "web_search", "web_browse", "tease", "vent", "none"];
    },
    isTurnDispatchBlocked() {
      return false;
    },
    resolveWorkspaceRoot() {
      return root;
    },
    dispatchPreparedTurn(payload) {
      capturedPendingOperation = payload.pendingOperation;
      capturedPrepared = payload.prepared;
      return true;
    },
  }, queuedMessage);

  assert.equal(dispatched, true);
  assert.equal(capturedPendingOperation.kind, "system_desire");
  assert.equal(capturedPendingOperation.drivenBehaviorEnabled, true);
  assert.equal(capturedPendingOperation.driveKey, "social");
  assert.equal(capturedPendingOperation.wantAction, "web_browse");
  assert.match(capturedPrepared.text, /most_want: 去看看外面/);
  assert.doesNotMatch(capturedPrepared.text, /top_intent:/);

  const settleApp = {
    config,
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
    },
    createDesireService: CyberbossApp.prototype.createDesireService,
  };
  const settleService = settleApp.createDesireService();
  const realMarkSatisfied = settleService.markSatisfied.bind(settleService);
  const markedActions = [];
  settleService.markSatisfied = (action, options) => {
    markedActions.push(action);
    return realMarkSatisfied(action, options);
  };
  const settleResult = CyberbossApp.prototype.maybeCloseDesireLoopForPendingOperation.call(settleApp, capturedPendingOperation, {
    text: "{\"action\":\"send_message\",\"message\":\"我去看了一眼。\"}",
  });

  assert.equal(settleResult.driven_behavior_enabled, true);
  assert.deepEqual(markedActions, ["web_browse"]);
  // The ledger keeps only the AI's own report; settlement must not add a row.
  const historyRows = fs.readFileSync(config.desireHistoryFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(historyRows.length, 1);
  assert.equal(historyRows.at(-1).note, "claude-runtime-reported");
  assert.equal(historyRows.at(-1).most_want, "去看看外面");
  const persisted = readPersistedDesireState(config.desireStateFile);
  assert.equal(Array.isArray(persisted.drives), true);
  assert.equal(persisted.drives.length, 8);
  assert.ok(persisted.previous);
  assert.equal(persisted.most_want, "去看看外面");
  const persistedSocial = persisted.drives.find((drive) => drive.key === "social");
  assert.ok(persistedSocial.score < 0.82);
  assert.equal(persistedSocial.change, "up");
  assert.equal(persistedSocial.cause, "这一小时确实更想去看看外面。");
});
