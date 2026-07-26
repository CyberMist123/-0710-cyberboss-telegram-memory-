const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { installDescriptor, installStartupArtifact, manifestCovers, sha256, sha256Bytes } = require("../scripts/orchestration/release-control-plane");
const { EXCLUDED_RELATIONSHIP_MEMORY_FILES, SCHEMA_VERSION } = require("../src/orchestration/release-manifest");

// realpathSync.native expands Windows 8.3 short paths (the GitHub runner's
// TEMP directory is spelled in short form): the installers reject any spelling
// that is not the canonical long form, which is what production passes.
function root() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-control-plane-"))); }
function target(root, name) { const release=path.join(root,name); const bin=path.join(release,"bin"); fs.mkdirSync(bin,{recursive:true}); const entry=path.join(bin,"cyberboss.js"); const watch=path.join(release,"start-safe.ps1"); fs.writeFileSync(entry,"//x"); fs.writeFileSync(watch,"#x"); for(const dir of ["config","state","logs"]) fs.mkdirSync(path.join(root,`${name}-${dir}`),{recursive:true}); return { telegram_entry:entry,config_dir:path.join(root,`${name}-config`),state_dir:path.join(root,`${name}-state`),log_dir:path.join(root,`${name}-logs`),pid_file:path.join(root,`${name}-state`,`x.pid`),watchdog_target:watch }; }
function descriptor(root) { const a=target(root,"active"), b=target(root,"rollback"); return {active_release_id:"active",...a,last_verified_sha:"a".repeat(40),rollback_release:{release_id:"rollback",...b,last_verified_sha:"b".repeat(40)}}; }
function setup() { const r=root(), candidate=path.join(r,"candidate.json"), manifest=path.join(r,"manifest.json"), audit=path.join(r,"audit"), targetFile=path.join(r,"deployment","current.json"); fs.writeFileSync(candidate,JSON.stringify(descriptor(r))); fs.writeFileSync(manifest,"{}"); return {r,candidate,manifest,audit,targetFile}; }
function install(x, extra={}) { return installDescriptor({candidatePath:x.candidate,expectedCandidateSha256:sha256(x.candidate),manifestPath:x.manifest,expectedManifestSha256:sha256(x.manifest),auditDirectory:x.audit,targetPath:x.targetFile,verify:()=>({ok:true,errors:[]}),...extra}); }
test("candidate install creates missing formal descriptor as exact UTF-8 bytes",()=>{const x=setup(); install(x); assert.deepEqual(fs.readFileSync(x.targetFile),fs.readFileSync(x.candidate)); assert.equal(fs.readdirSync(x.audit).length,1);});
test("candidate replacement retains an immutable backup and audit",()=>{const x=setup(); fs.mkdirSync(path.dirname(x.targetFile),{recursive:true}); fs.writeFileSync(x.targetFile,"old"); const audit=install(x); assert.ok(audit.backup_path && fs.existsSync(audit.backup_path)); assert.equal(fs.readFileSync(audit.backup_path,"utf8"),"old");});
test("hash mismatch, BOM, and validation failure do not damage old descriptor",()=>{const x=setup(); fs.mkdirSync(path.dirname(x.targetFile),{recursive:true}); fs.writeFileSync(x.targetFile,"old"); assert.throws(()=>install(x,{expectedCandidateSha256:"0".repeat(64)})); fs.writeFileSync(x.candidate,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),fs.readFileSync(x.candidate)])); assert.throws(()=>install(x)); assert.equal(fs.readFileSync(x.targetFile,"utf8"),"old");});
test("manifest failure and descriptor schema/path failures retain the old descriptor",()=>{const x=setup(); fs.mkdirSync(path.dirname(x.targetFile),{recursive:true}); fs.writeFileSync(x.targetFile,"old"); assert.throws(()=>install(x,{verify:()=>({ok:false,errors:["tampered"]})}),/manifest verification failed/); const bad=JSON.parse(fs.readFileSync(x.candidate)); bad.telegram_entry=path.join(x.r,"missing","cyberboss.js"); fs.writeFileSync(x.candidate,JSON.stringify(bad)); assert.throws(()=>install(x),/Invalid release descriptor/); assert.equal(fs.readFileSync(x.targetFile,"utf8"),"old");});
test("startup artifacts require manifest coverage and copy hash exactly",()=>{const r=root(), rel=path.join(r,"release"), src=path.join(rel,"watchdog.py"), dest=path.join(r,"runtime","watchdog.py"), manifest=path.join(r,"manifest.json"); fs.mkdirSync(rel,{recursive:true}); fs.writeFileSync(src,"watchdog"); fs.writeFileSync(manifest,JSON.stringify({files:[{path:"watchdog.py",sha256:sha256(src)}]})); installStartupArtifact({source:src,target:dest,manifestPath:manifest,expectedManifestSha256:sha256(manifest),releaseDir:rel,verify:()=>({ok:true})}); assert.equal(sha256(src),sha256(dest)); fs.writeFileSync(src,"changed"); assert.throws(()=>installStartupArtifact({source:src,target:dest,manifestPath:manifest,expectedManifestSha256:sha256(manifest),releaseDir:rel,verify:()=>({ok:true})}),/not covered/);});
test("startup artifact install is anchored to the operator's explicit manifest hash",()=>{
  const r=root(), rel=path.join(r,"release"), src=path.join(rel,"watchdog.py"), dest=path.join(r,"runtime","watchdog.py"), manifest=path.join(r,"manifest.json");
  fs.mkdirSync(rel,{recursive:true}); fs.writeFileSync(src,"watchdog");
  fs.writeFileSync(manifest,JSON.stringify({files:[{path:"watchdog.py",sha256:sha256(src)}]}));
  const pinned=sha256(manifest);
  // a manifest swapped after the operator hashed it must be rejected even if
  // the swapped-in manifest is internally consistent and covers the source
  fs.writeFileSync(manifest,JSON.stringify({files:[{path:"watchdog.py",sha256:sha256(src)}],swapped:true}));
  assert.throws(()=>installStartupArtifact({source:src,target:dest,manifestPath:manifest,expectedManifestSha256:pinned,releaseDir:rel,verify:()=>({ok:true})}),/manifest SHA256 does not match/);
  assert.equal(fs.existsSync(dest),false);
  // missing anchor is a hard failure, not a downgrade to unanchored install
  assert.throws(()=>installStartupArtifact({source:src,target:dest,manifestPath:manifest,releaseDir:rel,verify:()=>({ok:true})}),/manifest SHA256 does not match/);
  // a BOM on the manifest fails closed before any verification
  fs.writeFileSync(manifest,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from("{}")]));
  assert.throws(()=>installStartupArtifact({source:src,target:dest,manifestPath:manifest,expectedManifestSha256:sha256(manifest),releaseDir:rel,verify:()=>({ok:true})}),/without BOM/);
});
test("startup artifact verification judges the pinned manifest bytes, not a re-read",()=>{
  const r=root(), rel=path.join(r,"release"), src=path.join(rel,"watchdog.py"), dest=path.join(r,"runtime","watchdog.py"), manifest=path.join(r,"manifest.json");
  fs.mkdirSync(rel,{recursive:true}); fs.writeFileSync(src,"watchdog");
  const body=JSON.stringify({files:[{path:"watchdog.py",sha256:sha256(src)}]});
  fs.writeFileSync(manifest,body);
  let sawPinnedBytes=null;
  const verify=({manifestBytes})=>{ sawPinnedBytes=Boolean(manifestBytes && manifestBytes.toString("utf8")===body); return {ok:true}; };
  installStartupArtifact({source:src,target:dest,manifestPath:manifest,expectedManifestSha256:sha256(manifest),releaseDir:rel,verify});
  assert.equal(sawPinnedBytes,true);
  assert.equal(sha256(dest),sha256(src));
});
test("manifest coverage judges the caller's bytes, so a source swapped after reading cannot self-certify",()=>{const r=root(), rel=path.join(r,"release"), src=path.join(rel,"watchdog.py"); fs.mkdirSync(rel,{recursive:true}); fs.writeFileSync(src,"original"); const originalBytes=fs.readFileSync(src); const manifest={files:[{path:"watchdog.py",sha256:sha256Bytes(originalBytes)}]}; fs.writeFileSync(src,"swapped after the caller's read"); const record=manifestCovers(manifest,rel,src,originalBytes); assert.equal(record.sha256,sha256Bytes(originalBytes)); assert.throws(()=>manifestCovers(manifest,rel,src),/not covered/);});
test("post-write validation failure restores the previous descriptor and removes a fresh install",()=>{
  const x=setup(); fs.mkdirSync(path.dirname(x.targetFile),{recursive:true}); fs.writeFileSync(x.targetFile,"old");
  const sabotage=(candidateFile)=>()=>{ const parsed=JSON.parse(fs.readFileSync(candidateFile)); fs.rmSync(parsed.telegram_entry); return {ok:true,errors:[]}; };
  assert.throws(()=>install(x,{verify:sabotage(x.candidate)}),/previous descriptor was restored/);
  assert.equal(fs.readFileSync(x.targetFile,"utf8"),"old");
  const y=setup();
  assert.throws(()=>install(y,{verify:sabotage(y.candidate)}),/previous descriptor was restored/);
  assert.equal(fs.existsSync(y.targetFile),false);
});

