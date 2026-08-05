"use strict";

const { envFlagEnabled } = require("../core/env-flag");

const CATEGORIES = ["memory", "tool", "mcp", "skill"];
const RESIDENT_NAMES = ["cyberboss_system_send", "cyberboss_time"];
const TOOLSETS = { "chat-core@1": ["memory_lookup", "memory_note", "cyberboss_reminder", "cyberboss_diary_append", "cyberboss_system_send", "cyberboss_time"] };
const TOOL_THEMES = Object.freeze({
  github_repo_create: "工程派活", github_file_upload: "工程派活", github_issue_open: "工程派活", github_pr_open: "工程派活",
  route1_dispatch: "工程派活", route1_task_status: "工程派活", route1_task_result: "工程派活",
  route2_escalate: "工程派活",
  location_debug_snapshot: "感知", location_event_dashboard: "感知",
  memory_note: "记忆", memory_lookup: "记忆", memory_candidate_submit: "记忆",
  cyberboss_time: "感知", cyberboss_diary_append: "生活记录", cyberboss_reminder: "生活记录",
  cyberboss_system_send: "表达行动", cyberboss_sleep_mode: "作息", weather: "感知",
  cyberboss_channel_send_file: "表达行动", cyberboss_telegram_send: "表达行动",
  cyberboss_telegram_send_file: "表达行动", cyberboss_telegram_send_voice: "表达行动",
  cyberboss_sticker_tags: "表达行动", cyberboss_sticker_pick: "表达行动", cyberboss_sticker_send: "表达行动",
  cyberboss_sticker_delete: "维护调试", cyberboss_sticker_save_from_inbox: "维护调试", cyberboss_sticker_update: "维护调试",
  cyberboss_timeline_read: "时间线", cyberboss_timeline_categories: "时间线", cyberboss_timeline_proposals: "时间线",
  cyberboss_timeline_write: "时间线", cyberboss_timeline_build: "时间线", cyberboss_timeline_serve: "时间线",
  cyberboss_timeline_dev: "时间线", cyberboss_timeline_screenshot: "时间线",
  whereabouts_current_stay: "感知", whereabouts_recent_moves: "感知", whereabouts_recent_stays: "感知",
  whereabouts_snapshot: "感知", whereabouts_summary: "感知",
});
const THEME_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "表达行动", description: "想跟你说话、发文件、发语音、发贴纸时来这——她伸出手的那一面" }),
  Object.freeze({ name: "感知", description: "你和世界的状态：天气、位置；将来健康、手机使用、可穿戴、日常活动 MCP 全进这" }),
  Object.freeze({ name: "记忆", description: "翻过去（Episodes/账本都从这个把手进）、留笔记" }),
  Object.freeze({ name: "生活记录", description: "记日记、设提醒" }),
  Object.freeze({ name: "时间线", description: "你们的时间线回看与整理" }),
  Object.freeze({ name: "作息", description: "睡眠模式" }),
  Object.freeze({ name: "工程派活", description: "GitHub 操作；将来 Route 1 派工程车也在这" }),
  Object.freeze({ name: "维护调试", description: "平时不碰" }),
]);
// `arguments` is the transport seam (D34): MCP only lets the CLI call a tool it
// has already broadcast, so a non-resident tool is reachable only by handing its
// arguments to the one broadcast entry. `{handle}` loads a schema; `{handle,
// arguments}` calls that tool; `theme` stays exclusive with both.
const CATALOG_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: { theme: { type: "string" }, handle: { type: "string" }, arguments: { type: "object" } },
  additionalProperties: false,
});
// Explicit policy data: risk is reviewed per canonical tool, never inferred from
// spelling at runtime. Aliases inherit their canonical target's value.
const TOOL_RISKS = Object.freeze({
  memory_lookup: "read", memory_note: "append", memory_candidate_submit: "append",
  cyberboss_channel_send_file: "send", cyberboss_diary_append: "append", cyberboss_reminder: "append",
  cyberboss_sleep_mode: "mutate", cyberboss_sticker_delete: "mutate", cyberboss_sticker_pick: "read",
  cyberboss_sticker_save_from_inbox: "append", cyberboss_sticker_send: "send", cyberboss_sticker_tags: "read",
  cyberboss_sticker_update: "mutate", cyberboss_system_send: "send", cyberboss_telegram_send: "send",
  cyberboss_telegram_send_file: "send", cyberboss_telegram_send_voice: "send", cyberboss_time: "read",
  cyberboss_timeline_build: "mutate", cyberboss_timeline_categories: "read", cyberboss_timeline_dev: "admin",
  cyberboss_timeline_proposals: "read", cyberboss_timeline_read: "read", cyberboss_timeline_screenshot: "read",
  cyberboss_timeline_serve: "admin", cyberboss_timeline_write: "mutate", github_file_upload: "mutate",
  github_issue_open: "mutate", github_pr_open: "mutate", github_repo_create: "admin",
  route1_dispatch: "mutate", route1_task_status: "read", route1_task_result: "read",
  route2_escalate: "mutate",
  location_debug_snapshot: "admin", location_event_dashboard: "admin", weather: "read",
  whereabouts_current_stay: "read", whereabouts_recent_moves: "read", whereabouts_recent_stays: "read",
  whereabouts_snapshot: "read", whereabouts_summary: "read",
});
// These are per-tool response budgets enforced by mcp-stdio-server before the
// result enters the model context. Tools not listed here remain structurally
// ineligible for Route 2; there is deliberately no global fallback.
const TOOL_MAX_RESULT_BYTES = Object.freeze({
  cyberboss_time: 2048,
  weather: 16384,
  memory_lookup: 32768,
  cyberboss_sticker_tags: 8192,
  cyberboss_sticker_pick: 16384,
  cyberboss_timeline_read: 32768,
  cyberboss_timeline_categories: 8192,
  cyberboss_timeline_proposals: 16384,
  whereabouts_current_stay: 4096,
  whereabouts_recent_moves: 16384,
  whereabouts_recent_stays: 16384,
  whereabouts_summary: 16384,
});

