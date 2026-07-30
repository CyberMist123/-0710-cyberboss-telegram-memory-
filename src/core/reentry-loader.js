const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REENTRY_CHAR_BUDGET = 300;

// Last-known-good 副本（issue #76 目标 2）。
//
// 为什么需要它：超预算时旧实现整块跳过，开场人格交接信实际为零，而 context gate
// 仍然显示 reentry 开着。生产上这条已经在发生（err.log 连续记
// `reentry skipped reason=over_budget chars=954 budget=300`）。
//
// 落盘位置：`<continuityDir>/.jobs/reentry-last-known-good.json`。`.jobs` 是本仓库
// 既有的**机制状态**目录（`history-writer-state.json`、`memory-lookup-budget.json`、
// `memory-note-budget.json` 都在那里），不是 canon。副本因此：
//   - 不参与 candidate / review / history 发布链，不能被当成正史引用；
//   - 唯一 writer 是本模块的 `saveLastKnownGood()`，只在「当前正文预算内、成功注入」
//     这一刻写，永不写 `reentry.md` 本体（单 writer 不变式按文件成立）；
//   - 存的是**原始文件正文**，不是过滤后的注入视图，所以降级注入时会用当天的时钟
//     重新过滤 `<!-- until: -->` 钩子，过期钩子不会被副本复活。
//
// 明确只在 over_budget 时降级：`missing` / `expired` 不用副本。主体 AI 把
// `reentry.md` 清空是一个有权限的决定，用旧副本盖回去等于替她撤销那次决定。
const REENTRY_SNAPSHOT_VERSION = 1;
const REENTRY_SNAPSHOT_BASENAME = "reentry-last-known-good.json";

function reentrySnapshotFileFor(continuityDir) {
  const dir = normalizeText(continuityDir);
  return dir ? path.join(dir, ".jobs", REENTRY_SNAPSHOT_BASENAME) : "";
}

function loadReentry({
  filePath,
  episodesFile,
  snapshotFile = "",
  budget = REENTRY_CHAR_BUDGET,
  now = new Date(),
} = {}) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return { skipped: "missing", effective: "none" };
  try {
    const stat = fs.statSync(normalizedPath);
    const bytes = fs.readFileSync(normalizedPath);
    const originalText = bytes.toString("utf8");
    if (!originalText.trim()) return { skipped: "missing", effective: "none" };
    const text = filterExpiryHooks(originalText, now);
    if (!text.trim()) return { skipped: "expired", effective: "none" };
    const chars = countNonWhitespace(text);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const srcMtime = stat.mtime.toISOString();
    if (chars > budget) {
      // D16 / D19：后台不许截断或改写正文。所以这里只能**整块换用**上一份预算内的
      // 有效正文，绝不裁剪当前正文，也绝不回写 `reentry.md`。
      const fallback = loadLastKnownGood({ snapshotFile, budget, now });
      if (fallback) {
        console.warn(`[continuity] reentry degraded reason=over_budget chars=${chars} budget=${budget} effective=fallback fallback_chars=${fallback.chars}`);
        return {
          ...withEpisodeMetadata(fallback.text, episodesFile),
          chars: fallback.chars,
          hash: fallback.hash,
          src_mtime: fallback.src_mtime,
          effective: "fallback",
          degraded_reason: "over_budget",
          current_chars: chars,
          current_hash: hash,
        };
      }
      console.warn(`[continuity] reentry skipped reason=over_budget chars=${chars} budget=${budget}`);
      return {
        skipped: "over_budget",
        effective: "none",
        degraded_reason: "over_budget",
        chars,
        hash,
        src_mtime: srcMtime,
      };
    }
    saveLastKnownGood({ snapshotFile, body: originalText, chars, hash, srcMtime });
    return {
      ...withEpisodeMetadata(text, episodesFile),
      chars,
      hash,
      src_mtime: srcMtime,
      effective: "current",
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[continuity] reentry read failed: ${error.message || String(error)}`);
    }
    return { skipped: "missing", effective: "none" };
  }
}

function withEpisodeMetadata(text, episodesFile) {
  const metadata = readEpisodeMetadata(episodesFile);
  return {
    text: metadata ? `${text.replace(/\s+$/u, "")}\n${metadata.line}` : text,
    episode_count: metadata?.count,
    episode_earliest_month: metadata?.earliestMonth,
  };
}

/**
 * 读 last-known-good 副本并**重新验证**它。
 *
 * 副本是机制状态，不是可信输入：预算常量可能变过、期限钩子可能已经过期、文件可能被
 * 手改。所以这里重新过滤、重新数字数、重新比预算，任一条不过就当没有副本
 * （fail-open 退回空 reentry，而不是抛错拖垮本轮）。
 */
function loadLastKnownGood({ snapshotFile, budget, now }) {
  const normalized = normalizeText(snapshotFile);
  if (!normalized) return null;
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(normalized, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[continuity] reentry last-known-good read failed: ${error.message || String(error)}`);
    }
    return null;
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const body = typeof snapshot.body === "string" ? snapshot.body : "";
  if (!body.trim()) return null;
  const text = filterExpiryHooks(body, now);
  if (!text.trim()) return null;
  const chars = countNonWhitespace(text);
  if (chars > budget) return null;
  return {
    text,
    chars,
    hash: typeof snapshot.hash === "string" ? snapshot.hash : "",
    src_mtime: typeof snapshot.src_mtime === "string" ? snapshot.src_mtime : "",
  };
}

