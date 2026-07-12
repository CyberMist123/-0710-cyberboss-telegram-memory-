const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("../orchestration/atomic-json");

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function appendJsonlUnique(filePath, entries, key = "id") {
  const incoming = Array.isArray(entries) ? entries : [];
  if (!incoming.length) return [];
  const existing = new Set(readJsonl(filePath).map((item) => String(item?.[key] || "")).filter(Boolean));
  const added = incoming.filter((entry) => {
    const value = String(entry?.[key] || "");
    if (!value || existing.has(value)) return false;
    existing.add(value);
    return true;
  });
  if (!added.length) return [];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, added.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return added;
}

function backupFile(filePath, backupsDir) {
  if (!fs.existsSync(filePath)) return "";
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupsDir, `${path.basename(filePath)}.${stamp}.bak`);
  fs.copyFileSync(filePath, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}

function replaceTextAtomic(filePath, text) {
  const destination = path.resolve(filePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(handle, String(text), "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(tempPath, destination);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function loadJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

module.exports = {
  appendJsonlUnique,
  backupFile,
  loadJson,
  readJsonl,
  replaceTextAtomic,
  sha256,
  writeJsonAtomic,
};
