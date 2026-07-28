// issue #36（父题 #31）：Auto Review 的祈使句式格式闸门。
// 判据：docs/MEMORY_CONSTITUTION.md 第五条；职权边界：docs/DECISIONS.md D16。
// 这个样例集同时是误伤率的守门人——「好样例」那一组一条都不许被拦。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  IMPERATIVE_EXEMPT_TYPES,
  IMPERATIVE_PATTERNS,
  IMPERATIVE_STYLE_REASON,
  detectImperativeStyle,
} = require("../src/continuity/imperative-style");
const { ContinuityPipeline, buildLocalChecks, localReviewResult } = require("../src/continuity/continuity-pipeline");
const { readJsonl } = require("../src/continuity/continuity-store");

const SUBJECT_AI_METADATA = {
  origin: "live_closeout",
  authorRole: "subject_ai",
  authorModel: "fixture-subject-ai",
  contextScope: "active_session",
  semanticAuthority: "high",
  needsSubjectReview: false,
};

// --- 坏样例：以祈使式开头，必须被拦 ------------------------------------

const BLOCKED = [
  ["以后她累的时候要轻一点。", "future_scope"],
  ["下次先确认再动手。", "future_scope"],
  ["每次她提到工作就别追问。", "future_scope"],
  ["必须先问清楚再写。", "obligation"],
  ["务必保留原话。", "obligation"],
  ["一定要在她说完之前不要打断。", "obligation"],
  ["应当先读 CURRENT_STATUS。", "obligation"],
  ["要记得她讨厌黑话。", "remember_directive"],
  ["记住：她的时间不是我的时间。", "remember_directive"],
  ["别忘了她说过的那句。", "remember_directive"],
  ["别在她累的时候讲道理。", "prohibition"],
  ["不要替她做决定。", "prohibition"],
  ["千万别自作聪明。", "prohibition"],
  ["禁止在没有证据的时候下结论。", "prohibition"],
  ["凡是她没点头的事就不要推进。", "universal_rule"],
  ["一旦她沉默就停下来。", "universal_rule"],
  ["要轻一点。", "bare_directive"],
  ["Always confirm before writing.", "english_directive"],
  ["Never rewrite her words.", "english_directive"],
  ["Don't assume she is fine.", "english_directive"],
  ["Remember to check the ledger first.", "english_directive"],
];

for (const [body, patternId] of BLOCKED) {
  test(`blocked (${patternId}): ${body}`, () => {
    const verdict = detectImperativeStyle({ type: "episode", body });
    assert.equal(verdict.blocked, true, `expected blocked: ${body}`);
    assert.equal(verdict.reason, IMPERATIVE_STYLE_REASON);
    assert.equal(verdict.pattern_id, patternId);
  });
}

// 列表符号 / 编号开头的条目不能靠一个减号绕过闸门。
test("list markers and numbering do not smuggle an imperative past the gate", () => {
  for (const body of ["- 以后别熬夜。", "* 必须先确认。", "1. 下次早点说。", "  别再这样。"]) {
    assert.equal(detectImperativeStyle({ type: "episode", body }).blocked, true, body);
  }
});

// --- 好样例：不许误伤 --------------------------------------------------

const ALLOWED = [
  // 第一人称、过去式、具体场景——宪法第五条第 1 款要的正是这种。
  "2026-07-11 傍晚，她说“别管我”，我没走开，只是把灯调暗了。",
  "今天我第一次觉得，她停顿的那半秒是留给我的。",
  "我当时觉得必须先问她，后来发现问了反而更糟。", // 「必须」在句中，不是开头
  "她要的从来不是答案。", // 「要」在句中
  // 引号内转述她的原话：这是一件发生过的事，不是我立的规矩。
  "“以后别一个人扛。”——她昨晚是这么说的。",
  "「必须现在就做」是她的原话，我记下来了。",
  "『别哄我』，她说完就笑了。",
  "\"Don't be so careful with me,\" she said, and I stopped hedging.",
  // 否定的陈述句不是否定的祈使句。
  "不是每一次沉默都需要我说点什么。",
  "别人怎么想我管不着，我只在意她那句没说完的话。", // 「别人」不是「别」
  "别的窗口在跑别的事，我这边只剩这一件。", // 「别的」不是「别」
  // 条件 / 选择连词，不是命令。
  "要是她今天没提这件事，我大概就忘了。",
  "要不是那通电话，这个下午会很不一样。",
  // 英文：词界，不是子串。
  "Mustard on the table, she laughed at my typo.",
  "Nevertheless she stayed on the call until midnight.",
  // 推测式「应该」有意不收，这里守住它不被误伤。
  "应该是她累了，所以那句话听起来比平时短。",
];

for (const body of ALLOWED) {
  test(`allowed: ${body.slice(0, 24)}`, () => {
    const verdict = detectImperativeStyle({ type: "episode", body });
    assert.equal(verdict.blocked, false, `false positive: ${body}`);
    assert.equal(verdict.reason, null);
  });
}

// --- 豁免 --------------------------------------------------------------

