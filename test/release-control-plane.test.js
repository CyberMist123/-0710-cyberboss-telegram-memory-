const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { installDescriptor, installStartupArtifact, sha256 } = require("../scripts/orchestration/release-control-plane");
const { EXCLUDED_RELATIONSHIP_MEMORY_FILES, SCHEMA_VERSION } = require("../src/orchestration/release-manifest");

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-control-plane-")); }
function target(root, name) { const release=path.join(root,name); const bin=path.join(release,"bin"); fs.mkdirSync(bin,{recursive:true}); const entry=path.join(bin,"cyberboss.js"); const watch=path.join(release,"start-safe.ps1"); fs.writeFileSync(entry,"//x"); fs.writeFileSync(watch,"#x"); for(const dir of ["config","state","logs"]) fs.mkdirSync(path.join(root,`${name}-${dir}`),{recursive:true}); return { telegram_entry:entry,config_dir:path.join(root,`${name}-config`),state_dir:path.join(root,`${name}-state`),log_dir:path.join(root,`${name}-logs`),pid_file:path.join(root,`${name}-state`,`x.pid`),watchdog_target:watch }; }
function descriptor(root) { const a=target(root,"active"), b=target(root,"rollback"); return {active_release_id:"active",...a,last_verified_sha:"a".repeat(40),rollback_release:{release_id:"rollback",...b,last_verified_sha:"b".repeat(40)}}; }
function setup() { const r=root(), candidate=path.join(r,"candidate.json"), manifest=path.join(r,"manifest.json"), audit=path.join(r,"audit"), targetFile=path.join(r,"deployment","current.json"); fs.writeFileSync(candidate,JSON.stringify(descriptor(r))); fs.writeFileSync(manifest,"{}"); return {r,candidate,manifest,audit,targetFile}; }
function install(x, extra={}) { return installDescriptor({candidatePath:x.candidate,expectedCandidateSha256:sha256(x.candidate),manifestPath:x.manifest,expectedManifestSha256:sha256(x.manifest),auditDirectory:x.audit,targetPath:x.targetFile,verify:()=>({ok:true,errors:[]}),...extra}); }
test("candidate install creates missing formal descriptor as exact UTF-8 bytes",()=>{const x=setup(); install(x); assert.deepEqual(fs.readFileSync(x.targetFile),fs.readFileSync(x.candidate)); assert.equal(fs.readdirSync(x.audit).length,1);});
test("candidate replacement retains an immutable backup and audit",()=>{const x=setup(); fs.mkdirSync(path.dirname(x.targetFile),{recursive:true}); fs.writeFileSync(x.targetFile,"old"); const audit=install(x); assert.ok(audit.backup_path && fs.existsSync(audit.backup_path)); assert.equal(fs.readFileSync(audit.backup_path,"utf8"),"old");});
test("hash mismatch, BOM, and validation failure do not damage old descriptor",()=>{const x=setup(); fs.mkdirSync(path.dirname(x.targetFile),{recursive:true}); fs.writeFileSync(x.targetFile,"old"); assert.throws(()=>install(x,{expectedCandidateSha256:"0".repeat(64)})); fs.writeFileSync(x.candidate,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),fs.readFileSync(x.candidate)])); assert.throws(()=>install(x)); assert.equal(fs.readFileSync(x.targetFile,"utf8"),"old");});
test("manifest failure and descriptor schema/path failures retain the old descriptor",()=>{const x=setup(); fs.mkdirSync(path.dirname(x.targetFile),{recursive:true}); fs.writeFileSync(x.targetFile,"old"); assert.throws(()=>install(x,{verify:()=>({ok:false,errors:["tampered"]})}),/manifest verification failed/); const bad=JSON.parse(fs.readFileSync(x.candidate)); bad.telegram_entry=path.join(x.r,"missing","cyberboss.js"); fs.writeFileSync(x.candidate,JSON.stringify(bad)); assert.throws(()=>install(x),/Invalid release descriptor/); assert.equal(fs.readFileSync(x.targetFile,"utf8"),"old");});
test("startup artifacts require manifest coverage and copy hash exactly",()=>{const r=root(), rel=path.join(r,"release"), src=path.join(rel,"watchdog.py"), dest=path.join(r,"runtime","watchdog.py"), manifest=path.join(r,"manifest.json"); fs.mkdirSync(rel,{recursive:true}); fs.writeFileSync(src,"watchdog"); fs.writeFileSync(manifest,JSON.stringify({files:[{path:"watchdog.py",sha256:sha256(src)}]})); installStartupArtifact({source:src,target:dest,manifestPath:manifest,releaseDir:rel,verify:()=>({ok:true})}); assert.equal(sha256(src),sha256(dest)); fs.writeFileSync(src,"changed"); assert.throws(()=>installStartupArtifact({source:src,target:dest,manifestPath:manifest,releaseDir:rel,verify:()=>({ok:true})}),/not covered/);});

