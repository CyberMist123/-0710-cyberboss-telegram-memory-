"use strict";

const ALLOWED_MEDIA_KINDS = new Set(["voice", "audio", "photo", "sticker"]);
const DEFAULT_MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024;
const STICKER_TYPES = new Map([
  ["webp", { extension: ".webp", contentType: "image/webp" }],
  ["tgs", { extension: ".tgs", contentType: "application/x-tgsticker" }],
  ["webm", { extension: ".webm", contentType: "video/webm" }],
]);

function createTelegramMediaDescriptor(input) {
  const kind = normalizeText(input?.kind);
  const fileId = normalizeText(input?.fileId);
  const rawExtension = normalizeText(input?.extension);
  if (!ALLOWED_MEDIA_KINDS.has(kind) || !fileId) {
    return null;
  }
  if (rawExtension && !/^\.[a-z0-9]{1,8}$/i.test(rawExtension)) return null;
  const descriptor = {
    kind,
    type: kind,
    fileId,
    sizeBytes: positiveInt(input?.sizeBytes),
    contentType: normalizeText(input?.contentType),
    extension: normalizeExtension(input?.extension),
    durationSec: positiveNumber(input?.durationSec),
    width: positiveInt(input?.width),
    height: positiveInt(input?.height),
    stickerType: normalizeText(input?.stickerType),
  };
  if (kind === "sticker" && !STICKER_TYPES.has(descriptor.stickerType)) {
    return null;
  }
  if (!descriptor.extension || !descriptor.contentType) {
    const defaults = defaultsForDescriptor(descriptor);
    descriptor.extension ||= defaults.extension;
    descriptor.contentType ||= defaults.contentType;
  }
  return Object.freeze(descriptor);
}

function buildTelegramMediaDescriptors(message) {
  const descriptors = [];
  const caption = normalizeText(message?.caption);
  const voice = createTelegramMediaDescriptor({
    kind: "voice",
    fileId: message?.voice?.file_id,
    sizeBytes: message?.voice?.file_size,
    durationSec: message?.voice?.duration,
    contentType: message?.voice?.mime_type || "audio/ogg",
    extension: ".oga",
  });
  if (voice) descriptors.push(withCaption(voice, caption));

  const audio = createTelegramMediaDescriptor({
    kind: "audio",
    fileId: message?.audio?.file_id,
    sizeBytes: message?.audio?.file_size,
    durationSec: message?.audio?.duration,
    contentType: message?.audio?.mime_type || "audio/mpeg",
    extension: extensionFromName(message?.audio?.file_name, ".bin"),
  });
  if (audio) descriptors.push(withCaption(audio, caption));

  const photo = pickLargestTelegramPhoto(message?.photo);
  if (photo) descriptors.push(withCaption(photo, caption));

  const stickerType = message?.sticker?.is_animated
    ? "tgs"
    : (message?.sticker?.is_video ? "webm" : "webp");
  const sticker = createTelegramMediaDescriptor({
    kind: "sticker",
    fileId: message?.sticker?.file_id,
    sizeBytes: message?.sticker?.file_size,
    width: message?.sticker?.width,
    height: message?.sticker?.height,
    stickerType,
  });
  if (sticker) descriptors.push(withCaption(sticker, caption));
  return descriptors;
}

function pickLargestTelegramPhoto(sizes) {
  if (!Array.isArray(sizes) || !sizes.length) return null;
  let largest = null;
  for (const size of sizes) {
    const descriptor = createTelegramMediaDescriptor({
      kind: "photo",
      fileId: size?.file_id,
      sizeBytes: size?.file_size,
      width: size?.width,
      height: size?.height,
      contentType: "image/jpeg",
      extension: ".jpg",
    });
    if (!descriptor) continue;
    const pixels = descriptor.width * descriptor.height;
    if (!largest || pixels > largest.width * largest.height) largest = descriptor;
  }
  return largest;
}

function withCaption(descriptor, caption) {
  return Object.freeze({ ...descriptor, caption });
}

function defaultsForDescriptor(descriptor) {
  if (descriptor.kind === "photo") return { extension: ".jpg", contentType: "image/jpeg" };
  if (descriptor.kind === "voice") return { extension: ".oga", contentType: "audio/ogg" };
  if (descriptor.kind === "audio") return { extension: ".bin", contentType: "application/octet-stream" };
  return STICKER_TYPES.get(descriptor.stickerType) || { extension: ".bin", contentType: "application/octet-stream" };
}

function extensionFromName(name, fallback) {
  const value = normalizeText(name);
  const match = value.match(/\.[A-Za-z0-9]{1,8}$/);
  return match ? match[0].toLowerCase() : fallback;
}

function normalizeExtension(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized && /^\.[a-z0-9]{1,8}$/.test(normalized) ? normalized : "";
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

module.exports = {
  ALLOWED_MEDIA_KINDS,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  STICKER_TYPES,
  buildTelegramMediaDescriptors,
  createTelegramMediaDescriptor,
  pickLargestTelegramPhoto,
};
