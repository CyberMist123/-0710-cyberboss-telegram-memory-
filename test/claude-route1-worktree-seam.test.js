"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode");
const { buildTaskSessionPrompt } = require("../src/adapters/runtime/claudecode/task-session");
const {
  assertRoute1PathGate,
  buildProtectedTaskSpec,
  buildProtectedWorkProfile,
  cleanupRoute1Worktree,
  pathsOverlap,
  provisionRoute1Worktree,
  resolveRoute1ProtectedRoots,
} = require("../src/adapters/runtime/claudecode/route1-runtime-seam");

const FAKE_CLI = path.join(__dirname, "helpers", "fake-claude-cli.js");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(root) {
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "extensions", "relationship-memory"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "fixture.js"), "module.exports = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, "extensions", "relationship-memory", "fixture.js"), "module.exports = 2;\n", "utf8");
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "Route Fixture"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "fixture base"]);
  return { repo, baseSha: git(repo, ["rev-parse", "HEAD"]) };
}

function makeProfile(root, cwd, configRoot = path.join(root, "work-profile")) {
  const settings = path.join(root, "worker.settings.json");
  const personaSource = path.join(root, "worker.role.md");
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(settings, "{}\n", "utf8");
  fs.writeFileSync(personaSource, "FIXTURE_WORKER_ROLE\n", "utf8");
  return {
    schemaVersion: 3,
    profileId: "work-engineering",
    cwd,
    configRoot,
    harnessMode: "engineering",
    settingSources: ["user", "project", "local"],
    skillsMode: "enabled",
    settings: [settings],
    personaSource,
    residentToolSchemas: ["engineering-tools"],
    mcpServerCeiling: "work-ceiling@1",
    toolsetCeiling: "work-ceiling@1",
    defaultMcpServerSet: "work-base@1",
    defaultToolset: "work-full@1",
    strictMcpConfig: true,
    permissionMode: "work-engineering-full",
    envPolicy: "work-engineering",
  };
}

function makeSpec(repo, baseSha, taskId = "route1-seam-fixture") {
  return {
    task_id: taskId,
    objective: "Inspect the bounded engineering fixture.",
    allowed_paths: ["src", "extensions/relationship-memory"],
    forbidden_paths: [],
    workspace: repo,
    base_sha: baseSha,
    acceptance_tests: [{ name: "fixture", command: "node", args: ["--check", "src/fixture.js"] }],
    timeout_ms: 5_000,
    approval_policy: "never",
  };
}

