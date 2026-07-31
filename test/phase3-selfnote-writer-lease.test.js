// issue #74：`ai_self_notes.md` 的双 writer 双锁域竞态。
//
// 两个 writer 是真实存在的：
//   - History writer：`src/continuity/continuity-pipeline.js` 的 `publishSelfNote()`；
//   - 主体 AI 的 `memory_note` 工具：`src/services/memory-note-service.js`，
//     生产接线在 `src/tools/create-project-tooling.js` → `src/tools/tool-host.js`。
//
// 修复有两条腿，本文件对两条腿分别取证：
//   1. 锁域收敛 —— 两边用同一个 lease 文件（互斥可观测）；
//   2. 只追加 —— 即使窗口被强行造出来，两条写入也都活着。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");

const { acquireWriterLease, releaseWriterLease } = require("../src/orchestration/writer-lease");
const {
  RETIRED_MEMORY_NOTE_LEASE_BASENAME,
  resolveMemoryWriterLeaseFile,
} = require("../src/orchestration/memory-writer-lease");
const { ContinuityPipeline, createCandidate, createDecision } = require("../src/continuity/continuity-pipeline");
const { appendJsonlUnique, replaceTextAtomic } = require("../src/continuity/continuity-store");
const { MemoryNoteService } = require("../src/services/memory-note-service");

const SUBJECT_AI_METADATA = {
  origin: "live_closeout",
  authorRole: "subject_ai",
  authorModel: "fixture-subject-ai",
  contextScope: "active_session",
  semanticAuthority: "high",
  needsSubjectReview: false,
};

const LEASE_DETAILS = {
  model: "fixture-model",
  phase: "phase3",
  branch: "fixture-branch",
  base_sha: "a".repeat(40),
};

// ---------------------------------------------------------------------------
// 目标 1：锁域收敛
// ---------------------------------------------------------------------------

test("self-note writers resolve one and the same writer lease file", () => {
  const fixture = createFixture();

  // 默认路径：两边都算到 `<continuityDir>/.jobs/MEMORY_WRITER_LEASE.json`。
  assert.equal(fixture.service.leaseFile, fixture.pipeline.writerLeaseFile);
  assert.equal(
    fixture.service.leaseFile,
    path.resolve(path.join(fixture.continuityDir, ".jobs", "MEMORY_WRITER_LEASE.json")),
  );

  // 显式配置（生产机的 `CYBERBOSS_WRITER_LEASE_FILE`）也必须同时对两边生效。
  const configured = path.join(fixture.root, "cyberlink-root", "MEMORY_WRITER_LEASE.json");
  const configuredService = new MemoryNoteService({
    continuityDir: fixture.continuityDir,
    writerLeaseFile: configured,
  });
  const configuredPipeline = createPipeline(fixture.continuityDir, fixture.root, configured);
  assert.equal(configuredService.leaseFile, configuredPipeline.writerLeaseFile);
  assert.equal(configuredService.leaseFile, path.resolve(configured));

  // 退役的专属锁不许再被创建。
  assert.equal(fixture.service.note({ text: "第一条自述。" }).ok, true);
  assert.equal(
    fs.existsSync(path.join(fixture.continuityDir, ".jobs", RETIRED_MEMORY_NOTE_LEASE_BASENAME)),
    false,
  );
  assert.equal(fs.existsSync(fixture.service.leaseFile), false, "写完必须放锁");
  assert.equal(resolveMemoryWriterLeaseFile({}), "");
});