const packageRoot = path.resolve(__dirname, "..");
const installers = {
  descriptor: path.join(packageRoot, "scripts", "windows", "runtime-startup", "install-release-descriptor.ps1"),
  startup: path.join(packageRoot, "scripts", "windows", "runtime-startup", "install-runtime-startup-artifacts.ps1"),
};

function write(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
function makeRelease(base, name, includeStartupArtifacts = false) {
  const release = path.join(base, name);
  const entry = path.join(release, "bin", "cyberboss.js");
  const target = path.join(release, "start-safe.ps1");
  write(entry, "// synthetic release entry\n"); write(target, "# synthetic launcher\n");
  if (includeStartupArtifacts) {
    write(path.join(release, "extensions", "relationship-memory", "launcher", "watchdog.py"), "# synthetic watchdog\n");
    write(path.join(release, "scripts", "windows", "runtime-startup", "stable-telegram-launcher.candidate.ps1"), "# synthetic stable launcher\n");
  }
  for (const kind of ["config", "state", "logs"]) fs.mkdirSync(path.join(base, `${name}-${kind}`), { recursive: true });
  return { release, telegram_entry: entry, config_dir: path.join(base, `${name}-config`), state_dir: path.join(base, `${name}-state`), log_dir: path.join(base, `${name}-logs`), pid_file: path.join(base, `${name}-state`, "cyberboss.pid"), watchdog_target: target };
}
function makeDescriptor(base, active) {
  const rollback = makeRelease(base, "rollback");
  return { active_release_id: "synthetic-active", ...active, last_verified_sha: "a".repeat(40), rollback_release: { release_id: "synthetic-rollback", ...rollback, last_verified_sha: "b".repeat(40) } };
}
// The packaged release directory is not a git checkout, so these tests build
// their own single-commit fixture repository (same pattern as
// release-manifest.test.js) to supply the real commit/tree SHAs that
// verifyManifest resolves through `git cat-file` in the external repository.
function makeFixtureRepo(base) {
  const repoDir = path.join(base, "repo-fixture");
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repoDir, "fixture.txt"), "fixture\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture commit"]);
  return { repoDir, commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]) };
}
function writeVerifiedManifest(release, file, fixture) {
  const commit = fixture.commit;
  const tree = fixture.tree;
  const files = [];
  (function visit(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) visit(full); else { const bytes = fs.readFileSync(full); files.push({ path: path.relative(release, full).split(path.sep).join("/"), sha256: sha256(full), size: bytes.length, transform: "unconverted" }); } } })(release);
  write(file, JSON.stringify({ schema_version: SCHEMA_VERSION, release_id: "synthetic", commit: { sha: commit, tree_sha: tree }, files, excluded: EXCLUDED_RELATIONSHIP_MEMORY_FILES, additional_runtime_assets: [] }));
}
function runPowerShell(script, args) { return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, ...args], { encoding: "utf8" }); }

