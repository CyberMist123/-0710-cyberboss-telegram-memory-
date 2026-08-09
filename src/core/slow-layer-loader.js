const crypto = require("crypto");
const fs = require("fs");
const { countNonWhitespace } = require("./reentry-loader");

// 慢层注入面（二期批次 E1）：agreements / ai-portrait / wandering 三份人格积累层
// 文件在开窗时小预算缝入，与 reentry 同层（只走 prepareOpeningContext，不进热路径）。
//
// 三项各挂独立开关（CYBERBOSS_INJECT_AGREEMENTS / _PORTRAIT / _WANDERING），默认关。
// 开关全关时本模块零足迹：不读文件、不出块、不进 trace，opening 文本逐字节不变。
//
// fail-open 全程成立：文件缺失 / 为空 / 全是注释 → 该项静默跳过；任何异常 → 空结果。
// 宁可本轮不注入，不可炸开窗（不变量 5）。
//
// 单 writer 不动摇：本模块对三份文件**只读**，永不回写、永不截断改写正文（D16/D19）。
// 超预算的处理是整项跳过，不是裁剪。

// 三项合计的非空白字硬顶。超限按优先级逐项降级：agreements（共同约定，操作性最强）
// ≥ portrait（姿态背景）≥ wandering（悬置问题），装不下的整项跳过。
const SLOW_LAYER_TOTAL_BUDGET = 800;
// wandering 只轻量点出最上面几条问号，不是把灰名单整个搬进来。
const WANDERING_MAX_LINES = 3;
const WANDERING_CHAR_BUDGET = 100;

/**
 * 装配慢层注入块。返回 { blocks, skipped }：
 *   blocks  — [{ type, text, chars, hash, src_mtime }]，按注入优先级排列；
 *   skipped — [{ type, reason }]，只解释**开关开着**却没进去的项（missing / over_budget）。
 * 开关关着的项两边都不出现——默认关时 trace 形状与本批次之前逐字节一致。
 */
function loadSlowLayer({ config = {} } = {}) {
  const items = [
    { type: "agreements", enabled: Boolean(config.injectAgreements), filePath: config.agreementsFile },
    { type: "portrait", enabled: Boolean(config.injectPortrait), filePath: config.aiPortraitFile },
    { type: "wandering", enabled: Boolean(config.injectWandering), filePath: config.wanderingFile },
  ];
  const blocks = [];
  const skipped = [];
  let remaining = SLOW_LAYER_TOTAL_BUDGET;
  for (const item of items) {
    if (!item.enabled) continue;
    let loaded;
    try {
      loaded = loadSlowLayerFile(item);
    } catch (error) {
      console.warn(`[continuity] slow-layer ${item.type} read failed: ${error.message || String(error)}`);
      skipped.push({ type: item.type, reason: "missing" });
      continue;
    }
    if (!loaded) {
      skipped.push({ type: item.type, reason: "missing" });
      continue;
    }
    if (loaded.chars > remaining) {
      console.warn(`[continuity] slow-layer ${item.type} skipped reason=over_budget chars=${loaded.chars} remaining=${remaining} total_budget=${SLOW_LAYER_TOTAL_BUDGET}`);
      skipped.push({ type: item.type, reason: "over_budget" });
      continue;
    }
    remaining -= loaded.chars;
    blocks.push({ type: item.type, ...loaded });
  }
  return { blocks, skipped };
}

// 读一份慢层文件并做**选择**（不是改写）：剥 <!-- --> 注释、去首尾空行；
// wandering 额外只取最上面 2-3 条非注释行。剩不下正文就当没有这份文件。
function loadSlowLayerFile({ type, filePath }) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) return null;
  let bytes;
  let stat;
  try {
    stat = fs.statSync(normalizedPath);
    bytes = fs.readFileSync(normalizedPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return null;
  }
  const stripped = stripHtmlComments(bytes.toString("utf8"));
  const text = type === "wandering" ? pickWanderingLines(stripped) : stripped.trim();
  if (!text.trim()) return null;
  return {
    text,
    chars: countNonWhitespace(text),
    hash: crypto.createHash("sha256").update(bytes).digest("hex"),
    src_mtime: stat.mtime.toISOString(),
  };
}

// 三份文件的头部都是 <!-- --> 写作说明（agreements 与 wandering 目前整份只有说明）。
// 说明是给写作者看的，不是给开窗看的——剥掉后为空 = 这份文件还没长出内容。
function stripHtmlComments(text) {
  return String(text || "").replace(/<!--[\s\S]*?-->/gu, "");
}

// 灰名单只轻量点出最上面 2-3 条：第一条无条件要（预算是「约」不是闸），
// 之后每条要在 100 非空白字与 3 条上限内才继续收。
function pickWanderingLines(text) {
  const lines = String(text || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const picked = [];
  let chars = 0;
  for (const line of lines) {
    const lineChars = countNonWhitespace(line);
    if (picked.length >= WANDERING_MAX_LINES) break;
    if (picked.length > 0 && chars + lineChars > WANDERING_CHAR_BUDGET) break;
    picked.push(line);
    chars += lineChars;
  }
  return picked.join("\n");
}

module.exports = {
  SLOW_LAYER_TOTAL_BUDGET,
  WANDERING_CHAR_BUDGET,
  WANDERING_MAX_LINES,
  loadSlowLayer,
};
