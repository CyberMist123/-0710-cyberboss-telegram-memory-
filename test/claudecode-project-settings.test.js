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

test("T04 A2/A4 route MCP config keeps fable discovery separate from the work memory-write ceiling", () => {
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
  };
  process.env.CYBERBOSS_MUSIC_MCP_NAME = "engineering_sentinel";
  process.env.CYBERBOSS_MUSIC_MCP_COMMAND = "fixture-command";
  process.env.CYBERBOSS_MUSIC_MCP_ARGS = "[]";
  try {
    const fable = ensureRouteScopedMcpConfig({
      workspaceRoot, cyberbossHome, configDir, routeToken: "a".repeat(64),
      launchProfile: { schemaVersion: 3, profileId: "fable-chat", mcpServerCeiling: "chat-ceiling@1" },
    });
    const work = ensureRouteScopedMcpConfig({
      workspaceRoot, cyberbossHome, configDir, routeToken: "b".repeat(64),
      launchProfile: { schemaVersion: 3, profileId: "work-engineering", mcpServerCeiling: "work-ceiling@1" },
    });
    assert.deepEqual(Object.keys(fable.config.mcpServers), ["cyberboss_tools"]);
    assert.equal(Object.hasOwn(work.config.mcpServers, "engineering_sentinel"), true);
    assert.equal(fable.config.mcpServers.cyberboss_tools.args.includes("--authorization-ceiling"), false,
      "chat lane never receives a hard tool ceiling");
    assert.equal(fable.config.mcpServers.cyberboss_tools.env.CYBERBOSS_TOOL_CATALOG_ENABLED, "true");
    const workArgs = work.config.mcpServers.cyberboss_tools.args;
    assert.deepEqual(workArgs.slice(workArgs.indexOf("--authorization-ceiling")), [
      "--authorization-ceiling", "work-memory-readonly@1",
    ]);
  } finally {
    for (const [key, envKey] of [["name", "CYBERBOSS_MUSIC_MCP_NAME"], ["command", "CYBERBOSS_MUSIC_MCP_COMMAND"], ["args", "CYBERBOSS_MUSIC_MCP_ARGS"]]) {
      if (previous[key] === undefined) delete process.env[envKey];
      else process.env[envKey] = previous[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
