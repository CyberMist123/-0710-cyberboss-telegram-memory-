const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("../orchestration/atomic-json");

function readJsonl(filePath) {
  try {
    // Legacy exporters wrote a UTF-8 BOM; JSON.parse rejects it on line one.
    return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
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
  const prefix = path.join(backupsDir, `${path.basename(filePath)}.${stamp}`);
  // 同一毫秒内的第二次备份不许抛（issue #74）：canon 收敛到一把锁之后，两个 writer
  // 会紧挨着落盘，`COPYFILE_EXCL` 撞名会把一次本该成功的写入变成异常 —— fail-open
  // 的反面。撞名只换文件名，绝不覆盖已有备份，第一次仍然用历史文件名。
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const destination = attempt === 0 ? `${prefix}.bak` : `${prefix}.${attempt}.bak`;
    try {
      fs.copyFileSync(filePath, destination, fs.constants.COPYFILE_EXCL);
      return destination;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Backup name collision persisted: ${prefix}.bak`);
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
