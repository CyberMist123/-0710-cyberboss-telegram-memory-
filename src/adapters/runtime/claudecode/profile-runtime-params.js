"use strict";

// 把 /model 与 /effort 的选择写回 launch-profiles.json。
//
// 为什么需要这个（Owner 2026-08-11）：`/model` 原先只写 windowOverride，而覆盖是
// 按 sessionSlotKey 存的，slot 一轮换设置就没了——她 08-06 设的 opus-4-6 就是这样
// 在某次换 session 后悄悄掉回 profile 缺省，而 /status 读的又是配置意图，
// 于是显示和实际分叉了五天没人发现。profile 才是启动时的真相源，写这里才算数。
//
// 纪律：
//   * 原子写（临时文件 + rename），断电不会留半个 JSON
//   * 每次改动前留一份 .bak-<时间戳>，误改可回滚
//   * 只改 model / effort 两个字段，其余键原样保留（含注释无关的结构）
//   * 文件不可读、不是对象、或 profile 不存在时一律不写并如实报错——
//     宁可命令失败，也不要把她的启动配置写坏

const fs = require("fs");
const path = require("path");

const ALLOWED_KEYS = new Set(["model", "effort"]);

function persistProfileRuntimeParams({ filePath, profileId, patch } = {}) {
  const target = normalizeText(filePath);
  const profile = normalizeText(profileId);
  if (!target) return { saved: false, reason: "profiles_file_not_configured" };
  if (!profile) return { saved: false, reason: "profile_id_missing" };

  const entries = Object.entries(patch || {})
    .filter(([key, value]) => ALLOWED_KEYS.has(key) && normalizeText(value))
    .map(([key, value]) => [key, normalizeText(value)]);
  if (!entries.length) return { saved: false, reason: "nothing_to_write" };

  let raw;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch {
    return { saved: false, reason: "profiles_file_unreadable" };
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    return { saved: false, reason: "profiles_file_invalid_json" };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { saved: false, reason: "profiles_file_not_an_object" };
  }
  const current = document[profile];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return { saved: false, reason: "profile_not_found" };
  }

  const before = {};
  for (const [key] of entries) before[key] = normalizeText(current[key]);
  const next = { ...document, [profile]: { ...current, ...Object.fromEntries(entries) } };

  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  try {
    fs.copyFileSync(target, backup);
  } catch {
    return { saved: false, reason: "backup_failed" };
  }

  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
  } catch {
    try { fs.unlinkSync(temporary); } catch {}
    return { saved: false, reason: "write_failed" };
  }

  return { saved: true, profileId: profile, applied: Object.fromEntries(entries), before, backup };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { persistProfileRuntimeParams, ALLOWED_KEYS };
