"use strict";

const fs = require("fs");
const path = require("path");

const { summarizeUsageTokens } = require("./events");

// Why this file exists
// -------------------
// /status used to read context usage out of an in-memory map that is only ever
// written when the child emits an `assistant` message carrying a usage block.
// Nothing writes it at process start, at turn start, or at relaunch — so the
// number was empty after a bot restart and pre-relaunch after an escalation, and
// it only became right again once the Owner sent another message ("要等发完一条
// 消息才正确", 2026-08-06).
//
// The child cannot be asked for the figure: its startup handshake carries no
// usage of any kind (probed 2026-08-07), and any query that would produce one
// costs a real inference call and writes a turn into her conversation.
//
// But Claude Code already keeps the answer on disk. Every session has a JSONL
// transcript, one entry per message, and every assistant entry carries the usage
// block. A relaunch is `--resume <session>`, so the new child's context IS that
// transcript — reading its last usage tells us what the *current* process is
// carrying, for free, without waiting for her to say anything.
const TAIL_BYTES = 256 * 1024;

// The transcript lives at <configRoot>/projects/<slug>/<sessionId>.jsonl, where
// <slug> is a lossy encoding of the child's cwd. We look the file up by session
// id instead of recomputing that slug: the id is unique within the config root,
// and a naming scheme we neither own nor version is exactly the kind of thing
// that changes under us without notice.
function resolveTranscriptPath({ configRoot, sessionId }, { fsImpl = fs } = {}) {
  const root = typeof configRoot === "string" ? configRoot.trim() : "";
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!root || !id) {
    return "";
  }
  const projectsDir = path.join(root, "projects");
  let entries;
  try {
    entries = fsImpl.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return "";
  }
  const fileName = `${id}.jsonl`;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(projectsDir, entry.name, fileName);
    try {
      if (fsImpl.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not in this project dir; keep looking.
    }
  }
  return "";
}

function readTailUtf8(filePath, maxBytes, fsImpl) {
  const fd = fsImpl.openSync(filePath, "r");
  try {
    const size = fsImpl.fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) {
      return { text: "", truncatedHead: false };
    }
    const buffer = Buffer.alloc(length);
    fsImpl.readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString("utf8"), truncatedHead: start > 0 };
  } finally {
    fsImpl.closeSync(fd);
  }
}

// Last recorded usage for a session, or null. Read-only and fail-open in every
// direction: a missing file, an unreadable one, a transcript with no assistant
// entry yet, or a torn line all yield null rather than throwing — /status must
// never fail because a diagnostic field could not be resolved.
function readLastSessionUsage(filePath, { fsImpl = fs, tailBytes = TAIL_BYTES } = {}) {
  const target = typeof filePath === "string" ? filePath.trim() : "";
  if (!target) {
    return null;
  }
  let tail;
  try {
    tail = readTailUtf8(target, tailBytes, fsImpl);
  } catch {
    return null;
  }
  const lines = tail.text.split(/\r?\n/);
  // Reading a tail can slice the first line in half. Dropping it costs one entry
  // out of the window and beats parsing a fragment into a wrong number.
  if (tail.truncatedHead) {
    lines.shift();
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry?.message?.usage;
    if (!usage || typeof usage !== "object") {
      continue;
    }
    const summary = summarizeUsageTokens(usage);
    if (!Number.isFinite(summary.currentTokens) || summary.currentTokens <= 0) {
      continue;
    }
    const at = Date.parse(entry?.timestamp || "");
    return {
      ...summary,
      at: Number.isNaN(at) ? null : at,
    };
  }
  return null;
}

// Convenience: path lookup + read, for callers that only hold configRoot and the
// session id. Returns null whenever the answer cannot be established honestly.
function readSessionContextUsage({ configRoot, sessionId }, options = {}) {
  const filePath = resolveTranscriptPath({ configRoot, sessionId }, options);
  if (!filePath) {
    return null;
  }
  return readLastSessionUsage(filePath, options);
}

module.exports = {
  resolveTranscriptPath,
  readLastSessionUsage,
  readSessionContextUsage,
  TAIL_BYTES,
};
