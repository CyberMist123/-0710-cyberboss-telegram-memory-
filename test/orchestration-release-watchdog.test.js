const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  loadReleaseDescriptor,
  rollbackReleaseDescriptor,
  validateReleaseDescriptor,
} = require("../src/orchestration/release-descriptor");

function descriptor(root) {
  const activeState = path.join(root, "active-state");
  const oldState = path.join(root, "old-state");
  return {
    active_release_id: "phase1",
    telegram_entry: path.join(root, "phase1", "bin", "cyberboss.js"),
    config_dir: path.join(root, "active-config"),
    state_dir: activeState,
    log_dir: path.join(root, "active-logs"),
    pid_file: path.join(activeState, "cyberboss.pid"),
    watchdog_target: path.join(root, "phase1", "start-safe.ps1"),
    workspace_dir: path.join(root, "workspace"),
    rollback_release: {
      release_id: "legacy",
      telegram_entry: path.join(root, "legacy", "bin", "cyberboss.js"),
      config_dir: path.join(root, "old-config"),
      state_dir: oldState,
      log_dir: path.join(root, "old-logs"),
      pid_file: path.join(oldState, "cyberboss.pid"),
      watchdog_target: path.join(root, "legacy", "start-safe.ps1"),
      workspace_dir: path.join(root, "workspace"),
      last_verified_sha: "1".repeat(40),
    },
    last_verified_sha: "2".repeat(40),
  };
}

function materializeTarget(value) {
  for (const directory of [value.config_dir, value.state_dir, value.log_dir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(path.dirname(value.telegram_entry), { recursive: true });
  fs.writeFileSync(value.telegram_entry, "// entry\n", "utf8");
  fs.writeFileSync(value.watchdog_target, "# watchdog\n", "utf8");
  fs.writeFileSync(value.pid_file, "0\n", "utf8");
}

function materializeDescriptor(value) {
  materializeTarget(value);
  materializeTarget(value.rollback_release);
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-release-"));
}

test("complete active and rollback descriptors pass strict existing-path validation", () => {
  const value = descriptor(tempRoot());
  materializeDescriptor(value);
  assert.equal(validateReleaseDescriptor(value, { requireExistingPaths: true }).ok, true);
});

test("strict validation allows a missing active PID file when its parent exists", () => {
  const value = descriptor(tempRoot());
  materializeDescriptor(value);
  fs.unlinkSync(value.pid_file);
  assert.equal(validateReleaseDescriptor(value, { requireExistingPaths: true }).ok, true);
});

test("rollback preflight allows an inactive release PID file to be absent", () => {
  const root = tempRoot();
  const file = path.join(root, "current.json");
  const value = descriptor(root);
  materializeDescriptor(value);
  fs.unlinkSync(value.rollback_release.pid_file);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  const next = rollbackReleaseDescriptor(file);
  assert.equal(next.active_release_id, "legacy");
  assert.equal(loadReleaseDescriptor(file, { requireExistingPaths: true }).active_release_id, "legacy");
});

test("strict validation rejects a PID path whose parent directory is missing", () => {
  const value = descriptor(tempRoot());
  materializeDescriptor(value);
  fs.unlinkSync(value.pid_file);
  value.pid_file = path.join(value.state_dir, "missing-parent", "cyberboss.pid");
  const result = validateReleaseDescriptor(value, { requireExistingPaths: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /active\.pid_file: parent directory does not exist/);
});

test("strict validation rejects an existing PID path that is a directory", () => {
  const value = descriptor(tempRoot());
  materializeDescriptor(value);
  fs.unlinkSync(value.pid_file);
  fs.mkdirSync(value.pid_file);
  const result = validateReleaseDescriptor(value, { requireExistingPaths: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /active\.pid_file: must be a regular file when present/);
});

test("strict validation rejects a PID path inside the other release directory", () => {
  const value = descriptor(tempRoot());
  materializeDescriptor(value);
  value.pid_file = path.join(path.dirname(path.dirname(value.rollback_release.telegram_entry)), "active.pid");
  const result = validateReleaseDescriptor(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /active\.pid_file: must be outside rollback\.release_path/);
});

test("release descriptor rejects a PID file outside its release state directory", () => {
  const value = descriptor(tempRoot());
  value.pid_file = path.join(os.tmpdir(), "somewhere-else", "cyberboss.pid");
  const result = validateReleaseDescriptor(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /active\.pid_file: must belong/);
});

test("strict validation reports active missing entry without exposing values", () => {
  const value = descriptor(tempRoot());
  materializeDescriptor(value);
  fs.unlinkSync(value.telegram_entry);
  value.telegram_bot_token = "never-print-this";
  const result = validateReleaseDescriptor(value, { requireExistingPaths: true });
  const errors = result.errors.join("\n");
  assert.equal(result.ok, false);
  assert.match(errors, /active\.telegram_entry: does not exist/);
  assert.match(errors, /sensitive value/);
  assert.doesNotMatch(errors, /never-print-this/);
});

test("strict validation rejects rollback missing entry or watchdog target", () => {
  for (const field of ["telegram_entry", "watchdog_target"]) {
    const value = descriptor(tempRoot());
    materializeDescriptor(value);
    fs.unlinkSync(value.rollback_release[field]);
    const result = validateReleaseDescriptor(value, { requireExistingPaths: true });
    assert.equal(result.ok, false, field);
    assert.match(result.errors.join("\n"), new RegExp(`rollback\\.${field}: does not exist`));
  }
});

test("strict validation rejects rollback missing state or log directory", () => {
  for (const field of ["state_dir", "log_dir"]) {
    const value = descriptor(tempRoot());
    materializeDescriptor(value);
    fs.rmSync(value.rollback_release[field], { recursive: true, force: true });
    const result = validateReleaseDescriptor(value, { requireExistingPaths: true });
    assert.equal(result.ok, false, field);
    assert.match(result.errors.join("\n"), new RegExp(`rollback\\.${field}: does not exist`));
  }
});

test("descriptor rejects a UTF-8 BOM with a clear error", () => {
  const root = tempRoot();
  const value = descriptor(root);
  materializeDescriptor(value);
  const file = path.join(root, "current.json");
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(value))]));
  assert.throws(() => loadReleaseDescriptor(file), /UTF-8 without BOM/);
});

