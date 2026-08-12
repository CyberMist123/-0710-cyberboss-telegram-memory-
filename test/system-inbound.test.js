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
const { buildSystemInboundText } = require("../src/core/system-message-dispatcher");
const { runHourlyDesirePoller } = require("../src/app/hourly-desire-poller");
const { buildTelegramRouteLane, buildSystemRouteLane } = require("../src/core/route-lane");

test("only desire_checkin returns to its persisted Telegram lane; other system sources stay isolated", async () => {
  const telegramLane = buildTelegramRouteLane({ accountId: "telegram", chatId: "42" });
  const descriptor = {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    laneKey: telegramLane.laneKey,
    laneKind: "tg",
    provider: "telegram",
    accountId: "telegram",
    chatId: "42",
    messageThreadId: null,
  };
  const dispatched = [];
  const appLike = {
    config: { channel: "telegram" },
    systemMessageDispatcher: { buildPreparedMessage: (message) => ({ workspaceId: "default", accountId: "telegram", senderId: message.senderId, workspaceRoot: "/workspace" }) },
    runtimeAdapter: {
      getSessionStore: () => ({ buildBindingKey: () => "binding-1" }),
      listRestorableSlots: () => [{ route: descriptor }],
      resolveRouteSession: () => ({ threadId: "telegram-thread" }),
    },
    isTurnDispatchBlocked: () => false,
    dispatchPreparedTurn: async (value) => { dispatched.push(value); return true; },
  };
  for (const sourceType of ["desire_checkin", "reflect", "consolidation", "checkin", "liveness_alert"]) {
    await CyberbossApp.prototype.dispatchSystemMessage.call(appLike, { id: sourceType, senderId: "42", sourceType });
  }
  assert.equal(dispatched[0].lane.laneKey, telegramLane.laneKey);
  assert.equal(dispatched[0].gateLane.laneKey, telegramLane.laneKey);
  for (const turn of dispatched.slice(1)) {
    assert.equal(turn.lane.laneKey, buildSystemRouteLane("system-message").laneKey);
    assert.equal(turn.gateLane, null);
  }
});

test("desire_checkin falls back to the system lane when its saved route descriptor is unavailable", async () => {
  let turn;
  const appLike = {
    config: { channel: "telegram" },
    systemMessageDispatcher: { buildPreparedMessage: () => ({ workspaceId: "default", accountId: "telegram", senderId: "42", workspaceRoot: "/workspace" }) },
    runtimeAdapter: {
      getSessionStore: () => ({ buildBindingKey: () => "binding-1" }),
      listRestorableSlots: () => [{ route: { bindingKey: "binding-1", workspaceRoot: "/workspace", laneKind: "tg" } }],
      resolveRouteSession: () => ({ threadId: "" }),
    },
    isTurnDispatchBlocked: () => false,
    dispatchPreparedTurn: async (value) => { turn = value; return true; },
  };
  await CyberbossApp.prototype.dispatchSystemMessage.call(appLike, { id: "desire", senderId: "42", sourceType: "desire_checkin" });
  assert.equal(turn.lane.laneKey, buildSystemRouteLane("system-message").laneKey);
  assert.equal(turn.gateLane, null);
});

test("system messages bypass normal inbound wrapping", async () => {
  const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({}, {
    provider: "system",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    attachments: [],
  }, "/tmp");

  assert.deepEqual(prepared, {
    provider: "system",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    originalText: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    attachments: [],
    attachmentFailures: [],
  });
});

test("system inbound text includes desire guidance for proactive turns", () => {
  const text = buildSystemInboundText("测试 checkin", "2026-06-11T00:00:00.000Z", {
    sourceType: "checkin",
    desireLoopMinimalEnabled: true,
    desireState: {
      driven_behavior_enabled: true,
      intent: {
        drive_key: "social",
        want_action: "web_browse",
        reason: "想去看看人群现在在聊什么。",
        query_hint: "看看大家在聊什么",
      },
      heartbeat: {
        tension: 0.742,
      },
      refractory: {
        curiosity: 1,
        social: 0,
      },
    },
  });

  assert.match(text, /System trigger type: checkin\./);
  assert.match(text, /Desire snapshot:/);
  assert.match(text, /top_intent: social -> web_browse/);
  assert.match(text, /If acting, let the top intent lead this proactive turn/i);
  assert.match(text, /refractory_active: curiosity:1/);
  assert.doesNotMatch(text, /query_hint/i);
});

