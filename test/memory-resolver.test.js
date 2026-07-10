const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryService } = require("../src/services/memory-service");
const { resolveMemoryRetrievalPlan } = require("../src/core/memory-resolver");
const { CyberbossApp } = require("../src/core/app");

test("memory retrieval plan uses classified slots when present", () => {
  const plan = resolveMemoryRetrievalPlan("我喜欢直接一点，别用奇怪比喻");
  assert.deepEqual(plan.slots, ["preference"]);
  assert.deepEqual(plan.retrievalSlots, ["preference"]);
});

test("memory retrieval plan treats reminder-style messages as state-only when no stable slot matches", () => {
  const plan = resolveMemoryRetrievalPlan("记得中午提醒我关掉免打扰");
  assert.deepEqual(plan.slots, []);
  assert.deepEqual(plan.retrievalSlots, []);
  assert.equal(plan.mode, "state_only");
});

test("memory retrieval plan skips broad memory retrieval for lightweight status prompts", () => {
  const plan = resolveMemoryRetrievalPlan("你在干嘛");
  assert.deepEqual(plan.slots, []);
  assert.deepEqual(plan.retrievalSlots, []);
  assert.equal(plan.mode, "state_only");
});

test("memory retrieval plan treats percentage progress updates as state-only", () => {
  const plan = resolveMemoryRetrievalPlan("做到35%了哥哥");
  assert.deepEqual(plan.slots, []);
  assert.deepEqual(plan.retrievalSlots, []);
  assert.equal(plan.mode, "state_only");
});

test("memory retrieval plan treats ratio-style work progress updates as state-only", () => {
  const plan = resolveMemoryRetrievalPlan("跟进客户做到9/6了");
  assert.deepEqual(plan.slots, []);
  assert.deepEqual(plan.retrievalSlots, []);
  assert.equal(plan.mode, "state_only");
});

test("memory retrieval plan treats fuzzy work progress updates as state-only", () => {
  const plan = resolveMemoryRetrievalPlan("群发广告先推进一小块");
  assert.deepEqual(plan.slots, []);
  assert.deepEqual(plan.retrievalSlots, []);
  assert.equal(plan.mode, "state_only");
});

test("pre-response memory resolves markdown lines from fallback slots", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-service-"));
  const service = new MemoryService({ memoryDir });
  service.ensureFiles();
  service.appendMarkdownLine("preferences", "喜欢直接一点");

  const resolved = service.resolvePreResponseMemory({
    slots: ["identity", "relationship", "preference", "project", "pattern", "open_loop"],
  });
  assert.equal(resolved.categories.includes("preferences"), true);
  assert.deepEqual(resolved.markdownLines.preferences, ["喜欢直接一点"]);
});

test("pre-response memory returns markdown lines without index or vectors", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-tier-"));
  const service = new MemoryService({ memoryDir });
  service.ensureFiles();
  service.appendMarkdownLine("projects", "正在做一个页面");

  const resolved = service.resolvePreResponseMemory({ slots: ["project"] });
  assert.deepEqual(resolved.markdownLines.projects, ["正在做一个页面"]);
  assert.equal("index" in resolved, false);
  assert.equal("vectors" in resolved, false);
});

test("app memory context retrieval returns matched lines", async () => {
  const result = await CyberbossApp.prototype.resolveMemoryContextForPrepared.call({
    embeddingService: {
      async embedText() {
        return [0, 1];
      },
      cosineSimilarity() {
        return 0;
      },
    },
    memoryService: {
      readSevenDayMemory() {
        return [];
      },
      readPendingPromises() {
        return [];
      },
      resolvePreResponseMemory({ slots }) {
        assert.deepEqual(slots, ["preference"]);
        return {
          markdownLines: {
            preferences: ["喜欢直接一点"],
          },
        };
      },
    },
  }, {
    originalText: "我喜欢你说话直接一点",
  });

  assert.deepEqual(result.lines, ["preferences: 喜欢直接一点"]);
});

