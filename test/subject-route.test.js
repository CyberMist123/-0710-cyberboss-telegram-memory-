"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SessionSlotStore } = require("../src/adapters/runtime/claudecode/session-slot");
const { SessionStore: CodexSessionStore } = require("../src/adapters/runtime/codex/session-store");
const { CyberbossApp } = require("../src/core/app");
const { ConversationRecorder } = require("../src/services/conversation-recorder");
const {
  CANDIDATE_ROUTE_BOUND,
  MATERIAL_ROUTE_AMBIGUOUS,
  MATERIAL_ROUTE_EXACT,
  NO_SUBJECT_CANDIDATE,
  RECORDED_EXACT,
  RECORDED_PARTIAL,
  ROUTE_EXACT,
  ROUTE_PARTIAL,
  classifyRecorderRoute,
  computeRouteFingerprint,
  createSubjectRoute,
  evaluateSubjectRoute,
  normalizeRecorderRouteSnapshot,
  resolveMaterialRoute,
  validateSubjectRoute,
  windowIdFromNativeSessionId,
} = require("../src/continuity/subject-route");

test("recorder freezes the exact canonical route snapshot without later mutation", () => {
  const recorder = new ConversationRecorder();
  const inputRoute = exactRecorderRoute();
  const expected = JSON.stringify(inputRoute);
  const entry = recorder.normalizeEntry({
    id: "entry-exact",
    type: "user",
    timestamp: "2026-07-31T00:00:00.000Z",
    route: inputRoute,
    text: "fixture",
  });

  assert.equal(entry.routeStatus, RECORDED_EXACT);
  assert.equal(JSON.stringify(entry.route), expected);
  assert.equal(Object.isFrozen(entry.route), true);
  inputRoute.windowId = "native-session-mutated";
  inputRoute.profileId = "profile-mutated";
  assert.equal(JSON.stringify(entry.route), expected);
});

test("every missing recorder identity stays absent and makes the entry partial", () => {
  const recorder = new ConversationRecorder();
  for (const field of [
    "bindingKey",
    "laneKey",
    "sessionSlotKey",
    "messageThreadId",
    "profileId",
    "windowId",
  ]) {
    const inputRoute = exactRecorderRoute();
    delete inputRoute[field];
    const entry = recorder.normalizeEntry({
      id: `entry-missing-${field}`,
      type: "user",
      timestamp: "2026-07-31T00:00:00.000Z",
      route: inputRoute,
    });
    assert.equal(entry.routeStatus, RECORDED_PARTIAL, field);
    assert.equal(Object.hasOwn(entry.route, field), false, field);
  }

  const noNativeSession = normalizeRecorderRouteSnapshot({
    ...exactRecorderRoute(),
    windowId: windowIdFromNativeSessionId(""),
  });
  assert.equal(classifyRecorderRoute(noNativeSession), RECORDED_PARTIAL);
  assert.equal(Object.hasOwn(noNativeSession, "windowId"), false);
});

test("D24 window_id follows the native session across resume and changes on reopen", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-window-id-"));
  const storePath = path.join(root, "session-slots.json");
  const slot = "a".repeat(64);
  const store = new SessionSlotStore({ filePath: storePath });

  store.setThreadId(slot, "native-session-a");
  const first = normalizeRecorderRouteSnapshot({
    ...exactRecorderRoute(),
    windowId: windowIdFromNativeSessionId(store.getThreadId(slot)),
  });
  const resumedStore = new SessionSlotStore({ filePath: storePath });
  const resumed = normalizeRecorderRouteSnapshot({
    ...exactRecorderRoute(),
    windowId: windowIdFromNativeSessionId(resumedStore.getThreadId(slot)),
  });
  assert.equal(first.windowId, "native-session-a");
  assert.equal(resumed.windowId, first.windowId);

  resumedStore.clear(slot);
  resumedStore.setThreadId(slot, "native-session-b");
  const reopened = normalizeRecorderRouteSnapshot({
    ...exactRecorderRoute(),
    windowId: windowIdFromNativeSessionId(resumedStore.getThreadId(slot)),
  });
  assert.equal(reopened.windowId, "native-session-b");
  assert.notEqual(reopened.windowId, first.windowId);
});

