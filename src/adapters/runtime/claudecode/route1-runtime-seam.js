"use strict";

const fs = require("fs");
const path = require("path");
const {
  changedPaths,
  createDelegationWorktree,
  removeDelegationWorktree,
} = require("../../../orchestration/delegation/git-workspace");

const ROUTE1_CHAT_DISPATCH_FLAG = "CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED";
const ROUTE1_TASK_SESSION_FLAG = "CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED";

function flagEnabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

function route1RuntimeSeamEnabled(env = process.env) {
  return flagEnabled(env?.[ROUTE1_CHAT_DISPATCH_FLAG])
    && flagEnabled(env?.[ROUTE1_TASK_SESSION_FLAG]);
}

function lexicalPath(value, baseDir = "") {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const base = typeof baseDir === "string" ? baseDir.trim() : "";
  if (!path.isAbsolute(text) && !path.isAbsolute(base)) return "";
  const absolute = path.isAbsolute(text) ? path.resolve(text) : path.resolve(base, text);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function pathContains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return pathContains(left, right) || pathContains(right, left);
}

function route1SeamError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function parseProfileConfigRoots(raw, baseDir) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return [];
  let profiles;
  try {
    profiles = JSON.parse(text);
  } catch {
    throw route1SeamError("route1_protected_profile_roots_invalid");
  }
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw route1SeamError("route1_protected_profile_roots_invalid");
  }
  return Object.values(profiles)
    .map((profile) => lexicalPath(profile?.configRoot, baseDir))
    .filter(Boolean);
}

function resolveRoute1ProtectedRoots({ config = {}, launchProfile = null } = {}) {
  const baseDir = config.claudeLaunchProfileBaseDir || config.configDir || config.stateDir || "";
  const workspaceRoot = lexicalPath(config.workspaceRoot);
  const required = [
    ["memoryDir", lexicalPath(config.memoryDir)],
    ["continuityDir", lexicalPath(config.continuityDir)],
    ["stateDir", lexicalPath(config.stateDir)],
    ["settingsSecrets", lexicalPath(config.settingsSecretsDir || (workspaceRoot ? path.join(workspaceRoot, "settings", "secrets") : ""))],
  ];
  const missing = required.filter(([, value]) => !value).map(([label]) => label);
  if (missing.length) {
    throw route1SeamError("route1_protected_roots_incomplete", { missing });
  }

  const profileRoots = [
    lexicalPath(launchProfile?.configRoot, baseDir),
    ...parseProfileConfigRoots(config.claudeLaunchProfilesJson, baseDir),
    ...(Array.isArray(config.route1ProfileConfigRoots)
      ? config.route1ProfileConfigRoots.map((entry) => lexicalPath(entry, baseDir))
      : []),
  ].filter(Boolean);
  if (new Set(profileRoots).size < 2) {
    throw route1SeamError("route1_protected_profile_roots_missing");
  }

  const entries = [
    ...required.map(([label, root]) => ({ label, root })),
    ...profileRoots.map((root, index) => ({ label: `profileConfigRoot[${index}]`, root })),
  ];
  const seen = new Set();
  return entries.filter(({ root }) => {
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}

function assertRoute1PathGate({ workspace, allowedPaths, protectedRoots } = {}) {
  const workspaceRoot = lexicalPath(workspace);
  if (!workspaceRoot || !Array.isArray(allowedPaths) || !Array.isArray(protectedRoots)) {
    throw route1SeamError("route1_path_gate_input_invalid");
  }
  const candidates = [
    { field: "workspace", value: workspaceRoot },
    ...allowedPaths.map((entry, index) => ({
      field: `allowed_paths[${index}]`,
      value: lexicalPath(entry, workspaceRoot),
    })),
  ];
  for (const candidate of candidates) {
    const protectedEntry = protectedRoots.find(({ root }) => pathsOverlap(candidate.value, root));
    if (protectedEntry) {
      throw route1SeamError("route1_live_data_path_forbidden", {
        field: candidate.field,
        protectedRoot: protectedEntry.label,
      });
    }
  }
  return true;
}

function worktreePathFor({ repoRoot, taskId, configuredRoot = "" } = {}) {
  const root = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(path.dirname(path.resolve(repoRoot)), ".cyberboss-route1-worktrees");
  return path.join(root, taskId);
}

function provisionRoute1Worktree({ spec, protectedRoots, worktreeRoot = "" } = {}) {
  const repoRoot = lexicalPath(spec?.workspace);
  const target = worktreePathFor({ repoRoot, taskId: spec?.task_id, configuredRoot: worktreeRoot });
  assertRoute1PathGate({ workspace: target, allowedPaths: spec?.allowed_paths, protectedRoots });
  if (fs.existsSync(target)) throw route1SeamError("route1_worktree_target_exists");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    createDelegationWorktree({ repoRoot, baseSha: spec.base_sha, worktreePath: target });
  } catch (cause) {
    throw route1SeamError("route1_worktree_provision_failed", { cause });
  }
  return Object.freeze({ repoRoot, worktreePath: path.resolve(target), baseSha: spec.base_sha });
}

function buildProtectedTaskSpec(spec, worktree, protectedRoots) {
  const roots = protectedRoots.map(({ root }) => root);
  return Object.freeze({
    ...spec,
    workspace: worktree.worktreePath,
    forbidden_paths: Array.from(new Set([...(spec.forbidden_paths || []), ...roots])),
  });
}

function buildProtectedWorkProfile(launchProfile, {
  stateDir, taskId, protectedRoots, workspace,
} = {}) {
  const settingsDir = path.join(stateDir, "route1", "worker-settings");
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, `${taskId}.json`);
  const deny = protectedRoots.flatMap(({ root }) => {
    const pattern = `${root.replace(/\\/g, "/")}/**`;
    return [`Write(${pattern})`, `Edit(${pattern})`];
  });
  // This is defence in depth, not an OS sandbox. In v1 an absolute-path write
  // performed inside Bash can escape these Write/Edit rules; the legal artifact
  // surface remains the independently observed worktree diff.
  fs.writeFileSync(settingsPath, `${JSON.stringify({ permissions: { deny } }, null, 2)}\n`, "utf8");
  return Object.freeze({
    ...launchProfile,
    cwd: path.resolve(workspace),
    settings: [...(launchProfile.settings || []), settingsPath],
  });
}

function observeRoute1ChangedPaths({ spec } = {}) {
  return changedPaths({ workspace: spec.workspace, baseSha: spec.base_sha });
}

function cleanupRoute1Worktree(worktree) {
  if (!worktree) return Object.freeze({ ok: true, removed: false });
  try {
    const removed = removeDelegationWorktree({
      repoRoot: worktree.repoRoot,
      worktreePath: worktree.worktreePath,
      force: true,
    });
    return Object.freeze({ ok: true, removed });
  } catch (error) {
    // Cleanup failure is fail-open: execution/result delivery is never replaced
    // by a cleanup error. The retained path remains available for diagnosis.
    return Object.freeze({ ok: false, removed: false, error: error?.message || String(error) });
  }
}

module.exports = {
  ROUTE1_CHAT_DISPATCH_FLAG,
  assertRoute1PathGate,
  buildProtectedTaskSpec,
  buildProtectedWorkProfile,
  cleanupRoute1Worktree,
  lexicalPath,
  observeRoute1ChangedPaths,
  pathsOverlap,
  provisionRoute1Worktree,
  resolveRoute1ProtectedRoots,
  route1RuntimeSeamEnabled,
  worktreePathFor,
};
