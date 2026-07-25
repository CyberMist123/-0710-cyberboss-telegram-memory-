"use strict";

const ALLOWED_MEDIA_KINDS = new Set(["voice", "audio", "photo", "sticker"]);
const DEFAULT_MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024;
const STICKER_TYPES = new Map([
  ["webp", { extension: ".webp", contentType: "image/webp" }],
  ["tgs", { extension: ".tgs", contentType: "application/x-tgsticker" }],
  ["webm", { extension: ".webm", contentType: "video/webm" }],
]);

const MEDIA_FORMATS = Object.freeze({
  voice: new Map([
    [".oga", new Set(["audio/ogg", "audio/opus"])],
    [".ogg", new Set(["audio/ogg", "audio/opus"])],
  ]),
  audio: new Map([
    [".mp3", new Set(["audio/mpeg"])],
    [".m4a", new Set(["audio/mp4", "audio/x-m4a"])],
    [".ogg", new Set(["audio/ogg", "audio/opus"])],
    [".oga", new Set(["audio/ogg", "audio/opus"])],
    [".wav", new Set(["audio/wav", "audio/x-wav"])],
    [".flac", new Set(["audio/flac"])],
  ]),
  photo: new Map([[".jpg", new Set(["image/jpeg"])], [".jpeg", new Set(["image/jpeg"])]]) ,
  sticker: new Map([
    [".webp", new Set(["image/webp"])],
    [".tgs", new Set(["application/x-tgsticker"])],
    [".webm", new Set(["video/webm"])],
  ]),
});

function createTelegramMediaDescriptor(input) {
  const kind = normalizeText(input?.kind);
  const fileId = normalizeText(input?.fileId);
  const rawExtension = normalizeText(input?.extension);
  if (!ALLOWED_MEDIA_KINDS.has(kind) || !fileId) {
    return null;
  }
  if (rawExtension && !/^\.[a-z0-9]{1,8}$/i.test(rawExtension)) return null;
  const sizeBytes = parseNonNegativeInteger(input?.sizeBytes);
  const durationSec = parseNonNegativeNumber(input?.durationSec);
  const width = parseNonNegativeInteger(input?.width);
  const height = parseNonNegativeInteger(input?.height);
  if (!sizeBytes.ok || !durationSec.ok || !width.ok || !height.ok) return null;
  const descriptor = {
    kind,
    type: kind,
    fileId,
    sizeBytes: sizeBytes.value,
    contentType: normalizeText(input?.contentType),
    extension: normalizeExtension(input?.extension),
    durationSec: durationSec.value,
    width: width.value,
    height: height.value,
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
  if (!isAllowedFormat(descriptor)) return null;
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
    contentType: message?.audio?.mime_type || contentTypeForExtension(extensionFromName(message?.audio?.file_name, ".mp3"), "audio") || "audio/mpeg",
    extension: extensionFromName(message?.audio?.file_name, ".mp3"),
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
  if (descriptor.kind === "audio") return { extension: ".mp3", contentType: "audio/mpeg" };
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

function isAllowedFormat(descriptor) {
  const byExtension = MEDIA_FORMATS[descriptor.kind];
  if (!byExtension) return false;
  const allowedTypes = byExtension.get(descriptor.extension);
  return Boolean(allowedTypes && allowedTypes.has(descriptor.contentType));
}

function contentTypeForExtension(extension, kind) {
  const allowed = MEDIA_FORMATS[kind]?.get(extension);
  return allowed ? Array.from(allowed)[0] : "";
}

function parseNonNegativeInteger(value) {
  if (value === undefined || value === null) return { ok: true, value: 0 };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return { ok: false, value: 0 };
  return { ok: true, value };
}

function parseNonNegativeNumber(value) {
  if (value === undefined || value === null) return { ok: true, value: 0 };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { ok: false, value: 0 };
  return { ok: true, value };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

module.exports = {
  ALLOWED_MEDIA_KINDS,
  DEFAULT_MAX_INBOUND_MEDIA_BYTES,
  STICKER_TYPES,
  MEDIA_FORMATS,
  buildTelegramMediaDescriptors,
  createTelegramMediaDescriptor,
  pickLargestTelegramPhoto,
};
