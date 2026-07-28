// Git worktree isolation + the observed-diff source used by the verifier.
//
// A bounded run gets its own worktree and its own branch off a pinned base sha.
// That is what makes "allowed_paths" enforceable after the fact: the diff of
// the worktree against its base is the complete, authoritative list of what the
// sub-agent touched.
//
// changedPaths() deliberately unions tracked changes with untracked files. A
// sub-agent that creates a brand new file outside its allowlist is the exact
// case the boundary exists to catch, and `git diff` alone would not see it.

const { execFileSync } = require("child_process");
const path = require("path");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function toLines(output) {
  return String(output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function createDelegationWorktree({ repoRoot, branch, baseSha, worktreePath } = {}) {
  if (!repoRoot || !branch || !baseSha || !worktreePath) {
    throw new Error("repoRoot, branch, baseSha and worktreePath are all required");
  }
  const target = path.resolve(worktreePath);
  git(repoRoot, ["worktree", "add", "-b", branch, target, baseSha]);
  return { branch, worktreePath: target, baseSha };
}

function removeDelegationWorktree({ repoRoot, worktreePath, force = true } = {}) {
  if (!repoRoot || !worktreePath) {
    throw new Error("repoRoot and worktreePath are required");
  }
  const args = ["worktree", "remove"];
  if (force) {
    args.push("--force");
  }
  args.push(path.resolve(worktreePath));
  git(repoRoot, args);
}

function changedPaths({ workspace, baseSha } = {}) {
  if (!workspace || !baseSha) {
    throw new Error("workspace and baseSha are required");
  }
  const tracked = toLines(git(workspace, ["diff", "--name-only", baseSha]));
  const untracked = toLines(git(workspace, ["ls-files", "--others", "--exclude-standard"]));
  return Array.from(new Set([...tracked, ...untracked])).sort();
}

function headSha({ workspace } = {}) {
  if (!workspace) {
    throw new Error("workspace is required");
  }
  return toLines(git(workspace, ["rev-parse", "HEAD"]))[0] || null;
}

module.exports = {
  changedPaths,
  createDelegationWorktree,
  headSha,
  removeDelegationWorktree,
};