test("completed driven system turn satisfies the recorded desire action after send_message", () => {
  let satisfiedAction = "";
  let selfPulsedDrive = "";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-system-desire-close-"));
  const result = CyberbossApp.prototype.maybeCloseDesireLoopForPendingOperation.call({
    config: {
      desireLoopMinimalEnabled: true,
      desireStateFile: path.join(root, "desire-state.json"),
      desireHistoryFile: path.join(root, "desire-history.jsonl"),
    },
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
          drive: {
            attachment: 0.1,
            curiosity: 0.1,
            reflection: 0.1,
            duty: 0.1,
            social: 0.8,
            fatigue: 0.1,
            libido: 0.1,
            stress: 0.1,
          },
          refractory: {},
          heartbeat: { tension: 0.2 },
          intent: {
            drive_key: "social",
            want_action: action,
            reason: "",
          },
        };
      },
      pulseSelfExperience({ driveKey }) {
        selfPulsedDrive = driveKey;
        return {
          driven_behavior_enabled: true,
          drive: {
            attachment: 0.1,
            curiosity: 0.1,
            reflection: 0.1,
            duty: 0.1,
            social: 0.7,
            fatigue: 0.1,
            libido: 0.1,
            stress: 0.1,
          },
          refractory: {},
          heartbeat: { tension: 0.1 },
          intent: {
            drive_key: "social",
            want_action: "web_browse",
            reason: "",
          },
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
    reportedState: {
      most_want: "去看看外面",
      driven_behavior_enabled: true,
      intent: {
        drive_key: "social",
        want_action: "web_browse",
        reason: "想去看看外面在聊什么。",
      },
      drives: [
        { key: "attachment", score: 0.1 },
        { key: "curiosity", score: 0.1 },
        { key: "reflection", score: 0.1 },
        { key: "duty", score: 0.1 },
        { key: "social", score: 0.8 },
        { key: "fatigue", score: 0.1 },
        { key: "libido", score: 0.1 },
        { key: "stress", score: 0.1 },
      ],
    },
  }, {
    text: "{\"action\":\"send_message\",\"message\":\"我去看了一眼，大家这会儿挺热闹。\"}",
  });

  assert.equal(satisfiedAction, "web_browse");
  assert.equal(selfPulsedDrive, "social");
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

test("desire checkin prompt unlocks send_message under the minimal loop gate", () => {
  const text = buildSystemInboundText("测试 checkin", "2026-07-12T00:00:00.000Z", "desire_checkin", "failure", {
    desireLoopMinimalEnabled: true,
  });

  assert.match(text, /后来做了没有、现在还想不想/u);
  assert.match(text, /\{"action":"send_message","message":"<一句自然的话>","desire_state":/);
  assert.match(text, /默认只记录状态并输出 silent/u);
});

async function withStubbedHourlyDesireDependencies(config, assertion) {
  const pollerPath = require.resolve("../src/app/hourly-desire-poller");
  const queueStorePath = require.resolve("../src/core/system-message-queue-store");
  const sessionStorePath = require.resolve("../src/adapters/runtime/codex/session-store");
  const defaultTargetsPath = require.resolve("../src/core/default-targets");
  const schedulePath = require.resolve("../src/core/desire-schedule");
  const originalPoller = require.cache[pollerPath];
  const originalQueueStore = require.cache[queueStorePath];
  const originalSessionStore = require.cache[sessionStorePath];
  const originalDefaultTargets = require.cache[defaultTargetsPath];
  const originalSchedule = require.cache[schedulePath];
  try {
    const queueRows = [];
    require.cache[schedulePath] = {
      exports: {
        loadDesireSchedule() {
          return {
            enabled: true,
            timezone: "Australia/Sydney",
            intervalMinutes: 55,
          };
        },
        isNightSkipAt() {
          return false;
        },
        nextPlannedAt: (() => {
          let calls = 0;
          return (plannedAt, intervalMinutes, now) => {
            calls += 1;
            if (calls === 1) {
              return now;
            }
            throw new Error("stop-test-loop");
          };
        })(),
      },
    };
    require.cache[queueStorePath] = {
      exports: {
        SystemMessageQueueStore: class {
          hasPendingForAccount() { return false; }
          enqueue(row) { queueRows.push(row); return row; }
        },
      },
    };
    require.cache[sessionStorePath] = {
      exports: {
        SessionStore: class {},
      },
    };
    require.cache[defaultTargetsPath] = {
      exports: {
        resolvePreferredSenderId() { return "user-1"; },
        resolvePreferredWorkspaceRoot() { return config.workspaceRoot; },
      },
    };
    delete require.cache[pollerPath];
    const { runHourlyDesirePoller: runStubbedPoller } = require("../src/app/hourly-desire-poller");
    await assert.rejects(() => runStubbedPoller(config), /stop-test-loop/);
    await assertion(queueRows);
  } finally {
    if (originalPoller) require.cache[pollerPath] = originalPoller; else delete require.cache[pollerPath];
    if (originalSchedule) require.cache[schedulePath] = originalSchedule; else delete require.cache[schedulePath];
    if (originalQueueStore) require.cache[queueStorePath] = originalQueueStore; else delete require.cache[queueStorePath];
    if (originalSessionStore) require.cache[sessionStorePath] = originalSessionStore; else delete require.cache[sessionStorePath];
    if (originalDefaultTargets) require.cache[defaultTargetsPath] = originalDefaultTargets; else delete require.cache[defaultTargetsPath];
  }
}

test("hourly desire trigger keeps the legacy wording when minimal loop gate is off", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-hourly-desire-off-"));
  await withStubbedHourlyDesireDependencies({
    desireDriven: true,
    desireLoopMinimalEnabled: false,
    desirePlanFile: path.join(root, "desire-plan.json"),
    desireScheduleFile: path.join(root, "desire-schedule.json"),
    desireActiveFile: path.join(root, "desire-active.json"),
    desireTelemetry: false,
    desireTelemetryFile: path.join(root, "desire-usage.jsonl"),
    systemMessageQueueFile: path.join(root, "system-queue.json"),
    sessionsFile: path.join(root, "sessions.json"),
    channel: "telegram",
    accountId: "telegram",
    workspaceRoot: root,
  }, async (queueRows) => {
    assert.equal(queueRows[0].text, "ta又过了一小时。回顾这一小时，你内心有什么变化？此刻最想做的事是什么？各维度的感受和上小时比有什么变化？");
  });
});

test("hourly desire trigger includes the previous desire history row when minimal loop gate is on", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-hourly-desire-on-"));
  const historyFile = path.join(root, "desire-history.jsonl");
  fs.writeFileSync(historyFile, `${JSON.stringify({
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
  })}\n`, "utf8");
  await withStubbedHourlyDesireDependencies({
    desireDriven: true,
    desireLoopMinimalEnabled: true,
    desireHistoryFile: historyFile,
    desirePlanFile: path.join(root, "desire-plan.json"),
    desireScheduleFile: path.join(root, "desire-schedule.json"),
    desireActiveFile: path.join(root, "desire-active.json"),
    desireTelemetry: false,
    desireTelemetryFile: path.join(root, "desire-usage.jsonl"),
    systemMessageQueueFile: path.join(root, "system-queue.json"),
    sessionsFile: path.join(root, "sessions.json"),
    channel: "telegram",
    accountId: "telegram",
    workspaceRoot: root,
  }, async (queueRows) => {
    assert.match(queueRows[0].text, /上次你最想做的是「去看看外面」/u);
    assert.match(queueRows[0].text, /这件事后来做了没有、现在还想不想/u);
    assert.doesNotMatch(queueRows[0].text, /社交0\.6/u);
    assert.doesNotMatch(queueRows[0].text, /上次大概是/u);
  });
});

test("runtime turn completion forwards the final payload to completion side effects", async () => {
  let completedPayload = null;
  await CyberbossApp.prototype.handleRuntimeEvent.call({
    streamDelivery: {
      async handleRuntimeEvent() {},
      resolveReplyTargetForRun() {
        return null;
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
    },
    turnBoundaryScopeKeys: new Set(),
    pendingOperationByRunKey: new Map(),
    desireUsageByRunKey: new Map(),
    async synchronizeRecallTrace() {
      return false;
    },
    handleCompletedRuntimeTurn(pendingOperation, payload) {
      completedPayload = payload;
    },
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    async stopTypingForThread() {},
  }, {
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "{\"action\":\"send_message\",\"message\":\"想去看看外面在聊什么。\"}",
    },
  });

  assert.equal(completedPayload.text, "{\"action\":\"send_message\",\"message\":\"想去看看外面在聊什么。\"}");
});

test("image attachments stay as inbound drafts before runtime turn assembly", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "image/jpeg" : "";
      },
    },
    async arrayBuffer() {
      return Buffer.from("fake-jpeg-bytes");
    },
  });

  try {
    const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
        userName: "User",
      },
      runtimeAdapter: {
        describe() {
          return { id: "codex" };
        },
      },
      channelAdapter: {
        async sendText() {},
      },
    }, {
      provider: "weixin",
      text: "",
      senderId: "user-1",
      contextToken: "ctx-1",
      attachments: [{
        kind: "image",
        fileName: "photo.jpg",
        directUrls: ["https://example.com/photo.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-04-17T10:00:00.000Z",
    }, "/workspace");

    assert.equal(prepared.text, "");
    assert.equal(prepared.originalText, "");
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);

    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
      config: {
        userName: "User",
      },
      runtimeAdapter: {
        getTurnCapabilities() {
          return { nativeImageInput: false };
        },
      },
    }, { prepared, model: "" });
    assert.match(runtimeTurn.text, /Saved attachments:/i);
    assert.match(runtimeTurn.text, /vision caption provider is not configured/i);
    assert.match(runtimeTurn.text, /cyberboss_sticker_save_from_inbox/i);
    assert.match(runtimeTurn.text, /`items` array/i);
    assert.match(runtimeTurn.text, /cyberboss_sticker_tags/i);
    assert.match(runtimeTurn.text, /short new tag/i);
    assert.match(runtimeTurn.text, /Do not describe save steps/i);
    assert.doesNotMatch(runtimeTurn.text, /view_image/i);
    assert.doesNotMatch(runtimeTurn.text, /Read every image first/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test("image prompt assembly is runtime-neutral for claudecode drafts", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "image/jpeg" : "";
      },
    },
    async arrayBuffer() {
      return Buffer.from("fake-jpeg-bytes");
    },
  });

  try {
    const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
        userName: "User",
      },
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
      },
      channelAdapter: {
        async sendText() {},
      },
    }, {
      provider: "weixin",
      text: "",
      senderId: "user-1",
      contextToken: "ctx-1",
      attachments: [{
        kind: "image",
        fileName: "photo.jpg",
        directUrls: ["https://example.com/photo.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-04-17T10:00:00.000Z",
    }, "/workspace");

    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
      config: {
        userName: "User",
      },
      runtimeAdapter: {
        getTurnCapabilities() {
          return { nativeImageInput: false };
        },
      },
    }, { prepared, model: "" });

    assert.match(runtimeTurn.text, /Saved attachments:/i);
    assert.match(runtimeTurn.text, /cyberboss_sticker_save_from_inbox/i);
    assert.match(runtimeTurn.text, /`items` array/i);
    assert.match(runtimeTurn.text, /cyberboss_sticker_tags/i);
    assert.match(runtimeTurn.text, /short new tag/i);
    assert.match(runtimeTurn.text, /Do not describe save steps/i);
    assert.doesNotMatch(runtimeTurn.text, /Read every image first/i);
    assert.doesNotMatch(runtimeTurn.text, /view_image/i);
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("text-only runtimes receive vision API captions as visual context", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-vision-test-"));
  const imagePath = path.join(stateDir, "photo.jpg");
  fs.writeFileSync(imagePath, Buffer.from("fake-jpeg-bytes"));
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), "https://dashscope.example.com/compatible-mode/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "qwen-vl-demo");
    assert.equal(body.messages[0].content[1].type, "image_url");
    assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    return {
      ok: true,
      async text() {
        return JSON.stringify({
          choices: [{
            message: {
              content: "一杯带拉花的咖啡放在桌上。",
            },
          }],
        });
      },
    };
  };

  try {
    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
      config: {
        visionMode: "auto",
        visionProvider: "openai-compatible",
        visionApiBaseUrl: "https://dashscope.example.com/compatible-mode/v1",
        visionModel: "qwen-vl-demo",
      },
      runtimeAdapter: {
        getTurnCapabilities() {
          return { nativeImageInput: false };
        },
      },
    }, {
      prepared: {
        provider: "weixin",
        originalText: "",
        text: "",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: imagePath,
        }],
        attachmentFailures: [],
        receivedAt: "2026-04-17T10:00:00.000Z",
      },
      model: "deepseek-chat",
    });

    assert.match(runtimeTurn.text, /Visual context from attachments:/i);
    assert.match(runtimeTurn.text, /一杯带拉花的咖啡/);
    assert.match(runtimeTurn.text, /cyberboss_sticker_save_from_inbox/i);
    assert.deepEqual(runtimeTurn.attachments, []);
    assert.equal(runtimeTurn.visionContext.route, "caption");
  } finally {
    global.fetch = originalFetch;
  }
});

