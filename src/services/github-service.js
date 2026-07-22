const { execFile } = require("node:child_process");

class GithubService {
  constructor({ ghPath = "gh", runner = execFile } = {}) {
    this.ghPath = ghPath;
    this.runner = runner;
  }

  async createRepository(args = {}) {
    const name = requiredText(args.name, "name");
    const visibility = args.private === true ? "--private" : "--public";
    const commandArgs = ["repo", "create", name, visibility];
    if (hasText(args.description)) commandArgs.push("--description", args.description.trim());
    if (args.clone === true) commandArgs.push("--clone");
    return this.run(commandArgs);
  }

  async uploadFile(args = {}) {
    const repository = requiredText(args.repository, "repository");
    const path = requiredText(args.path, "path");
    const message = requiredText(args.message, "message");
    if (typeof args.content !== "string") throw new Error("github_file_upload content must be a string.");
    const commandArgs = ["api", `repos/${repository}/contents/${path}`, "--method", "PUT", "--field", `message=${message}`, "--field", `content=${Buffer.from(args.content, "utf8").toString("base64")}`];
    if (hasText(args.branch)) commandArgs.push("--field", `branch=${args.branch.trim()}`);
    if (hasText(args.sha)) commandArgs.push("--field", `sha=${args.sha.trim()}`);
    return this.run(commandArgs);
  }

  async openIssue(args = {}) {
    const commandArgs = ["issue", "create", "--repo", requiredText(args.repository, "repository"), "--title", requiredText(args.title, "title")];
    if (hasText(args.body)) commandArgs.push("--body", args.body.trim());
    for (const label of normalizedStringArray(args.labels, "labels")) commandArgs.push("--label", label);
    return this.run(commandArgs);
  }

  async openPullRequest(args = {}) {
    const commandArgs = ["pr", "create", "--repo", requiredText(args.repository, "repository"), "--title", requiredText(args.title, "title"), "--head", requiredText(args.head, "head"), "--base", hasText(args.base) ? args.base.trim() : "main"];
    if (hasText(args.body)) commandArgs.push("--body", args.body.trim());
    if (args.draft === true) commandArgs.push("--draft");
    return this.run(commandArgs);
  }

  run(args) {
    return new Promise((resolve, reject) => {
      this.runner(this.ghPath, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message || "gh command failed").trim();
          reject(new Error(`gh command failed: ${detail}`));
          return;
        }
        resolve({ text: String(stdout || "").trim() || "GitHub operation completed.", data: { stdout: String(stdout || "").trim() } });
      });
    });
  }
}

function requiredText(value, name) {
  if (!hasText(value)) throw new Error(`GitHub ${name} is required.`);
  return value.trim();
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedStringArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !hasText(item))) throw new Error(`github_issue_open ${name} must contain only non-empty strings.`);
  return value.map((item) => item.trim());
}

module.exports = { GithubService };
