const {
  STICKER_DESC_GUIDANCE,
  STICKER_TAG_GUIDANCE,
} = require("../services/sticker-service");
const { formatAppDateTime } = require("../utils/app-time");

// Subject provenance rides on the inbound message as non-enumerable properties
// so it never leaks into the message's own serialization -- but that is exactly
// why every rebuild below drops it: object spread and field-by-field clones copy
// own *enumerable* properties only. Losing it is silent and fatal: with no
// source entry id, `issueSubjectCapabilityForTurnFailOpen` returns null, no
// capability is ever recorded for the turn, and the child's submit dies at
// `subject_signing_turn_unknown`. Every rebuild must carry it forward
// explicitly, preserving non-enumerability.
const SUBJECT_PROVENANCE_KEYS = ["subjectSourceEntryId", "subjectSourceEvidence"];

function carrySubjectProvenance(target, source) {
  if (!target || typeof target !== "object" || !source || typeof source !== "object") {
    return target;
  }
  for (const key of SUBJECT_PROVENANCE_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    Object.defineProperty(target, key, { value, enumerable: false, configurable: true });
  }
  return target;
}

function buildInboundDraft(normalized, { attachments = [], attachmentFailures = [] } = {}) {
  const originalText = normalizeText(normalized?.text);
  return carrySubjectProvenance({
    ...normalized,
    originalText,
    text: originalText,
    attachments: Array.isArray(attachments) ? attachments : [],
    attachmentFailures: Array.isArray(attachmentFailures) ? attachmentFailures : [],
    attachmentVisionContexts: normalizeAttachmentVisionContexts(normalized?.attachmentVisionContexts),
  }, normalized);
}

function buildMergedInboundPrepared({
  bindingKey,
  workspaceRoot,
  messages = [],
  trailingPrepared = null,
}) {
  const queued = Array.isArray(messages) ? messages.filter((message) => message && typeof message === "object") : [];
  const latest = trailingPrepared || queued[queued.length - 1] || {};
  const originalTexts = queued
    .map((message) => normalizeText(message.originalText))
    .filter(Boolean);
  const trailingText = normalizeText(trailingPrepared?.originalText);
  if (trailingText) {
    originalTexts.push(trailingText);
  }
  const attachments = queued.flatMap((message) => Array.isArray(message.attachments) ? message.attachments : []);
  const attachmentFailures = queued.flatMap((message) => Array.isArray(message.attachmentFailures) ? message.attachmentFailures : []);
  const attachmentVisionContexts = [
    ...queued.flatMap((message) => normalizeAttachmentVisionContexts(message?.attachmentVisionContexts)),
    ...normalizeAttachmentVisionContexts(trailingPrepared?.attachmentVisionContexts),
  ].slice(0, 10);
  const originalText = originalTexts.join("\n\n");

  // A merged batch cites the newest inbound entry -- the same message `latest`
  // supplies every other field from.
  return carrySubjectProvenance({
    bindingKey,
    workspaceRoot,
    ...latest,
    originalText,
    text: originalText,
    attachments,
    attachmentFailures,
    attachmentVisionContexts,
  }, latest);
}

function assembleRuntimeTurnText({ prepared, config = {}, visionContext = {}, memoryContext = {} }) {
  const lines = [];
  const localTime = formatWechatLocalTime(prepared?.receivedAt);
  const originalText = normalizeText(prepared?.originalText ?? prepared?.text);
  const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
  const attachmentFailures = Array.isArray(prepared?.attachmentFailures) ? prepared.attachmentFailures : [];
  const imageAttachments = attachments.filter((item) => isImageAttachmentItem(item));
  const visualItems = Array.isArray(visionContext.items) ? visionContext.items : [];
  const visionErrors = Array.isArray(visionContext.errors) ? visionContext.errors : [];
  const memoryLines = Array.isArray(memoryContext.lines) ? memoryContext.lines : [];

  if (memoryLines.length) {
    lines.push("Retrieved memory context:");
    for (const line of memoryLines) lines.push(`- ${line}`);
  }

  if (localTime) {
    lines.push(`[${localTime}]`);
  }
  if (originalText) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(originalText);
  }

  if (attachments.length) {
    pushSectionBreak(lines);
    lines.push("Saved attachments:");
    for (const item of attachments) {
      const suffix = item.sourceFileName ? ` (original name: ${item.sourceFileName})` : "";
      lines.push(`- [${item.kind || "attachment"}] ${item.absolutePath}${suffix}`);
    }
    lines.push("Use the saved local files if they are needed for the request.");
  }

  if (visualItems.length) {
    pushSectionBreak(lines);
    lines.push("Visual context from attachments:");
    for (const item of visualItems) {
      const source = normalizeText(item.absolutePath) || normalizeText(item.sourceFileName) || "image";
      lines.push(`- ${source}: ${normalizeText(item.description)}`);
    }
  }

  if (imageAttachments.length) {
    pushSectionBreak(lines);
    lines.push(`If some images are reusable stickers, load \`cyberboss_sticker_tags\` only when needed. ${STICKER_TAG_GUIDANCE}`);
    lines.push(`To save reusable stickers, call \`cyberboss_sticker_save_from_inbox\` once with an \`items\` array. Use 1-3 tags. ${STICKER_DESC_GUIDANCE} Skip ordinary photos, screenshots, and unclear images.`);
    lines.push("Do not describe save steps. The system sends the sticker notice.");
  }

  if (attachmentFailures.length || visionErrors.length) {
    pushSectionBreak(lines);
    lines.push("Attachment intake errors:");
    for (const item of attachmentFailures) {
      const label = item.sourceFileName || item.kind || "attachment";
      lines.push(`- ${label}: ${item.reason}`);
    }
    for (const item of visionErrors) {
      const label = item.absolutePath || item.sourceFileName || item.kind || "image";
      lines.push(`- ${label}: ${item.reason}`);
    }
  }

  return lines.join("\n").trim();
}