test("native image-capable runtimes receive attachments without caption fallback", async () => {
  const attachment = {
    kind: "image",
    contentType: "image/jpeg",
    isImage: true,
    absolutePath: "/tmp/native.jpg",
  };
  const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
    config: {
      visionMode: "auto",
    },
    resolveMemoryContextForPrepared: async () => ({ lines: [], slots: [], mode: "disabled" }),
    runtimeAdapter: {
      getTurnCapabilities() {
        return { nativeImageInput: true };
      },
    },
  }, {
    prepared: {
      provider: "weixin",
      originalText: "看看这个",
      text: "看看这个",
      attachments: [attachment],
      attachmentFailures: [],
      receivedAt: "2026-04-17T10:00:00.000Z",
    },
    model: "vision-model",
  });

  assert.match(runtimeTurn.text, /Saved attachments:/i);
  assert.doesNotMatch(runtimeTurn.text, /Visual context from attachments:/i);
  assert.deepEqual(runtimeTurn.attachments, [attachment]);
  assert.equal(runtimeTurn.visionContext.route, "native");
});

test("tool image-capable runtimes keep local image paths without caption fallback", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("caption provider should not be called");
  };

  try {
    const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({
      config: {
        visionMode: "auto",
        visionProvider: "openai-compatible",
        visionApiBaseUrl: "https://dashscope.example.com/compatible-mode/v1",
        visionModel: "qwen-vl-demo",
      },
      resolveMemoryContextForPrepared: async () => ({ lines: [], slots: [], mode: "disabled" }),
      runtimeAdapter: {
        getTurnCapabilities() {
          return { nativeImageInput: false, toolImageRead: true };
        },
      },
    }, {
      prepared: {
        provider: "weixin",
        originalText: "看看这个",
        text: "看看这个",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: "/tmp/tool-readable.jpg",
        }],
        attachmentFailures: [],
        receivedAt: "2026-04-17T10:00:00.000Z",
      },
      model: "claude-sonnet",
    });

    assert.match(runtimeTurn.text, /Saved attachments:/i);
    assert.match(runtimeTurn.text, /\/tmp\/tool-readable\.jpg/);
    assert.doesNotMatch(runtimeTurn.text, /Visual context from attachments:/i);
    assert.deepEqual(runtimeTurn.attachments, []);
    assert.equal(runtimeTurn.visionContext.route, "tool");
  } finally {
    global.fetch = originalFetch;
  }
});