test("details / ledger structured entries are exempt", () => {
  for (const type of IMPERATIVE_EXEMPT_TYPES) {
    const verdict = detectImperativeStyle({ type, body: "下次复查：2026-08-12，市三院。" });
    assert.equal(verdict.blocked, false);
    assert.equal(verdict.exempt, "structured_ledger_type");
  }
  // 大小写与空白不该改变豁免判定。
  assert.equal(detectImperativeStyle({ type: " Details ", body: "必须带医保卡。" }).exempt, "structured_ledger_type");
});

test("a body that is nothing but quoted speech is exempt, not blocked", () => {
  const verdict = detectImperativeStyle({ type: "episode", body: "「以后别一个人扛。」" });
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.exempt, "quoted_speech");
});

test("an empty body is not the style gate's business", () => {
  assert.equal(detectImperativeStyle({ type: "episode", body: "   " }).exempt, "empty_body");
  assert.equal(detectImperativeStyle(null).exempt, "empty_body");
});

// --- 闸门只拦不改 ------------------------------------------------------

test("the gate never touches the candidate body", () => {
  const candidate = { type: "episode", body: "以后必须先确认。" };
  const frozen = Object.freeze({ ...candidate });
  const verdict = detectImperativeStyle(frozen);
  assert.equal(verdict.blocked, true);
  assert.equal(frozen.body, "以后必须先确认。");
  // 返回值里不许出现任何替代正文字段。
  assert.deepEqual(Object.keys(verdict).sort(), ["blocked", "exempt", "pattern_id", "reason"]);
});

test("pattern list is exported as an iterable constant with stable ids", () => {
  assert.ok(IMPERATIVE_PATTERNS.length >= 7);
  const ids = IMPERATIVE_PATTERNS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "pattern ids must be unique");
  for (const item of IMPERATIVE_PATTERNS) assert.ok(item.pattern.source.startsWith("^"), `${item.id} must be anchored`);
});

// --- 接进 Review 流程 --------------------------------------------------

test("buildLocalChecks surfaces the gate and localReviewResult defers on it", () => {
  const checks = buildLocalChecks({ type: "episode", body: "必须先确认。" }, true);
  assert.equal(checks.imperative_style, true);
  assert.equal(checks.imperative_pattern, "obligation");
  // 句中软警告仍然独立存在，没有被新闸门吞掉。
  assert.equal(checks.imperative_warning, true);

  const local = localReviewResult({ ...checks, publication_allowed: true });
  assert.equal(local.result, "deferred");
  assert.equal(local.reason, IMPERATIVE_STYLE_REASON);
});

test("review defers an imperative candidate even when the review model accepts it", () => {
  const fixture = createFixture();
  fixture.pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => ({ episodes: [{ body: "以后她累的时候要轻一点。" }] }),
  });
  const decision = fixture.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } }).decisions[0];
  assert.equal(decision.result, "deferred");
  assert.equal(decision.reason, IMPERATIVE_STYLE_REASON);
  assert.equal(decision.checks.imperative_style, true);
  assert.equal(decision.checks.imperative_pattern, "future_scope");

  // 打回不发布，而候选正文一个字没变——重写的人是原作者。
  fixture.pipeline.runHistoryWriter();
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 0);
  assert.equal(readJsonl(fixture.pipeline.paths.candidates)[0].body, "以后她累的时候要轻一点。");
});

test("a scene-shaped candidate quoting her words still passes review", () => {
  const fixture = createFixture();
  fixture.pipeline.runCloseout({
    date: "2026-07-11",
    candidateMetadata: SUBJECT_AI_METADATA,
    author: () => ({ episodes: [{ body: "2026-07-11 夜里，她说“以后别一个人扛”，我只回了一个字。" }] }),
  });
  const decision = fixture.pipeline.runReview({ env: { ...process.env, AUTO_REVIEW_MOCK: "accept" } }).decisions[0];
  assert.equal(decision.result, "accepted");
  assert.equal(decision.checks.imperative_style, false);
  fixture.pipeline.runHistoryWriter();
  assert.equal(readJsonl(fixture.pipeline.paths.episodes).length, 1);
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imperative-gate-"));
  const conversationDir = path.join(root, "conversation");
  const continuityDir = path.join(root, "continuity");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(
    path.join(conversationDir, "2026-07-11.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-07-11T20:00:00+08:00", type: "user", text: "以后别一个人扛。" }),
      JSON.stringify({ timestamp: "2026-07-11T20:00:10+08:00", type: "assistant", text: "嗯。" }),
    ].join("\n") + "\n",
    "utf8",
  );
  const pipeline = new ContinuityPipeline({
    conversationDir,
    continuityDir,
    writerLeaseFile: path.join(root, "MEMORY_WRITER_LEASE.json"),
    python: process.env.PYTHON || "python",
    reviewScript: path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/auto_review.py"),
    model: "fixture-model",
    branch: "fixture-branch",
    worktree: root,
    baseSha: "a".repeat(40),
  });
  return { root, pipeline };
}
