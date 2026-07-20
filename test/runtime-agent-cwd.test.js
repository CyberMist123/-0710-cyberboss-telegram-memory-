const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveAgentCwd } = require("../src/adapters/runtime/claudecode");
const { ensureClaudeProjectMcpConfig } = require("../src/adapters/runtime/claudecode/project-settings");

test("agent cwd is isolated while MCP configuration stays at the system workspace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-agent-cwd-"));
  const workspaceRoot = path.join(root, "project");
  const agentCwd = path.join(root, "memory");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(agentCwd, { recursive: true });
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  try {
    assert.equal(resolveAgentCwd(agentCwd, workspaceRoot), agentCwd);
    assert.equal(resolveAgentCwd("", workspaceRoot), workspaceRoot);
    ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome: root });
    assert.equal(fs.existsSync(path.join(workspaceRoot, ".mcp.json")), true);
    assert.equal(fs.existsSync(path.join(agentCwd, ".mcp.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
