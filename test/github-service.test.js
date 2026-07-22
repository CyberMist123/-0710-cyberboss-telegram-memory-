const test = require("node:test");
const assert = require("node:assert/strict");

const { GithubService } = require("../src/services/github-service");
const { ProjectToolHost } = require("../src/tools/tool-host");

function fakeRunner(calls, { stdout = "ok\n", error = null, stderr = "" } = {}) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error, stdout, stderr);
  };
}

test("GithubService maps repository, file, issue, and PR operations to gh", async () => {
  const calls = [];
  const service = new GithubService({ runner: fakeRunner(calls) });

  await service.createRepository({ name: "demo", description: "A demo", private: true });
  await service.uploadFile({ repository: "CyberMist123/demo", path: "README.md", content: "你好", message: "docs: add readme", branch: "main" });
  await service.openIssue({ repository: "CyberMist123/demo", title: "Bug", body: "Details", labels: ["bug", "triage"] });
  await service.openPullRequest({ repository: "CyberMist123/demo", title: "Fix", body: "Details", head: "fix/bug", draft: true });

  assert.deepEqual(calls.map((call) => call.args), [
    ["repo", "create", "demo", "--private", "--description", "A demo"],
    ["api", "repos/CyberMist123/demo/contents/README.md", "--method", "PUT", "--field", "message=docs: add readme", "--field", `content=${Buffer.from("你好").toString("base64")}`, "--field", "branch=main"],
    ["issue", "create", "--repo", "CyberMist123/demo", "--title", "Bug", "--body", "Details", "--label", "bug", "--label", "triage"],
    ["pr", "create", "--repo", "CyberMist123/demo", "--title", "Fix", "--head", "fix/bug", "--base", "main", "--body", "Details", "--draft"],
  ]);
  assert.ok(calls.every((call) => call.file === "gh" && call.options.windowsHide === true));
});

test("GithubService rejects command failures without exposing credentials", async () => {
  const service = new GithubService({ runner: fakeRunner([], { error: new Error("exit 1"), stderr: "not logged in" }) });
  await assert.rejects(() => service.openIssue({ repository: "owner/repo", title: "Test" }), /gh command failed: not logged in/);
});

test("GitHub MCP tools are exposed and validate required fields", async () => {
  const calls = [];
  const host = new ProjectToolHost({
    services: { github: new GithubService({ runner: fakeRunner(calls) }) },
    runtimeContextStore: { load() {}, resolveActiveContext() { return {}; } },
  });
  const names = host.listTools().map((tool) => tool.name);
  assert.deepEqual(names.filter((name) => name.startsWith("github_")), ["github_repo_create", "github_file_upload", "github_issue_open", "github_pr_open"]);
  await assert.rejects(() => host.invokeTool("github_pr_open", { repository: "owner/repo", title: "Missing head" }), /head is required/);
});
