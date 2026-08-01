"use strict";

const crypto = require("node:crypto");
const { normalizeEffort, resolveEffortLevel } = require("./process-client");

const WINDOW_OVERRIDE_FLAG = "CYBERBOSS_CLAUDE_WINDOW_OVERRIDE_ENABLED";
const SOURCE_VALUES = new Set(["default", "profile_default", "command", "overlay", "self_escalation"]);
const SCOPE_VALUES = new Set(["window", "turn"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}$/;
const SENSITIVE_ID = /(?:^sk-[A-Za-z0-9]{16,}|^ghp_[A-Za-z0-9]{20,}|credential|password|secret|api[_-]?key|auth[_-]?token)/i;
const IDENTITY_FIELDS = ["personaSource", "permissionIdentity", "permissionMode"];

class WindowOverrideError extends Error {
  constructor(message, code = "window_override_invalid") {
    super(message);
    this.name = "WindowOverrideError";
    this.code = code;
  }
}

function windowOverrideEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.[WINDOW_OVERRIDE_FLAG] || "").trim());
}

function route2GateEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.CYBERBOSS_ROUTE2_GATE_ENABLED || "").trim());
}

function resolveWindowOverride(input = {}, { profile = null, env = process.env } = {}) {
  if (!windowOverrideEnabled(env)) return null;
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const field of IDENTITY_FIELDS) {
    if (Object.hasOwn(raw, field)) {
      throw new WindowOverrideError(
        `${field} is launch identity and requires a new window`,
        "window_override_identity_change_requires_new_window",
      );
    }
  }

  const launchModel = raw.model || profile?.model || "";
  const model = safeId(launchModel || "default", "model");
  const effort = normalizeEffort(raw.effort || profile?.effort)
    || resolveEffortLevel("", env);
  const effectiveToolset = safeId(raw.effectiveToolset || profile?.defaultToolset || "full", "effectiveToolset");
  const mcpNames = normalizeMcpNames(raw.effectiveMcpSet);
  const defaultMcpSet = safeId(profile?.defaultMcpServerSet || "runtime-default", "defaultMcpServerSet");
  const overlays = normalizeOverlays(raw.harnessOverlay);
  const capabilityLease = route2GateEnabled(env) ? normalizeCapabilityLease(raw.capabilityLease) : null;

  const entries = [
    traceEntry("model", model, raw.modelSource || (raw.model ? "command" : (profile?.model ? "profile_default" : "default")), raw.modelScope),
    traceEntry("effort", effort, raw.effortSource || (raw.effort ? "command" : (profile?.effort ? "profile_default" : "default")), raw.effortScope),
    traceEntry("effective_toolset", effectiveToolset, raw.toolsetSource || (raw.effectiveToolset ? "overlay" : (profile?.defaultToolset ? "profile_default" : "default")), raw.toolsetScope),
    traceEntry(
      "effective_mcp_set",
      mcpNames === null ? defaultMcpSet : `set:${mcpNames.length}`,
      raw.mcpSource || (mcpNames === null ? (profile?.defaultMcpServerSet ? "profile_default" : "default") : "overlay"),
      raw.mcpScope,
      mcpNames === null ? defaultMcpSet : mcpNames.join("\u0000"),
    ),
  ];
  for (const overlay of overlays) {
    entries.push(traceEntry(
      "harness_overlay",
      overlay.label,
      overlay.source,
      overlay.scope,
      `${overlay.label}\u0000${overlay.text}`,
      overlay.label,
    ));
  }
  if (capabilityLease) {
    entries.push(traceEntry(
      "capability_lease",
      capabilityLease.status,
      "self_escalation",
      "turn",
      JSON.stringify(capabilityLease),
    ));
  }

  const effective = Object.freeze({
    model: launchModel ? model : "",
    effort,
    effectiveToolset,
    effectiveMcpSet: mcpNames === null ? null : Object.freeze(mcpNames),
    harnessOverlay: Object.freeze(overlays),
    capabilityLease,
  });
  return Object.freeze({
    ...effective,
    fingerprint: token(JSON.stringify(effective)),
    trace: Object.freeze({
      scope: "window",
      entries: Object.freeze(entries),
      overlay_labels: Object.freeze(overlays.map((item) => item.label)),
    }),
  });
}

function normalizeCapabilityLease(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WindowOverrideError("capabilityLease must be an object");
  }
  const status = value.status === "active" ? "active" : "revoked";
  const toolNames = normalizeMcpNames(value.toolNames || []);
  const expiresAt = Number(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new WindowOverrideError("capabilityLease.expiresAt must be a positive timestamp");
  }
  return Object.freeze({
    id: safeId(value.id, "capabilityLease.id"),
    status,
    expiresAt,
    toolNames: Object.freeze(toolNames || []),
    sessionSlotKey: safeId(value.sessionSlotKey, "capabilityLease.sessionSlotKey"),
    windowId: safeId(value.windowId, "capabilityLease.windowId"),
  });
}

function applyHarnessOverlay(text, override) {
  const overlays = override?.harnessOverlay;
  if (!Array.isArray(overlays) || overlays.length === 0) return text;
  const blocks = overlays.map((item) => (
    `<harness_overlay label="${item.label}">\n${item.text}\n</harness_overlay>`
  ));
  return `${blocks.join("\n")}\n${String(text || "")}`;
}

function traceEntry(kind, value, source, scope = "window", tokenMaterial = value, overlayLabel = "") {
  const normalizedSource = SOURCE_VALUES.has(source) ? source : "overlay";
  const normalizedScope = SCOPE_VALUES.has(scope) ? scope : "window";
  return Object.freeze({
    kind,
    effective_value: value,
    effective_token: token(tokenMaterial),
    source: normalizedSource,
    scope: normalizedScope,
    ...(overlayLabel ? { overlay_label: overlayLabel } : {}),
  });
}

function normalizeMcpNames(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 32) {
    throw new WindowOverrideError("effectiveMcpSet must be an array with at most 32 server names");
  }
  const names = [...new Set(value.map((item) => safeId(item, "effectiveMcpSet member")))].sort();
  return names;
}

function normalizeOverlays(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 8) throw new WindowOverrideError("harnessOverlay has too many entries");
  return list.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WindowOverrideError("harnessOverlay entries must be objects");
    }
    const label = safeId(item.label, "harnessOverlay label");
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text || text.length > 8192) throw new WindowOverrideError("harnessOverlay text is empty or too long");
    return Object.freeze({
      label,
      text,
      source: SOURCE_VALUES.has(item.source) ? item.source : "overlay",
      scope: SCOPE_VALUES.has(item.scope) ? item.scope : "turn",
    });
  });
}

function safeId(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!SAFE_ID.test(text) || SENSITIVE_ID.test(text) || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/")) {
    throw new WindowOverrideError(`${field} is not a safe identifier`);
  }
  return text;
}

function token(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 24);
}

module.exports = {
  IDENTITY_FIELDS,
  WINDOW_OVERRIDE_FLAG,
  WindowOverrideError,
  applyHarnessOverlay,
  resolveWindowOverride,
  token,
  windowOverrideEnabled,
};
