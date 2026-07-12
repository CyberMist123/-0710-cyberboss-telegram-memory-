const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("all legacy memory gates off keep ordinary start construction zero-touch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-gates-off-"));
  const memoryDir = path.join(root, "memory");
  fs.mkdirSync(path.join(memoryDir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "episodes.jsonl"), "{\"id\":\"fixture\"}\n", "utf8");
  fs.writeFileSync(path.join(memoryDir, "nested", "state.md"), "fixture state\n", "utf8");
  const before = snapshotDirectory(memoryDir);
  const spies = createSpies();

  await withAppWithSpies(spies, async ({ CyberbossApp }) => {
    const app = new CyberbossApp(createConfig(root, memoryDir, {
      legacyMemoryRetrieval: false,
      legacyMemoryBackgroundWrite: false,
      legacyMemoryReplyTransform: false,
      includeLegacyMemoryRelays: false,
    }));
    await app.resolveMemoryContextForPrepared({ text: "fixture asks a normal question" });
    app.recordAssistantReplyForMemory("fixture reply");
  });

  assert.equal(spies.memoryConstructs, 0);
  assert.equal(spies.embeddingConstructs, 0);
  assert.equal(spies.ensureFilesCalls, 0);
  assert.deepEqual(snapshotDirectory(memoryDir), before);
});

test("enabling a legacy memory gate initializes the old memory pipeline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-gates-on-"));
  const memoryDir = path.join(root, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const spies = createSpies();

  await withAppWithSpies(spies, ({ CyberbossApp }) => {
    new CyberbossApp(createConfig(root, memoryDir, {
      legacyMemoryRetrieval: true,
      legacyMemoryBackgroundWrite: false,
      legacyMemoryReplyTransform: false,
      includeLegacyMemoryRelays: false,
    }));
  });

  assert.equal(spies.memoryConstructs, 1);
  assert.equal(spies.embeddingConstructs, 1);
  assert.equal(spies.ensureFilesCalls, 1);
});

test("explicit memory command lazily constructs MemoryService when ordinary gates are off", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-command-lazy-"));
  const memoryDir = path.join(root, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  const spies = createSpies();

  await withAppWithSpies(spies, async ({ CyberbossApp }) => {
    const app = new CyberbossApp(createConfig(root, memoryDir, {
      legacyMemoryRetrieval: false,
      legacyMemoryBackgroundWrite: false,
      legacyMemoryReplyTransform: false,
      includeLegacyMemoryRelays: false,
    }));
    assert.equal(spies.memoryConstructs, 0);

    const output = await app.executeMemoryCommand({
      action: "list",
      args: [],
      options: { json: true },
    });
    const rows = JSON.parse(output);

    assert.equal(rows[0].id, "fixture-memory");
  });

  assert.equal(spies.memoryConstructs, 1);
  assert.equal(spies.ensureFilesCalls, 1);
});

function createSpies() {
  return {
    memoryConstructs: 0,
    embeddingConstructs: 0,
    ensureFilesCalls: 0,
  };
}

function createConfig(root, memoryDir, gates) {
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  return {
    channel: "telegram",
    runtime: "claudecode",
    stateDir,
    workspaceRoot: path.join(root, "workspace"),
    memoryDir,
    memoryVectorFile: path.join(memoryDir, "vectors.jsonl"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    telegramStateFile: path.join(stateDir, "telegram-state.json"),
    conversationDir: "",
    locationV2Enabled: false,
    ...gates,
  };
}

async function withAppWithSpies(spies, fn) {
  const appPath = require.resolve("../src/core/app");
  const mockPaths = new Map([
    [require.resolve("../src/adapters/channel/telegram"), {
      createTelegramChannelAdapter() {
        return {
          describe: () => ({ id: "telegram", kind: "channel" }),
          sendText: async () => {},
        };
      },
    }],
    [require.resolve("../src/adapters/channel/weixin"), {
      createWeixinChannelAdapter() {
        return {
          describe: () => ({ id: "weixin", kind: "channel" }),
          sendText: async () => {},
        };
      },
    }],
    [require.resolve("../src/adapters/runtime/claudecode"), {
      createClaudeCodeRuntimeAdapter() {
        return createRuntimeAdapterStub();
      },
    }],
    [require.resolve("../src/adapters/runtime/codex"), {
      createCodexRuntimeAdapter() {
        return createRuntimeAdapterStub();
      },
    }],
    [require.resolve("../src/integrations/timeline"), {
      createTimelineIntegration() {
        return { describe: () => ({ id: "timeline", kind: "integration" }) };
      },
    }],
    [require.resolve("../src/tools/create-project-tooling"), {
      createProjectTooling() {
        return {
          services: {
            locationStateStore: { recordMemoryInjection() {} },
            locationEventStore: { listRecent: () => [] },
          },
          toolHost: {},
          runtimeContextStore: {},
        };
      },
    }],
    [require.resolve("../src/services/embedding-service"), {
      EmbeddingService: class EmbeddingService {
        constructor() {
          spies.embeddingConstructs += 1;
        }
      },
    }],
    [require.resolve("../src/services/memory-service"), {
      MemoryService: class MemoryService {
        constructor(options) {
          spies.memoryConstructs += 1;
          this.options = options;
        }

        ensureFiles() {
          spies.ensureFilesCalls += 1;
        }

        readIndex() {
          return [{ id: "fixture-memory", category: "facts", text: "fixture", status: "active" }];
        }

        readPending() {
          return [];
        }
      },
    }],
  ]);
  const originals = new Map();
  for (const [modulePath, exportsValue] of mockPaths.entries()) {
    originals.set(modulePath, require.cache[modulePath]);
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: exportsValue,
    };
  }
  delete require.cache[appPath];
  const loaded = require(appPath);
  try {
    return await fn(loaded);
  } finally {
    delete require.cache[appPath];
    for (const [modulePath, original] of originals.entries()) {
      if (original) {
        require.cache[modulePath] = original;
      } else {
        delete require.cache[modulePath];
      }
    }
  }
}

function createRuntimeAdapterStub() {
  const sessionStore = {
    findBindingForThreadId: () => null,
    getActiveWorkspaceRoot: () => "",
  };
  return {
    describe: () => ({ id: "claudecode", kind: "runtime" }),
    getSessionStore: () => sessionStore,
    onEvent: () => () => {},
  };
}

function snapshotDirectory(dirPath) {
  const entries = [];
  walk(dirPath, "", entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function walk(root, relativeDir, entries) {
  const current = path.join(root, relativeDir);
  for (const name of fs.readdirSync(current).sort()) {
    const relativePath = path.join(relativeDir, name);
    const fullPath = path.join(root, relativePath);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walk(root, relativePath, entries);
      continue;
    }
    const content = fs.readFileSync(fullPath);
    entries.push({
      path: relativePath.replace(/\\/g, "/"),
      size: stat.size,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      content: content.toString("utf8"),
    });
  }
}
