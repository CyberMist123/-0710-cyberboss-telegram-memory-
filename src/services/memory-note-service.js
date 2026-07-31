const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { acquireWriterLease, releaseWriterLease } = require("../orchestration/writer-lease");
const {
  memoryWriterLeaseArchiveDir,
  resolveMemoryWriterLeaseFile,
} = require("../orchestration/memory-writer-lease");
const { backupFile, loadJson, writeJsonAtomic } = require("../continuity/continuity-store");

const DAILY_LIMIT = 10;

/**
 * 主体 AI 的 `memory_note` 工具（`src/tools/tool-host.js` 的 `memory_note`）。
 *
 * issue #74 之前这里有两处违反不变量 4：
 * 1. 用**专属** lease（`.jobs/memory-note-writer-lease.json`），与 History writer
 *    的共享 lease 互不排斥 —— 两把锁等于没有锁；
 * 2. 写入是「整读文件 → 整写回」，并发时会把别人刚追加的行整段盖掉。
 *
 * 现在：锁域由 `resolveMemoryWriterLeaseFile()` 统一（与 History writer 同一个文件），
 * 写入是**只追加**（`ai_self_notes.md` 按 `docs/architecture/MEMORY.md` 2.3 本来就只追加）。
 */
class MemoryNoteService {
  constructor({ continuityDir, writerLeaseFile, writerLeaseArchiveDir, now = () => new Date() } = {}) {
    this.dir = String(continuityDir || "").trim();
    this.now = now;
    this.leaseFile = resolveMemoryWriterLeaseFile({ continuityDir: this.dir, writerLeaseFile });
    this.leaseArchiveDir = memoryWriterLeaseArchiveDir({ continuityDir: this.dir, writerLeaseArchiveDir });
  }

  note({ text, quote } = {}) {
    const body = clean(text, 1000);
    const quoted = clean(quote, 500);
    if (!body) return { error: "invalid_note" };
    if (!this.leaseFile) return { error: "note_unavailable" };
    const p = {
      notes: path.join(this.dir, "ai_self_notes.md"),
      budget: path.join(this.dir, ".jobs", "memory-note-budget.json"),
      audit: path.join(this.dir, ".jobs", "memory-note-audit.jsonl"),
      backups: path.join(this.dir, ".backups"),
    };
    let lease;
    try {
      lease = acquireWriterLease(this.leaseFile, {
        writer: "memory-note",
        model: "subject-runtime",
        phase: "phase3",
        branch: "runtime",
        worktree: this.dir,
        base_sha: "0".repeat(40),
      }, { recoverStale: true, staleArchiveDir: this.leaseArchiveDir });
    } catch {
      // fail-open：拿不到锁只回一个 error，不阻断聊天，也绝不绕过锁去写。
      return { error: "note_unavailable" };
    }
    try {
      const date = this.now().toISOString().slice(0, 10);
      const budget = loadJson(p.budget, { days: {} });
      const used = Number(budget.days?.[date]?.count || 0);
      if (used >= DAILY_LIMIT) return { error: "budget_exhausted", budget: { date, limit: DAILY_LIMIT, remaining: 0 } };
      const stamp = this.now().toISOString().slice(0, 16).replace("T", " ");
      const line = quoted ? `[收藏] "${quoted}" —— 她，${stamp}\n${body}` : `${body} —— ${stamp}`;
      backupFile(p.notes, p.backups);
      appendNoteLine(p.notes, line);
      budget.days = budget.days || {};
      budget.days[date] = { count: used + 1, updated_at: this.now().toISOString() };
      writeJsonAtomic(p.budget, budget);
      fs.mkdirSync(path.dirname(p.audit), { recursive: true });
      fs.appendFileSync(p.audit, `${JSON.stringify({ ts: this.now().toISOString(), date, chars: chars(body), quote_chars: chars(quoted), hash: hash(line) })}\n`, "utf8");
      return { ok: true, budget: { date, limit: DAILY_LIMIT, remaining: DAILY_LIMIT - used - 1 } };
    } finally {
      releaseWriterLease(this.leaseFile, lease.lease_id);
    }
  }
}

/**
 * 只追加（issue #74 目标 2）。绝不整读整写回 —— read-modify-replace 一旦和
 * History writer 的 append 交错，就会把对方的行连同文件其余内容一起盖掉。
 */
function appendNoteLine(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${needsLeadingNewline(filePath) ? "\n" : ""}${line}\n`, "utf8");
}

/** 只读最后一个字节判断要不要补换行；整读文件正是旧实现丢写入的起点。 */
function needsLeadingNewline(filePath) {
  let handle;
  try {
    const size = fs.statSync(filePath).size;
    if (!size) return false;
    handle = fs.openSync(filePath, "r");
    const tail = Buffer.alloc(1);
    fs.readSync(handle, tail, 0, 1, size - 1);
    return tail.toString("utf8") !== "\n";
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function clean(v, n) { const x = String(v || "").trim(); return chars(x) <= n ? x : ""; }
function chars(v) { return Array.from(String(v || "").replace(/\s/gu, "")).length; }
function hash(v) { return crypto.createHash("sha256").update(v, "utf8").digest("hex"); }

module.exports = { DAILY_LIMIT, MemoryNoteService };
