"use strict";

const fs = require("fs");
const path = require("path");

// 系统触发提示词的可编辑覆盖层。
//
// 这些话决定她被唤起时听见什么，本来只存在于 `system-message-dispatcher.js` 的
// 字符串里——改一个字要改代码、要部署。放成 md 之后 Owner 可以直接编辑。
//
// 只读、fail-open（不变量 5：宁可本轮用旧词，不可本轮哑掉）：目录没配、文件不
// 存在、读失败、内容为空，一律回落内置文本，绝不因此丢掉一次触发。
//
// 文件名即 sourceType（`window_open` -> `window_open.md`）。sourceType 来自代码
// 内的常量，不是外部输入，但仍然只允许 [a-z0-9_-]，免得哪天有人把它接上用户输入
// 就变成路径穿越。
const SAFE_SOURCE_TYPE = /^[a-z0-9_-]{1,64}$/u;
const MAX_PROMPT_BYTES = 64 * 1024;

function loadTriggerPrompt({ dir = "", sourceType = "" } = {}) {
  const normalizedDir = typeof dir === "string" ? dir.trim() : "";
  const normalizedType = typeof sourceType === "string" ? sourceType.trim().toLowerCase() : "";
  if (!normalizedDir || !SAFE_SOURCE_TYPE.test(normalizedType)) return "";
  try {
    const filePath = path.join(normalizedDir, `${normalizedType}.md`);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) return "";
    return stripEditorNotes(fs.readFileSync(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

// `<!-- ... -->` 是写给编辑这份文件的人看的，不该进她的上下文。
function stripEditorNotes(text) {
  return String(text || "").replace(/<!--[\s\S]*?-->/gu, "");
}

module.exports = { loadTriggerPrompt, stripEditorNotes, MAX_PROMPT_BYTES };
