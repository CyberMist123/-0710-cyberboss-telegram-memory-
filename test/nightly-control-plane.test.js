const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

test("nightly treats deployment/current.json as Telegram SSOT and fails closed on manifest conflict", { skip: process.platform !== "win32" }, () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cyberboss-nightly-")); const active=path.join(root,"active"), rollback=path.join(root,"rollback");
  const make=(release,name)=>{fs.mkdirSync(path.join(release,"bin"),{recursive:true}); fs.writeFileSync(path.join(release,"bin","cyberboss.js"),"//x"); fs.writeFileSync(path.join(release,"watch.ps1"),"#x"); for(const d of ["config","state","logs"])fs.mkdirSync(path.join(root,`${name}-${d}`),{recursive:true}); return {telegram_entry:path.join(release,"bin","cyberboss.js"),config_dir:path.join(root,`${name}-config`),state_dir:path.join(root,`${name}-state`),log_dir:path.join(root,`${name}-logs`),pid_file:path.join(root,`${name}-state`,`x.pid`),watchdog_target:path.join(release,"watch.ps1")};};
  const a=make(active,"active"), b=make(rollback,"rollback"), descriptor=path.join(root,"current.json"), manifest=path.join(root,"manifest.json"); fs.writeFileSync(descriptor,JSON.stringify({active_release_id:"active",...a,last_verified_sha:"a".repeat(40),rollback_release:{release_id:"rollback",...b,last_verified_sha:"b".repeat(40)}}));
  fs.writeFileSync(manifest,JSON.stringify({workspace_root:root,formal_repo:{},telegram:{entry:path.join(root,"old","cyberboss.js"),pid_file:a.pid_file,watchdog_target:a.watchdog_target},dashboard:{},watchdog:{},soft_retrieval:{}}));
  const before=fs.readFileSync(descriptor); const script=path.join(__dirname,"..","scripts","windows","continuity-nightly.ps1"); const r=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-ManifestPath",manifest,"-DescriptorPath",descriptor],{encoding:"utf8"});
  assert.notEqual(r.status,0); assert.match(r.stderr,/conflicts with deployment\/current\.json/); assert.deepEqual(fs.readFileSync(descriptor),before);
});

test("nightly has an explicit descriptor-first path and a documented bootstrap-only fallback", () => {
  const source=fs.readFileSync(path.join(__dirname,"..","scripts","windows","continuity-nightly.ps1"),"utf8");
  assert.match(source,/production descriptor is the sole Telegram topology authority/);
  assert.match(source,/Bootstrap only/);
  assert.match(source,/refusing nightly run/);
});
