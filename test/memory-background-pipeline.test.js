const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runMemoryPostResponsePipeline,
  SEGMENT_SILENCE_MS,
} = require("../src/core/memory-background-pipeline");

test("background memory pipeline stores segment summary instead of raw quote candidates", async () => {
  const pending = [];
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = "1";
  const base = Date.parse("2026-06-05T09:00:00.000Z");
  const bgState = {};
  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: {
      async embedText() {
        throw new Error("should not embed auto candidates before approval");
      },
    },
    normalized: {
      text: "记住：我吃太辣会胃疼，而且今天眼睛疼，先别催我做大块任务。",
      receivedAt: new Date(base).toISOString(),
    },
    bgState,
  });
  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "好，我记住了，后面我会按这个节奏来。",
      role: "assistant",
      receivedAt: new Date(base + 10_000).toISOString(),
    },
    bgState,
  });
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = previous;

  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "active");
  assert.match(pending[0].summary, /吃太辣会胃疼|眼睛疼|别催我做大块任务/);
  assert.equal(pending[0].quoted, "");
  assert.equal(pending[0].source, "wechat_segment_summary");
  assert.notEqual(
    pending[0].summary,
    "我吃太辣会胃疼；今天眼睛疼；先别催我做大块任务"
  );
});

test("background memory pipeline flushes previous segment after 20 minutes silence", async () => {
  const pending = [];
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = "1";
  const base = Date.parse("2026-06-05T09:00:00.000Z");
  const bgState = {};

  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "我今天眼睛疼，先一点点推进工作。",
      receivedAt: new Date(base).toISOString(),
    },
    bgState,
  });
  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "刚到公司了。",
      receivedAt: new Date(base + SEGMENT_SILENCE_MS + 60 * 1000).toISOString(),
    },
    bgState,
  });
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = previous;

  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /眼睛疼|一点点推进工作/);
  assert.equal(bgState.segmentBuffer.length, 1);
});

test("background memory pipeline schedules automatic flush after silence", async () => {
  const pending = [];
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = "1";
  let scheduled = null;
  const bgState = {
    scheduleFlush(fn, delay) {
      scheduled = { fn, delay };
      return () => {
        scheduled = null;
      };
    },
  };

  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "我今天眼睛疼，先一点点推进工作。",
      receivedAt: "2026-06-05T09:00:00.000Z",
    },
    bgState,
  });
  assert.equal(scheduled.delay, SEGMENT_SILENCE_MS);
  scheduled.fn();
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = previous;

  assert.equal(pending.length, 1);
  assert.equal(bgState.segmentBuffer.length, 0);
});

test("background memory pipeline skips ordinary chat without significant event", async () => {
  const pending = [];
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = "1";
  let scheduled = null;
  const bgState = {
    scheduleFlush(fn, delay) {
      scheduled = { fn, delay };
      return () => {
        scheduled = null;
      };
    },
  };

  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "刚到公司了，路上有点热。",
      receivedAt: "2026-06-05T09:00:00.000Z",
    },
    bgState,
  });
  scheduled.fn();
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = previous;

  assert.equal(pending.length, 0);
  assert.equal(bgState.segmentBuffer.length, 0);
});

test("background memory pipeline skips ordinary work progress chatter", async () => {
  const pending = [];
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = "1";
  let scheduled = null;
  const bgState = {
    scheduleFlush(fn, delay) {
      scheduled = { fn, delay };
      return () => {
        scheduled = null;
      };
    },
  };

  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "今天先跟进客户，再做页面，晚点整理资料。",
      receivedAt: "2026-06-05T09:00:00.000Z",
    },
    bgState,
  });
  scheduled.fn();
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = previous;

  assert.equal(pending.length, 0);
});

test("background memory pipeline keeps work events with a real blocker or state change", async () => {
  const pending = [];
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = "1";
  let scheduled = null;
  const bgState = {
    scheduleFlush(fn, delay) {
      scheduled = { fn, delay };
      return () => {
        scheduled = null;
      };
    },
  };

  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "跨屏互联连不上，今天工作先只推进一小块，别一下子压大任务。",
      receivedAt: "2026-06-05T09:00:00.000Z",
    },
    bgState,
  });
  scheduled.fn();
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = previous;

  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /连不上|项目进展有波动|小块推进/);
});

test("background memory pipeline rewrites direct quotes into summary-style relationship memory", async () => {
  const pending = [];
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = "1";
  const bgState = {};

  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "记住，叫我小坏蛋或者坏宝宝诶。",
      receivedAt: "2026-06-05T09:00:00.000Z",
    },
    bgState,
  });
  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "好，我之后会这么叫你。",
      role: "assistant",
      receivedAt: "2026-06-05T09:00:10.000Z",
    },
    bgState,
  });
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = previous;

  assert.equal(pending.length, 1);
  assert.equal(pending[0].category, "relationships");
  assert.match(pending[0].summary, /偏好称呼为/);
  assert.notEqual(pending[0].summary, "叫我小坏蛋或者坏宝宝诶");
});

test("background memory pipeline summarizes the full exchange after assistant reply", async () => {
  const pending = [];
  const previous = process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE;
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = "1";
  const bgState = {};

  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "记住，待会十点半提醒我找mentor请假，下午不来上班了。",
      role: "user",
      receivedAt: "2026-06-05T09:00:00.000Z",
    },
    bgState,
  });
  assert.equal(pending.length, 0);

  await runMemoryPostResponsePipeline({
    memoryService: {
      appendPending(entry) {
        pending.push(entry);
        return entry;
      },
    },
    embeddingService: null,
    normalized: {
      text: "好，我会在十点半提醒你找 mentor 请假。",
      role: "assistant",
      receivedAt: "2026-06-05T09:00:10.000Z",
    },
    bgState,
  });
  process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE = previous;

  assert.equal(pending.length, 1);
  assert.match(pending[0].summary, /^这段对话里/);
  assert.match(pending[0].summary, /十点半|mentor请假|我回应会跟进/);
});
