const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DRIVE_KEYS,
  createDefaultDrive,
  feedThought,
  tickThoughts,
  tickRefractory,
  applyRefractory,
  applyCoupling,
  applyBaselineDrift,
  applyDrivePulse,
  settleAfterAction,
  inferOwnerPulseDrive,
  pickIntent,
  satisfy,
  computeHeartbeatState,
  sourceDriveFor,
} = require("../src/core/desire");

test("desire exports the expected eight drive keys", () => {
  assert.deepEqual(DRIVE_KEYS, [
    "attachment",
    "curiosity",
    "reflection",
    "duty",
    "social",
    "fatigue",
    "libido",
    "stress",
  ]);
});

test("inferOwnerPulseDrive routes common user intents to the matching drive", () => {
  assert.equal(inferOwnerPulseDrive("哥哥我有点烦，今天压力好大"), "stress");
  assert.equal(inferOwnerPulseDrive("想跟你聊聊，顺便做个复盘"), "reflection");
  assert.equal(inferOwnerPulseDrive("记得提醒我跟进客户"), "duty");
  assert.equal(inferOwnerPulseDrive("想跟哥哥亲亲贴贴"), "attachment");
  assert.equal(inferOwnerPulseDrive("想跟哥哥色色"), "libido");
});

test("pickIntent gates to rest when fatigue crosses the threshold", () => {
  const drive = createDefaultDrive();
  drive.fatigue = 0.8;
  const intent = pickIntent({
    drive,
    thoughts: [],
    availableActions: ["none", "web_search"],
  });
  assert.equal(intent.drive_key, "fatigue");
  assert.equal(intent.want_action, "none");
  assert.match(intent.reason, /累了/u);
});

test("pickIntent skips a refractory drive when driven gating is enabled", () => {
  const drive = createDefaultDrive();
  drive.curiosity = 0.95;
  drive.social = 0.8;
  const intent = pickIntent({
    drive,
    thoughts: [],
    availableActions: ["web_search", "web_browse"],
    refractory: { curiosity: 2 },
    gates: { desireDriven: true },
  });
  assert.equal(intent.drive_key, "social");
  assert.equal(intent.want_action, "web_browse");
});

test("curiosity intent switches to github when the strongest thought looks code-related", () => {
  const drive = createDefaultDrive();
  drive.curiosity = 0.9;
  const intent = pickIntent({
    drive,
    thoughts: [{
      text: "想看看 github 上这个 repo 的 readme 和 issue",
      drive: "curiosity",
      kind: "fixation",
      strength: 0.92,
      bornAt: "2026-06-10T00:00:00.000Z",
      fedCount: 0,
    }],
    availableActions: ["github", "web_search"],
  });
  assert.equal(intent.drive_key, "curiosity");
  assert.equal(intent.want_action, "github");
});

test("feedThought strengthens duplicate thoughts and can promote them into fixation", () => {
  let thoughts = feedThought([], {
    text: "想接着翻那本共读的书",
    drive: "reflection",
    kind: "flit",
    strength: 0.6,
  });
  thoughts = feedThought(thoughts, {
    text: "想接着翻那本共读的书",
    drive: "reflection",
    kind: "flit",
    strength: 0.6,
  });
  assert.equal(thoughts.length, 1);
  assert.equal(thoughts[0].drive, "reflection");
  assert.equal(thoughts[0].kind, "fixation");
  assert.ok(thoughts[0].strength >= 0.8);
});

test("tickThoughts feeds fixation back into its drive and resolves after enough feeds", () => {
  const drive = createDefaultDrive();
  const thoughts = [{
    text: "这件事一直在脑子里绕",
    drive: "stress",
    kind: "fixation",
    strength: 0.9,
    bornAt: "2026-06-10T00:00:00.000Z",
    fedCount: 2,
  }];
  const next = tickThoughts(thoughts, drive, 1);
  assert.ok(next.drive.stress > drive.stress);
  assert.equal(next.thoughts.length, 0);
});

test("refractory ticks down and can be applied from an action source drive", () => {
  const refractory = applyRefractory({}, "libido", 3);
  assert.equal(refractory.libido, 3);
  const next = tickRefractory(refractory, 2);
  assert.equal(next.libido, 1);
});

test("coupling level and delta modes nudge linked drives when enabled", () => {
  const previousDrive = {
    ...createDefaultDrive(),
    stress: 0.2,
    attachment: 0.3,
    curiosity: 0.3,
    libido: 0.2,
  };
  const drive = {
    ...previousDrive,
    stress: 0.8,
    attachment: 0.8,
  };
  const next = applyCoupling({
    drive,
    previousDrive,
    baselines: { attachment: 0.34, curiosity: 0.16 },
    gates: { coupling: true },
    edges: [
      { source: "stress", target: "curiosity", mode: "level", coefficient: -0.05 },
      { source: "attachment", target: "libido", mode: "delta", coefficient: 0.05 },
    ],
  });
  assert.ok(next.curiosity < drive.curiosity);
  assert.ok(next.libido > drive.libido);
});

test("baseline drift slowly raises attachment floor and stays capped", () => {
  const next = applyBaselineDrift({
    drive: createDefaultDrive(),
    baselines: { attachment: 0.49, curiosity: 0.16 },
    selfDrive: { enabled: false, curiosityFloor: 0.16 },
    gates: { baselineDrift: true },
    elapsedHours: 10,
  });
  assert.ok(next.baselines.attachment >= 0.49);
  assert.ok(next.baselines.attachment <= 0.5);
  assert.ok(next.drive.attachment >= next.baselines.attachment);
});