test("image-only inbound turns enter the dedicated debounce queue", async () => {
  const queued = [];
  let routed = 0;
  await CyberbossApp.prototype.handlePreparedMessage.call({
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
        };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime() {
      return {
        workspaceId: "default",
        accountId: "wx-account",
        senderId: "user-1",
        contextToken: "ctx-1",
        provider: "weixin",
        originalText: "",
        text: "image prompt",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: "/tmp/a.jpg",
        }],
        attachmentFailures: [],
        receivedAt: "2026-04-30T10:00:00.000Z",
      };
    },
    isTurnDispatchBlocked() {
      return false;
    },
    enqueuePendingImageInbound(payload) {
      queued.push(payload);
    },
    async routePreparedInbound() {
      routed += 1;
    },
    resolveDesireAvailableActions() {
      return ["none"];
    },
  }, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    text: "今天有点烦",
    attachments: [],
  }, {
    allowCommands: false,
  });

  assert.equal(queued.length, 1);
  assert.equal(routed, 0);
});

test("debounced image batches merge with a trailing text message into one prepared turn", async () => {
  const scopeKey = "binding-1::/workspace";
  let routed = null;
  const app = {
    config: {
      userName: "User",
    },
    pendingImageInboundByScope: new Map([[scopeKey, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      messages: [{
        senderId: "user-1",
        accountId: "wx-account",
        workspaceId: "default",
        provider: "weixin",
        contextToken: "ctx-1",
        originalText: "",
        text: "image prompt 1",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: "/tmp/a.jpg",
        }],
        attachmentFailures: [],
        receivedAt: "2026-04-30T10:00:00.000Z",
      }, {
        senderId: "user-1",
        accountId: "wx-account",
        workspaceId: "default",
        provider: "weixin",
        contextToken: "ctx-1",
        originalText: "",
        text: "image prompt 2",
        attachments: [{
          kind: "image",
          contentType: "image/png",
          isImage: true,
          absolutePath: "/tmp/b.png",
        }],
        attachmentFailures: [],
        receivedAt: "2026-04-30T10:00:01.000Z",
      }],
      timer: null,
    }]]),
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
    },
    clearPendingImageInboundTimer: CyberbossApp.prototype.clearPendingImageInboundTimer,
    async routePreparedInbound({ prepared }) {
      routed = prepared;
      return true;
    },
  };

  await CyberbossApp.prototype.flushPendingImageInboundBatch.call(app, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    trailingPrepared: {
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      contextToken: "ctx-2",
      originalText: "这是补充文字",
      text: "text prompt",
      attachments: [],
      attachmentFailures: [],
      receivedAt: "2026-04-30T10:00:02.000Z",
    },
  });

  assert.ok(routed);
  assert.equal(routed.attachments.length, 2);
  assert.equal(routed.contextToken, "ctx-2");
  assert.match(routed.originalText, /这是补充文字/);
  assert.match(routed.text, /这是补充文字/);
  assert.doesNotMatch(routed.text, /Saved attachments:/i);
  assert.doesNotMatch(routed.text, /Read every image first/i);
});

