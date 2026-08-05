const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureClaudeProjectMcpConfig,
  ensureRouteScopedMcpConfig,
  buildClaudeProjectMcpServerConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");
// The *child-side* reader, on purpose: this file's job here is to prove the two
// sides of the process boundary agree about what "on" means.
const { subjectSigningEnabled } = require("../src/tools/tool-catalog-manifest");

function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the subject signing switch survives the bridge -> tool server hop in the deployment's own form", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-signing-hop-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  const launchProfile = { schemaVersion: 3, profileId: "fable-chat" };
  try {
    // Production writes `=1` -- the form every other switch in telegram.env
    // uses. Anything narrower than "accepts 1" is the 2026-08-05 defect.
    for (const deploymentForm of ["1", "true", "TRUE", "yes", "on"]) {
      withEnv({ CYBERBOSS_SUBJECT_SIGNING_ENABLED: deploymentForm }, () => {
        const entry = buildClaudeProjectMcpServerConfig({ workspaceRoot, cyberbossHome, routeToken: "route", launchProfile });
        assert.equal(
          subjectSigningEnabled(entry.env), true,
          `bridge forwarded a value the tool server rejects (deployment wrote ${deploymentForm})`,
        );
        // The tool server also loads the deployment env file (override), so the
        // forwarded value is replaced by the file's own form a moment later.
        // Both must mean the same thing or the tool silently disappears.
        assert.equal(
          subjectSigningEnabled({ ...entry.env, CYBERBOSS_SUBJECT_SIGNING_ENABLED: deploymentForm }), true,
          `env-file override of ${deploymentForm} turned the switch off`,
        );
      });
    }
    for (const off of ["0", "false", "no", "off", ""]) {
      withEnv({ CYBERBOSS_SUBJECT_SIGNING_ENABLED: off }, () => {
        const entry = buildClaudeProjectMcpServerConfig({ workspaceRoot, cyberbossHome, routeToken: "route", launchProfile });
        assert.equal(entry.env?.CYBERBOSS_SUBJECT_SIGNING_ENABLED, undefined, `"${off}" must not be forwarded as on`);
      });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ensureClaudeProjectMcpConfig upserts cyberboss MCP server into workspace .mcp.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-settings-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      other: {
        command: "uvx",
        args: ["other"],
      },
    },
  }, null, 2));

  const result = ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome });
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.deepEqual(saved.mcpServers.other, {
    command: "uvx",
    args: ["other"],
  });
  assert.deepEqual(saved.mcpServers.cyberboss_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    cyberbossHome,
  }));
});

test("ensureClaudeProjectMcpConfig rewrites stale cyberboss MCP server config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-settings-stale-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      cyberboss_tools: {
        command: "node",
        args: ["old.js"],
      },
    },
  }, null, 2));

  ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.mcpServers.cyberboss_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    cyberbossHome,
  }));
});