test("self drive raises curiosity floor when enabled", () => {
  const next = applyBaselineDrift({
    drive: createDefaultDrive(),
    baselines: { attachment: 0.34, curiosity: 0.16 },
    selfDrive: { enabled: true, curiosityFloor: 0.2 },
    gates: { selfDrive: true },
    elapsedHours: 8,
  });
  assert.ok(next.selfDrive.curiosityFloor > 0.2);
  assert.ok(next.drive.curiosity >= next.selfDrive.curiosityFloor);
});

test("owner interaction pulse is not weakened when self drive is enabled", () => {
  const baseDrive = {
    ...createDefaultDrive(),
    attachment: 0.35,
    curiosity: 0.8,
  };
  const withoutSelfDrive = applyDrivePulse({
    drive: baseDrive,
    baselines: { attachment: 0.45, curiosity: 0.16 },
    selfDrive: { enabled: false, curiosityFloor: 0.16 },
    gates: { baselineDrift: true, selfDrive: false },
    driveKey: "attachment",
    amount: 0.18,
    source: "owner",
  });
  const withSelfDrive = applyDrivePulse({
    drive: baseDrive,
    baselines: { attachment: 0.45, curiosity: 0.3 },
    selfDrive: { enabled: true, curiosityFloor: 0.3 },
    gates: { baselineDrift: true, selfDrive: true },
    driveKey: "attachment",
    amount: 0.18,
    source: "owner",
  });
  assert.ok(withSelfDrive.drive.attachment >= withoutSelfDrive.drive.attachment);
});

test("settleAfterAction pulls attachment baseline back toward home", () => {
  const next = settleAfterAction({
    drive: createDefaultDrive(),
    baselines: { attachment: 0.48, curiosity: 0.16 },
    selfDrive: { enabled: false, curiosityFloor: 0.16 },
    gates: { baselineDrift: true },
    action: "none",
  });
  assert.ok(next.baselines.attachment < 0.48);
  assert.ok(next.baselines.attachment >= 0.34);
});

test("satisfy applies the configured action falloff", () => {
  const drive = {
    ...createDefaultDrive(),
    libido: 0.9,
    attachment: 0.8,
  };
  const next = satisfy(drive, "tease");
  assert.ok(Math.abs(next.libido - 0.495) < 1e-9);
  assert.ok(Math.abs(next.attachment - 0.624) < 1e-9);
});

test("sourceDriveFor reverse maps outward actions back to their source drive", () => {
  assert.equal(sourceDriveFor("co_read"), "reflection");
  assert.equal(sourceDriveFor("web_browse"), "social");
  assert.equal(sourceDriveFor("github"), "curiosity");
  assert.equal(sourceDriveFor("web_search"), "curiosity");
  assert.equal(sourceDriveFor("tease"), "libido");
  assert.equal(sourceDriveFor("vent"), "stress");
});

test("computeHeartbeatState returns a bounded interval", () => {
  const heartbeat = computeHeartbeatState({
    drive: {
      ...createDefaultDrive(),
      attachment: 0.95,
      curiosity: 0.88,
      fatigue: 0.2,
    },
    gates: { heartbeatAutonomy: true },
  });
  assert.equal(heartbeat.enabled, true);
  assert.ok(heartbeat.tension > 0);
  assert.ok(heartbeat.intervalMs >= 15 * 60_000);
  assert.ok(heartbeat.intervalMs <= 180 * 60_000);
});

test("coupling remains bounded over many ticks", () => {
  let previousDrive = createDefaultDrive();
  let drive = {
    ...createDefaultDrive(),
    attachment: 0.91,
    curiosity: 0.74,
    reflection: 0.67,
    duty: 0.52,
    social: 0.58,
    fatigue: 0.29,
    libido: 0.61,
    stress: 0.77,
  };
  const edges = [
    { source: "stress", target: "attachment", mode: "level", coefficient: 0.04 },
    { source: "stress", target: "curiosity", mode: "level", coefficient: -0.05 },
    { source: "attachment", target: "libido", mode: "delta", coefficient: 0.05 },
    { source: "curiosity", target: "reflection", mode: "delta", coefficient: 0.04 },
    { source: "reflection", target: "social", mode: "delta", coefficient: 0.03 },
  ];
  for (let index = 0; index < 200; index += 1) {
    const drifted = { ...drive };
    drifted.stress = Math.max(0, Math.min(1, drive.stress + (index % 2 === 0 ? 0.03 : -0.02)));
    drifted.attachment = Math.max(0, Math.min(1, drive.attachment + (index % 3 === 0 ? 0.02 : -0.01)));
    const next = applyCoupling({
      drive: drifted,
      previousDrive,
      baselines: { attachment: 0.34, curiosity: 0.16 },
      gates: { coupling: true },
      edges,
    });
    for (const key of DRIVE_KEYS) {
      assert.ok(next[key] >= 0, `${key} dropped below 0 on tick ${index}`);
      assert.ok(next[key] <= 1, `${key} exceeded 1 on tick ${index}`);
    }
    previousDrive = drive;
    drive = next;
  }
});