test("debounced image batches still hand off to the normal pending buffer when the runtime is blocked", async () => {
  const scopeKey = "binding-1::/workspace";
  const buffered = [];
  const app = {
    pendingImageInboundByScope: new Map([[scopeKey, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      messages: [{
        senderId: "user-1",
        accountId: "wx-account",
        workspaceId: "default",
        provider: "weixin",
        contextToken: "ctx-1",
        originalText: "",
        text: "image prompt",
        attachments: [{
          kind: "image",
          contentType: "image/jpeg",
          isImage: true,
          absolutePath: "/tmp/a.jpg",
        }],
        attachmentFailures: [],
        receivedAt: "2026-04-30T10:00:00.000Z",
      }],
      timer: null,
    }]]),
    config: {
      userName: "User",
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
    },
    isTurnDispatchBlocked() {
      return true;
    },
    bufferPendingInboundMessage(payload) {
      buffered.push(payload);
    },
    async dispatchPreparedTurn() {
      throw new Error("should not dispatch while blocked");
    },
    clearPendingImageInboundTimer: CyberbossApp.prototype.clearPendingImageInboundTimer,
    routePreparedInbound: CyberbossApp.prototype.routePreparedInbound,
  };

  await CyberbossApp.prototype.flushPendingImageInboundBatch.call(app, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(buffered.length, 1);
  assert.equal(buffered[0].prepared.attachments.length, 1);
});

