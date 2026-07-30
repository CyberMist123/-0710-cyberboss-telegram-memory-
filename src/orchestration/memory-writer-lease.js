const path = require("path");

/**
 * canon 记忆文件的**唯一锁域**（issue #74）。
 *
 * 不变量 4（单 writer）是按文件成立的：`ai_self_notes.md` 同时被 History writer
 * （`src/continuity/continuity-pipeline.js` 的 `publishSelfNote`）和主体 AI 的
 * `memory_note` 工具（`src/services/memory-note-service.js`）写。两边只要用两个
 * **不同的 lease 文件**，锁就互不排斥 —— 谁都拿得到自己那把锁，等于没有锁。
 *
 * 所以 lease 文件路径不能各算各的，只能从这里算一次：
 * - 显式配置（`CYBERBOSS_WRITER_LEASE_FILE`）优先，生产机就是靠它把 lease 指到
 *   cyberlink 根，与编排层 `scripts/orchestration/writer-lease.js` 共用同一把锁；
 * - 没配置时落 `<continuityDir>/.jobs/MEMORY_WRITER_LEASE.json`。
 *
 * 这个模块只算路径，不碰锁本身 —— 拿锁/放锁仍然只走 `writer-lease.js`。
 */
const MEMORY_WRITER_LEASE_BASENAME = "MEMORY_WRITER_LEASE.json";

/** 已退役的 memory_note 专属 lease（issue #74 之前的第二锁域），只用于普查与断言。 */
const RETIRED_MEMORY_NOTE_LEASE_BASENAME = "memory-note-writer-lease.json";

function resolveMemoryWriterLeaseFile({ continuityDir = "", writerLeaseFile = "" } = {}) {
  const configured = normalize(writerLeaseFile);
  if (configured) return path.resolve(configured);
  const dir = normalize(continuityDir);
  if (!dir) return "";
  return path.resolve(path.join(dir, ".jobs", MEMORY_WRITER_LEASE_BASENAME));
}

/**
 * 失效 lease 的归档目录。与 lease 文件位置无关，永远跟着 continuity 目录走，
 * 这样同一把锁被不同 writer 回收时，归档也只有一处。
 */
function memoryWriterLeaseArchiveDir({ continuityDir = "", writerLeaseArchiveDir = "" } = {}) {
  const configured = normalize(writerLeaseArchiveDir);
  if (configured) return path.resolve(configured);
  const dir = normalize(continuityDir);
  if (!dir) return "";
  return path.resolve(path.join(dir, ".backups", "writer-leases"));
}

function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  MEMORY_WRITER_LEASE_BASENAME,
  RETIRED_MEMORY_NOTE_LEASE_BASENAME,
  memoryWriterLeaseArchiveDir,
  resolveMemoryWriterLeaseFile,
};
