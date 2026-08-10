const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  materializeEpisode,
  regenerateIndex,
  ensureEmptyEpisodeIndex,
  EMPTY_INDEX_TEXT,
  parseFrontmatter,
} = require("../src/continuity/episode-materializer");
const { ContinuityPipeline } = require("../src/continuity/continuity-pipeline");
const { readJsonl } = require("../src/continuity/continuity-store");

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "episode-md-"));
  const episodesDir = path.join(root, "episodes");
  const jobsDir = path.join(root, ".jobs");
  return { root, episodesDir, jobsDir };
}

function makeRecord(overrides = {}) {
  return {
    ep_id: "ep-0123456789abcdef",
    ts: "2026-08-09T14:00:00.000Z",
    type: "episode",
    body: "窗台上的常量\n\n测试场景里，我们把一次约定记成了常量。这条是虚构夹具。",
    source_ref: { file: "x", source_entry_ids: ["a"] },
    candidate_id: "cand-1",
    decision_id: "dec-1",
    publication_intent_id: "intent-1",
    publication_key: "pub-key-1",
    supersedes: null,
    origin: "live_subject",
    author_role: "subject_ai",
    author_model: "fixture",
    context_scope: "active_session",
    semantic_authority: "high",
    ...overrides,
  };
}

test("materializeEpisode 写出 ep001 文件：frontmatter、正文逐字保留、附注区、index 链接", () => {
  const { episodesDir, jobsDir } = makeDirs();
  const result = materializeEpisode({ episodesDir, jobsDir, record: makeRecord() });
  assert.equal(result.status, "written");
  assert.equal(result.seq, "ep001");
  const text = fs.readFileSync(path.join(episodesDir, result.file), "utf8");
  assert.match(text, /seq: ep001/);
  assert.match(text, /title: "窗台上的常量"/);
  assert.match(text, /status: active/);
  assert.match(text, /publication_key: "pub-key-1"/);
  // 正文按 D16 逐字保留（含标题行本身）
  assert.ok(text.includes("测试场景里，我们把一次约定记成了常量。这条是虚构夹具。"));
  assert.match(text, /## 附注/);
  const index = fs.readFileSync(path.join(episodesDir, "index.md"), "utf8");
  assert.match(index, /## 2026-08/);
  assert.ok(index.includes(`](${encodeURI(result.file)})`));
  assert.ok(index.includes("ep001 · 窗台上的常量"));
});

test("同一 publication_key 第二次物化被跳过，不产生重复文件", () => {
  const { episodesDir, jobsDir } = makeDirs();
  materializeEpisode({ episodesDir, jobsDir, record: makeRecord() });
  const second = materializeEpisode({ episodesDir, jobsDir, record: makeRecord() });
  assert.equal(second.status, "skipped");
  const files = fs.readdirSync(episodesDir).filter((name) => name.startsWith("ep"));
  assert.equal(files.length, 1);
});

test("空 canon 只在缺失时种下 index，已有 canon 或 index 都不改", () => {
  const { episodesDir } = makeDirs();
  assert.equal(ensureEmptyEpisodeIndex({ episodesDir, canonRecords: [] }).status, "written");
  assert.equal(fs.readFileSync(path.join(episodesDir, "index.md"), "utf8"), `${EMPTY_INDEX_TEXT}\n`);
  fs.writeFileSync(path.join(episodesDir, "index.md"), "手写目录\n", "utf8");
  assert.equal(ensureEmptyEpisodeIndex({ episodesDir, canonRecords: [] }).reason, "index_exists");
  assert.equal(fs.readFileSync(path.join(episodesDir, "index.md"), "utf8"), "手写目录\n");
  assert.equal(ensureEmptyEpisodeIndex({ episodesDir, canonRecords: [{}] }).reason, "canon_not_empty");
});

test("序号递增；文件名 slug 去掉危险字符；超长标题截断", () => {
  const { episodesDir, jobsDir } = makeDirs();
  materializeEpisode({ episodesDir, jobsDir, record: makeRecord() });
  const second = materializeEpisode({
    episodesDir,
    jobsDir,
    record: makeRecord({
      publication_key: "pub-key-2",
      body: `她问：为什么/怎么办?我说"先吃饭"……${"很长".repeat(40)}`,
    }),
  });
  assert.equal(second.seq, "ep002");
  assert.doesNotMatch(second.file, /[/:*?"<>|？：]/u);
  assert.ok(second.file.length < 80);
});

test("index：superseded 划线沉底、pinned 加标记；附注区手写内容在重生成后保留", () => {
  const { episodesDir, jobsDir } = makeDirs();
  const first = materializeEpisode({ episodesDir, jobsDir, record: makeRecord() });
  const second = materializeEpisode({
    episodesDir,
    jobsDir,
    record: makeRecord({ publication_key: "pub-key-2", body: "第二条\n正文。" }),
  });
  // 模拟二期的状态流转：直接改 frontmatter（写侧工具二期做，这里只验目录读侧）
  const firstPath = path.join(episodesDir, first.file);
  fs.writeFileSync(firstPath, fs.readFileSync(firstPath, "utf8")
    .replace("status: active", "status: superseded")
    .replace("## 附注\n", "## 附注\n\n回看补一句：当时没意识到这条的分量。\n"), "utf8");
  const secondPath = path.join(episodesDir, second.file);
  fs.writeFileSync(secondPath, fs.readFileSync(secondPath, "utf8")
    .replace("status: active", "status: pinned"), "utf8");
  regenerateIndex({ episodesDir });
  const index = fs.readFileSync(path.join(episodesDir, "index.md"), "utf8");
  assert.match(index, /已沉降/);
  assert.ok(index.includes("~~ep001 · 窗台上的常量~~"));
  assert.ok(index.includes("📌 [ep002"));
  // 单条文件不被 index 重生成动到：附注仍在
  assert.ok(fs.readFileSync(firstPath, "utf8").includes("回看补一句"));
});

test("物化失败不抛出：episodesDir 不可建时报 error 并记 .jobs 错误账", () => {
  const { root, jobsDir } = makeDirs();
  const blocker = path.join(root, "not-a-dir");
  fs.writeFileSync(blocker, "occupied", "utf8");
  const result = materializeEpisode({
    episodesDir: path.join(blocker, "episodes"),
    jobsDir,
    record: makeRecord(),
  });
  assert.equal(result.status, "error");
  const log = fs.readFileSync(path.join(jobsDir, "episode-materializer-errors.jsonl"), "utf8");
  assert.match(log, /pub-key-1/);
});

test("publishEpisode 集成：canon jsonl 与 md 视图一次发布同时长出", () => {
  const { root } = makeDirs();
  const pipeline = new ContinuityPipeline({
    continuityDir: root,
    conversationDir: path.join(root, "conversations"),
    writerLeaseFile: path.join(root, "writer-lease.json"),
    reviewScript: path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/auto_review.py"),
    janitorScript: path.resolve(__dirname, "../extensions/relationship-memory/memory-kit/janitor.py"),
    transcriptDir: path.join(root, "transcripts"),
    worktree: "fixture-worktree",
  });
  const candidate = {
    candidate_id: "cand-int-1",
    ts: "2026-08-09T15:00:00.000Z",
    type: "episode",
    body: "集成测试的一条\n正文原样。",
    source_ref: { file: "x", source_entry_ids: ["a"] },
    origin: "live_subject",
    author_role: "subject_ai",
    author_model: "fixture",
    context_scope: "active_session",
    semantic_authority: "high",
  };
  pipeline.publishEpisode(candidate, { decision_id: "dec-int-1" }, {
    publication_intent_id: "intent-int-1",
    publication_key: "pub-int-1",
  });
  const canon = readJsonl(pipeline.paths.episodes);
  assert.equal(canon.length, 1);
  assert.equal(canon[0].publication_key, "pub-int-1");
  const episodeFiles = fs.readdirSync(path.join(root, "episodes")).filter((name) => name.startsWith("ep0"));
  assert.equal(episodeFiles.length, 1);
  const frontmatter = parseFrontmatter(path.join(root, "episodes", episodeFiles[0]));
  assert.equal(frontmatter.publication_key, "pub-int-1");
  assert.ok(fs.existsSync(path.join(root, "episodes", "index.md")));
});

const { EpisodeAnnotateService } = require("../src/services/episode-annotate-service");

test("episode_annotate：按 seq 或 ep_id 追加带时间戳附注，正文不动；错误路径返回机器可读原因", () => {
  const { root, episodesDir, jobsDir } = makeDirs();
  materializeEpisode({ episodesDir, jobsDir, record: makeRecord() });
  const service = new EpisodeAnnotateService({
    continuityDir: root,
    now: () => new Date("2026-08-09T16:00:00.000Z"),
  });
  const ok = service.append({ episode: "ep001", text: "回看补一句：这条其实是转折点。" });
  assert.equal(ok.seq, "ep001");
  const text = fs.readFileSync(path.join(episodesDir, ok.file), "utf8");
  assert.ok(text.includes("- 2026-08-09 16:00 — 回看补一句：这条其实是转折点。"));
  assert.ok(text.includes("测试场景里，我们把一次约定记成了常量。这条是虚构夹具。"));
  const byId = service.append({ episode: "ep-0123456789abcdef", text: "再补一句。" });
  assert.equal(byId.seq, "ep001");
  assert.equal(service.append({ episode: "ep999", text: "x" }).error, "episode_not_found");
  assert.equal(service.append({ episode: "ep001", text: "" }).error, "empty_text");
  assert.equal(service.append({ episode: "ep001", text: "长".repeat(501) }).error, "text_too_long");
});
