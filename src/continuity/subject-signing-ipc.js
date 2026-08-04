"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const SUBJECT_SIGNING_REQUEST = "subject-signing.submit";
const SUBJECT_SIGNING_RESPONSE = "subject-signing.submit.result";
const SUBJECT_PROFILE_ID = "fable-chat";

class SubjectSigningBroker {
  constructor({
    enabled = false,
    subjectCandidateService = null,
    subjectCapabilityByRunKey = null,
    runtimeContextStore = null,
    maxReplayEntries = 2048,
  } = {}) {
    this.enabled = enabled === true;
    this.subjectCandidateService = subjectCandidateService;
    this.subjectCapabilityByRunKey = subjectCapabilityByRunKey;
    this.runtimeContextStore = runtimeContextStore;
    this.maxReplayEntries = maxReplayEntries;
    this.seenRequestIds = new Set();
  }

  submit({ requestId = "", args = {}, coordinates = {} } = {}) {
    if (!this.enabled || !this.subjectCandidateService || !this.subjectCapabilityByRunKey) {
      throw signingIpcError("subject_signing_disabled");
    }
    const normalizedRequestId = requireText(requestId, "subject_signing_ipc_request_id_missing");
    if (this.seenRequestIds.has(normalizedRequestId)) {
      throw signingIpcError("subject_signing_ipc_replay");
    }
    this.rememberRequestId(normalizedRequestId);

    const routeToken = requireText(coordinates.routeToken, "subject_signing_route_token_missing");
    const active = this.runtimeContextStore?.resolveActiveContext?.({ routeToken }) || null;
    if (!active || active.turnActive !== true) {
      throw signingIpcError("subject_signing_turn_inactive");
    }
    assertCoordinateMatches(coordinates, active);

    const threadId = requireText(active.threadId, "subject_signing_thread_missing");
    const turnId = requireText(active.turnId, "subject_signing_turn_missing");
    const signing = this.subjectCapabilityByRunKey.get(buildRunKey(threadId, turnId)) || null;
    const subjectRoute = signing?.subject_route || null;
    const capability = signing?.capability || null;
    if (!subjectRoute || !capability) {
      throw signingIpcError("subject_signing_turn_unknown");
    }
    assertAuthoritativeRoute({ active, routeToken, subjectRoute });

    const result = this.subjectCandidateService.createSubjectCandidate({
      ...args,
      capability_id: capability.capability_id,
      subject_turn_id: capability.subject_turn_id,
      subject_route: subjectRoute,
      source_ref: {
        ...args.source_ref,
        source_entry_ids: Array.isArray(subjectRoute.source_entry_ids)
          ? subjectRoute.source_entry_ids
          : [],
      },
    });
    return sanitizeResult(result);
  }

  rememberRequestId(requestId) {
    this.seenRequestIds.add(requestId);
    while (this.seenRequestIds.size > this.maxReplayEntries) {
      this.seenRequestIds.delete(this.seenRequestIds.values().next().value);
    }
  }
}

class SubjectSigningIpcClient {
  constructor({ stateDir = "", timeoutMs = 5000, requestIdFactory = () => crypto.randomUUID() } = {}) {
    this.stateDir = normalizeText(stateDir);
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    this.requestIdFactory = requestIdFactory;
  }

  async submit(args, context = {}) {
    if (!this.stateDir) throw signingIpcError("subject_signing_ipc_state_dir_required");
    let endpoint;
    let token;
    try {
      endpoint = JSON.parse(fs.readFileSync(path.join(this.stateDir, "claudecode-runtime.json"), "utf8"));
      token = fs.readFileSync(endpoint.tokenFile, "utf8").trim();
    } catch {
      throw signingIpcError("subject_signing_ipc_unavailable");
    }
    if (!endpoint?.host || !Number.isInteger(endpoint?.port) || !token) {
      throw signingIpcError("subject_signing_ipc_unavailable");
    }
    const requestId = requireText(this.requestIdFactory(), "subject_signing_ipc_request_id_missing");
    const coordinates = pickCoordinates(context);
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      let buffer = "";
      let finished = false;
      const timer = setTimeout(
        () => finish(signingIpcError("subject_signing_ipc_timeout")),
        this.timeoutMs,
      );
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ type: "auth", token })}\n`);
        socket.write(`${JSON.stringify({
          type: SUBJECT_SIGNING_REQUEST,
          requestId,
          args,
          coordinates,
        })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message?.type === "auth.result" && message.error) {
            finish(signingIpcError("subject_signing_ipc_auth_failed"));
            return;
          }
          if (message?.type !== SUBJECT_SIGNING_RESPONSE || message.requestId !== requestId) continue;
          if (message.error) finish(signingIpcError(message.error));
          else finish(null, message.result);
          return;
        }
      });
      socket.on("error", () => finish(signingIpcError("subject_signing_ipc_unavailable")));
      socket.on("close", () => {
        if (!finished) finish(signingIpcError("subject_signing_ipc_unavailable"));
      });
    });
  }
}

function assertCoordinateMatches(coordinates, active) {
  for (const field of [
    "runtimeId", "workspaceRoot", "routeToken", "laneKey", "threadId",
    "bindingKey", "turnId", "accountId", "senderId", "provider",
  ]) {
    const supplied = requireText(coordinates[field], `subject_signing_coordinate_${field}_missing`);
    const authoritative = requireText(active[field], `subject_signing_authority_${field}_missing`);
    if (supplied !== authoritative) throw signingIpcError("subject_signing_identity_mismatch");
  }
}

function assertAuthoritativeRoute({ active, routeToken, subjectRoute }) {
  if (subjectRoute.provider !== "telegram"
    || subjectRoute.session?.profile_id !== SUBJECT_PROFILE_ID
    || subjectRoute.session?.runtime_id !== active.runtimeId
    || subjectRoute.session?.session_slot_key !== routeToken
    || subjectRoute.session?.runtime_thread_id !== active.threadId
    || subjectRoute.author_turn_id !== active.turnId
    || subjectRoute.route_lane?.lane_key !== active.laneKey
    || subjectRoute.continuity_binding?.binding_key !== active.bindingKey
    || subjectRoute.continuity_binding?.account_id !== active.accountId
    || subjectRoute.continuity_binding?.sender_id !== active.senderId) {
    throw signingIpcError("subject_signing_identity_mismatch");
  }
}

function sanitizeResult(result) {
  return Object.freeze({
    status: normalizeText(result?.status) || "unknown",
    candidate_id: normalizeText(result?.candidate?.candidate_id),
    idempotency_key: normalizeText(result?.candidate?.idempotency_key),
  });
}

function pickCoordinates(context) {
  return Object.freeze(Object.fromEntries([
    "runtimeId", "workspaceRoot", "routeToken", "laneKey", "threadId",
    "bindingKey", "turnId", "accountId", "senderId", "provider",
  ].map((field) => [field, normalizeText(context?.[field])])));
}

function buildRunKey(threadId, turnId) {
  return `${normalizeText(threadId)}:${normalizeText(turnId)}`;
}

function requireText(value, code) {
  const text = normalizeText(value);
  if (!text) throw signingIpcError(code);
  return text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function signingIpcError(code) {
  const normalized = normalizeText(code) || "subject_signing_ipc_failed";
  const error = new Error(normalized);
  error.code = normalized;
  return error;
}

module.exports = {
  SUBJECT_PROFILE_ID,
  SUBJECT_SIGNING_REQUEST,
  SUBJECT_SIGNING_RESPONSE,
  SubjectSigningBroker,
  SubjectSigningIpcClient,
  pickCoordinates,
  signingIpcError,
};