test("one lock domain is observable in both directions and stays fail-open", () => {
  const fixture = createFixture();

  // History writer 持锁 → memory_note 拿不到锁：只返回 error，不写任何文件。
  const held = acquireWriterLease(fixture.pipeline.writerLeaseFile, {
    writer: "history-writer",
    worktree: fixture.root,
    ...LEASE_DETAILS,
  });
  const blocked = fixture.service.note({ text: "锁被别人拿着的时候不许写。" });
  assert.deepEqual(blocked, { error: "note_unavailable" });
  assert.equal(fs.existsSync(fixture.paths.notes), false);
  assert.equal(fs.existsSync(fixture.paths.budget), false);
  assert.equal(fs.existsSync(fixture.paths.audit), false);
  releaseWriterLease(fixture.pipeline.writerLeaseFile, held.lease_id);

  // 放锁之后同一次调用能成功 —— 证明上面拦下来的确实是锁，不是别的错误。
  const allowed = fixture.service.note({ text: "锁放开之后就能写。" });
  assert.equal(allowed.ok, true);
  assert.match(fs.readFileSync(fixture.paths.notes, "utf8"), /锁放开之后就能写。/u);

  // 反向：memory_note 持锁 → History writer 跳过（既有 fail-open 降级不变）。
  seedSelfNoteDecision(fixture, "被 memory_note 挡住的一条 Self-note。", 0);
  const noteLease = acquireWriterLease(fixture.pipeline.writerLeaseFile, {
    writer: "memory-note",
    worktree: fixture.root,
    ...LEASE_DETAILS,
  });
  const before = fs.readFileSync(fixture.paths.notes, "utf8");
  const skipped = fixture.pipeline.runHistoryWriter();
  assert.deepEqual(skipped, { status: "skipped", reason: "lease_unavailable" });
  assert.equal(fs.readFileSync(fixture.paths.notes, "utf8"), before);
  releaseWriterLease(fixture.pipeline.writerLeaseFile, noteLease.lease_id);

  const published = fixture.pipeline.runHistoryWriter();
  assert.equal(published.written.length, 1);
  assert.match(fs.readFileSync(fixture.paths.notes, "utf8"), /被 memory_note 挡住的一条 Self-note。/u);
});

// ---------------------------------------------------------------------------
// 目标 2 + 3：窗口被强行造出来时，两条写入都活着
// ---------------------------------------------------------------------------

test("a foreign append landing inside the write window survives (and would not have before)", () => {
  const fixture = createFixture();
  fs.mkdirSync(fixture.continuityDir, { recursive: true });
  fs.writeFileSync(fixture.paths.notes, "既有的第一行。\n", "utf8");

  const foreign = "<!-- decision:foreign -->\nHistory writer 在同一瞬间落下的这一行。";
  const rawAppend = fs.appendFileSync;

  // 先证明这个窗口是**真的**：把同样的注入放进旧实现（整读 → 整写回，
  // 与 memory-note-service.js@3730027:14 逐字对应），对方的行会被整段盖掉。
  const legacyFile = path.join(fixture.root, "legacy-self-notes.md");
  fs.writeFileSync(legacyFile, "既有的第一行。\n", "utf8");
  legacyReadModifyReplace(legacyFile, "旧实现写下的一行。", () => {
    rawAppend.call(fs, legacyFile, `\n${foreign}\n`, "utf8");
  });
  const legacyText = fs.readFileSync(legacyFile, "utf8");
  assert.equal(legacyText.includes(foreign), false, "旧实现下这条并发写入必须是丢的（窗口成立）");
  assert.match(legacyText, /旧实现写下的一行。/u);

  // 现在同一个窗口打在新实现上：注入正好发生在 memory_note 决定好正文、
  // 即将落盘的那一刻（append 之前），也就是旧实现丢数据的同一个位置。
  let injected = false;
  fs.appendFileSync = function patchedAppendFileSync(file, data, options) {
    if (!injected && path.resolve(String(file)) === path.resolve(fixture.paths.notes)) {
      injected = true;
      rawAppend.call(fs, fixture.paths.notes, `\n${foreign}\n`, "utf8");
    }
    return rawAppend.call(fs, file, data, options);
  };
  let result;
  try {
    result = fixture.service.note({ text: "memory_note 写下的一行。" });
  } finally {
    fs.appendFileSync = rawAppend;
  }

  assert.equal(injected, true, "注入没打进写入窗口，这个测试就什么都没测");
  assert.equal(result.ok, true);
  const text = fs.readFileSync(fixture.paths.notes, "utf8");
  assert.match(text, /既有的第一行。/u);
  assert.ok(text.includes(foreign), "并发落下的 History writer 行必须存活");
  assert.match(text, /memory_note 写下的一行。/u);
  // 顺序也要对：后写的在后面，没有人被前移或覆盖。
  assert.ok(text.indexOf(foreign) < text.indexOf("memory_note 写下的一行。"));
});