test("pending image-only inbox messages merge into one clean inbound draft", () => {
  const merged = CyberbossApp.prototype.mergePendingInboundDraft.call({
    config: {
      userName: "User",
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
    },
  }, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    messages: [{
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      contextToken: "ctx-1",
      originalText: "",
      text: "old image prompt 1",
      attachments: [{
        kind: "image",
        contentType: "image/jpeg",
        isImage: true,
        absolutePath: "/tmp/a.jpg",
      }],
      attachmentFailures: [],
      receivedAt: "2026-04-30T10:00:00.000Z",
    }, {
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      contextToken: "ctx-1",
      originalText: "",
      text: "old image prompt 2",
      attachments: [{
        kind: "image",
        contentType: "image/png",
        isImage: true,
        absolutePath: "/tmp/b.png",
      }],
      attachmentFailures: [],
      receivedAt: "2026-04-30T10:00:01.000Z",
    }],
  });

  assert.equal(merged.prepared.attachments.length, 2);
  assert.equal(merged.remainingMessages.length, 0);
  assert.equal(merged.prepared.text, "");
  assert.doesNotMatch(merged.prepared.text, /Saved attachments:/i);
  assert.doesNotMatch(merged.prepared.text, /Read every image first/i);
});

test("a mixed pending batch keeps every message and every attachment, not just the newest", () => {
  // Regression, 2026-08-12. This branch used to merge by hand: it spread
  // `...latest` and then set only `text`. Readers prefer `originalText`, so the
  // newest message's originalText won and the earlier ones vanished -- send
  // three messages while a turn is running and only the third arrived.
  const merged = CyberbossApp.prototype.mergePendingInboundDraft.call({
    config: { userName: "User" },
    runtimeAdapter: { describe() { return { id: "claudecode" }; } },
  }, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    messages: [{
      senderId: "user-1",
      accountId: "telegram",
      workspaceId: "default",
      provider: "telegram",
      contextToken: "ctx-1",
      originalText: "第一条：我回来了",
      text: "第一条：我回来了",
      attachments: [],
      attachmentFailures: [],
      receivedAt: "2026-08-12T01:00:00.000Z",
    }, {
      senderId: "user-1",
      accountId: "telegram",
      workspaceId: "default",
      provider: "telegram",
      contextToken: "ctx-1",
      originalText: "[语音]\n[语音转写: 第二条语音]",
      text: "[语音]\n[语音转写: 第二条语音]",
      attachments: [{ kind: "voice", absolutePath: "/tmp/v.oga" }],
      attachmentFailures: [],
      receivedAt: "2026-08-12T01:00:01.000Z",
    }, {
      senderId: "user-1",
      accountId: "telegram",
      workspaceId: "default",
      provider: "telegram",
      contextToken: "ctx-1",
      originalText: "第三条：你看这张图",
      text: "第三条：你看这张图",
      attachments: [{ kind: "photo", absolutePath: "/tmp/p.jpg" }],
      attachmentFailures: [],
      receivedAt: "2026-08-12T01:00:02.000Z",
    }],
  });

  // Every message survives, in order, in the field readers actually use.
  assert.match(merged.prepared.originalText, /第一条：我回来了/);
  assert.match(merged.prepared.originalText, /第二条语音/);
  assert.match(merged.prepared.originalText, /第三条：你看这张图/);
  assert.equal(merged.prepared.text, merged.prepared.originalText);
  assert.ok(
    merged.prepared.originalText.indexOf("第一条") < merged.prepared.originalText.indexOf("第三条"),
    "blocks must stay in arrival order",
  );

  // The voice note and the photo both survive; previously only the photo did.
  assert.equal(merged.prepared.attachments.length, 2);
  assert.deepEqual(
    merged.prepared.attachments.map((a) => a.kind),
    ["voice", "photo"],
  );
  assert.equal(merged.remainingMessages.length, 0);
});

