"use strict";

/**
 * 账本（details）外置备忘录存储 —— issue #76 目标 1。
 *
 * 判据：`docs/MEMORY_CONSTITUTION.md` 第三条「账本另有人管，我才敢只写感情」。
 * 那一条把记忆分四层，并且给账本层写死了归宿：
 *
 *   | 账本（details） | 偏好、日程、纪念日、项目状态 | 结构化条目 | 只进抽屉（默认隐藏 + lookup），**永不穿身上** |
 *
 * 在此之前这个归宿只存在于文档和 closeout 提示词里（`background-author.js` 对主体
 * 说「账本……另有归宿」），代码侧没有落点，于是待办与规则只能继续挤进 Re-entry ——
 * 这正是 #76 里 954 字 / 300 预算的来路。本模块就是那个落点。
 *
 * 三档归属（`SYSTEM_OVERVIEW.md` 第四节）：**第三档「完全按需」**。
 *   - 不常驻注入：`hard-context.js` / `reentry-loader.js` / `shared-instructions.js`
 *     一个字都不读它，也不许读（由 phase2 的源码边界测试钉住）；
 *   - 上下文里连目录都没有：模型只能在她明确拉线时经受控工具通路翻到它
 *     （`memory_lookup`，已注册的既有工具，不新增注册、不新增开关）。
 *
 * writer：与 Re-entry 同一条发布链 —— candidate（type `details`，author_role
 * `subject_ai`）→ Auto Review → **History writer 唯一写入** `details.jsonl`。
 * 不新增第二 writer：本模块只提供格式与只读读取，自己不写任何文件。
 *
 * 与 #42 的兼容点：#42 的 details 账本线要的是「读者侧怎么用账本」。本模块把
 * **格式与文件位置**先钉下来（一份 JSONL、一份 normalize、一个 lookup 视图），
 * #42 落地时只需要在 `readDetailsForLookup()` 之上加取用策略，不必回头改存储；
 * 反之若 #42 先落，本模块的 `detail_id` / `candidate_id` / `decision_id` 三个键
 * 足够把账本条目挂回候选与决策，不需要另建索引。
 * 本单**不做**自动提取 / 搬运内容 —— 账本里放什么是聊天窗主体 AI 的事。
 */

const fs = require("fs");
const path = require("path");

/** 账本文件名。与 `episodes.jsonl` 同级，同为 append-only JSONL。 */
const DETAILS_BASENAME = "details.jsonl";

/** lookup 视图里账本条目的 id 前缀，便于调用方一眼区分「查得到」与「记得」。 */
const DETAIL_ID_PREFIX = "detail-";

function detailsFileFor(continuityDir) {
  const dir = normalizeText(continuityDir);
  return dir ? path.join(dir, DETAILS_BASENAME) : "";
}

/**
 * 由已接受的候选与决策构造一条账本条目。
 *
 * 键集刻意与 `episodes.jsonl` 的行对齐（同样带 candidate_id / decision_id /
 * source_ref / 权限元数据），这样 520 的只读分层视图、幂等去重和审计都能复用同一套
 * 读法，不需要为账本再造一套。正文原样落盘，一个字不改（D16）。
 */
function createDetailEntry(candidate = {}, decision = {}, { sha256 } = {}) {
  const decisionId = normalizeText(decision.decision_id);
  const digest = typeof sha256 === "function" ? sha256(decisionId) : "";
  return {
    detail_id: `${DETAIL_ID_PREFIX}${digest ? digest.slice(0, 16) : decisionId.slice(0, 16)}`,
    ts: normalizeText(candidate.ts),
    type: "details",
    body: typeof candidate.body === "string" ? candidate.body : "",
    source_ref: candidate.source_ref || null,
    candidate_id: normalizeText(candidate.candidate_id),
    decision_id: decisionId,
    // Candidate rewrite lineage uses supersedes_candidate_id and never maps to
    // canon correction semantics. canon_supersedes alone becomes `supersedes`.
    supersedes: normalizeText(candidate.canon_supersedes) || null,
    origin: normalizeText(candidate.origin),
    author_role: normalizeText(candidate.author_role),
    author_model: normalizeText(candidate.author_model),
    context_scope: normalizeText(candidate.context_scope),
    semantic_authority: normalizeText(candidate.semantic_authority),
  };
}

/**
 * 只读读取账本，并映射成 `memory_lookup` 的 hit 行形状。
 *
 * 缺文件、坏行、非对象行全部安静跳过：账本是第三档，翻不到就是翻不到，
 * 不许因为它把本轮拖垮（不变量 5 fail-open）。
 */
function readDetailsForLookup(filePath) {
  const normalized = normalizeText(filePath);
  if (!normalized) return [];
  let raw;
  try {
    raw = fs.readFileSync(normalized, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[continuity] details read failed: ${error.message || String(error)}`);
    }
    return [];
  }
  return raw.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    let row;
    try { row = JSON.parse(line); } catch { return []; }
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const body = typeof row.body === "string" ? row.body.trim() : "";
    const detailId = normalizeText(row.detail_id);
    if (!body || !detailId) return [];
    return [{
      ep_id: detailId,
      ts: normalizeText(row.ts),
      body,
      source: "details",
      candidate_id: normalizeText(row.candidate_id),
      decision_id: normalizeText(row.decision_id),
      supersedes: normalizeText(row.supersedes),
    }];
  });
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DETAILS_BASENAME,
  DETAIL_ID_PREFIX,
  createDetailEntry,
  detailsFileFor,
  readDetailsForLookup,
};