// All three read a deployment switch, so all three use the one shared rule:
// the env file writes `=1`, the bridge forwards `"true"`, and both forms mean
// the same thing on either side of the process boundary.
function catalogEnabled(env = process.env) { return envFlagEnabled("CYBERBOSS_TOOL_CATALOG_ENABLED", env); }
function subjectSigningEnabled(env = process.env) { return envFlagEnabled("CYBERBOSS_SUBJECT_SIGNING_ENABLED", env); }
function route2GateEnabled(env = process.env) { return envFlagEnabled("CYBERBOSS_ROUTE2_GATE_ENABLED", env); }
function resolveToolset(value, env = process.env, toolsets = TOOLSETS) {
  const id = typeof value === "string" ? value.trim() : (env.CYBERBOSS_TOOL_CATALOG_TOOLSET || "").trim();
  if (!id) return null;
  if (!Object.hasOwn(toolsets, id)) throw catalogError("catalog_unknown_toolset", id);
  const members = toolsets[id];
  if (new Set(members).size !== members.length) throw catalogError("catalog_duplicate_toolset_member", id);
  return { id, members: new Set(members) };
}
function catalogError(code, value) { const error = new Error(`${code}: ${value}`); error.code = code; return error; }
function classifyProjectTool(tool) {
  if (!tool || !typeof tool.name === "string") throw catalogError("catalog_unclassified_entry", String(tool?.name || "unknown"));
  return Array.isArray(tool.topics) && tool.topics.includes("memory") ? "memory" : "tool";
}
function schemaMetric(schema) { return JSON.stringify(schema || {}).length; }
function buildManifest({ projectTools = [], aliases = {}, extraHosts = [], deprecatedNames = new Set(), toolset = null } = {}) {
  const entries = [];
  const canonical = new Map();
  for (const tool of projectTools) {
    const category = classifyProjectTool(tool); canonical.set(tool.name, { tool, category });
    entries.push(makeEntry(tool.name, category, tool, { hidden: tool.hidden === true, authorized: authorize(tool.name, toolset) }));
  }
  for (const host of extraHosts) for (const tool of host.listTools()) entries.push(makeEntry(tool.name, "mcp", tool, { deprecated: deprecatedNames.has(tool.name), authorized: authorize(tool.name, toolset) }));
  for (const [name, alias] of Object.entries(aliases)) {
    const target = canonical.get(alias.name); if (!target) throw catalogError("catalog_unclassified_entry", `${name} (alias target ${alias.name} missing)`);
    entries.push(makeEntry(name, target.category, target.tool, { aliasOf: alias.name, deprecated: false, authorized: authorize(alias.name, toolset) }));
  }
  const names = new Set();
  for (const entry of entries) { if (names.has(entry.id)) throw catalogError("catalog_unclassified_entry", `duplicate ${entry.id}`); names.add(entry.id); }
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  return entries;
}
function authorize(name, toolset) { return !toolset || toolset.members.has(name); }
function makeEntry(id, category, tool, { hidden = false, deprecated = false, aliasOf = null, authorized = true } = {}) {
  if (!CATEGORIES.includes(category)) throw catalogError("catalog_unclassified_entry", id);
  const canonical = aliasOf || id;
  const risk = TOOL_RISKS[canonical];
  if (!risk) throw catalogError("catalog_unclassified_entry", `${id} (risk missing)`);
  const theme = TOOL_THEMES[canonical];
  if (!theme || !THEME_DEFINITIONS.some((definition) => definition.name === theme)) throw catalogError("catalog_unclassified_entry", `${id} (theme missing)`);
  return { id, category, theme, purpose: tool.shortHint || tool.description || "", risk, estimated_schema_chars: schemaMetric(tool.inputSchema), schema_handle: `${category}/${canonical}`, hidden, deprecated, alias_of: aliasOf, resident: RESIDENT_NAMES.includes(canonical), authorized, max_result_bytes: route2GateEnabled() ? (TOOL_MAX_RESULT_BYTES[canonical] || null) : null };
}
function findSchema({ entries, category, handle, capabilityLease = null, allowSelfEscalation = false, now = Date.now() }) {
  if (typeof handle !== "string" || !/^(memory|tool|mcp|skill)\/[^/]+$/.test(handle)) throw catalogError("catalog_invalid_handle", String(handle));
  if (!handle.startsWith(`${category}/`)) throw catalogError("catalog_handle_category_mismatch", handle);
  const matches = entries.filter((item) => item.schema_handle === handle && !item.alias_of);
  if (matches.length > 1) throw catalogError("catalog_duplicate_handle", handle);
  const entry = matches[0];
  if (!entry) throw catalogError("catalog_unknown_handle", handle);
  if (entry.category !== category) throw catalogError("catalog_handle_category_mismatch", handle);
  if (!entry.authorized && !allowSelfEscalation) throw catalogError("catalog_schema_not_authorized", handle);
  assertCapabilityLease(capabilityLease, entry.id, now);
  return entry;
}
function assertCapabilityLease(lease, toolName, now = Date.now()) {
  if (!route2GateEnabled() || !lease || typeof lease !== "object") return;
  const members = Array.isArray(lease.toolNames) ? lease.toolNames : [];
  if (!members.includes(toolName)) return;
  if (lease.status !== "active" || !Number.isFinite(Number(lease.expiresAt)) || Number(now) >= Number(lease.expiresAt)) {
    throw catalogError("capability_lease_expired", toolName);
  }
}
module.exports = {
  CATEGORIES, RESIDENT_NAMES, TOOLSETS, TOOL_RISKS, TOOL_THEMES, TOOL_MAX_RESULT_BYTES, THEME_DEFINITIONS,
  CATALOG_INPUT_SCHEMA, catalogEnabled, subjectSigningEnabled, route2GateEnabled, resolveToolset,
  catalogError, classifyProjectTool, buildManifest, findSchema, assertCapabilityLease,
};