test("app memory context retrieval includes curated markdown memory lines", async () => {
  const result = await CyberbossApp.prototype.resolveMemoryContextForPrepared.call({
    embeddingService: {
      async embedText() {
        return [0, 1];
      },
      cosineSimilarity() {
        return 0;
      },
    },
    memoryService: {
      readSevenDayMemory() {
        return [];
      },
      readPendingPromises() {
        return [];
      },
      resolvePreResponseMemory({ slots }) {
        assert.ok(slots.includes("preference"));
        return {
          markdownLines: {
            preferences: [
              "私密话题优先放 Telegram；微信主要聊日常、工作、提醒和正经事",
              "日常说话时多用完整、具体、贴近情境的表达",
            ],
          },
        };
      },
    },
  }, {
    originalText: "这段私密话题我们换到 telegram 说",
  });

  assert.equal(result.lines[0], "preferences: 私密话题优先放 Telegram；微信主要聊日常、工作、提醒和正经事");
  assert.equal(result.lines.length, 1);
});

test("app memory context retrieval falls back to semantic markdown match when wording changes", async () => {
  const result = await CyberbossApp.prototype.resolveMemoryContextForPrepared.call({
    embeddingService: {
      async embedText(text) {
        if (String(text).includes("边界我想")) return [1, 0];
        if (String(text).includes("私密话题优先放 Telegram")) return [0.92, 0.08];
        return [0, 1];
      },
      cosineSimilarity(left, right) {
        return (left[0] || 0) * (right[0] || 0) + (left[1] || 0) * (right[1] || 0);
      },
    },
    memoryService: {
      readSevenDayMemory() {
        return [];
      },
      readPendingPromises() {
        return [];
      },
      resolvePreResponseMemory() {
        return {
          markdownLines: {
            preferences: [
              "私密话题优先放 Telegram；微信主要聊日常、工作、提醒和正经事",
              "喜欢直接一点",
            ],
          },
        };
      },
      async syncMarkdownEmbeddings({ categories, markdownLines }) {
        assert.deepEqual(categories, ["preferences"]);
        assert.equal(markdownLines.preferences.length, 2);
        return [
          {
            category: "preferences",
            text: "私密话题优先放 Telegram；微信主要聊日常、工作、提醒和正经事",
            vector: [0.92, 0.08],
          },
          {
            category: "preferences",
            text: "喜欢直接一点",
            vector: [0, 1],
          },
        ];
      },
    },
  }, {
    originalText: "这个边界我想放到更私密的渠道聊",
  });

  assert.deepEqual(result.lines, ["preferences: 私密话题优先放 Telegram；微信主要聊日常、工作、提醒和正经事"]);
});

test("app memory context retrieval skips memory injection for state-only messages", async () => {
  const result = await CyberbossApp.prototype.resolveMemoryContextForPrepared.call({
    embeddingService: {
      async embedText() {
        return [0, 1];
      },
      cosineSimilarity() {
        return 0;
      },
    },
    memoryService: {
      readSevenDayMemory() {
        return [{
          summary: "今天出门前忘了拿伞，后来回楼上拿了",
          category: "event",
        }];
      },
      readPendingPromises() {
        return [];
      },
    },
  }, {
    originalText: "现在出门了",
  });

  assert.deepEqual(result.lines, []);
  assert.equal(result.mode, "state_only");
});

test("app memory context retrieval limits targeted memory to one line", async () => {
  const result = await CyberbossApp.prototype.resolveMemoryContextForPrepared.call({
    embeddingService: {
      async embedText() {
        return [0, 1];
      },
      cosineSimilarity() {
        return 0;
      },
    },
    memoryService: {
      readSevenDayMemory() {
        return [{
          summary: "最近提过说话想要更直接一点",
          category: "preferences",
          key: "no",
        }];
      },
      readPendingPromises() {
        return [];
      },
      resolvePreResponseMemory() {
        return {
          markdownLines: {
            preferences: [
              "喜欢直接一点",
              "日常说话时多用完整、具体、贴近情境的表达",
            ],
          },
        };
      },
    },
  }, {
    originalText: "我喜欢你说话直接一点",
  });

  assert.deepEqual(result.lines, ["preferences: 喜欢直接一点"]);
  assert.equal(result.lines.length, 1);
  assert.equal(result.mode, "targeted");
});
