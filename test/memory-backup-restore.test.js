const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "memory-backup.js");

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

// 坑 11：不许裸写 notEqual(status, 0)——ENOENT 下恒真。先证明进程真的跑过。
function assertFailedClosed(result, message) {
  assert.equal(result.error, undefined, `process never ran: ${result.error}`);
  assert.notEqual(result.status, null, "process never ran: spawnSync returned status null");
  assert.notEqual(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
}

function assertRan(result, message) {
  assert.equal(result.error, undefined, `process never ran: ${result.error}`);
  assert.equal(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
  return JSON.parse(result.stdout);
}

function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-g5-"));
  const memory = path.join(root, "memory");
  fs.mkdirSync(path.join(memory, "candidates"), { recursive: true });
  fs.mkdirSync(path.join(memory, "trace", "nested"), { recursive: true });
  fs.mkdirSync(path.join(memory, "empty-on-purpose"), { recursive: true });
  fs.writeFileSync(path.join(memory, "episodes.jsonl"), '{"id":"e1"}\n{"id":"e2"}\n', "utf8");
  fs.writeFileSync(path.join(memory, "reentry.md"), "今天的锚点\n", "utf8");
  fs.writeFileSync(path.join(memory, "candidates", "pending.jsonl"), '{"id":"c1"}\n', "utf8");
  fs.writeFileSync(path.join(memory, "trace", "nested", "deep.json"), '{"deep":true}\n', "utf8");
  return { root, memory, dest: path.join(root, "backups") };
}

function listTree(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) { out.push(`${rel}/`); stack.push(full); } else out.push(rel);
    }
  }
  return out.sort();
}