test("subject_route fingerprint is stable across input key order", () => {
  const left = createSubjectRoute(exactSubjectRouteInput());
  const rightInput = exactSubjectRouteInput();
  rightInput.continuity_binding = {
    binding_key: rightInput.continuity_binding.binding_key,
    sender_id: rightInput.continuity_binding.sender_id,
    account_id: rightInput.continuity_binding.account_id,
    workspace_id: rightInput.continuity_binding.workspace_id,
  };
  rightInput.session = {
    window_id: rightInput.session.window_id,
    profile_fingerprint: rightInput.session.profile_fingerprint,
    profile_id: rightInput.session.profile_id,
    runtime_thread_id: rightInput.session.runtime_thread_id,
    session_slot_key: rightInput.session.session_slot_key,
    runtime_id: rightInput.session.runtime_id,
  };
  const right = createSubjectRoute({
    source_entry_ids: rightInput.source_entry_ids,
    author_turn_id: rightInput.author_turn_id,
    session: rightInput.session,
    route_lane: rightInput.route_lane,
    continuity_binding: rightInput.continuity_binding,
    provider: rightInput.provider,
    version: rightInput.version,
  });

  assert.equal(left.route_fingerprint, right.route_fingerprint);
  assert.equal(validateSubjectRoute(left).status, ROUTE_EXACT);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(Object.isFrozen(left.session), true);
});

test("T06 profile windows change only the session identity, never continuity binding", () => {
  const profileA = createSubjectRoute(exactSubjectRouteInput());
  const profileBInput = exactSubjectRouteInput();
  profileBInput.session = {
    ...profileBInput.session,
    session_slot_key: "slot-profile-b",
    runtime_thread_id: "native-session-b",
    profile_id: "profile-b",
    profile_fingerprint: "profile-fingerprint-b",
    window_id: "native-session-b",
  };
  const profileB = createSubjectRoute(profileBInput);

  assert.equal(
    Buffer.from(JSON.stringify(profileB.continuity_binding)).equals(
      Buffer.from(JSON.stringify(profileA.continuity_binding)),
    ),
    true,
  );
  assert.equal(profileB.continuity_binding.binding_key, profileA.continuity_binding.binding_key);
  assert.equal(profileB.continuity_binding.workspace_id, profileA.continuity_binding.workspace_id);
  assert.notEqual(profileB.session.profile_id, profileA.session.profile_id);
  assert.notEqual(profileB.session.window_id, profileA.session.window_id);
});

test("missing any subject identity is PARTIAL and cannot produce a subject candidate", () => {
  for (const pathParts of [
    ["continuity_binding", "binding_key"],
    ["route_lane", "lane_key"],
    ["session", "session_slot_key"],
    ["session", "window_id"],
  ]) {
    const route = JSON.parse(JSON.stringify(createSubjectRoute(exactSubjectRouteInput())));
    delete route[pathParts[0]][pathParts[1]];
    route.route_fingerprint = computeRouteFingerprint(route);
    const validation = validateSubjectRoute(route);
    const state = evaluateSubjectRoute(route);
    assert.equal(validation.status, ROUTE_PARTIAL, pathParts.join("."));
    assert.equal(state.candidateState, NO_SUBJECT_CANDIDATE, pathParts.join("."));
    assert.equal(state.canCreateSubjectCandidate, false, pathParts.join("."));
  }
});

test("material route is exact only for one route and rejects cross topic/profile mixing", () => {
  const routeA = exactRecorderRoute();
  const exact = resolveMaterialRoute([
    { id: "entry-a1", route: routeA },
    { id: "entry-a2", route: { ...routeA } },
  ]);
  assert.equal(exact.status, MATERIAL_ROUTE_EXACT);
  assert.equal(exact.candidateState, CANDIDATE_ROUTE_BOUND);
  assert.equal(exact.canCreateSubjectCandidate, true);
  assert.deepEqual(exact.sourceEntryIds, ["entry-a1", "entry-a2"]);

  const crossTopic = {
    ...routeA,
    laneKey: "v2|tg|8:telegram|4:-100|2:22",
    messageThreadId: "22",
    sessionSlotKey: "slot-topic-b",
  };
  const topicMix = resolveMaterialRoute([
    { id: "entry-a", route: routeA },
    { id: "entry-b", route: crossTopic },
  ]);
  assert.equal(topicMix.status, MATERIAL_ROUTE_AMBIGUOUS);
  assert.equal(topicMix.candidateState, NO_SUBJECT_CANDIDATE);
  assert.equal(topicMix.canCreateSubjectCandidate, false);
  assert.equal(Object.hasOwn(topicMix, "route"), false);

  const crossProfile = {
    ...routeA,
    sessionSlotKey: "slot-profile-b",
    profileId: "profile-b",
    windowId: "native-session-profile-b",
  };
  const profileMix = resolveMaterialRoute([
    { id: "entry-a", route: routeA },
    { id: "entry-b", route: crossProfile },
  ]);
  assert.equal(profileMix.status, MATERIAL_ROUTE_AMBIGUOUS);
  assert.equal(profileMix.candidateState, NO_SUBJECT_CANDIDATE);
});

