#!/usr/bin/env node
// G5 备份与恢复工具（D20 硬门的可重复手段）。
//
// 三条命令，各自 fail-closed：
//   snapshot --source <memoryDir> --dest <backupRoot> [--label <text>]
//   verify   --backup <backupDir> [--against <dir>]
//   restore  --backup <backupDir> --target <dir> --root <CYBERLINK_ROOT> [--confirm] [--overwrite] [--allow-live-memory]
//
// 纪律：
// - 不向上摸目录找根（D8）：路径一律显式传入；restore 必须显式给 --root 且校验存在。
// - restore 默认是 dry-run，没有 --confirm 不动任何字节。
// - 目标落在 <root>/memory（真档）时，必须再加 --allow-live-memory 才允许。
// - manifest 里只存 POSIX 相对路径 + sha256，不存绝对路径（跨机可核对；避开 8.3 短名路径语义坑）。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOL_VERSION = 1;
const MANIFEST_NAME = "manifest.json";
const DATA_DIR = "data";
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

function parseArgs(argv) {
  const args = { _: [], flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) { args._.push(token); continue; }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { args.flags.add(name); continue; }
    args[name] = next;
    i += 1;
  }
  return args;
}

function fail(message) {
  console.error(`ERROR ${message}`);
  process.exit(EXIT_FAILED);
}

function usage(message) {
  console.error(`ERROR ${message}`);
  console.error("Usage:");
  console.error("  memory-backup.js snapshot --source <memoryDir> --dest <backupRoot> [--label <text>]");
  console.error("  memory-backup.js verify   --backup <backupDir> [--against <dir>]");
  console.error("  memory-backup.js restore  --backup <backupDir> --target <dir> --root <CYBERLINK_ROOT> [--confirm] [--overwrite] [--allow-live-memory]");
  process.exit(EXIT_USAGE);
}

function requireDir(value, label) {
  if (!value) usage(`${label} is required`);
  const resolved = path.resolve(value);
  let stat = null;
  try { stat = fs.statSync(resolved); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) fail(`${label} is not an existing directory: ${resolved}`);
  return resolved;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// 词法相对路径 + POSIX 分隔符：两端都不做物理规范化，避免同一路径两处解析结果不同（协议坑 21）。
function toPosixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

// 只收普通文件与普通目录；symlink / junction 一律不跟随，登记进 skipped 而不是静默丢掉。
function walkTree(root) {
  const files = [];
  const dirs = [];
  const skipped = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) {
      skipped.push({ path: toPosixRelative(root, current), reason: `readdir_failed:${error.code || "unknown"}` });
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = toPosixRelative(root, full);
      if (entry.isSymbolicLink()) { skipped.push({ path: rel, reason: "symlink_not_followed" }); continue; }
      if (entry.isDirectory()) { dirs.push(rel); stack.push(full); continue; }
      if (!entry.isFile()) { skipped.push({ path: rel, reason: "not_a_regular_file" }); continue; }
      files.push(rel);
    }
  }
  files.sort();
  dirs.sort();
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, dirs, skipped };
}

function hashTree(root) {
  const { files, dirs, skipped } = walkTree(root);
  const entries = files.map((rel) => {
    const full = path.join(root, ...rel.split("/"));
    return { path: rel, bytes: fs.statSync(full).size, sha256: sha256(full) };
  });
  return { entries, dirs, skipped };
}

function readManifest(backupDir) {
  const manifestPath = path.join(backupDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) fail(`backup has no ${MANIFEST_NAME}: ${manifestPath}`);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (error) {
    fail(`unreadable ${MANIFEST_NAME}: ${error.message}`);
  }
  if (!manifest || !Array.isArray(manifest.files)) fail(`${MANIFEST_NAME} has no files[]`);
  return manifest;
}

function compareAgainstManifest(manifest, treeRoot) {
  const expected = new Map(manifest.files.map((row) => [row.path, row]));
  const { entries } = hashTree(treeRoot);
  const actual = new Map(entries.map((row) => [row.path, row]));
  const missing = [];
  const extra = [];
  const mismatched = [];
  for (const [rel, row] of expected) {
    const found = actual.get(rel);
    if (!found) { missing.push(rel); continue; }
    if (found.sha256 !== row.sha256) mismatched.push({ path: rel, expected: row.sha256, actual: found.sha256 });
  }
  for (const rel of actual.keys()) if (!expected.has(rel)) extra.push(rel);
  return { missing, extra, mismatched, checked: expected.size };
}