test("pending image-only inbox messages are split into batches of 10 attachments", () => {
  const merged = CyberbossApp.prototype.mergePendingInboundDraft.call({
    config: {
      userName: "User",
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
    },
  }, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    messages: [{
      senderId: "user-1",
      accountId: "wx-account",
      workspaceId: "default",
      provider: "weixin",
      contextToken: "ctx-1",
      originalText: "",
      text: "old image prompt",
      attachments: Array.from({ length: 12 }, (_, index) => ({
        kind: "image",
        contentType: "image/jpeg",
        isImage: true,
        absolutePath: `/tmp/${index + 1}.jpg`,
      })),
      attachmentFailures: [],
      receivedAt: "2026-04-30T10:00:00.000Z",
    }],
  });

  assert.equal(merged.prepared.attachments.length, 10);
  assert.equal(merged.remainingMessages.length, 1);
  assert.equal(merged.remainingMessages[0].attachments.length, 2);
});

test("location arrive_home trigger enqueues a system action message", () => {
  const queued = [];
  CyberbossApp.prototype.handleLocationAccepted.call({
    activeAccountId: "wx-account",
    config: {
      allowedUserIds: ["user-1"],
      locationV2Enabled: false,
      workspaceRoot: "/workspace",
      workspaceId: "default",
    },
    handleLegacyLocationAccepted: CyberbossApp.prototype.handleLegacyLocationAccepted,
    runtimeAdapter: {
      getSessionStore() {
        return {};
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
  }, {
    appended: {
      point: {
        id: "point-1",
        trigger: "arrive_home",
        timestamp: "2026-04-18T16:00:00.000Z",
        receivedAt: "2026-04-18T16:00:01.000Z",
      },
      movementEvent: null,
    },
  });

  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "location-trigger:point-1");
  assert.equal(queued[0].senderId, "user-1");
  assert.equal(queued[0].workspaceRoot, "/workspace");
  assert.equal(queued[0].text, "User arrives home.");
});

test("location leave_home trigger and major move both enqueue system action messages", () => {
  const queued = [];
  CyberbossApp.prototype.handleLocationAccepted.call({
    activeAccountId: "wx-account",
    config: {
      allowedUserIds: ["user-1"],
      locationV2Enabled: false,
      workspaceRoot: "/workspace",
      workspaceId: "default",
    },
    handleLegacyLocationAccepted: CyberbossApp.prototype.handleLegacyLocationAccepted,
    runtimeAdapter: {
      getSessionStore() {
        return {};
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
  }, {
    appended: {
      point: {
        id: "point-2",
        trigger: "leave_home",
        timestamp: "2026-04-18T17:00:00.000Z",
        receivedAt: "2026-04-18T17:00:02.000Z",
      },
      movementEvent: {
        id: "move-1",
        distanceMeters: 2400,
        fromAddress: "Home",
        toAddress: "Office",
        movedAt: "2026-04-18T17:20:00.000Z",
      },
    },
  });

  assert.equal(queued.length, 2);
  assert.equal(queued[0].id, "location-trigger:point-2");
  assert.equal(queued[0].text, "User leaves home.");
  assert.equal(queued[1].id, "location-move:move-1");
  assert.match(queued[1].text, /location appears to have changed significantly/i);
});

// 整理的触发时机在八维菜单里，但整理本身必须在独处窗口做。
// 这几条钉的是那道墙：八维这一轮只负责把意愿转成排队消息，
// 真正的整理走 consolidation ——而 consolidation 仍旧固定在 system lane
// （由本文件上面那条 lane 回归测试保证）。
function buildDesireReplyApp(queued, { pending = false } = {}) {
  return {
    config: { desireStateFile: "", desireHistoryFile: "" },
    automationTargets: { accountId: "telegram", senderId: "42", workspaceRoot: "/workspace" },
    systemMessageQueue: {
      hasPendingForAccount: () => pending,
      enqueue: (message) => queued.push(message),
    },
  };
}

test("a checkin that asks to tidy up queues consolidation instead of tidying in the chat turn", () => {
  const queued = [];
  const result = CyberbossApp.prototype.maybeQueueConsolidationFromDesireReply.call(
    buildDesireReplyApp(queued),
    { want_consolidation: true }
  );
  assert.equal(result.queued, true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceType, "consolidation");
  assert.equal(queued[0].accountId, "telegram");
  assert.equal(queued[0].senderId, "42");
  assert.equal(queued[0].workspaceRoot, "/workspace");
  assert.match(queued[0].id, /^desire-consolidation:/u);
});

test("a checkin that does not ask to tidy up queues nothing", () => {
  for (const state of [{}, { want_consolidation: false }, { want_consolidation: "true" }, null]) {
    const queued = [];
    const result = CyberbossApp.prototype.maybeQueueConsolidationFromDesireReply.call(
      buildDesireReplyApp(queued),
      state
    );
    assert.equal(result.queued, false);
    assert.equal(queued.length, 0);
  }
});

test("a consolidation already waiting is not queued twice", () => {
  const queued = [];
  const result = CyberbossApp.prototype.maybeQueueConsolidationFromDesireReply.call(
    buildDesireReplyApp(queued, { pending: true }),
    { want_consolidation: true }
  );
  assert.equal(result.queued, false);
  assert.equal(result.reason, "overlap");
  assert.equal(queued.length, 0);
});

test("missing automation targets degrade quietly rather than throwing", () => {
  const queued = [];
  const app = buildDesireReplyApp(queued);
  app.automationTargets = { accountId: "", senderId: "", workspaceRoot: "" };
  const result = CyberbossApp.prototype.maybeQueueConsolidationFromDesireReply.call(app, { want_consolidation: true });
  assert.equal(result.queued, false);
  assert.equal(result.reason, "target_unavailable");
  assert.equal(queued.length, 0);
});

test("the checkin prompt tells her to signal rather than open the archives in this turn", () => {
  const text = buildSystemInboundText("", "2026-08-10T00:00:00.000Z", "desire_checkin", "failure");
  assert.match(text, /want_consolidation/u);
  assert.match(text, /别在这一轮里翻档案/u);
});