test("descriptor rejects SHA and release identity mismatches", () => {
  const invalidSha = descriptor(tempRoot());
  invalidSha.rollback_release.last_verified_sha = "not-a-sha";
  assert.match(validateReleaseDescriptor(invalidSha).errors.join("\n"), /rollback\.last_verified_sha/);

  const duplicateIdentity = descriptor(tempRoot());
  duplicateIdentity.rollback_release.release_id = duplicateIdentity.active_release_id;
  assert.match(validateReleaseDescriptor(duplicateIdentity).errors.join("\n"), /release_id.*distinct/);
});

test("descriptor rejects state, log, and PID paths inside a release directory", () => {
  for (const field of ["state_dir", "log_dir", "pid_file"]) {
    const value = descriptor(tempRoot());
    value[field] = path.join(path.dirname(path.dirname(value.telegram_entry)), field);
    if (field === "pid_file") value.pid_file = path.join(path.dirname(path.dirname(value.telegram_entry)), "pid-state", "cyberboss.pid");
    const result = validateReleaseDescriptor(value);
    assert.equal(result.ok, false, field);
    assert.match(result.errors.join("\n"), new RegExp(`active\\.${field}: must be outside`));
  }
});

test("rollback atomically promotes a fully preflighted rollback release", () => {
  const root = tempRoot();
  const file = path.join(root, "current.json");
  const value = descriptor(root);
  materializeDescriptor(value);
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
  const next = rollbackReleaseDescriptor(file);
  assert.equal(next.active_release_id, "legacy");
  assert.equal(next.rollback_release.release_id, "phase1");
  assert.equal(loadReleaseDescriptor(file, { requireExistingPaths: true }).active_release_id, "legacy");
});

