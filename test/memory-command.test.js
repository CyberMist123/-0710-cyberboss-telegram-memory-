const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

test("memory add command stores a manual memory and replies with confirmation", async () => {
  const sent = [];
  const stored = [];
  await CyberbossApp.prototype.handleMemoryCommand.call({
    memoryService: {
      findDuplicate() {
        return null;
      },
      saveFormalMemory(entry) {
        stored.push(entry);
        return entry;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    executeMemoryCommand: CyberbossApp.prototype.executeMemoryCommand,
  }, {
    senderId: "user-1",
    contextToken: "ctx-1",
    text: "/memory add preferences 喜欢直接一点",
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].category, "preferences");
  assert.equal(stored[0].text, "喜欢直接一点");
  assert.match(sent[0].text, /Memory saved/);
});

test("memory list command renders active memories", async () => {
  const result = await CyberbossApp.prototype.executeMemoryCommand.call({
    memoryService: {
      readIndex() {
        return [{
          id: "mem_1",
          category: "preferences",
          text: "喜欢直接一点",
          status: "active",
        }];
      },
    },
  }, {
    action: "list",
    args: [],
  });

  assert.match(result, /Memories \(active\)/);
  assert.match(result, /喜欢直接一点/);
});

test("memory approve command promotes pending candidate into formal memory with rewrite", async () => {
  const result = await CyberbossApp.prototype.executeMemoryCommand.call({
    memoryService: {
      approvePending(id, options) {
        assert.equal(id, "pending_1");
        assert.equal(options.text, "不喜欢奇怪比喻，偏好直接表达");
        return {
          id: "pending_1",
          category: "preferences",
          text: "偏好直接、易理解的表达",
          value: "偏好直接、易理解的表达",
          status: "pending",
        };
      },
    },
  }, {
    action: "approve",
    args: ["pending_1", "不喜欢奇怪比喻，偏好直接表达"],
  });

  assert.match(result, /approved into formal memory/);
  assert.match(result, /不喜欢奇怪比喻，偏好直接表达/);
});

test("memory review command renders pending suggestions", async () => {
  const result = await CyberbossApp.prototype.executeMemoryCommand.call({
    memoryService: {
      readPending() {
        return [{
          id: "pending_1",
          category: "preferences",
          text: "我喜欢你说话直接一点",
        }];
      },
    },
  }, {
    action: "review",
    args: [],
    options: { limit: "10" },
  });

  assert.match(result, /Pending review/);
  assert.match(result, /suggest: 偏好直接、易理解的表达/);
});

test("memory pending command supports json output", async () => {
  const result = await CyberbossApp.prototype.executeMemoryCommand.call({
    executeMemoryCommand: CyberbossApp.prototype.executeMemoryCommand,
    memoryService: {
      readPending() {
        return [{
          id: "pending_1",
          category: "facts",
          text: "吃太辣会胃疼",
        }];
      },
    },
  }, {
    action: "pending",
    args: [],
    options: { json: true },
  });

  const parsed = JSON.parse(result);
  assert.equal(parsed[0].id, "pending_1");
  assert.equal(parsed[0].category, "facts");
});

test("memory suggest command returns rewrite suggestion for pending item", async () => {
  const result = await CyberbossApp.prototype.executeMemoryCommand.call({
    memoryService: {
      readPending() {
        return [{
          id: "pending_1",
          category: "preferences",
          text: "我喜欢你说话直接一点",
        }];
      },
    },
  }, {
    action: "suggest",
    args: ["pending_1"],
    options: {},
  });

  assert.match(result, /Pending suggestion: pending_1/);
  assert.match(result, /suggested: 偏好直接、易理解的表达/);
});

test("memory apply-suggestion command approves pending item with suggestion", async () => {
  const result = await CyberbossApp.prototype.executeMemoryCommand.call({
    memoryService: {
      readPending() {
        return [{
          id: "pending_1",
          category: "preferences",
          text: "我喜欢你说话直接一点",
        }];
      },
      approvePending(id, options) {
        assert.equal(id, "pending_1");
        assert.equal(options.text, "偏好直接、易理解的表达");
        return {
          id: "pending_1",
          category: "preferences",
          text: "我喜欢你说话直接一点",
          value: "我喜欢你说话直接一点",
        };
      },
    },
  }, {
    action: "apply-suggestion",
    args: ["pending_1"],
    options: {},
  });

  assert.match(result, /approved with suggestion/);
  assert.match(result, /偏好直接、易理解的表达/);
});