test("B1 snapshot writes a hashed manifest, leaves no .partial, and records empty dirs", () => {
  const { memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  assert.equal(snap.ok, true);
  assert.equal(snap.file_count, 4);

  const manifest = JSON.parse(fs.readFileSync(path.join(snap.backup, "manifest.json"), "utf8"));
  assert.equal(manifest.algorithm, "sha256");
  assert.equal(manifest.files.length, 4);
  for (const row of manifest.files) assert.match(row.sha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.dirs.includes("empty-on-purpose"), "empty dir must be recorded so restore can recreate it");
  assert.ok(fs.existsSync(path.join(snap.backup, "data", "trace", "nested", "deep.json")));
  assert.equal(fs.existsSync(`${snap.backup}.partial`), false, "atomic rename must leave no .partial behind");
});

test("B2 manifest stores only POSIX relative paths (no absolute path can leak in)", () => {
  const { memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const manifest = JSON.parse(fs.readFileSync(path.join(snap.backup, "manifest.json"), "utf8"));
  // 协议坑 21：两端各自解析同一路径是路径语义 bug 的温床；manifest 只存词法相对路径就不给它机会。
  for (const row of manifest.files) {
    assert.equal(path.isAbsolute(row.path), false, `manifest path must be relative: ${row.path}`);
    assert.doesNotMatch(row.path, /^[A-Za-z]:|\\/, `manifest path must be POSIX-style: ${row.path}`);
  }
});

test("B3 verify passes on a fresh snapshot and fails closed on a tampered byte", () => {
  const { memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const fresh = assertRan(run(["verify", "--backup", snap.backup]), "fresh snapshot must verify");
  assert.equal(fresh.ok, true);
  assert.equal(fresh.checked, 4);

  const victim = path.join(snap.backup, "data", "episodes.jsonl");
  fs.writeFileSync(victim, `${fs.readFileSync(victim, "utf8")}tampered\n`, "utf8");
  const tampered = run(["verify", "--backup", snap.backup]);
  assertFailedClosed(tampered, "tampered backup must fail verification");
  const report = JSON.parse(tampered.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.mismatched.length, 1);
  assert.equal(report.mismatched[0].path, "episodes.jsonl");
});

test("B4 verify reports missing and extra files, not just content drift", () => {
  const { memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  fs.rmSync(path.join(snap.backup, "data", "reentry.md"));
  fs.writeFileSync(path.join(snap.backup, "data", "stowaway.md"), "not in the manifest\n", "utf8");
  const result = run(["verify", "--backup", snap.backup]);
  assertFailedClosed(result, "missing + extra files must fail verification");
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.missing, ["reentry.md"]);
  assert.deepEqual(report.extra, ["stowaway.md"]);
});

test("B5 restore without --confirm is a dry run that writes nothing", () => {
  const { root, memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const target = path.join(root, "restore-target");
  const preview = assertRan(run(["restore", "--backup", snap.backup, "--target", target, "--root", root]), "dry run must succeed");
  assert.equal(preview.dry_run, true);
  assert.equal(preview.changed, false);
  assert.equal(preview.would_restore_files, 4);
  assert.equal(fs.existsSync(target), false, "dry run must not create the target");
});

test("B6 drill: real snapshot -> damage the copy -> restore -> byte-for-byte match", () => {
  const { root, memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const copy = path.join(root, "memory-copy");

  // 演练第一步：把备份恢复成一个隔离副本（真档不动）。
  const first = assertRan(run(["restore", "--backup", snap.backup, "--target", copy, "--root", root, "--confirm"]), "restore into empty target must succeed");
  assert.equal(first.ok, true);
  assert.equal(first.restored_files, 4);
  assert.ok(listTree(copy).includes("empty-on-purpose/"), "empty dir must survive the round trip");

  // 第二步：破坏副本——删一个、改一个、塞一个野文件。
  fs.rmSync(path.join(copy, "reentry.md"));
  fs.writeFileSync(path.join(copy, "episodes.jsonl"), "corrupted\n", "utf8");
  fs.writeFileSync(path.join(copy, "junk.tmp"), "junk\n", "utf8");
  const damaged = run(["verify", "--backup", snap.backup, "--against", copy]);
  assertFailedClosed(damaged, "damaged copy must fail verification — otherwise the drill proves nothing");

  // 第三步：从备份恢复，第四步：核对。
  const second = assertRan(run(["restore", "--backup", snap.backup, "--target", copy, "--root", root, "--confirm", "--overwrite"]), "restore over damaged copy must succeed");
  assert.equal(second.ok, true);
  const recheck = assertRan(run(["verify", "--backup", snap.backup, "--against", copy]), "restored copy must verify");
  assert.equal(recheck.ok, true);
  assert.equal(fs.existsSync(path.join(copy, "junk.tmp")), false, "restore must not leave foreign files behind");
  assert.equal(fs.readFileSync(path.join(copy, "episodes.jsonl"), "utf8"), fs.readFileSync(path.join(memory, "episodes.jsonl"), "utf8"));
});

test("B7 restore fails closed on a non-empty target without --overwrite", () => {
  const { root, memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const target = path.join(root, "occupied");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "someone-elses.md"), "do not clobber me\n", "utf8");
  assertFailedClosed(
    run(["restore", "--backup", snap.backup, "--target", target, "--root", root, "--confirm"]),
    "non-empty target must fail closed without --overwrite",
  );
  assert.equal(fs.readFileSync(path.join(target, "someone-elses.md"), "utf8"), "do not clobber me\n");
});

test("B8 restore onto live memory fails closed without --allow-live-memory", () => {
  const { root, memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const before = fs.readFileSync(path.join(memory, "episodes.jsonl"), "utf8");
  assertFailedClosed(
    run(["restore", "--backup", snap.backup, "--target", memory, "--root", root, "--confirm", "--overwrite"]),
    "live memory target must fail closed without --allow-live-memory",
  );
  assertFailedClosed(
    run(["restore", "--backup", snap.backup, "--target", path.join(memory, "candidates"), "--root", root, "--confirm", "--overwrite"]),
    "a path inside live memory must fail closed too",
  );
  assert.equal(fs.readFileSync(path.join(memory, "episodes.jsonl"), "utf8"), before, "live memory must be untouched");
});

test("B9 restore requires an explicit validated root (D8: no upward root sniffing)", () => {
  const { root, memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const target = path.join(root, "target-no-root");
  const noRoot = run(["restore", "--backup", snap.backup, "--target", target, "--confirm"], { CYBERLINK_ROOT: "" });
  assertFailedClosed(noRoot, "restore without --root must fail closed");
  assert.match(noRoot.stderr, /--root/);
  assertFailedClosed(
    run(["restore", "--backup", snap.backup, "--target", target, "--root", path.join(root, "does-not-exist"), "--confirm"]),
    "a non-existent root must fail closed rather than be created",
  );
  assert.equal(fs.existsSync(target), false);
});

test("B10 restore refuses to overwrite anything with a corrupted backup", () => {
  const { root, memory, dest } = makeFixtureRoot();
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const target = path.join(root, "target-corrupt-backup");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "keep.md"), "still here\n", "utf8");
  const victim = path.join(snap.backup, "data", "episodes.jsonl");
  fs.writeFileSync(victim, "silently corrupted\n", "utf8");
  assertFailedClosed(
    run(["restore", "--backup", snap.backup, "--target", target, "--root", root, "--confirm", "--overwrite"]),
    "a backup that fails self-verification must never be restored",
  );
  assert.equal(fs.readFileSync(path.join(target, "keep.md"), "utf8"), "still here\n", "target must be untouched when the backup is bad");
});

test("B11 snapshot does not follow symlinks; it records them as skipped", () => {
  const { memory, dest } = makeFixtureRoot();
  let linked = true;
  try {
    fs.symlinkSync(path.join(memory, "episodes.jsonl"), path.join(memory, "episodes.link.jsonl"));
  } catch {
    linked = false; // 无权限建符号链接的机器上跳过这条，但不伪装成通过。
  }
  const snap = assertRan(run(["snapshot", "--source", memory, "--dest", dest]), "snapshot must succeed");
  const manifest = JSON.parse(fs.readFileSync(path.join(snap.backup, "manifest.json"), "utf8"));
  if (!linked) {
    assert.equal(manifest.file_count, 4, "no symlink was created on this host; plain tree must still be complete");
    return;
  }
  assert.equal(manifest.file_count, 4, "symlink must not be copied as a regular file");
  assert.deepEqual(manifest.skipped.map((row) => row.path), ["episodes.link.jsonl"]);
  assert.equal(manifest.skipped[0].reason, "symlink_not_followed");
});
