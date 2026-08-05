"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const { ClaudeCodeIpcServer } = require("../src/adapters/runtime/claudecode/ipc-server");
const { readConfig } = require("../src/core/config");
const { SubjectCapabilityRegistry, SubjectCandidateService } = require("../src/continuity/subject-signing");
const {
  SubjectSigningBroker,
  SubjectSigningIpcClient,
} = require("../src/continuity/subject-signing-ipc");
const { createSubjectRoute, canonicalSerialize } = require("../src/continuity/subject-route");
const { sha256 } = require("../src/continuity/continuity-store");
const { createProjectTooling } = require("../src/tools/create-project-tooling");
const { RuntimeContextStore } = require("../src/tools/runtime-context-store");

const ROOT = path.resolve(__dirname, "..");
const ENTRY_ID = "entry-fable";
const TURN_ID = "turn-fable";
const THREAD_ID = "native-fable";
const ROUTE_TOKEN = "slot-fable";
const BODY = "这一刻由我自己留下。";

test("6a tool-mcp-server topology has a broker client, the null stub, and no writable candidate owner", () => {
  const fixture = new SigningFixture();
  try {
    withEnv(fixture.env, () => {
      const tooling = createProjectTooling(readConfig());
      assert.equal(Object.hasOwn(tooling.services, "subjectCandidate"), false);
      assert.equal(typeof tooling.services.subjectSigningBroker?.submit, "function");
      assert.equal(tooling.services.subjectSigningContext.resolve(), null);
    });
    const indexSource = fs.readFileSync(path.join(ROOT, "src", "index.js"), "utf8");
    assert.match(indexSource, /createProjectTooling\(config, \{ toolset, authorizationCeiling, chatSelfEscalation, route2Lease \}\)/u);
    assert.doesNotMatch(indexSource, /subjectCandidateOwner\s*:\s*true/u);
  } finally {
    fixture.remove();
  }
});

test("6b/6e real tool-mcp-server reaches the main-owned broker and persists one secret-free attestation", async () => {
  const fixture = new SigningFixture();
  try {
    await fixture.startServer();
    const child = await fixture.spawnToolServer();
    const response = await child.call("tools/call", {
      name: "memory_candidate_submit",
      arguments: candidateArgs(),
    });
    assert.equal(response.result?.isError, undefined, child.stderr);
    assert.match(toolText(response), /Memory candidate created/u);

    const rows = fixture.readCandidates();
    assert.equal(rows.length, 1);
    const candidate = rows[0];
    assert.equal(candidate.author_attestation.version, 2);
    assert.equal(candidate.author_attestation.subject_turn_id, TURN_ID);
    assert.equal(candidate.author_attestation.route_fingerprint, fixture.route.route_fingerprint);
    assert.equal(candidate.author_attestation.source_entry_ids_sha256, sha256(canonicalSerialize([ENTRY_ID])));
    assert.equal(candidate.subject_route.route_fingerprint, fixture.route.route_fingerprint);
    assert.equal(Object.hasOwn(candidate.author_attestation, "capability_id"), false);
    assert.equal(JSON.stringify(fixture.signingMessages).includes(fixture.capability.capability_id), false);
    assert.equal(JSON.stringify(response).includes(fixture.capability.capability_id), false);
    assert.equal(child.spawnText().includes(fixture.capability.capability_id), false);
    assert.equal(readAllFiles(fixture.root).includes(fixture.capability.capability_id), false);
    await child.close();
  } finally {
    await fixture.close();
  }
});

