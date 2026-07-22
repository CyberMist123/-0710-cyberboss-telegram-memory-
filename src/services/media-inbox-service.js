"use strict";

const path = require("path");

// Telegram Bot API getFile refuses files above 20MB, so this is also the
// practical ceiling for anything downloadable through the bot token.
const DEFAULT_MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * Persist inbound Telegram photos under `<stateDir>/media/photos/inbox` and
 * record saved-file metadata on `normalized.attachments`.
 *
 * Never throws: download failures are logged and must not break the poller
 * loop. Oversized files are skipped before download.
 */
class MediaInboxService {
  constructor({ config }) {
    this.config = config || {};
    this.maxInboundBytes = normalizePositiveInt(this.config.mediaInboxMaxBytes)
      || DEFAULT_MAX_INBOUND_MEDIA_BYTES;
  }

  async processInboundPhoto({ normalized, channelAdapter, log = null }) {
    const photo = normalized?.telegram?.photo;
    if (!photo?.fileId || typeof channelAdapter?.downloadFileById !== "function") {
      return;
    }
    const mediaDir = normalizeText(this.config.photoMediaDir);
    if (!mediaDir) {
      return;
    }
    if (photo.sizeBytes > this.maxInboundBytes) {
      writeMediaLog(
        log,
        `photo inbound skipped messageId=${normalized.messageId} sizeBytes=${photo.sizeBytes} limit=${this.maxInboundBytes}`
      );
      return;
    }
    try {
      const saved = await channelAdapter.downloadFileById({
        fileId: photo.fileId,
        targetDir: path.join(mediaDir, "inbox"),
        fileName: buildInboundMediaFileName(normalized),
        maxSizeBytes: this.maxInboundBytes,
      });
      if (!Array.isArray(normalized.attachments)) {
        normalized.attachments = [];
      }
      normalized.attachments.push({
        kind: "photo",
        type: "photo",
        contentType: inferImageContentType(saved.fileName),
        isImage: true,
        sourceFileName: "",
        fileName: saved.fileName,
        absolutePath: saved.absolutePath,
        path: saved.absolutePath,
        relativePath: path.relative(mediaDir, saved.absolutePath).replace(/\\/g, "/"),
        sizeBytes: saved.sizeBytes,
        downloadState: "saved",
        width: photo.width || 0,
        height: photo.height || 0,
      });
    } catch (error) {
      writeMediaLog(
        log,
        `photo inbound failed messageId=${normalized.messageId} error=${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

function buildInboundMediaFileName(normalized) {
  const day = normalizeDay(normalized?.receivedAt);
  const messageId = normalizeText(normalized?.messageId) || String(Date.now());
  return `${day}-${messageId}`;
}

function normalizeDay(receivedAt) {
  const date = receivedAt ? new Date(receivedAt) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function inferImageContentType(fileName) {
  const extension = path.extname(normalizeText(fileName)).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
}

function writeMediaLog(log, message) {
  if (typeof log !== "function") {
    return;
  }
  try {
    log(message);
  } catch {}
}

function normalizePositiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

module.exports = {
  MediaInboxService,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  writeMediaLog,
};