function protectedFixture(root, repo, profile) {
  const config = {
    stateDir: path.join(root, "live-state"),
    memoryDir: path.join(root, "live-memory"),
    continuityDir: path.join(root, "live-continuity"),
    workspaceRoot: path.join(root, "live-runtime-root"),
    route1ProfileConfigRoots: [path.join(root, "fable-profile")],
  };
  for (const dir of [
    config.stateDir, config.memoryDir, config.continuityDir, config.workspaceRoot,
    profile.configRoot, ...config.route1ProfileConfigRoots,
  ]) fs.mkdirSync(dir, { recursive: true });
  return { config, roots: resolveRoute1ProtectedRoots({ config, launchProfile: profile }) };
}

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve().then(run).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("T10-A A3/A4/A5 path gate rejects all live-data root classes without blocking memory source code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route1-gate-"));
  try {
    const { repo, baseSha } = makeRepo(root);
    const profile = makeProfile(root, repo);
    const { roots } = protectedFixture(root, repo, profile);
    let reached = 0;
    for (const protectedRoot of roots) {
      reached += 1;
      assert.throws(
        () => assertRoute1PathGate({
          workspace: protectedRoot.root,
          allowedPaths: ["src"],
          protectedRoots: roots,
        }),
        (error) => error.code === "route1_live_data_path_forbidden"
          && error.field === "workspace"
          && error.protectedRoot === protectedRoot.label,
      );
      assert.throws(
        () => assertRoute1PathGate({
          workspace: path.join(root, "isolated-worktree"),
          allowedPaths: [protectedRoot.root],
          protectedRoots: roots,
        }),
        (error) => error.code === "route1_live_data_path_forbidden"
          && error.field === "allowed_paths[0]"
          && error.protectedRoot === protectedRoot.label,
      );
    }
    assert.equal(reached, roots.length, "every configured protection class reached the fail-closed decision");

    const isolated = path.join(root, "isolated-worktree");
    assert.equal(assertRoute1PathGate({
      workspace: isolated,
      allowedPaths: ["src", "extensions/relationship-memory"],
      protectedRoots: roots,
    }), true);
    const spec = buildProtectedTaskSpec(makeSpec(repo, baseSha), { worktreePath: isolated }, roots);
    assert.deepEqual(spec.forbidden_paths.slice(-roots.length), roots.map(({ root: protectedRoot }) => protectedRoot));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T10-A A1/A7/A8 worktree cleanup is idempotent/fail-open and profile deny remains honest about Bash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route1-provision-"));
  try {
    const { repo, baseSha } = makeRepo(root);
    const profile = makeProfile(root, repo);
    const { config, roots } = protectedFixture(root, repo, profile);
    const spec = makeSpec(repo, baseSha, "route1-provision-fixture");
    const worktree = provisionRoute1Worktree({ spec, protectedRoots: roots, worktreeRoot: path.join(root, "worktrees") });
    assert.equal(fs.existsSync(path.join(worktree.worktreePath, "src", "fixture.js")), true);
    assert.equal(pathsOverlap(repo, worktree.worktreePath), false, "source and worker lock domains are disjoint");

    const protectedProfile = buildProtectedWorkProfile(profile, {
      stateDir: config.stateDir,
      taskId: spec.task_id,
      protectedRoots: roots,
      workspace: worktree.worktreePath,
    });
    const denySettings = JSON.parse(fs.readFileSync(protectedProfile.settings.at(-1), "utf8"));
    assert.equal(denySettings.permissions.deny.length, roots.length * 2);
    assert.equal(denySettings.permissions.deny.every((rule) => /^(?:Write|Edit)\(/.test(rule)), true);
    assert.equal(denySettings.permissions.deny.some((rule) => /^Bash\(/.test(rule)), false,
      "v1 does not pretend CC deny rules seal absolute-path Bash escape");

    assert.deepEqual(cleanupRoute1Worktree(worktree), { ok: true, removed: true });
    assert.deepEqual(cleanupRoute1Worktree(worktree), { ok: true, removed: false });
    const retained = path.join(root, "not-a-worktree");
    fs.mkdirSync(retained);
    const cleanupFailure = cleanupRoute1Worktree({ repoRoot: repo, worktreePath: retained });
    assert.equal(cleanupFailure.ok, false, "cleanup failure is reported but does not throw");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T10-A A1/A2/A10 runTaskSession provisions a disjoint lock domain and observes its own empty diff", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route1-runtime-"));
  const { repo, baseSha } = makeRepo(root);
  const profile = makeProfile(root, repo);
  const { config } = protectedFixture(root, repo, profile);
  const launchLog = path.join(root, "launches.jsonl");
  fs.writeFileSync(launchLog, "", "utf8");
  const worktreeRoot = path.join(root, "worktrees");
  const adapter = createClaudeCodeRuntimeAdapter({
    ...config,
    agentCwd: repo,
    route1WorktreeRoot: worktreeRoot,
    sessionsFile: path.join(config.stateDir, "sessions.json"),
    claudeSessionSlotsFile: path.join(config.stateDir, "slots.json"),
    claudeCommand: process.execPath,
    claudeCommandPrefixArgs: [FAKE_CLI],
    claudeDisableVerbose: true,
    claudeLaunchProfileBaseDir: root,
    claudeG3AuthProbe: async () => ({ ok: true }),
  });
  const spec = makeSpec(repo, baseSha, "route1-runtime-fixture");
  const capsule = {
    task_id: spec.task_id,
    status: "completed",
    summary: "Read-only fixture inspection completed.",
    files_changed: [], tests: [], commit_sha: null, risks: [], recommended_action: "accept",
  };
  const hold = await adapter.__internals.workspaceLocks.acquire(repo, "write");
  try {
    await withEnv({
      CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED: "true",
      CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED: "true",
      CYBERBOSS_CLAUDE_G3_PROFILE_CONTRACT_ENABLED: "true",
      CYBERBOSS_CLAUDE_G3_PREFLIGHT_ENABLED: "true",
      CB_FAKE_LAUNCH_LOG: launchLog,
      CB_FAKE_COUNTER: path.join(root, "counter"),
      CB_FAKE_RESULT_JSON: JSON.stringify(capsule),
    }, async () => {
      const result = await Promise.race([
        adapter.runTaskSession({ spec, launchProfile: profile }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("workspace_lock_timeout regression")), 2_000)),
      ]);
      assert.equal(result.shortStatus.decision, "accept");
      const worker = adapter.__internals.taskWorktrees.get(spec.task_id);
      assert.equal(pathsOverlap(worker.worktreePath, repo), false);
      assert.equal(fs.existsSync(path.join(worktreeRoot, spec.task_id)), false, "completed worktree was reclaimed");
    });
  } finally {
    hold.release();
    await adapter.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T10-A A10 new flag off preserves T09 observedChangedPaths requirement and creates no worktree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route1-flag-off-"));
  const { repo, baseSha } = makeRepo(root);
  const profile = makeProfile(root, repo);
  const { config } = protectedFixture(root, repo, profile);
  const worktreeRoot = path.join(root, "worktrees");
  const adapter = createClaudeCodeRuntimeAdapter({
    ...config,
    route1WorktreeRoot: worktreeRoot,
    sessionsFile: path.join(config.stateDir, "sessions.json"),
    claudeSessionSlotsFile: path.join(config.stateDir, "slots.json"),
  });
  try {
    const baselinePrompt = buildTaskSessionPrompt({ spec: makeSpec(repo, baseSha) });
    assert.equal(baselinePrompt.includes("small rounds"), false, "T09 prompt bytes do not gain T10-A instructions while off");
    await withEnv({
      CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED: "true",
      CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED: "false",
    }, () => assert.rejects(
      () => adapter.runTaskSession({ spec: makeSpec(repo, baseSha), launchProfile: profile }),
      (error) => error.code === "task_session_observed_paths_required",
    ));
    assert.equal(fs.existsSync(worktreeRoot), false);
  } finally {
    await adapter.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T10-A A9 pins small-round intent without app commands or changed interrupt semantics", () => {
  const adapterSource = fs.readFileSync(path.join(__dirname, "..", "src", "adapters", "runtime", "claudecode", "index.js"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "core", "app.js"), "utf8");
  assert.match(adapterSource, /One atomic step is intentionally one small worker round/);
  assert.doesNotMatch(appSource, /CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED|stop-tasks-and-answer-now|force-stop-now/);
});
