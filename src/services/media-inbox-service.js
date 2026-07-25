"use strict";

const fs = require("fs");
const path = require("path");

const { DEFAULT_MAX_INBOUND_MEDIA_BYTES, createTelegramMediaDescriptor } = require("./telegram-media-descriptor");

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
      const mediaRoot = ensureStateMediaRoot(stateDir);
      const mediaDir = ensureMediaKindDirectory(mediaRoot, descriptor.kind);
      const fileName = buildSafeFileName(normalized, descriptor);
      const finalPath = resolveUniqueTargetPath(mediaDir, fileName);
      assertPathWithinMediaRoot(mediaRoot, finalPath);
      partPath = `${finalPath}.part`;
      assertPathWithinMediaRoot(mediaRoot, partPath);
      const fetched = await channelAdapter.fetchFileById({
        fileId: descriptor.fileId,
        maxSizeBytes: this.maxInboundBytes,
      });
      if (!fetched?.bytes?.length || fetched.bytes.length > this.maxInboundBytes) {
        throw new Error("media payload exceeds size limit or is empty");
      }
      assertPathWithinMediaRoot(mediaRoot, partPath);
      const fd = fs.openSync(partPath, "wx");
      try {
        fs.writeFileSync(fd, fetched.bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      assertPathWithinMediaRoot(mediaRoot, finalPath);
      fs.renameSync(partPath, finalPath);
      assertSavedFileWithinMediaRoot(mediaRoot, finalPath);
      const relativePath = relativePathWithinStateMediaRoot(mediaRoot, finalPath);
      const stateMediaRef = createStateMediaReference(relativePath);
      normalized.attachments.push({
        kind: descriptor.kind,
        type: descriptor.kind,
        contentType: descriptor.contentType,
        isImage: descriptor.kind === "photo" || (descriptor.kind === "sticker" && descriptor.stickerType === "webp"),
        fileName: path.basename(finalPath),
        absolutePath: finalPath,
        path: finalPath,
        relativePath,
        stateMediaRef,
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
  const validated = createTelegramMediaDescriptor(descriptor);
  return Boolean(validated && MEDIA_DIRS[validated.kind]);
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

function ensureStateMediaRoot(stateDir) {
  const stateRoot = path.resolve(stateDir);
  fs.mkdirSync(stateRoot, { recursive: true });
  assertNoLinkedPath(stateRoot);
  const realStateRoot = fs.realpathSync(stateRoot);
  const mediaRoot = path.join(realStateRoot, "media");
  ensureDirectory(mediaRoot);
  assertNoLinkedPath(mediaRoot);
  return fs.realpathSync(mediaRoot);
}

function ensureMediaKindDirectory(mediaRoot, kind) {
  const directory = MEDIA_DIRS[kind];
  if (!directory) throw new Error("unsupported media kind");
  const mediaDir = path.join(mediaRoot, directory);
  assertPathWithinMediaRoot(mediaRoot, mediaDir);
  ensureDirectory(mediaDir);
  assertNoLinkedPath(mediaDir);
  const realMediaDir = fs.realpathSync(mediaDir);
  assertPathWithinMediaRoot(mediaRoot, realMediaDir);
  return realMediaDir;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || isLinkOrReparsePoint(stat)) throw new Error("media directory is not safe");
}

function assertNoLinkedPath(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  const relative = path.relative(parsed.root, resolved);
  let current = parsed.root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (isLinkOrReparsePoint(stat)) throw new Error("linked media path rejected");
  }
}

function isLinkOrReparsePoint(stat) {
  return Boolean(stat?.isSymbolicLink?.() || stat?.isReparsePoint?.());
}

function assertPathWithinMediaRoot(mediaRoot, candidate) {
  const root = path.resolve(mediaRoot);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error("media path escapes state media root");
  }
}

function assertSavedFileWithinMediaRoot(mediaRoot, finalPath) {
  assertPathWithinMediaRoot(mediaRoot, finalPath);
  const stat = fs.lstatSync(finalPath);
  if (!stat.isFile() || isLinkOrReparsePoint(stat)) throw new Error("saved media file is not safe");
  const realFinalPath = fs.realpathSync(finalPath);
  assertPathWithinMediaRoot(mediaRoot, realFinalPath);
}

function relativePathWithinStateMediaRoot(mediaRoot, finalPath) {
  const mediaRelative = path.relative(mediaRoot, finalPath).replace(/\\/g, "/");
  if (!mediaRelative || mediaRelative.includes("..") || mediaRelative.startsWith("/")) {
    throw new Error("invalid saved media path");
  }
  return `media/${mediaRelative}`;
}

function createStateMediaReference(relativePath) {
  if (!isSafeStateMediaRelativePath(relativePath)) throw new Error("invalid state media reference");
  return `state-media://${relativePath}`;
}

function resolveStateMediaReference(stateDir, reference) {
  const prefix = "state-media://";
  const normalized = normalizeText(reference);
  if (!normalized.startsWith(prefix)) return "";
  const relativePath = normalized.slice(prefix.length);
  if (!isSafeStateMediaRelativePath(relativePath)) return "";
  let mediaRoot;
  try { mediaRoot = ensureStateMediaRoot(stateDir); } catch { return ""; }
  const candidate = path.join(path.dirname(mediaRoot), ...relativePath.split("/"));
  try {
    assertSavedFileWithinMediaRoot(mediaRoot, candidate);
    return candidate;
  } catch {
    return "";
  }
}

function isSafeStateMediaRelativePath(value) {
  if (typeof value !== "string" || !value.startsWith("media/") || value.includes("\\") || value.includes("\0")) return false;
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("//")) return false;
  const parts = value.split("/");
  return parts.length >= 3 && parts.every((part) => part && part !== "." && part !== "..");
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
  createStateMediaReference,
  resolveStateMediaReference,
  isSafeStateMediaRelativePath,
  writeMediaLog,
};