test("both writers survive a real two-process race on the shared lease", async () => {
  const fixture = createFixture();
  const notes = 10;
  const publications = 6;
  const readyFile = path.join(fixture.root, "child-ready");
  const contendFile = path.join(fixture.root, "child-contended");
  const reportFile = path.join(fixture.root, "child-report.json");
  const childScript = path.join(fixture.root, "race-child.js");
  fs.writeFileSync(childScript, CHILD_SOURCE, "utf8");
  const published = [];
  for (let index = 0; index < publications; index += 1) {
    const body = `History writer 的第 ${index} 条 Self-note。`;
    seedSelfNoteDecision(fixture, body, index);
    published.push(body);
  }

  // 1) 父进程先占住共享锁，再拉起子进程 —— 子进程的第一次写入必然撞锁，
  //    竞态窗口是**构造出来的**，不是碰运气碰出来的。
  const held = acquireWriterLease(fixture.pipeline.writerLeaseFile, {
    writer: "history-writer",
    worktree: fixture.root,
    ...LEASE_DETAILS,
  });
  const child = fork(childScript, [
    require.resolve("../src/services/memory-note-service"),
    fixture.continuityDir,
    fixture.pipeline.writerLeaseFile,
    readyFile,
    contendFile,
    reportFile,
    String(notes),
  ], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const childExit = once(child, "exit");

  waitForFile(readyFile, 30_000, "子进程没有启动");
  waitForFile(contendFile, 30_000, "子进程没有撞上锁（窗口没造出来）");
  releaseWriterLease(fixture.pipeline.writerLeaseFile, held.lease_id);

  // 2) 父子两侧同时写：父进程一条一条发布 Self-note，子进程一条一条追加笔记，
  //    两边抢的是同一把锁，每一轮都会发生一次锁交接。
  let parentSkips = 0;
  for (let index = 0; index < publications; index += 1) {
    let done = false;
    for (let attempt = 0; attempt < 20_000 && !done; attempt += 1) {
      const result = fixture.pipeline.runHistoryWriter();
      if (result.status === "skipped") { parentSkips += 1; sleepSync(1); continue; }
      done = true;
    }
    assert.equal(done, true, "History writer 一直没拿到锁");
  }

  const [code] = await childExit;
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(code, 0, `子进程异常退出：${JSON.stringify(report)}`);
  assert.equal(report.ok, true);
  assert.equal(report.lines.length, notes);
  assert.ok(report.contended >= 1, "子进程没有真的撞上锁");

  // 3) 两条路径的写入必须一条不少，且既没被覆盖也没被写重。
  const text = fs.readFileSync(fixture.paths.notes, "utf8");
  for (const body of published) assert.ok(text.includes(body), `丢了 History writer 的写入：${body}`);
  for (const line of report.lines) assert.ok(text.includes(line), `丢了 memory_note 的写入：${line}`);
  const nonEmptyLines = text.split(/\r?\n/).filter((line) => line.trim()).length;
  // 每条发布 = publication marker + decision marker + 正文；每条笔记 = 一行。
  assert.equal(nonEmptyLines, publications * 3 + notes);

  // 锁与账都要干净：锁已释放、专属锁从未出现、预算与审计各记 notes 条。
  assert.equal(fs.existsSync(fixture.pipeline.writerLeaseFile), false);
  assert.equal(
    fs.existsSync(path.join(fixture.continuityDir, ".jobs", RETIRED_MEMORY_NOTE_LEASE_BASENAME)),
    false,
  );
  const budget = JSON.parse(fs.readFileSync(fixture.paths.budget, "utf8"));
  const counted = Object.values(budget.days).reduce((sum, day) => sum + Number(day.count || 0), 0);
  assert.equal(counted, notes);
  assert.equal(fs.readFileSync(fixture.paths.audit, "utf8").split("\n").filter(Boolean).length, notes);
  console.log(`[issue74] 真并发：子进程撞锁 ${report.contended} 次，父进程撞锁 ${parentSkips} 次，平台 ${process.platform}`);
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const CHILD_SOURCE = `const fs = require("node:fs");
const [, , servicePath, continuityDir, leaseFile, readyFile, contendFile, reportFile, totalRaw] = process.argv;
const { MemoryNoteService } = require(servicePath);
const total = Number(totalRaw);
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
let contended = 0;
const lines = [];
fs.writeFileSync(readyFile, "ready", "utf8");
for (let index = 0; index < total; index += 1) {
  // 每 5 条换一天，避开 DAILY_LIMIT=10 的每日预算。
  const day = String(10 + Math.floor(index / 5)).padStart(2, "0");
  const iso = "2026-07-" + day + "T0" + (index % 5) + ":00:00.000Z";
  const service = new MemoryNoteService({ continuityDir, writerLeaseFile: leaseFile, now: () => new Date(iso) });
  const text = "memory_note 的第 " + index + " 条笔记。";
  let result = null;
  for (let attempt = 0; attempt < 20000; attempt += 1) {
    result = service.note({ text });
    if (result.ok || result.error !== "note_unavailable") break;
    contended += 1;
    if (contended === 1) fs.writeFileSync(contendFile, "1", "utf8");
    sleepSync(1);
  }
  if (!result || !result.ok) {
    fs.writeFileSync(reportFile, JSON.stringify({ ok: false, index, result, contended }), "utf8");
    process.exit(2);
  }
  lines.push(text);
}
fs.writeFileSync(reportFile, JSON.stringify({ ok: true, contended, lines }), "utf8");
`;

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-issue74-"));
  const continuityDir = path.join(root, "continuity");
  const pipeline = createPipeline(continuityDir, root);
  return {
    root,
    continuityDir,
    pipeline,
    service: new MemoryNoteService({ continuityDir }),
    paths: {
      notes: path.join(continuityDir, "ai_self_notes.md"),
      budget: path.join(continuityDir, ".jobs", "memory-note-budget.json"),
      audit: path.join(continuityDir, ".jobs", "memory-note-audit.jsonl"),
    },
  };
}

function createPipeline(continuityDir, root, writerLeaseFile) {
  return new ContinuityPipeline({
    continuityDir,
    conversationDir: path.join(root, "conversations"),
    // 与生产同一个解析口径：不显式配置时就是 `<continuityDir>/.jobs/MEMORY_WRITER_LEASE.json`。
    writerLeaseFile: writerLeaseFile || resolveMemoryWriterLeaseFile({ continuityDir }),
    reviewScript: path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/auto_review.py"),
    worktree: root,
    model: "fixture-model",
    branch: "fixture-branch",
    baseSha: "a".repeat(40),
    reviewArtifactsEnabled: true,
  });
}

/** 直接落一条 accepted 的 self_note 决策，绕开 Review 的 python 依赖。 */
function seedSelfNoteDecision(fixture, body, index) {
  const candidate = createCandidate({
    date: "2026-07-11",
    type: "self_note",
    author: "subject_ai",
    body,
    sourceRef: { file: path.join(fixture.root, "conversations", "2026-07-11.jsonl"), window: `${index + 1}-${index + 2}` },
    ...SUBJECT_AI_METADATA,
  });
  appendJsonlUnique(fixture.pipeline.paths.candidates, [candidate], "candidate_id");
  const decision = createDecision(candidate, { result: "accepted", reason: "accepted" });
  appendJsonlUnique(fixture.pipeline.paths.decisions, [decision], "decision_id");
  assert.equal(fixture.pipeline.repairReviewArtifacts().publication_intent_complete, true);
  return { candidate, decision };
}

/** memory-note-service.js@3730027:14 的写入语义，只在测试里保留，用来证明窗口成立。 */
function legacyReadModifyReplace(filePath, line, injectForeignWrite) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  injectForeignWrite();
  replaceTextAtomic(filePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    sleepSync(5);
  }
  throw new Error(`${message}: ${filePath}`);
}
