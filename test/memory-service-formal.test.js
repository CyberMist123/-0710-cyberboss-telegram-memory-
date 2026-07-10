const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryService } = require("../src/services/memory-service");

test("approvePending writes approved memory into markdown formal source", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-formal-"));
  fs.writeFileSync(path.join(memoryDir, "index.jsonl"), "", "utf8");
  const service = new MemoryService({ memoryDir });
  service.ensureFiles();

  service.appendPending({
    id: "pending_1",
    category: "preferences",
    text: "偏好直接、易理解的表达",
    value: "偏好直接、易理解的表达",
    priority: "hard_preference",
    tier: "stable",
    status: "pending",
  });

  const approved = service.approvePending("pending_1", {
    text: "不喜欢奇怪比喻，偏好直接表达",
  });

  assert.equal(approved.id, "pending_1");
  const markdown = service.readMarkdown("preferences");
  assert.match(markdown, /不喜欢奇怪比喻，偏好直接表达/);
  const active = service.readIndex({ status: "active", categories: ["preferences"], limit: 20 });
  assert.equal(active.length, 1);
  assert.equal(active[0].text, "不喜欢奇怪比喻，偏好直接表达");
  const pending = service.readSevenDayMemory({ status: "", limit: 20 });
  assert.equal(pending.length, 0);
});

test("ensureFiles does not recreate detached jsonl stores", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-detached-"));
  const service = new MemoryService({ memoryDir });
  service.ensureFiles();

  assert.equal(fs.existsSync(path.join(memoryDir, "index.jsonl")), false);
  assert.equal(fs.existsSync(path.join(memoryDir, "vectors.jsonl")), false);
  assert.equal(fs.existsSync(path.join(memoryDir, "ops.jsonl")), false);

  service.appendPending({
    id: "pending_detached_1",
    category: "preferences",
    text: "喜欢直接表达",
    value: "喜欢直接表达",
    status: "pending",
  });
  service.approvePending("pending_detached_1", {
    text: "偏好直接表达",
  });

  assert.match(service.readMarkdown("preferences"), /偏好直接表达/);
  assert.equal(fs.existsSync(path.join(memoryDir, "index.jsonl")), false);
  assert.equal(fs.existsSync(path.join(memoryDir, "vectors.jsonl")), false);
  assert.equal(fs.existsSync(path.join(memoryDir, "ops.jsonl")), false);
});

test("markdown embedding cache follows markdown text updates", async () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-embeddings-"));
  const service = new MemoryService({ memoryDir });
  service.ensureFiles();
  service.appendMarkdownLine("preferences", "喜欢直接一点");

  let calls = 0;
  const embeddingService = {
    async embedText(text) {
      calls += 1;
      return [String(text).length, 1];
    },
  };

  let entries = await service.syncMarkdownEmbeddings({
    categories: ["preferences"],
    embeddingService,
  });
  assert.equal(entries.length, 1);
  assert.equal(calls, 1);

  entries = await service.syncMarkdownEmbeddings({
    categories: ["preferences"],
    embeddingService,
  });
  assert.equal(entries.length, 1);
  assert.equal(calls, 1);

  fs.writeFileSync(path.join(memoryDir, "preferences.md"), "- 偏好直接表达\n", "utf8");
  entries = await service.syncMarkdownEmbeddings({
    categories: ["preferences"],
    embeddingService,
  });
  assert.equal(entries.length, 1);
  assert.equal(calls, 2);

  const cache = service.readMarkdownEmbeddingCache();
  assert.equal(Boolean(cache.categories.preferences["偏好直接表达"]), true);
  assert.equal(Boolean(cache.categories.preferences["喜欢直接一点"]), false);
});

test("readMarkdownLines skips retired and instructional markdown sections", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-markdown-filter-"));
  const service = new MemoryService({ memoryDir });
  service.ensureFiles();

  fs.writeFileSync(path.join(memoryDir, "open_loops.md"), [
    "## 状态",
    "- 该文件已退役，由 pending-promises.md 取代。",
    "",
    "## 迁移规则",
    "- 长期事项写进 projects.md。",
    "",
    "## 真正条目",
    "- 这行也不该再被取到。",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(memoryDir, "projects.md"), [
    "## 持续性项目",
    "- 继续推进记忆检索优化。",
    "",
    "## 记录规则",
    "- 这里只放长期项目。",
    "",
  ].join("\n"), "utf8");

  assert.deepEqual(service.readMarkdownLines("open_loops"), []);
  assert.deepEqual(service.readMarkdownLines("projects"), ["继续推进记忆检索优化。"]);
});
