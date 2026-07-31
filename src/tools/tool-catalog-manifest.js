"use strict";

const CATEGORIES = ["memory", "tool", "mcp", "skill"];
const RESIDENT_NAMES = ["cyberboss_system_send", "cyberboss_time"];
const TOOLSETS = { "chat-core@1": ["memory_lookup", "memory_note", "cyberboss_reminder", "cyberboss_diary_append", "cyberboss_system_send", "cyberboss_time"] };
// Explicit policy data: risk is reviewed per canonical tool, never inferred from
// spelling at runtime. Aliases inherit their canonical target's value.
const TOOL_RISKS = Object.freeze({
  memory_lookup: "read", memory_note: "append",
  cyberboss_channel_send_file: "send", cyberboss_diary_append: "append", cyberboss_reminder: "append",
  cyberboss_sleep_mode: "mutate", cyberboss_sticker_delete: "mutate", cyberboss_sticker_pick: "read",
  cyberboss_sticker_save_from_inbox: "append", cyberboss_sticker_send: "send", cyberboss_sticker_tags: "read",
  cyberboss_sticker_update: "mutate", cyberboss_system_send: "send", cyberboss_telegram_send: "send",
  cyberboss_telegram_send_file: "send", cyberboss_telegram_send_voice: "send", cyberboss_time: "read",
  cyberboss_timeline_build: "mutate", cyberboss_timeline_categories: "read", cyberboss_timeline_dev: "admin",
  cyberboss_timeline_proposals: "read", cyberboss_timeline_read: "read", cyberboss_timeline_screenshot: "read",
  cyberboss_timeline_serve: "admin", cyberboss_timeline_write: "mutate", github_file_upload: "mutate",
  github_issue_open: "mutate", github_pr_open: "mutate", github_repo_create: "admin",
  location_debug_snapshot: "admin", location_event_dashboard: "admin", weather: "read",
  whereabouts_current_stay: "read", whereabouts_recent_moves: "read", whereabouts_recent_stays: "read",
  whereabouts_snapshot: "read", whereabouts_summary: "read",
});

function catalogEnabled(env = process.env) { return env.CYBERBOSS_TOOL_CATALOG_ENABLED === "true"; }
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
  return { id, category, purpose: tool.shortHint || tool.description || "", risk, estimated_schema_chars: schemaMetric(tool.inputSchema), schema_handle: `${category}/${canonical}`, hidden, deprecated, alias_of: aliasOf, resident: RESIDENT_NAMES.includes(canonical), authorized, max_result_bytes: null };
}
function findSchema({ entries, category, handle }) {
  if (typeof handle !== "string" || !/^(memory|tool|mcp|skill)\/[^/]+$/.test(handle)) throw catalogError("catalog_invalid_handle", String(handle));
  if (!handle.startsWith(`${category}/`)) throw catalogError("catalog_handle_category_mismatch", handle);
  const entry = entries.find((item) => item.schema_handle === handle);
  if (!entry) throw catalogError("catalog_unknown_handle", handle);
  if (entry.category !== category) throw catalogError("catalog_handle_category_mismatch", handle);
  if (!entry.authorized) throw catalogError("catalog_schema_not_authorized", handle);
  return entry;
}
module.exports = { CATEGORIES, RESIDENT_NAMES, TOOLSETS, TOOL_RISKS, catalogEnabled, resolveToolset, catalogError, classifyProjectTool, buildManifest, findSchema };