// R4 F1: on non-Windows machines spawnSync("powershell.exe") returns
// { status: null, error: ENOENT } without throwing, so `notEqual(status, 0)`
// is vacuously true. Fail-closed assertions must first prove the process ran.
const IS_WINDOWS = process.platform === "win32";
function assertFailedClosed(result, message) {
  assert.equal(result.error, undefined, `process never ran: ${result.error}`);
  assert.notEqual(result.status, null, "process never ran: spawnSync returned status null");
  assert.notEqual(result.status, 0, `${message}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
}

test("descriptor installer writes only an explicit temporary absolute target", { skip: !IS_WINDOWS }, () => {
  const r = root();
  try {
    const active = makeRelease(r, "active"); const candidate = path.join(r, "candidate.json"); const manifest = path.join(r, "release-manifest.json"); const audit = path.join(r, "audit"); const target = path.join(r, "deployment", "current.json");
    const fixture = makeFixtureRepo(r);
    write(candidate, JSON.stringify(makeDescriptor(r, active))); writeVerifiedManifest(active.release, manifest, fixture);
    const result = runPowerShell(installers.descriptor, ["-CandidatePath", candidate, "-ExpectedCandidateSha256", sha256(candidate), "-ManifestPath", manifest, "-ExpectedManifestSha256", sha256(manifest), "-AuditDirectory", audit, "-TargetDescriptorPath", target, "-RepositoryDirectory", fixture.repoDir]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const bytes = fs.readFileSync(target); assert.deepEqual(bytes, fs.readFileSync(candidate)); assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false); assert.equal(sha256(target), sha256(candidate));
    assert.equal(fs.readdirSync(audit).some((name) => name.startsWith("descriptor-install-") && name.endsWith(".json")), true);
    assert.deepEqual(fs.readdirSync(r).sort().filter((name) => !["active", "active-config", "active-logs", "active-state", "audit", "candidate.json", "deployment", "release-manifest.json", "repo-fixture", "rollback", "rollback-config", "rollback-logs", "rollback-state"].includes(name)), []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("startup artifacts installer copies both manifest-covered sources only to its explicit temporary target", { skip: !IS_WINDOWS }, () => {
  const r = root();
  try {
    const active = makeRelease(r, "active", true); const descriptorFile = path.join(r, "descriptor.json"); const manifest = path.join(r, "release-manifest.json"); const startup = path.join(r, "runtime", "startup");
    const fixture = makeFixtureRepo(r);
    write(descriptorFile, JSON.stringify(makeDescriptor(r, active))); writeVerifiedManifest(active.release, manifest, fixture);
    const result = runPowerShell(installers.startup, ["-DescriptorPath", descriptorFile, "-ManifestPath", manifest, "-ExpectedManifestSha256", sha256(manifest), "-TargetStartupDirectory", startup, "-RepositoryDirectory", fixture.repoDir]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(sha256(path.join(startup, "telegram-watchdog.py")), sha256(path.join(active.release, "extensions", "relationship-memory", "launcher", "watchdog.py")));
    assert.equal(sha256(path.join(startup, "stable-telegram-launcher.ps1")), sha256(path.join(active.release, "scripts", "windows", "runtime-startup", "stable-telegram-launcher.candidate.ps1")));
    assert.deepEqual(fs.readdirSync(r).sort().filter((name) => !["active", "active-config", "active-logs", "active-state", "descriptor.json", "release-manifest.json", "repo-fixture", "rollback", "rollback-config", "rollback-logs", "rollback-state", "runtime"].includes(name)), []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("retired legacy deploy and manifest-topology launch paths fail closed with explicit guidance", { skip: !IS_WINDOWS }, () => {
  const r = root();
  try {
    const scripts = path.join(packageRoot, "scripts", "windows");
    for (const retired of [path.join(scripts, "runtime-startup", "install-telegram-watchdog.ps1"), path.join(scripts, "cyberlink-deploy.ps1")]) {
      const result = runPowerShell(retired, []);
      assertFailedClosed(result, `${retired} did not fail closed`);
      assert.match(`${result.stderr}${result.stdout}`, /retired/i);
    }
    const manifest = path.join(r, "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ workspace_root: r, formal_repo: {}, telegram: {}, dashboard: {}, watchdog: {}, soft_retrieval: {} }));
    const telegramMode = runPowerShell(path.join(scripts, "cyberlink-start.ps1"), ["-Mode", "Telegram", "-ManifestPath", manifest]);
    assertFailedClosed(telegramMode, "cyberlink-start.ps1 -Mode Telegram did not fail closed");
    assert.match(`${telegramMode.stderr}${telegramMode.stdout}`, /Start-TelegramLine is retired/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("startup artifacts installer rejects a relative target before it can create artifacts", { skip: !IS_WINDOWS }, () => {
  const r = root();
  try {
    const fakeProduction = path.join(r, "deployment", "current.json"); write(fakeProduction, "production sentinel bytes");
    const result = runPowerShell(installers.startup, ["-DescriptorPath", path.join(r, "missing.json"), "-ManifestPath", path.join(r, "missing-manifest.json"), "-ExpectedManifestSha256", "0".repeat(64), "-TargetStartupDirectory", ".\\runtime\\startup", "-RepositoryDirectory", packageRoot]);
    assertFailedClosed(result, "startup installer accepted a relative target"); assert.match(`${result.stderr}\n${result.stdout}`, /TargetStartupDirectory must be an absolute path/);
    assert.equal(fs.readFileSync(fakeProduction, "utf8"), "production sentinel bytes"); assert.equal(fs.existsSync(path.join(r, "runtime", "startup", "telegram-watchdog.py")), false); assert.equal(fs.existsSync(path.join(r, "runtime", "startup", "stable-telegram-launcher.ps1")), false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
