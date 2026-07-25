"use strict";

const fs = require("fs");
const path = require("path");

const { DEFAULT_MAX_INBOUND_MEDIA_BYTES } = require("./telegram-media-descriptor");

const MEDIA_DIRS = Object.freeze({
  voice: "voice",
  audio: "audio",
  photo: "photos",
  sticker: "stickers",
});

class MediaInboxService {
  constructor({ config }) {
    this.config = config || {};
    this.maxInboundBytes = normalizePositiveInt(this.config.mediaInboxMaxBytes)
      || DEFAULT_MAX_INBOUND_MEDIA_BYTES;
  }

  async processInboundMedia({ normalized, channelAdapter, log = null }) {
    const descriptors = Array.isArray(normalized?.telegram?.media)
      ? normalized.telegram.media
      : legacyDescriptors(normalized);
    for (const descriptor of descriptors) {
      await this.processDescriptor({ normalized, descriptor, channelAdapter, log });
    }
  }

  async processInboundPhoto(args) {
    return this.processDescriptor({
      ...args,
      descriptor: args?.normalized?.telegram?.photo,
    });
  }

  async processDescriptor({ normalized, descriptor, channelAdapter, log = null }) {
    if (!isSafeDescriptor(descriptor) || typeof channelAdapter?.fetchFileById !== "function") return;
    if (!Array.isArray(normalized.attachments)) normalized.attachments = [];
    const attachmentKey = `${normalized.messageId}:${descriptor.kind}:${descriptor.fileId}`;
    if (normalized.attachments.some((item) => item.sourceRef === attachmentKey)) return;
    if (descriptor.sizeBytes > this.maxInboundBytes) {
      writeMediaLog(log, `${descriptor.kind} inbound skipped messageId=${normalized.messageId} limit=${this.maxInboundBytes}`);
      return;
    }
    const stateDir = normalizeText(this.config.stateDir);
    if (!stateDir) {
      writeMediaLog(log, `${descriptor.kind} inbound skipped messageId=${normalized.messageId} reason=state_dir_missing`);
      return;
    }
    let partPath = "";
    try {
      const mediaDir = path.join(stateDir, "media", MEDIA_DIRS[descriptor.kind]);
      fs.mkdirSync(mediaDir, { recursive: true });
      const fileName = buildSafeFileName(normalized, descriptor);
      const finalPath = resolveUniqueTargetPath(mediaDir, fileName);
      partPath = `${finalPath}.part`;
      const fetched = await channelAdapter.fetchFileById({
        fileId: descriptor.fileId,
        maxSizeBytes: this.maxInboundBytes,
      });
      if (!fetched?.bytes?.length || fetched.bytes.length > this.maxInboundBytes) {
        throw new Error("media payload exceeds size limit or is empty");
      }
      const fd = fs.openSync(partPath, "wx");
      try {
        fs.writeFileSync(fd, fetched.bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(partPath, finalPath);
      const relativePath = path.relative(stateDir, finalPath).replace(/\\/g, "/");
      normalized.attachments.push({
        kind: descriptor.kind,
        type: descriptor.kind,
        contentType: descriptor.contentType,
        isImage: descriptor.kind === "photo" || (descriptor.kind === "sticker" && descriptor.stickerType === "webp"),
        fileName: path.basename(finalPath),
        absolutePath: finalPath,
        path: finalPath,
        relativePath,
        sourceRef: attachmentKey,
        sourceFileId: descriptor.fileId,
        sizeBytes: fetched.sizeBytes,
        durationSec: descriptor.durationSec,
        width: descriptor.width,
        height: descriptor.height,
        stickerType: descriptor.stickerType,
        downloadState: "saved",
      });
    } catch (error) {
      writeMediaLog(log, `${descriptor.kind} inbound failed messageId=${normalized.messageId} error=${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (partPath) {
        try { fs.rmSync(partPath, { force: true }); } catch {}
      }
    }
  }
}

function legacyDescriptors(normalized) {
  return [normalized?.telegram?.photo, normalized?.telegram?.voice, normalized?.telegram?.audio, normalized?.telegram?.sticker].filter(Boolean);
}

function isSafeDescriptor(descriptor) {
  return Boolean(descriptor && MEDIA_DIRS[descriptor.kind] && normalizeText(descriptor.fileId) && /^\.[a-z0-9]{1,8}$/i.test(descriptor.extension || ""));
}

function buildSafeFileName(normalized, descriptor) {
  const day = normalizeDay(normalized?.receivedAt);
  const messageId = normalizeText(normalized?.messageId).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80) || "message";
  return `${day}-${messageId}-${descriptor.kind}${descriptor.extension}`;
}

function resolveUniqueTargetPath(targetDir, fileName) {
  const parsed = path.parse(fileName);
  let candidate = path.join(targetDir, `${parsed.name}${parsed.ext}`);
  let suffix = 1;
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.part`)) {
    candidate = path.join(targetDir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

function normalizeDay(receivedAt) {
  const date = receivedAt ? new Date(receivedAt) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
}

function writeMediaLog(log, message) {
  if (typeof log !== "function") return;
  try { log(message); } catch {}
}

function normalizePositiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

module.exports = {
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  MediaInboxService,
  writeMediaLog,
};
