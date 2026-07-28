// Path boundary check for a bounded sub-agent run.
//
// Reuses isPathWithinRoot() from the shared approval helper rather than growing
// a second containment implementation -- a second one would inevitably drift
// from the first, and containment bugs are exactly the kind you do not want two
// versions of.
//
// One thing is deliberately added on top: case folding on Windows. The shared
// helper compares resolved paths case-sensitively, which is correct on Linux
// but means "SRC/core/app.js" would slip past a "src/" forbidden rule on a
// Windows checkout, where it names the very same file. The fold happens only
// here, in the boundary layer, so production approval behaviour is untouched.

const path = require("path");
const { isPathWithinRoot } = require("../../adapters/runtime/shared/approval-command");

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function foldCase(value) {
  return CASE_INSENSITIVE_FS ? String(value).toLowerCase() : String(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveWithin(workspace, relativePath) {
  return path.resolve(workspace, relativePath);
}

function contains(rootAbsolute, targetAbsolute) {
  return isPathWithinRoot(foldCase(targetAbsolute), foldCase(rootAbsolute));
}

// changedPaths are repo-relative, as produced by `git diff --name-only`.
// Returns every violation rather than the first, so a rejected run reports the
// full boundary breach instead of one file at a time.
function evaluateChangedPaths({ workspace, allowedPaths, forbiddenPaths, changedPaths } = {}) {
  const violations = [];

  if (!isNonEmptyString(workspace)) {
    return { ok: false, violations: [{ path: null, reason: "workspace_missing" }] };
  }
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    return { ok: false, violations: [{ path: null, reason: "allowed_paths_missing" }] };
  }
  if (!Array.isArray(changedPaths)) {
    return { ok: false, violations: [{ path: null, reason: "changed_paths_missing" }] };
  }

  const workspaceRoot = path.resolve(workspace);
  const allowedRoots = allowedPaths.map((entry) => resolveWithin(workspaceRoot, entry));
  const forbiddenRoots = (Array.isArray(forbiddenPaths) ? forbiddenPaths : [])
    .map((entry) => resolveWithin(workspaceRoot, entry));

  for (const changed of changedPaths) {
    if (!isNonEmptyString(changed)) {
      violations.push({ path: changed, reason: "invalid_path" });
      continue;
    }

    const target = resolveWithin(workspaceRoot, changed);

    // A path that leaves the workspace fails before allow/deny is consulted:
    // no allowlist entry can legitimately cover it.
    if (!contains(workspaceRoot, target)) {
      violations.push({ path: changed, reason: "outside_workspace" });
      continue;
    }

    // Forbidden wins over allowed. A file that matches both is denied, so a
    // broad allowlist can always be narrowed by an explicit deny.
    if (forbiddenRoots.some((root) => contains(root, target))) {
      violations.push({ path: changed, reason: "forbidden_path" });
      continue;
    }

    if (!allowedRoots.some((root) => contains(root, target))) {
      violations.push({ path: changed, reason: "not_allowed" });
    }
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  evaluateChangedPaths,
};