function copyTree(sourceRoot, destRoot, plan) {
  fs.mkdirSync(destRoot, { recursive: true });
  for (const rel of plan.dirs) fs.mkdirSync(path.join(destRoot, ...rel.split("/")), { recursive: true });
  for (const row of plan.entries) {
    const segments = row.path.split("/");
    const target = path.join(destRoot, ...segments);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, ...segments), target);
  }
}

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function commandSnapshot(args) {
  const source = requireDir(args.source, "--source");
  if (!args.dest) usage("--dest is required");
  const destRoot = path.resolve(args.dest);
  const label = (args.label || "memory").replace(/[^A-Za-z0-9._-]/g, "-");
  const backupDir = path.join(destRoot, `${label}-${utcStamp()}`);
  if (fs.existsSync(backupDir)) fail(`backup directory already exists: ${backupDir}`);

  const plan = hashTree(source);
  // 先写 .partial 再整体改名：中途崩溃不会留下一个看起来完整的备份。
  const partial = `${backupDir}.partial`;
  fs.rmSync(partial, { recursive: true, force: true });
  copyTree(source, path.join(partial, DATA_DIR), plan);
  const manifest = {
    tool_version: TOOL_VERSION,
    algorithm: "sha256",
    created_at: new Date().toISOString(),
    source_basename: path.basename(source),
    file_count: plan.entries.length,
    total_bytes: plan.entries.reduce((sum, row) => sum + row.bytes, 0),
    dirs: plan.dirs,
    skipped: plan.skipped,
    files: plan.entries,
  };
  fs.writeFileSync(path.join(partial, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(partial, backupDir);

  console.log(JSON.stringify({
    ok: true,
    command: "snapshot",
    backup: backupDir,
    file_count: manifest.file_count,
    total_bytes: manifest.total_bytes,
    skipped: manifest.skipped.length,
  }));
  return EXIT_OK;
}

function commandVerify(args) {
  const backupDir = requireDir(args.backup, "--backup");
  const manifest = readManifest(backupDir);
  const target = args.against ? requireDir(args.against, "--against") : requireDir(path.join(backupDir, DATA_DIR), "backup data/");
  const result = compareAgainstManifest(manifest, target);
  const ok = result.missing.length === 0 && result.extra.length === 0 && result.mismatched.length === 0;
  console.log(JSON.stringify({
    ok,
    command: "verify",
    backup: backupDir,
    against: target,
    checked: result.checked,
    missing: result.missing,
    extra: result.extra,
    mismatched: result.mismatched,
  }, null, 2));
  return ok ? EXIT_OK : EXIT_FAILED;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function commandRestore(args) {
  const backupDir = requireDir(args.backup, "--backup");
  const manifest = readManifest(backupDir);
  const dataDir = requireDir(path.join(backupDir, DATA_DIR), "backup data/");
  if (!args.target) usage("--target is required");
  const target = path.resolve(args.target);

  // D8：根必须显式给出并校验，不许向上摸。
  const rootArg = args.root || process.env.CYBERLINK_ROOT;
  if (!rootArg) usage("--root (or CYBERLINK_ROOT) is required for restore");
  const root = requireDir(rootArg, "--root");

  const liveMemory = path.join(root, "memory");
  const touchesLive = isInside(liveMemory, target) || isInside(target, liveMemory);
  if (touchesLive && !args.flags.has("allow-live-memory")) {
    fail(`refusing to restore onto live memory without --allow-live-memory: ${target}`);
  }

  let targetExists = false;
  try { targetExists = fs.statSync(target).isDirectory(); } catch { targetExists = false; }
  const targetNotEmpty = targetExists && fs.readdirSync(target).length > 0;
  if (targetNotEmpty && !args.flags.has("overwrite")) {
    fail(`target is not empty; pass --overwrite to replace its contents: ${target}`);
  }

  if (!args.flags.has("confirm")) {
    console.log(JSON.stringify({
      ok: true,
      command: "restore",
      dry_run: true,
      changed: false,
      backup: backupDir,
      target,
      would_restore_files: manifest.file_count,
      would_replace_existing: targetNotEmpty,
      touches_live_memory: touchesLive,
      note: "no bytes written; re-run with --confirm",
    }, null, 2));
    return EXIT_OK;
  }

  // 先核对备份本身没坏，再往目标写——不拿一个已损坏的备份去覆盖任何东西。
  const selfCheck = compareAgainstManifest(manifest, dataDir);
  if (selfCheck.missing.length || selfCheck.extra.length || selfCheck.mismatched.length) {
    fail(`backup failed self-verification; refusing to restore: ${JSON.stringify(selfCheck)}`);
  }

  if (targetNotEmpty) for (const entry of fs.readdirSync(target)) fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  const plan = hashTree(dataDir);
  copyTree(dataDir, target, plan);

  const after = compareAgainstManifest(manifest, target);
  const ok = after.missing.length === 0 && after.extra.length === 0 && after.mismatched.length === 0;
  console.log(JSON.stringify({
    ok,
    command: "restore",
    dry_run: false,
    changed: true,
    backup: backupDir,
    target,
    restored_files: manifest.file_count,
    post_restore_check: after,
  }, null, 2));
  return ok ? EXIT_OK : EXIT_FAILED;
}

function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "snapshot") return commandSnapshot(args);
  if (command === "verify") return commandVerify(args);
  if (command === "restore") return commandRestore(args);
  usage(`unknown command: ${command || "(none)"}`);
  return EXIT_USAGE;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, hashTree, compareAgainstManifest, toPosixRelative };