function shouldBatchImageOnlyInbound(message) {
  const originalText = normalizeText(message?.originalText);
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentFailures = Array.isArray(message?.attachmentFailures) ? message.attachmentFailures : [];
  return !originalText
    && attachments.length > 0
    && attachments.every((item) => isImageAttachmentItem(item))
    && attachmentFailures.length === 0;
}

function takeImageOnlyBatchMessages(messages, maxAttachments) {
  const batchMessages = [];
  const remainingMessages = [];
  let remainingCapacity = Math.max(1, Number(maxAttachments) || 1);

  for (const message of Array.isArray(messages) ? messages : []) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const contexts = normalizeAttachmentVisionContexts(message?.attachmentVisionContexts);
    if (!attachments.length) {
      continue;
    }
    if (remainingCapacity <= 0) {
      remainingMessages.push(message);
      continue;
    }
    if (attachments.length <= remainingCapacity) {
      batchMessages.push(message);
      remainingCapacity -= attachments.length;
      continue;
    }
    batchMessages.push({
      ...message,
      attachments: attachments.slice(0, remainingCapacity),
      attachmentVisionContexts: contexts.slice(0, remainingCapacity),
    });
    remainingMessages.push({
      ...message,
      attachments: attachments.slice(remainingCapacity),
      attachmentVisionContexts: contexts.slice(remainingCapacity),
    });
    remainingCapacity = 0;
  }

  return {
    batchMessages,
    remainingMessages,
  };
}

function clonePreparedInboundMessage(prepared) {
  return carrySubjectProvenance({
    workspaceId: prepared.workspaceId,
    accountId: prepared.accountId,
    senderId: prepared.senderId,
    // Route lane fields. Without them a buffered/merged message loses its topic
    // and its reply would fall back to the chat's default lane.
    chatId: prepared.chatId ?? prepared.telegram?.chatId ?? "",
    messageThreadId: prepared.messageThreadId ?? prepared.telegram?.messageThreadId ?? null,
    messageId: prepared.messageId,
    contextToken: prepared.contextToken,
    provider: prepared.provider,
    originalText: prepared.originalText,
    text: prepared.text,
    attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
    attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
    attachmentVisionContexts: normalizeAttachmentVisionContexts(prepared?.attachmentVisionContexts),
    receivedAt: prepared.receivedAt,
  }, prepared);
}

function isPlainTextPreparedMessage(prepared) {
  const originalText = normalizeText(prepared?.originalText);
  const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
  const attachmentFailures = Array.isArray(prepared?.attachmentFailures) ? prepared.attachmentFailures : [];
  return Boolean(originalText) && attachments.length === 0 && attachmentFailures.length === 0;
}

function isImageAttachmentItem(item) {
  return Boolean(item?.isImage) || normalizeText(item?.contentType).toLowerCase().startsWith("image/")
    || normalizeText(item?.kind).toLowerCase() === "image";
}

function normalizeAttachmentVisionContexts(value) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim())
    .slice(0, 10);
}

function pushSectionBreak(lines) {
  if (lines.length) {
    lines.push("");
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return formatAppDateTime(parsed);
}

module.exports = {
  assembleRuntimeTurnText,
  buildInboundDraft,
  buildMergedInboundPrepared,
  carrySubjectProvenance,
  clonePreparedInboundMessage,
  isImageAttachmentItem,
  isPlainTextPreparedMessage,
  normalizeAttachmentVisionContexts,
  shouldBatchImageOnlyInbound,
  takeImageOnlyBatchMessages,
};
