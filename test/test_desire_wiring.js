const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DesireService } = require("../src/services/desire-service");

function createConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-test-"));
  return {
    desireStateFile: path.join(dir, "desire-state.json"),
    desireThoughtsFile: path.join(dir, "desire-thoughts.json"),
    memoryDir: path.join(dir, "memory"),
    desireDriven: false,
    desireThoughtMax: 80,
  };
}

test("desire service persists state and returns a readable snapshot", () => {
  const service = new DesireService(createConfig());
  const state = service.getState({
    availableActions: ["co_read", "github", "web_search", "web_browse", "tease", "vent", "none"],
  });
  assert.equal(state.driven_behavior_enabled, false);
  assert.equal(typeof state.intent.reason, "string");
  assert.equal(Array.isArray(state.thoughts), true);
  assert.equal(typeof state.drive.attachment, "number");
  assert.equal(typeof state.refractory.attachment, "number");
  assert.equal(typeof state.gates.coupling, "boolean");
  assert.equal(typeof state.heartbeat.intervalMs, "number");
  assert.equal(typeof state.baselines.attachment, "number");
  assert.equal(typeof state.self_drive.curiosityFloor, "number");
  assert.deepEqual(state.thought_origin_stats, { USER: 0, SELF: 0, MEMORY: 0, WORLD: 0 });
});

test("autofeedVoiceThought lands a self monologue flit on the current top drive", () => {
  const service = new DesireService(createConfig());
  service.state.drive.libido = 0.88;
  const state = service.autofeedVoiceThought("想把她拉过来抱一下", {
    availableActions: ["tease", "none"],
  });
  assert.equal(state.thought_count, 1);
  assert.equal(state.thoughts[0].origin, "SELF");
  assert.equal(state.thoughts[0].drive, "libido");
  assert.equal(state.thoughts[0].kind, "flit");
  assert.notEqual(state.thoughts[0].internal_monologue, "想把她拉过来抱一下");
});

test("owner thought autofeed stores a user experience monologue, not the raw sentence", () => {
  const service = new DesireService(createConfig());
  const raw = "哥哥我有点烦，今天压力好大。";
  const state = service.autofeedOwnerThought(raw, {
    availableActions: ["vent", "none"],
  });
  assert.equal(state.thought_count, 1);
  assert.equal(state.thoughts[0].origin, "USER");
  assert.equal(state.thoughts[0].drive, "stress");
  assert.equal(state.thoughts[0].raw_source, raw);
  assert.notEqual(state.thoughts[0].internal_monologue, raw);
  assert.match(state.thoughts[0].internal_monologue, /挂念|压力/u);
});

test("assistant thought autofeed ignores structured action payloads", () => {
  const service = new DesireService(createConfig());
  const state = service.autofeedAssistantThought("{\"action\":\"send_message\",\"message\":\"想去看看外面在聊什么。\"}", {
    availableActions: ["web_browse", "none"],
  });
  assert.equal(state.thought_count, 0);
});

test("memory markdown themes generate MEMORY thoughts that can become fixations", () => {
  const config = createConfig();
  fs.mkdirSync(config.memoryDir, { recursive: true });
  fs.writeFileSync(path.join(config.memoryDir, "patterns.md"), [
    "# Patterns",
    "- 最近工作压力反复出现，客户和项目都很多。",
    "- 她提到工作、压力、开会和任务时容易疲惫。",
  ].join("\n"));
  const service = new DesireService(config);
  let state = service.getState({ availableActions: ["vent", "none"] });
  const memoryThought = state.thoughts.find((thought) => thought.origin === "MEMORY");
  assert.ok(memoryThought);
  assert.equal(memoryThought.drive, "stress");
  assert.match(memoryThought.internal_monologue, /我记得.*反复出现/u);
  assert.ok(state.thought_origin_stats.MEMORY > 0);

  state = service.feedThought({
    internal_monologue: memoryThought.internal_monologue,
    raw_source: memoryThought.raw_source,
    origin: "MEMORY",
    drive: memoryThought.drive,
    kind: "flit",
    strength: 0.8,
  }, { availableActions: ["vent", "none"] });
  const updated = state.thoughts.find((thought) => thought.origin === "MEMORY" && thought.drive === "stress");
  assert.equal(updated.kind, "fixation");
});

test("owner pulse and self pulse update the richer state safely", () => {
  const config = createConfig();
  config.desireBaselineDrift = true;
  config.desireSelfDrive = true;
  const service = new DesireService(config);
  service.state.baselines.attachment = 0.46;
  const ownerState = service.pulseOwnerInteraction({
    driveKey: "attachment",
    amount: 0.18,
    availableActions: ["none"],
  });
  assert.ok(ownerState.drive.attachment > 0);
  assert.ok(ownerState.baselines.attachment < 0.46);

  const selfState = service.pulseSelfExperience({
    driveKey: "curiosity",
    amount: 0.1,
    availableActions: ["web_search"],
    now: "2026-06-11T00:00:00.000Z",
  });
  assert.equal(selfState.self_drive.enabled, true);
  assert.equal(selfState.self_drive.lastSelfPulseDrive, "curiosity");
});

test("desire service writes both state and thoughts files", () => {
  const config = createConfig();
  const service = new DesireService(config);
  service.feedThought({
    text: "想接着翻那本共读的书",
    drive: "reflection",
    kind: "flit",
    strength: 0.6,
  }, {
    availableActions: ["co_read", "none"],
  });

  assert.equal(fs.existsSync(config.desireStateFile), true);
  assert.equal(fs.existsSync(config.desireThoughtsFile), true);

  const state = JSON.parse(fs.readFileSync(config.desireStateFile, "utf8"));
  const thoughts = JSON.parse(fs.readFileSync(config.desireThoughtsFile, "utf8"));
  assert.equal(typeof state.drive.reflection, "number");
  assert.equal(typeof state.refractory.reflection, "number");
  assert.equal(typeof state.gates.selfDrive, "boolean");
  assert.equal(Array.isArray(thoughts.thoughts), true);
  assert.equal(thoughts.thoughts.length, 1);
});