/**
 * 写 last-known-good 副本。只在当前正文预算内、真的被注入的那一刻调用。
 *
 * 同 hash 不重写：开场注入每个新线程都会走一次，没必要每次都落盘。
 * 写失败只 warn —— 副本是机制状态，宁可下次降级不可本轮失联（不变量 5）。
 */
function saveLastKnownGood({ snapshotFile, body, chars, hash, srcMtime }) {
  const normalized = normalizeText(snapshotFile);
  if (!normalized) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(normalized, "utf8"));
    if (existing?.version === REENTRY_SNAPSHOT_VERSION && existing?.hash === hash) return false;
  } catch {
    // 副本缺失或损坏都按「需要重写」处理。
  }
  const temp = `${normalized}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(normalized), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify({
      version: REENTRY_SNAPSHOT_VERSION,
      saved_at: new Date().toISOString(),
      chars,
      hash,
      src_mtime: srcMtime,
      body,
    })}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, normalized);
    return true;
  } catch (error) {
    console.warn(`[continuity] reentry last-known-good write failed: ${error.message || String(error)}`);
    try { fs.unlinkSync(temp); } catch { /* 临时文件清理失败不影响本轮 */ }
    return false;
  }
}

function filterExpiryHooks(text, now) {
  const today = toLocalDate(now);
  return String(text || "").split(/\r?\n/u).filter((line) => {
    const matches = [...line.matchAll(/<!--\s*until:\s*(\d{4}-\d{2}-\d{2})\s*-->/giu)];
    return !matches.some((match) => isExpired(match[1], today));
  }).map((line) => line.replace(/<!--\s*until:\s*\d{4}-\d{2}-\d{2}\s*-->/giu, "")).join("\n");
}

function readEpisodeMetadata(filePath) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) return null;
  try {
    const rows = fs.readFileSync(normalizedPath, "utf8").split(/\r?\n/u)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === "object" && !Array.isArray(row));
    const months = rows.flatMap((row) => Object.values(row)
      .filter((value) => typeof value === "string")
      .map((value) => /\b(\d{4}-\d{2})-\d{2}\b/u.exec(value)?.[1])
      .filter(Boolean));
    const earliestMonth = months.sort()[0] || "未知";
    return {
      count: rows.length,
      earliestMonth,
      line: `（episodes 共 ${rows.length} 条，最早至 ${earliestMonth}，细节你现在读不到）`,
    };
  } catch {
    return null;
  }
}

function isExpired(value, today) {
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : "";
  return Boolean(date && date < today);
}

function toLocalDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function countNonWhitespace(value) {
  return Array.from(String(value || "").replace(/\s/gu, "")).length;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  REENTRY_CHAR_BUDGET,
  REENTRY_SNAPSHOT_BASENAME,
  REENTRY_SNAPSHOT_VERSION,
  countNonWhitespace,
  filterExpiryHooks,
  loadReentry,
  readEpisodeMetadata,
  reentrySnapshotFileFor,
};