test("6d/6e work-engineering schema read and direct call are both denied before broker dispatch", async () => {
  const fixture = new SigningFixture();
  try {
    await fixture.startServer();
    const child = await fixture.spawnToolServer({ authorizationCeiling: "work-memory-readonly@1" });
    const schema = await child.call("tools/call", {
      name: "cyberboss_catalog",
      arguments: { handle: "memory/memory_candidate_submit" },
    });
    const direct = await child.call("tools/call", {
      name: "memory_candidate_submit",
      arguments: candidateArgs(),
    });
    assert.equal(schema.result?.isError, true);
    assert.match(toolText(schema), /^g3_schema_not_authorized:/u);
    assert.equal(direct.result?.isError, true);
    assert.match(toolText(direct), /^g3_call_not_authorized:/u);
    assert.equal(fixture.signingMessages.length, 0);
    const workRoute = createSubjectRoute({
      ...JSON.parse(JSON.stringify(fixture.route)),
      session: {
        ...fixture.route.session,
        profile_id: "work-engineering",
        profile_fingerprint: "work-profile-fingerprint",
      },
    });
    const workCapability = fixture.registry.issue({ subjectTurnId: TURN_ID, subjectRoute: workRoute });
    fixture.byRunKey.set(`${THREAD_ID}:${TURN_ID}`, {
      capability: workCapability,
      subject_route: workRoute,
    });
    const forgedClaimsClient = new SubjectSigningIpcClient({ stateDir: fixture.stateDir });
    await assert.rejects(
      () => forgedClaimsClient.submit(candidateArgs(), {
        ...fixture.coordinates,
        profileId: "fable-chat",
        authorized: "true",
      }),
      { code: "subject_signing_identity_mismatch" },
    );
    assert.equal(fixture.readCandidates().length, 0);
    await child.close();
  } finally {
    await fixture.close();
  }
});

for (const terminalState of ["completed", "failed"]) {
  test(`6c/6e ${terminalState} turn rejects a later child submission without ending the tool server`, async () => {
    const fixture = new SigningFixture();
    try {
      await fixture.startServer();
      fixture.endTurn();
      const child = await fixture.spawnToolServer();
      const rejected = await child.call("tools/call", {
        name: "memory_candidate_submit",
        arguments: candidateArgs(),
      });
      assert.equal(rejected.result?.isError, true);
      assert.match(toolText(rejected), /^subject_signing_turn_inactive:/u);
      const ping = await child.call("ping", {});
      assert.deepEqual(ping.result, {});
      assert.equal(fixture.readCandidates().length, 0);
      await child.close();
    } finally {
      await fixture.close();
    }
  });
}

test("6c missing broker, bad auth, timeout, and replay fail closed with explicit codes", async () => {
  const missing = new SigningFixture();
  try {
    const child = await missing.spawnToolServer();
    const response = await child.call("tools/call", { name: "memory_candidate_submit", arguments: candidateArgs() });
    assert.equal(response.result?.isError, true);
    assert.match(toolText(response), /^subject_signing_ipc_unavailable:/u);
    assert.equal(missing.readCandidates().length, 0);
    await child.close();
  } finally {
    await missing.close();
  }

  const badAuth = new SigningFixture();
  try {
    await badAuth.startServer();
    fs.writeFileSync(badAuth.server.tokenFile, "wrong-test-auth-token", "utf8");
    const child = await badAuth.spawnToolServer();
    const response = await child.call("tools/call", { name: "memory_candidate_submit", arguments: candidateArgs() });
    assert.equal(response.result?.isError, true);
    assert.match(toolText(response), /^subject_signing_ipc_auth_failed:/u);
    assert.equal(badAuth.readCandidates().length, 0);
    await child.close();
  } finally {
    await badAuth.close();
  }

  const timeout = new SigningFixture({ suppressReplies: true });
  try {
    await timeout.startServer();
    const child = await timeout.spawnToolServer();
    const response = await child.call("tools/call", { name: "memory_candidate_submit", arguments: candidateArgs() }, 8_000);
    assert.equal(response.result?.isError, true);
    assert.match(toolText(response), /^subject_signing_ipc_timeout:/u);
    const ping = await child.call("ping", {});
    assert.deepEqual(ping.result, {});
    assert.equal(timeout.readCandidates().length, 0);
    await child.close();
  } finally {
    await timeout.close();
  }

  const replay = new SigningFixture();
  try {
    await replay.startServer();
    const client = new SubjectSigningIpcClient({
      stateDir: replay.stateDir,
      timeoutMs: 1000,
      requestIdFactory: () => "replayed-request-id",
    });
    const first = await client.submit(candidateArgs(), replay.coordinates);
    assert.equal(first.status, "created");
    await assert.rejects(
      () => client.submit(candidateArgs(), replay.coordinates),
      { code: "subject_signing_ipc_replay" },
    );
    assert.equal(replay.readCandidates().length, 1);
  } finally {
    await replay.close();
  }
});

