"use strict";

// Classification contract (deliberately static; never inferred at runtime):
// - memory: PROJECT_TOOLS whose declared topics include "memory"; these are
//   the continuity/memory surface.
// - tool: every other PROJECT_TOOLS entry; it is implemented in tool-host.js.
// - mcp: entries returned by createExtraToolHosts(); their source is an
//   external MCP host (whereabouts-mcp), rather than PROJECT_TOOLS.
// - skill: reserved for a future explicit skill catalog; no current source
//   produces one, so it is intentionally empty.
// Aliases are catalogued as tool entries because TOOL_ALIASES is declared in
// tool-host.js; deprecated aliases remain visible here as historical entries.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  PROJECT_TOOLS, TOOL_ALIASES, DEPRECATED_HIDDEN_TOOL_NAMES, createExtraToolHosts,
} = require("../../src/tools/tool-host");
const { buildManifest, resolveToolset } = require("../../src/tools/tool-catalog-manifest");

const CATEGORIES = ["memory", "tool", "mcp", "skill"];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function metric(value) {
  const text = canonicalJson(value || {});
  return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
}

function classifyProjectTool(tool) {
  return Array.isArray(tool.topics) && tool.topics.includes("memory") ? "memory" : "tool";
}

function makeItem({ category, name, namespace, schema, description, hidden = false, deprecated = false, aliasOf = null }) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unclassified catalog entry: ${name}`);
  const schemaMetric = metric(schema);
  return {
    category, name, namespace, hidden, deprecated, alias_of: aliasOf,
    schema_chars: schemaMetric.chars, schema_bytes: schemaMetric.bytes,
    description_chars: String(description || "").length,
    has_max_result_bytes: false, max_result_bytes: null,
  };
}

function buildCatalog({ projectTools = PROJECT_TOOLS, aliases = TOOL_ALIASES, extraHosts = createExtraToolHosts({ whereabouts: {} }) } = {}) {
  const canonical = new Map();
  for (const tool of projectTools) {
    const category = classifyProjectTool(tool);
    canonical.set(tool.name, { category, schema: tool.inputSchema, description: tool.shortHint || tool.description, hidden: tool.hidden === true });
  }
  const items = [...canonical.entries()].map(([name, tool]) => makeItem({ ...tool, name, namespace: "cyberboss" }));
  for (const host of extraHosts) {
    for (const tool of host.listTools()) {
      items.push(makeItem({ category: "mcp", name: tool.name, namespace: "whereabouts", schema: tool.inputSchema, description: tool.description, deprecated: DEPRECATED_HIDDEN_TOOL_NAMES.has(tool.name) }));
    }
  }
  for (const [name, alias] of Object.entries(aliases)) {
    const target = canonical.get(alias.name);
    if (!target) throw new Error(`Unclassified catalog entry: ${name} (alias target ${alias.name} missing)`);
    items.push(makeItem({ ...target, name, namespace: "cyberboss", deprecated: DEPRECATED_HIDDEN_TOOL_NAMES.has(name), aliasOf: alias.name }));
  }
  const names = new Set();
  for (const item of items) {
    const key = `${item.category}\u0000${item.name}`;
    if (names.has(key)) throw new Error(`Unclassified catalog entry: duplicate ${item.name}`);
    names.add(key);
  }
  items.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const categories = Object.fromEntries(CATEGORIES.map((category) => [category, { item_count: items.filter((item) => item.category === category).length }]));
  const totals = items.reduce((sum, item) => ({
    item_count: sum.item_count + 1, schema_chars: sum.schema_chars + item.schema_chars, schema_bytes: sum.schema_bytes + item.schema_bytes,
  }), { item_count: 0, schema_chars: 0, schema_bytes: 0 });
  const withoutHashes = { schema_version: 1, generated_by: "scripts/audit/catalog-metering.js", categories, items, totals };
  const catalogText = canonicalJson(withoutHashes);
  totals.catalog_chars = catalogText.length;
  totals.catalog_bytes = Buffer.byteLength(catalogText, "utf8");
  const output = { ...withoutHashes, items_hash: sha256(canonicalJson(items)) };
  output.catalog_hash = sha256(canonicalJson(withoutHashes));
  return output;
}

function buildResidentCatalog({ toolset = null } = {}) {
  const full = buildCatalog();
  const resolved = resolveToolset(toolset || "");
  const entries = buildManifest({ projectTools: PROJECT_TOOLS, aliases: TOOL_ALIASES, extraHosts: createExtraToolHosts({ whereabouts: {} }), deprecatedNames: DEPRECATED_HIDDEN_TOOL_NAMES })
    .map((entry) => ({ ...entry, authorized: !resolved || resolved.members.has(entry.alias_of || entry.id) }));
  const residentTools = PROJECT_TOOLS.filter((tool) => ["cyberboss_system_send", "cyberboss_time"].includes(tool.name)).map((tool) => ({ name: tool.name, schema_chars: metric(tool.inputSchema).chars, schema_bytes: metric(tool.inputSchema).bytes }));
  const list = ["memory", "tool", "mcp", "skill"].map((category) => ({ name: `cyberboss_catalog_${category}`, description: `${entries.filter((entry) => entry.category === category).length} ${category} catalog entries; optionally load an authorized schema by exact handle.`, inputSchema: { type: "object", properties: { handle: { type: "string" } }, additionalProperties: false } }))
    .concat(PROJECT_TOOLS.filter((tool) => ["cyberboss_system_send", "cyberboss_time"].includes(tool.name)).map((tool) => ({ name: tool.name, description: tool.shortHint || tool.description, inputSchema: tool.inputSchema })));
  const totals = { resident_item_count: residentTools.length, resident_schema_chars: residentTools.reduce((n, item) => n + item.schema_chars, 0), resident_schema_bytes: residentTools.reduce((n, item) => n + item.schema_bytes, 0), tools_list_chars: JSON.stringify(list).length, tools_list_bytes: Buffer.byteLength(JSON.stringify(list), "utf8") };
  const output = { schema_version: 1, generated_by: "scripts/audit/catalog-metering.js", surface: "resident", toolset: resolved?.id || null, resident_tools: residentTools, directory_entries: Object.fromEntries(CATEGORIES.map((category) => [category, entries.filter((item) => item.category === category).length])), totals, full_surface: { item_count: full.totals.item_count, schema_chars: full.totals.schema_chars, tools_list_chars: JSON.stringify(full.items).length } };
  output.resident_hash = sha256(canonicalJson(output));
  return output;
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const surfaceIndex = argv.indexOf("--surface");
  const surface = surfaceIndex >= 0 ? argv[surfaceIndex + 1] : "full";
  const toolsetIndex = argv.indexOf("--toolset");
  if (!["full", "resident"].includes(surface)) throw new Error("--surface must be full or resident");
  const outIndex = argv.indexOf("--out");
  const baselineIndex = argv.indexOf("--baseline");
  if (outIndex >= 0 && (!argv[outIndex + 1] || argv[outIndex + 1].startsWith("--"))) throw new Error("--out requires a path");
  const output = `${JSON.stringify(surface === "resident" ? buildResidentCatalog({ toolset: toolsetIndex >= 0 ? argv[toolsetIndex + 1] : "" }) : buildCatalog(), null, 2)}\n`;
  if (check) {
    const baselinePath = baselineIndex >= 0 ? path.resolve(argv[baselineIndex + 1]) : path.join(__dirname, surface === "resident" ? "../../test/fixtures/catalog-metering-resident.json" : "../../test/fixtures/catalog-metering-baseline.json");
    const baseline = fs.readFileSync(baselinePath, "utf8");
    // Compare with BOM/EOL normalized on both sides: git autocrlf checkouts hand
    // the fixture back with CRLF, which is a transport artifact, not a content
    // change. Any real content drift still fails closed.
    const normalizeTransport = (text) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (normalizeTransport(output) !== normalizeTransport(baseline)) { process.stderr.write("catalog-metering baseline mismatch\n"); process.exitCode = 1; return; }
  }
  if (outIndex >= 0) fs.writeFileSync(path.resolve(argv[outIndex + 1]), output, "utf8");
  else process.stdout.write(output);
}

if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { buildCatalog, buildResidentCatalog, canonicalJson, main };