test("fable route MCP config admits configured external servers and enforces override subsets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-g3-route-settings-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const configDir = path.join(root, "route-config");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  const previous = {
    name: process.env.CYBERBOSS_MUSIC_MCP_NAME,
    command: process.env.CYBERBOSS_MUSIC_MCP_COMMAND,
    args: process.env.CYBERBOSS_MUSIC_MCP_ARGS,
    extra: process.env.CYBERBOSS_EXTRA_MCP_SERVERS,
  };
  delete process.env.CYBERBOSS_MUSIC_MCP_NAME;
  delete process.env.CYBERBOSS_MUSIC_MCP_COMMAND;
  delete process.env.CYBERBOSS_MUSIC_MCP_ARGS;
  process.env.CYBERBOSS_EXTRA_MCP_SERVERS = JSON.stringify([
    { name: "fixture_alpha", command: "alpha-command", args: ["--alpha"] },
    { name: "fixture_beta", command: "beta-command", args: ["--beta"] },
  ]);
  try {
    const fable = ensureRouteScopedMcpConfig({
      workspaceRoot, cyberbossHome, configDir, routeToken: "a".repeat(64),
      launchProfile: { schemaVersion: 3, profileId: "fable-chat", mcpServerCeiling: "chat-ceiling@2" },
    });
    const work = ensureRouteScopedMcpConfig({
      workspaceRoot, cyberbossHome, configDir, routeToken: "b".repeat(64),
      launchProfile: { schemaVersion: 3, profileId: "work-engineering", mcpServerCeiling: "work-ceiling@1" },
    });
    assert.deepEqual(Object.keys(fable.config.mcpServers), ["cyberboss_tools", "fixture_alpha", "fixture_beta"]);
    assert.equal(Object.hasOwn(work.config.mcpServers, "fixture_alpha"), true);
    assert.equal(fable.config.mcpServers.cyberboss_tools.args.includes("--authorization-ceiling"), false,
      "chat lane never receives a hard tool ceiling");
    assert.equal(fable.config.mcpServers.cyberboss_tools.env.CYBERBOSS_TOOL_CATALOG_ENABLED, "true");
    const workArgs = work.config.mcpServers.cyberboss_tools.args;
    assert.deepEqual(workArgs.slice(workArgs.indexOf("--authorization-ceiling")), [
      "--authorization-ceiling", "work-memory-readonly@1",
    ]);

    const subset = ensureRouteScopedMcpConfig({
      workspaceRoot, cyberbossHome, configDir, routeToken: "c".repeat(64),
      launchProfile: { schemaVersion: 3, profileId: "fable-chat", mcpServerCeiling: "chat-ceiling@2" },
      mutableOverride: { effectiveMcpSet: ["cyberboss_tools", "fixture_beta"] },
    });
    assert.deepEqual(Object.keys(subset.config.mcpServers), ["cyberboss_tools", "fixture_beta"]);
    assert.throws(
      () => ensureRouteScopedMcpConfig({
        workspaceRoot, cyberbossHome, configDir, routeToken: "d".repeat(64),
        launchProfile: { schemaVersion: 3, profileId: "fable-chat", mcpServerCeiling: "chat-ceiling@2" },
        mutableOverride: { effectiveMcpSet: ["outside_ceiling"] },
      }),
      (error) => error.code === "window_override_mcp_outside_ceiling",
    );
  } finally {
    for (const [key, envKey] of [["name", "CYBERBOSS_MUSIC_MCP_NAME"], ["command", "CYBERBOSS_MUSIC_MCP_COMMAND"], ["args", "CYBERBOSS_MUSIC_MCP_ARGS"], ["extra", "CYBERBOSS_EXTRA_MCP_SERVERS"]]) {
      if (previous[key] === undefined) delete process.env[envKey];
      else process.env[envKey] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildClaudeProjectMcpServerConfig forwards CYBERBOSS_SUBJECT_SIGNING_ENABLED to the tool-mcp-server child only for the fable-chat subject", () => {
  // Regression guard for the second cross-process wiring gap: the child env is
  // isolated, so memory_candidate_submit (gated on subjectSigningEnabled of the
  // child's own env in tool-host `registeredProjectTools`) never registers
  // unless the flag is forwarded here. Offline fixtures that hand-build the
  // child env could not catch this; this asserts the real generation path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-signing-env-"));
  const cyberbossHome = path.join(root, "home");
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "");
  const prev = process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED;
  try {
    process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED = "1"; // 1/true/yes/on all equivalent
    const fable = buildClaudeProjectMcpServerConfig({
      workspaceRoot: root, cyberbossHome, routeToken: "a".repeat(64),
      launchProfile: { schemaVersion: 3, profileId: "fable-chat" },
    });
    assert.equal(fable.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED, "true",
      "fable-chat child must see signing on so memory_candidate_submit registers");
    const work = buildClaudeProjectMcpServerConfig({
      workspaceRoot: root, cyberbossHome, routeToken: "b".repeat(64),
      launchProfile: { schemaVersion: 3, profileId: "work-engineering" },
    });
    assert.equal(work.env?.CYBERBOSS_SUBJECT_SIGNING_ENABLED, undefined,
      "work-engineering child must never see signing (G3 isolation)");
    process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED = "0";
    const off = buildClaudeProjectMcpServerConfig({
      workspaceRoot: root, cyberbossHome, routeToken: "c".repeat(64),
      launchProfile: { schemaVersion: 3, profileId: "fable-chat" },
    });
    assert.equal(off.env?.CYBERBOSS_SUBJECT_SIGNING_ENABLED, undefined,
      "signing off must not forward the flag");
  } finally {
    if (prev === undefined) delete process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED;
    else process.env.CYBERBOSS_SUBJECT_SIGNING_ENABLED = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