test("6e concurrent real child calls with one idempotency key append exactly once", async () => {
  const fixture = new SigningFixture();
  try {
    await fixture.startServer();
    const child = await fixture.spawnToolServer();
    const responses = await Promise.all([
      child.call("tools/call", { name: "memory_candidate_submit", arguments: candidateArgs() }),
      child.call("tools/call", { name: "memory_candidate_submit", arguments: candidateArgs() }),
    ]);
    assert.equal(responses.filter((response) => response.result?.isError !== true).length, 1);
    assert.equal(responses.filter((response) => /^capability_expired:/u.test(toolText(response))).length, 1);
    const rows = fixture.readCandidates();
    assert.equal(rows.length, 1);
    assert.equal(new Set(rows.map((row) => row.idempotency_key)).size, 1);
    await child.close();
  } finally {
    await fixture.close();
  }
});

class SigningFixture {
  constructor({ suppressReplies = false } = {}) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "subject-signing-ipc-"));
    this.stateDir = path.join(this.root, "state");
    this.continuityDir = path.join(this.root, "continuity");
    this.workspaceRoot = path.join(this.root, "workspace");
    this.configDir = path.join(this.root, "config");
    this.memoryDir = path.join(this.root, "memory");
    for (const dir of [this.stateDir, this.continuityDir, this.workspaceRoot, this.configDir, this.memoryDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.promptFile = path.join(this.root, "prompt.md");
    fs.writeFileSync(this.promptFile, "test prompt", "utf8");
    this.env = {
      ...process.env,
      CYBERBOSS_CHANNEL: "telegram",
      CYBERBOSS_RUNTIME: "claudecode",
      CYBERBOSS_TELEGRAM_BOT_TOKEN: "fake-test-token",
      CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS: "42",
      CYBERBOSS_STATE_DIR: this.stateDir,
      CYBERBOSS_CONTINUITY_DIR: this.continuityDir,
      CYBERBOSS_MEMORY_DIR: this.memoryDir,
      CYBERBOSS_WORKSPACE: this.workspaceRoot,
      CYBERBOSS_CONFIG_DIR: this.configDir,
      CYBERBOSS_PROMPT_FILE: this.promptFile,
      CYBERBOSS_SUBJECT_SIGNING_ENABLED: "true",
      CYBERBOSS_TOOL_CATALOG_ENABLED: "true",
      CYBERBOSS_TOOL_CATALOG_TOOLSET: "",
    };
    this.runtimeContextStore = new RuntimeContextStore({
      filePath: path.join(this.stateDir, "project-tool-runtime-context.json"),
    });
    this.coordinates = this.runtimeContextStore.setActiveContext({
      workspaceRoot: this.workspaceRoot,
      runtimeId: "claudecode",
      threadId: THREAD_ID,
      bindingKey: "binding-fable",
      accountId: "telegram",
      senderId: "42",
      provider: "telegram",
      chatId: "-100",
      messageThreadId: "7",
      routeToken: ROUTE_TOKEN,
      laneKey: "lane:-100:7",
      processKey: "process-fable",
      turnId: TURN_ID,
    });
    this.route = createSubjectRoute({
      provider: "telegram",
      continuity_binding: {
        workspace_id: "workspace-fable",
        account_id: "telegram",
        sender_id: "42",
        binding_key: "binding-fable",
      },
      route_lane: {
        lane_key: "lane:-100:7",
        chat_id: "-100",
        message_thread_id: "7",
      },
      session: {
        runtime_id: "claudecode",
        session_slot_key: ROUTE_TOKEN,
        runtime_thread_id: THREAD_ID,
        profile_id: "fable-chat",
        profile_fingerprint: "fable-profile-fingerprint",
        window_id: THREAD_ID,
      },
      author_turn_id: TURN_ID,
      source_entry_ids: [ENTRY_ID],
    });
    this.registry = new SubjectCapabilityRegistry({ enabled: true });
    this.capability = this.registry.issue({ subjectTurnId: TURN_ID, subjectRoute: this.route });
    // Shaped exactly like what `issueSubjectCapabilityForTurnFailOpen` stores:
    // the recorded inbound line, its file, and its digest. The file is real and
    // the digest is over its actual bytes, so Review's `locateSourceEntriesById`
    // would resolve this candidate rather than defer it.
    const conversationDir = path.join(this.stateDir, "conversations");
    fs.mkdirSync(conversationDir, { recursive: true });
    const conversationFile = path.join(conversationDir, "2026-08-06.jsonl");
    const sourceLine = JSON.stringify({ id: ENTRY_ID, type: "user", text: "source fixture" });
    fs.writeFileSync(conversationFile, `${sourceLine}\n`, "utf8");
    this.byRunKey = new Map([[`${THREAD_ID}:${TURN_ID}`, {
      capability: this.capability,
      subject_route: this.route,
      source_ref: {
        file: conversationFile,
        source_entry_ids: [ENTRY_ID],
        source_entry_hashes: [{ entry_id: ENTRY_ID, sha256: sha256(sourceLine) }],
        content_sha256: sha256(sourceLine),
      },
    }]]);
    this.service = new SubjectCandidateService({
      continuityDir: this.continuityDir,
      registry: this.registry,
      enabled: true,
    });
    this.broker = new SubjectSigningBroker({
      enabled: true,
      subjectCandidateService: this.service,
      subjectCapabilityByRunKey: this.byRunKey,
      runtimeContextStore: this.runtimeContextStore,
    });
    this.server = new ClaudeCodeIpcServer({ stateDir: this.stateDir });
    this.suppressReplies = suppressReplies;
    this.signingMessages = [];
    this.children = new Set();
  }

  async startServer() {
    this.server.on("clientMessage", (message, socket) => {
      if (message?.type !== "subject-signing.submit") return;
      this.signingMessages.push(JSON.parse(JSON.stringify(message)));
      if (this.suppressReplies) return;
      try {
        const result = this.broker.submit({
          requestId: message.requestId,
          args: message.args,
          coordinates: message.coordinates,
        });
        this.server.reply(socket, {
          type: "subject-signing.submit.result",
          requestId: message.requestId,
          result,
        });
      } catch (error) {
        this.server.reply(socket, {
          type: "subject-signing.submit.result",
          requestId: message.requestId,
          error: error.code || "subject_signing_ipc_failed",
        });
      }
    });
    await this.server.start();
  }

  async spawnToolServer({ authorizationCeiling = "" } = {}) {
    const args = [
      path.join(ROOT, "bin", "cyberboss.js"),
      "tool-mcp-server",
      "--runtime-id", "claudecode",
      "--workspace-root", this.workspaceRoot,
      "--route-token", ROUTE_TOKEN,
    ];
    if (authorizationCeiling) args.push("--authorization-ceiling", authorizationCeiling);
    const child = new McpChild({ args, env: this.env });
    this.children.add(child);
    await child.call("initialize", { protocolVersion: "2024-11-05" });
    return child;
  }

  endTurn() {
    this.runtimeContextStore.clearActiveTurn(ROUTE_TOKEN);
    this.registry.expireTurn(TURN_ID);
    this.byRunKey.delete(`${THREAD_ID}:${TURN_ID}`);
  }

  readCandidates() {
    const filePath = path.join(this.continuityDir, "candidates", "episodes.candidates.jsonl");
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  }

  async close() {
    for (const child of this.children) await child.close();
    this.children.clear();
    await this.server.close();
    this.remove();
  }

  remove() {
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

class McpChild {
  constructor({ args, env }) {
    this.args = args;
    this.env = env;
    this.process = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.stderr = "";
    this.stdoutBuffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.consume(chunk));
    this.process.on("exit", (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`tool-mcp-server exited code=${code} stderr=${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  call(method, params, timeoutMs = 4_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP response timeout method=${method} stderr=${this.stderr}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  consume(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/u);
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  spawnText() {
    return JSON.stringify({ args: this.args, env: this.env, stderr: this.stderr });
  }

  async close() {
    if (this.process.exitCode !== null) return;
    this.process.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.process.kill();
        resolve();
      }, 1000);
      this.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// No source_ref: the child cannot express provenance any more, and the tool
// schema rejects it as an unknown property. The broker supplies it from the
// capability record instead.
function candidateArgs() {
  return {
    type: "episode",
    body: BODY,
    origin: "live_subject",
  };
}

function toolText(response) {
  return String(response?.result?.content?.[0]?.text || "");
}

function readAllFiles(root) {
  const values = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try { values.push(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8")); } catch {}
  }
  return values.join("\n");
}

function withEnv(env, run) {
  const keys = Object.keys(env);
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
