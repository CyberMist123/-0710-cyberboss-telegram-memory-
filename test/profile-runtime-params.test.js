const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { persistProfileRuntimeParams } = require("../src/adapters/runtime/claudecode/profile-runtime-params");

// /model 与 /effort 写回 launch-profiles.json（Owner 2026-08-11 裁定 (a)）。
// 这是她的启动配置：写坏了她下次就起不来，所以每条失败路径都必须"不写并如实报错"，
// 绝不允许写出半个 JSON 或悄悄吞掉错误。

function tempProfiles(document) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-profiles-"));
  const file = path.join(dir, "launch-profiles.json");
  fs.writeFileSync(file, JSON.stringify(document, null, 2), "utf8");
  return { dir, file };
}

const BASE = {
  "fable-chat": { profileId: "fable-chat", model: "claude-fable-5", effort: "medium", builtInTools: ["Read"] },
  "work-engineering": { profileId: "work-engineering", model: "claude-opus-4-6" },
};

test("writes model into the named profile and leaves everything else untouched", () => {
  const { dir, file } = tempProfiles(BASE);
  const result = persistProfileRuntimeParams({ filePath: file, profileId: "fable-chat", patch: { model: "claude-opus-4-6" } });

  assert.equal(result.saved, true);
  assert.equal(result.before.model, "claude-fable-5");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after["fable-chat"].model, "claude-opus-4-6");
  assert.equal(after["fable-chat"].effort, "medium", "没让改的字段不能被动");
  assert.deepEqual(after["fable-chat"].builtInTools, ["Read"], "工具面不能被这条命令牵连");
  assert.deepEqual(after["work-engineering"], BASE["work-engineering"], "别的 profile 不能被动");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("keeps a backup of the file it is about to change", () => {
  const { dir, file } = tempProfiles(BASE);
  persistProfileRuntimeParams({ filePath: file, profileId: "fable-chat", patch: { effort: "high" } });

  const backups = fs.readdirSync(dir).filter((name) => name.includes(".bak-"));
  assert.equal(backups.length, 1, "改她的启动配置必须留下可回滚的副本");
  const restored = JSON.parse(fs.readFileSync(path.join(dir, backups[0]), "utf8"));
  assert.equal(restored["fable-chat"].effort, "medium", "备份里必须是改动前的内容");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses to write anything when the profile is not in the file", () => {
  const { dir, file } = tempProfiles(BASE);
  const before = fs.readFileSync(file, "utf8");
  const result = persistProfileRuntimeParams({ filePath: file, profileId: "no-such-profile", patch: { model: "x" } });

  assert.equal(result.saved, false);
  assert.equal(result.reason, "profile_not_found");
  assert.equal(fs.readFileSync(file, "utf8"), before, "失败路径一个字节都不能写");
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".bak-")).length, 0, "没写就不该留备份");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses to write when the file is not valid JSON, rather than replacing it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-profiles-"));
  const file = path.join(dir, "launch-profiles.json");
  fs.writeFileSync(file, "{ not json", "utf8");

  const result = persistProfileRuntimeParams({ filePath: file, profileId: "fable-chat", patch: { model: "x" } });
  assert.equal(result.saved, false);
  assert.equal(result.reason, "profiles_file_invalid_json");
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "坏文件要原样留着给人查，不能被覆盖");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("only model and effort are writable — no other key can ride in", () => {
  const { dir, file } = tempProfiles(BASE);
  const result = persistProfileRuntimeParams({
    filePath: file,
    profileId: "fable-chat",
    patch: { model: "claude-opus-4-6", builtInTools: ["Bash"], permissionMode: "bypass" },
  });

  assert.equal(result.saved, true);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after["fable-chat"].model, "claude-opus-4-6");
  assert.deepEqual(after["fable-chat"].builtInTools, ["Read"], "工具面绝不能经这条路被改");
  assert.equal(after["fable-chat"].permissionMode, undefined, "权限模式绝不能经这条路被写进去");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an inline-profile deployment is told plainly instead of failing silently", () => {
  const result = persistProfileRuntimeParams({ filePath: "", profileId: "fable-chat", patch: { model: "x" } });
  assert.equal(result.saved, false);
  assert.equal(result.reason, "profiles_file_not_configured");
});