const repo = path.resolve(__dirname, "..");
const installers = {
  descriptor: path.join(repo, "scripts", "windows", "runtime-startup", "install-release-descriptor.ps1"),
  startup: path.join(repo, "scripts", "windows", "runtime-startup", "install-runtime-startup-artifacts.ps1"),
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
function writeVerifiedManifest(release, file) {
  const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const files = [];
  (function visit(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, item.name); if (item.isDirectory()) visit(full); else { const bytes = fs.readFileSync(full); files.push({ path: path.relative(release, full).split(path.sep).join("/"), sha256: sha256(full), size: bytes.length, transform: "unconverted" }); } } })(release);
  write(file, JSON.stringify({ schema_version: SCHEMA_VERSION, release_id: "synthetic", commit: { sha: commit, tree_sha: tree }, files, excluded: EXCLUDED_RELATIONSHIP_MEMORY_FILES, additional_runtime_assets: [] }));
}
function runPowerShell(script, args) { return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, ...args], { encoding: "utf8" }); }

test("descriptor installer writes only an explicit temporary absolute target", () => {
  const r = root();
  try {
    const active = makeRelease(r, "active"); const candidate = path.join(r, "candidate.json"); const manifest = path.join(r, "release-manifest.json"); const audit = path.join(r, "audit"); const target = path.join(r, "deployment", "current.json");
    write(candidate, JSON.stringify(makeDescriptor(r, active))); writeVerifiedManifest(active.release, manifest);
    const result = runPowerShell(installers.descriptor, ["-CandidatePath", candidate, "-ExpectedCandidateSha256", sha256(candidate), "-ManifestPath", manifest, "-ExpectedManifestSha256", sha256(manifest), "-AuditDirectory", audit, "-TargetDescriptorPath", target, "-RepositoryDirectory", repo]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const bytes = fs.readFileSync(target); assert.deepEqual(bytes, fs.readFileSync(candidate)); assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false); assert.equal(sha256(target), sha256(candidate));
    assert.equal(fs.readdirSync(audit).some((name) => name.startsWith("descriptor-install-") && name.endsWith(".json")), true);
    assert.deepEqual(fs.readdirSync(r).sort().filter((name) => !["active", "active-config", "active-logs", "active-state", "audit", "candidate.json", "deployment", "release-manifest.json", "rollback", "rollback-config", "rollback-logs", "rollback-state"].includes(name)), []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("startup artifacts installer copies both manifest-covered sources only to its explicit temporary target", () => {
  const r = root();
  try {
    const active = makeRelease(r, "active", true); const descriptorFile = path.join(r, "descriptor.json"); const manifest = path.join(r, "release-manifest.json"); const startup = path.join(r, "runtime", "startup");
    write(descriptorFile, JSON.stringify(makeDescriptor(r, active))); writeVerifiedManifest(active.release, manifest);
    const result = runPowerShell(installers.startup, ["-DescriptorPath", descriptorFile, "-ManifestPath", manifest, "-TargetStartupDirectory", startup, "-RepositoryDirectory", repo]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(sha256(path.join(startup, "telegram-watchdog.py")), sha256(path.join(active.release, "extensions", "relationship-memory", "launcher", "watchdog.py")));
    assert.equal(sha256(path.join(startup, "stable-telegram-launcher.ps1")), sha256(path.join(active.release, "scripts", "windows", "runtime-startup", "stable-telegram-launcher.candidate.ps1")));
    assert.deepEqual(fs.readdirSync(r).sort().filter((name) => !["active", "active-config", "active-logs", "active-state", "descriptor.json", "release-manifest.json", "rollback", "rollback-config", "rollback-logs", "rollback-state", "runtime"].includes(name)), []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test("startup artifacts installer rejects a relative target before it can create artifacts", () => {
  const r = root();
  try {
    const fakeProduction = path.join(r, "deployment", "current.json"); write(fakeProduction, "production sentinel bytes");
    const result = runPowerShell(installers.startup, ["-DescriptorPath", path.join(r, "missing.json"), "-ManifestPath", path.join(r, "missing-manifest.json"), "-TargetStartupDirectory", ".\\runtime\\startup", "-RepositoryDirectory", repo]);
    assert.notEqual(result.status, 0); assert.match(`${result.stderr}\n${result.stdout}`, /TargetStartupDirectory must be an absolute path/);
    assert.equal(fs.readFileSync(fakeProduction, "utf8"), "production sentinel bytes"); assert.equal(fs.existsSync(path.join(r, "runtime", "startup", "telegram-watchdog.py")), false); assert.equal(fs.existsSync(path.join(r, "runtime", "startup", "stable-telegram-launcher.ps1")), false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});