test("the real inbound recorder call freezes route/session canonical values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-recorder-route-"));
  const recorder = new ConversationRecorder({ dirPath: root, automationTimezone: "UTC" });
  const app = {
    conversationRecorder: recorder,
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey({ workspaceId, accountId, senderId }) {
            return `${workspaceId}:${accountId}:${senderId}`;
          },
        };
      },
      resolveRouteSession({ lane }) {
        return {
          sessionSlotKey: "canonical-slot-a",
          laneKey: lane.laneKey,
          messageThreadId: lane.messageThreadId,
          threadId: "native-session-a",
          profileId: "profile-a",
        };
      },
    },
    resolveWorkspaceRoot() {
      return "C:\\fixture\\workspace";
    },
    resolveLaunchProfileForLane() {
      return null;
    },
  };

  CyberbossApp.prototype.recordInboundMessage.call(app, {
    workspaceId: "workspace-a",
    accountId: "telegram",
    senderId: "42",
    provider: "telegram",
    chatId: "-100",
    messageThreadId: "7",
    receivedAt: "2026-07-31T00:00:00.000Z",
    messageId: "1000",
    contextToken: "ctx",
    text: "真实 recorder 调用点",
    attachments: [],
  });

  const [entry] = fs.readFileSync(path.join(root, "2026-07-31.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map(JSON.parse);
  assert.equal(entry.routeStatus, RECORDED_EXACT);
  assert.deepEqual(entry.route, {
    bindingKey: "workspace-a:telegram:42",
    laneKey: "v2|tg|8:telegram|4:-100|1:7",
    sessionSlotKey: "canonical-slot-a",
    messageThreadId: "7",
    profileId: "profile-a",
    windowId: "native-session-a",
  });
});

test("codex window_id comes from its session store and remains partial without a canonical slot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-codex-recorder-route-"));
  const recorder = new ConversationRecorder({ dirPath: root, automationTimezone: "UTC" });
  const sessions = new CodexSessionStore({
    filePath: path.join(root, "sessions.json"),
    runtimeId: "codex",
  });
  const bindingKey = sessions.buildBindingKey({
    workspaceId: "workspace-a",
    accountId: "telegram",
    senderId: "42",
  });
  const workspaceRoot = "C:\\fixture\\workspace";
  sessions.setThreadIdForWorkspace(
    bindingKey,
    workspaceRoot,
    "codex-native-session-a",
    {},
    "codex",
  );
  const app = {
    conversationRecorder: recorder,
    runtimeAdapter: {
      getSessionStore() {
        return sessions;
      },
    },
    resolveWorkspaceRoot() {
      return workspaceRoot;
    },
    resolveLaunchProfileForLane() {
      return null;
    },
  };

  CyberbossApp.prototype.recordInboundMessage.call(app, {
    workspaceId: "workspace-a",
    accountId: "telegram",
    senderId: "42",
    provider: "telegram",
    chatId: "-100",
    messageThreadId: "7",
    receivedAt: "2026-07-31T00:00:00.000Z",
    text: "codex recorder",
    attachments: [],
  });

  const [entry] = fs.readFileSync(path.join(root, "2026-07-31.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map(JSON.parse);
  assert.equal(entry.route.windowId, "codex-native-session-a");
  assert.equal(Object.hasOwn(entry.route, "sessionSlotKey"), false);
  assert.equal(entry.routeStatus, RECORDED_PARTIAL);
});

function exactRecorderRoute() {
  return {
    bindingKey: "workspace-a:telegram:42",
    laneKey: "v2|tg|8:telegram|4:-100|1:7",
    sessionSlotKey: "slot-topic-a",
    messageThreadId: "7",
    profileId: "profile-a",
    windowId: "native-session-a",
  };
}

function exactSubjectRouteInput() {
  return {
    version: 1,
    provider: "telegram",
    continuity_binding: {
      workspace_id: "workspace-a",
      account_id: "telegram",
      sender_id: "42",
      binding_key: "workspace-a:telegram:42",
    },
    route_lane: {
      lane_key: "v2|tg|8:telegram|4:-100|1:7",
      chat_id: "-100",
      message_thread_id: "7",
    },
    session: {
      runtime_id: "claudecode",
      session_slot_key: "slot-topic-a",
      runtime_thread_id: "native-session-a",
      profile_id: "profile-a",
      profile_fingerprint: "profile-fingerprint-a",
      window_id: "native-session-a",
    },
    author_turn_id: "turn-subject-a",
    source_entry_ids: ["entry-a1", "entry-a2"],
  };
}