test("rollback activation preflight refuses to replace the current descriptor when a target is missing", () => {
  const root = tempRoot();
  const file = path.join(root, "current.json");
  const value = descriptor(root);
  materializeDescriptor(value);
  fs.unlinkSync(value.rollback_release.watchdog_target);
  const original = JSON.stringify(value);
  fs.writeFileSync(file, original, "utf8");
  assert.throws(() => rollbackReleaseDescriptor(file), /rollback\.watchdog_target: does not exist/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

function manifestForWriter(root, descriptorPath) {
  const value = descriptor(root);
  materializeDescriptor(value);
  fs.mkdirSync(path.join(root, "watchdog-owner"), { recursive: true });
  return {
    telegram: {
      descriptor_path: descriptorPath,
      release_id: value.active_release_id,
      entry: value.telegram_entry,
      config_dir: value.config_dir,
      state_dir: value.state_dir,
      log_dir: value.log_dir,
      pid_file: value.pid_file,
      watchdog_target: value.watchdog_target,
    },
    dashboard: { app_root: path.dirname(path.dirname(value.telegram_entry)) },
    watchdog: { owner_dir: path.join(root, "watchdog-owner") },
    workspace_root: value.workspace_dir,
    formal_repo: { commit: value.last_verified_sha },
    rollback: value.rollback_release,
  };
}

// R4 F1: on non-Windows machines spawnSync("powershell.exe") returns
// { status: null, error: ENOENT } without throwing, so `notEqual(status, 0)`
// is vacuously true. Fail-closed assertions must first prove the process ran.
// Only the two PowerShell-spawning tests are guarded; the Python-based tests
// below are platform-neutral and must keep running everywhere (R4 F1.3b).
const IS_WINDOWS = process.platform === "win32";
function assertFailedClosed(result, message) {
  assert.equal(result.error, undefined, `process never ran: ${result.error}`);
  assert.notEqual(result.status, null, "process never ran: spawnSync returned status null");
  assert.notEqual(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
}

function runWriter(manifest) {
  const script = path.join(__dirname, "..", "scripts", "windows", "cyberlink-manifest.ps1");
  const command = `. '${script.replace(/'/g, "''")}'; $manifest = $env:CYBERBOSS_TEST_MANIFEST | ConvertFrom-Json; Write-TelegramDescriptor -Manifest $manifest`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    env: { ...process.env, CYBERBOSS_TEST_MANIFEST: JSON.stringify(manifest) },
  });
}

test("legacy manifest writer is retired so it cannot overwrite the formal descriptor", { skip: !IS_WINDOWS }, () => {
  const root = tempRoot();
  const descriptorPath = path.join(root, "external", "current.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, '{"old":true}\n', "utf8");
  const result = runWriter(manifestForWriter(root, descriptorPath));
  assertFailedClosed(result, "legacy manifest writer did not fail closed");
  assert.match(result.stderr, /Write-TelegramDescriptor is retired/);
  assert.equal(fs.readFileSync(descriptorPath, "utf8"), '{"old":true}\n');
});

test("legacy manifest writer fails closed before it can alter a descriptor", { skip: !IS_WINDOWS }, () => {
  const root = tempRoot();
  const descriptorPath = path.join(root, "external", "current.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  const old = '{"old":true}\n';
  fs.writeFileSync(descriptorPath, old, "utf8");
  const manifest = manifestForWriter(root, descriptorPath);
  manifest.rollback.telegram_entry = path.join(root, "legacy", "bin", "missing-cyberboss.js");
  const result = runWriter(manifest);
  assertFailedClosed(result, "legacy manifest writer did not fail closed");
  assert.match(result.stderr, /Write-TelegramDescriptor is retired/);
  assert.equal(fs.readFileSync(descriptorPath, "utf8"), old);
  assert.equal(fs.readdirSync(path.dirname(descriptorPath)).filter((name) => /\.(tmp|bak)$/.test(name)).length, 0);
});

test("watchdog is release-only and can parse its CLI", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py"), "utf8");
  assert.doesNotMatch(source, /getUpdates|dashboard-hidden|wechat-hidden|TARGETS\s*=/i);
  assert.match(source, /deployment.*current\.json|DEFAULT_DESCRIPTOR/s);
  const python = process.env.PYTHON || "python";
  const result = spawnSync(python, [path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py"), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("watchdog descriptor reader rejects BOM, malformed JSON, and missing fields", () => {
  const root = tempRoot();
  const watchdog = path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py");
  const probe = `import importlib.util,sys
s=importlib.util.spec_from_file_location('w',sys.argv[1])
m=importlib.util.module_from_spec(s)
s.loader.exec_module(m)
try:
 m.load_descriptor(__import__('pathlib').Path(sys.argv[2]))
except Exception as e:
 print(type(e).__name__+':'+str(e))
else:
 raise SystemExit('unexpected success')`;
  for (const [name, content, expected] of [["bom", Buffer.from([0xef,0xbb,0xbf,0x7b,0x7d]), /without BOM/], ["json", "{ nope", /valid UTF-8 JSON/], ["fields", "{}", /missing/]]) {
    const file = path.join(root, `${name}.json`); fs.writeFileSync(file, content);
    const result = spawnSync(process.env.PYTHON || "python", ["-c", probe, watchdog, file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, expected);
  }
});

test("watchdog owner check uses descriptor-scoped process identity and retries without stack spam", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py"), "utf8");
  assert.match(source, /watchdog_rows\(\)/);
  assert.match(source, /descriptor_path/);
  assert.match(source, /will retry/);
  assert.doesNotMatch(source, /log\(f"check failed: \{error\}"/);
});

test("dashboard is isolated from TG watchdog and automatic memory writes remain disabled", () => {
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "extensions", "relationship-memory", "memory-kit", "dashboard.py"), "utf8");
  assert.match(dashboard, /AUTO_JANITOR_HOURS\s*=\s*0/);
  const watchdog = fs.readFileSync(path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py"), "utf8");
  assert.doesNotMatch(watchdog, /dashboard/i);
});

function pythonWatchdog(code, args = []) {
  const watchdog = path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py");
  return spawnSync(process.env.PYTHON || "python", ["-c", code, watchdog, ...args], { encoding: "utf8" });
}

test("watchdog keeps one loop alive across initial BOM, JSON, and schema failures without launching", () => {
  const probe = `import importlib.util,json,sys,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('w',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=Path(tempfile.mkdtemp()); d=root/'current.json'; logs=[]; launches=[]
for raw in [b'\\xef\\xbb\\xbf{}', b'{ invalid', b'{}']:
 d.write_bytes(raw); logs.clear(); launches.clear()
 m.run_watchdog(d, 0, iterations=2, sleep=lambda _:None, launcher=lambda *a:launches.append(1), health=lambda _: (True,'ok'), owner_verifier=lambda *a:None, log_sink=lambda message,_:logs.append(message))
 assert not launches and len(logs)==1 and 'will retry' in logs[0], (raw, logs, launches)
print('ok')`;
  const result = pythonWatchdog(probe);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
});

test("watchdog recovers in the same finite loop after atomic descriptor replacement and logs state transitions", () => {
  const probe = `import importlib.util,json,sys,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('w',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=Path(tempfile.mkdtemp()); state=root/'state'; state.mkdir(); d=root/'current.json'; d.write_text('{ bad',encoding='utf8'); logs=[]; healthy=[]
value={'active_release_id':'a','telegram_entry':str(root/'entry'),'config_dir':str(root/'config'),'state_dir':str(state),'log_dir':str(root/'logs'),'pid_file':str(state/'a.pid'),'watchdog_target':str(root/'start.ps1'),'rollback_release':{},'last_verified_sha':'x'}
def sleep(_):
 if len(logs)==1:
  temp=root/'current.tmp'; temp.write_text(json.dumps(value),encoding='utf8'); temp.replace(d)
def health(_): healthy.append(1); return True,'ok'
m.run_watchdog(d,0,iterations=3,sleep=sleep,launcher=lambda *a:(_ for _ in ()).throw(AssertionError('launcher')),health=health,owner_verifier=lambda *a:None,log_sink=lambda message,_:logs.append(message))
assert len(healthy)==2 and sum('will retry' in x for x in logs)==1 and any('recovered' in x for x in logs), logs
print('ok')`;
  const result = pythonWatchdog(probe);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
});

test("watchdog --once reports its single cycle's outcome through the exit code", () => {
  const watchdog = path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-watchdog-once-"));
  const bad = path.join(root, "current.json");
  fs.writeFileSync(bad, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));
  const failing = spawnSync(process.env.PYTHON || "python", [watchdog, "--once", "--descriptor", bad], { encoding: "utf8" });
  assert.equal(failing.status, 1, `--once accepted a BOM descriptor: ${failing.stderr}\n${failing.stdout}`);
  const probe = `import importlib.util,json,sys,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('w',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=Path(tempfile.mkdtemp()); state=root/'state'; state.mkdir(); d=root/'current.json'
value={'active_release_id':'a','telegram_entry':str(root/'entry'),'config_dir':str(root/'config'),'state_dir':str(state),'log_dir':str(root/'logs'),'pid_file':str(state/'a.pid'),'watchdog_target':str(root/'start.ps1'),'rollback_release':{},'last_verified_sha':'x'}
d.write_text(json.dumps(value),encoding='utf8')
err=m.run_watchdog(d,0,iterations=1,sleep=lambda _:None,launcher=lambda *a:None,health=lambda _:(True,'ok'),owner_verifier=lambda *a:None,log_sink=lambda *a:None)
assert err is None, err
d.write_bytes(b'\\xef\\xbb\\xbf{}')
err=m.run_watchdog(d,0,iterations=1,sleep=lambda _:None,launcher=lambda *a:None,health=lambda _:(True,'ok'),owner_verifier=lambda *a:None,log_sink=lambda *a:None)
assert err is not None, 'failed cycle must surface its error marker'
print('ok')`;
  const result = pythonWatchdog(probe);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
});

test("watchdog owner identity parses quoted Windows argv and accepts only exact current or allowlisted pairs", () => {
  const probe = `import importlib.util,sys,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('w',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=Path(tempfile.mkdtemp()); script=root/'space dir'/'watchdog.py'; descriptor=root/'descriptor dir'/'current.json'; other=root/'other cyberboss'/'watchdog.py'; legacy=root/'legacy'/'watchdog.py'; legacyd=root/'legacy'/'current.json'
row=lambda command:{'ExecutablePath':r'C:\\\\Python\\\\python.exe','CommandLine':command}
cmd='"C:\\\\Python\\\\python.exe" "'+str(script)+'" --descriptor "'+str(descriptor)+'"'
assert m.watchdog_identity(row(cmd),descriptor,script)
assert m.watchdog_identity(row('"C:\\\\Python\\\\python.exe" "'+str(script)+'" --descriptor="'+str(descriptor)+'"'),descriptor,script)
assert not m.watchdog_identity(row(cmd),descriptor,other)
assert not m.watchdog_identity(row('"C:\\\\Python\\\\python.exe" "'+str(other)+'" --descriptor "'+str(descriptor)+'"'),descriptor,script)
assert not m.watchdog_identity(row('"C:\\\\Python\\\\python.exe" "'+str(legacy)+'" --descriptor "'+str(legacyd)+'"'),descriptor,script)
assert m.watchdog_identity(row('"C:\\\\Python\\\\python.exe" "'+str(legacy)+'" --descriptor "'+str(legacyd)+'"'),legacyd,legacy)
# A stale/reused PID is overwritten; only an exact current or supplied legacy
# pair blocks ownership, including two independently discovered exact owners.
m.WATCHDOG_SCRIPT=script; pid=root/'owner'/'watchdog.pid'; m.read_pid=lambda _:77; m.process_row=lambda _:row('"C:\\\\Python\\\\python.exe" "'+str(other)+'" --descriptor "'+str(descriptor)+'"'); m.watchdog_rows=lambda:[]
m.verify_watchdog_owner(pid,descriptor); assert pid.read_text() == str(m.os.getpid())
m.watchdog_rows=lambda:[dict(row(cmd),ProcessId=101),dict(row(cmd),ProcessId=102)]
try: m.verify_watchdog_owner(pid,descriptor)
except RuntimeError: pass
else: raise AssertionError('exact duplicate owner was not blocked')
m.watchdog_rows=lambda:[dict(row('"C:\\\\Python\\\\python.exe" "'+str(legacy)+'" --descriptor "'+str(legacyd)+'"'),ProcessId=103)]
try: m.verify_watchdog_owner(pid,descriptor,[(legacy,legacyd)])
except RuntimeError: pass
else: raise AssertionError('exact legacy owner was not blocked')
print('ok')`;
  const result = pythonWatchdog(probe);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok/);
  const source = fs.readFileSync(path.join(__dirname, "..", "extensions", "relationship-memory", "launcher", "watchdog.py"), "utf8");
  assert.match(source, /Path\(__file__\)\.resolve\(\)/);
  assert.match(source, /CommandLineToArgvW/);
  assert.doesNotMatch(source, /cyberboss.*in token|watchdog\\\\\.py.*-match/);
});
