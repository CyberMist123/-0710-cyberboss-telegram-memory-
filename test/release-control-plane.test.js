const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { installDescriptor, installStartupArtifact, sha256 } = require("../scripts/orchestration/release-control-plane");

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

test("PowerShell installers require explicit normalized targets and contain no production default",()=>{
  const base=path.join(__dirname,"..","scripts","windows","runtime-startup");
  const descriptorInstaller=path.join(base,"install-release-descriptor.ps1");
  const startupInstaller=path.join(base,"install-runtime-startup-artifacts.ps1");
  const descriptorSource=fs.readFileSync(descriptorInstaller,"utf8");
  const startupSource=fs.readFileSync(startupInstaller,"utf8");
  assert.match(descriptorSource,/\[Parameter\(Mandatory=\$true\)\]\[string\]\$TargetDescriptorPath/);
  assert.match(startupSource,/\[Parameter\(Mandatory=\$true\)\]\[string\]\$TargetStartupDirectory/);
  assert.doesNotMatch(descriptorSource,/deployment['"]?\s*\)|DeploymentDirectory/);
  assert.doesNotMatch(startupSource,/runtime\\startup|CyberlinkRoot/);
  const r=root(), fakeProduction=path.join(r,"deployment","current.json"); fs.mkdirSync(path.dirname(fakeProduction),{recursive:true}); fs.writeFileSync(fakeProduction,"do-not-touch");
  for (const installer of [descriptorInstaller,startupInstaller]) {
    const result=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-File",installer],{encoding:"utf8"});
    assert.notEqual(result.status,0,`${installer} unexpectedly accepted a missing target`);
    assert.equal(fs.readFileSync(fakeProduction,"utf8"),"do-not-touch");
  }
  const relative=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",`& '${descriptorInstaller.replace(/'/g,"''")}' -CandidatePath x -ExpectedCandidateSha256 x -ManifestPath x -ExpectedManifestSha256 x -AuditDirectory x -TargetDescriptorPath relative.json`],{encoding:"utf8"});
  assert.notEqual(relative.status,0);
  assert.match(`${relative.stderr}${relative.stdout}`,/absolute path/);
  assert.equal(fs.readFileSync(fakeProduction,"utf8"),"do-not-touch");
});
