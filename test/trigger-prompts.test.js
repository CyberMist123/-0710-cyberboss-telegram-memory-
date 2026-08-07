"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadTriggerPrompt, MAX_PROMPT_BYTES } = require("../src/core/trigger-prompts");
const { buildSystemInboundText } = require("../src/core/system-message-dispatcher");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cb-trigger-prompts-"));
}

test("md 覆盖内置文本，注释不进她的上下文", () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, "window_open.md"),
    "<!-- 这行是写给编辑的人看的 -->\n她刚开窗，说一句你真正想说的。\n",
    "utf8",
  );

  const override = loadTriggerPrompt({ dir, sourceType: "window_open" });
  assert.equal(override, "她刚开窗，说一句你真正想说的。");
  assert.equal(override.includes("写给编辑的人看的"), false);

  const text = buildSystemInboundText("她刚敲了 /new。", "2026-08-07T10:00:00.000Z", "window_open", "failure", {
    promptOverride: override,
  });
  assert.match(text, /她刚开窗，说一句你真正想说的。/u);
  // 覆盖生效时内置那套措辞必须整段让位，不能两份叠着发给她。
  assert.equal(text.includes("不要表演熟悉"), false);
  // 时间戳与 Trigger 正文仍由程序拼。
  assert.match(text, /^\[/u);
  assert.match(text, /Trigger:\n她刚敲了 \/new。/u);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("目录没配、文件缺失、内容为空，一律回落内置文本", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "empty_type.md"), "   \n<!-- 只有注释 -->\n", "utf8");

  assert.equal(loadTriggerPrompt({ dir: "", sourceType: "window_open" }), "");
  assert.equal(loadTriggerPrompt({ dir, sourceType: "window_open" }), "");
  assert.equal(loadTriggerPrompt({ dir, sourceType: "empty_type" }), "");

  // 回落之后她仍然听得见完整的内置指令——不变量 5：宁可用旧词，不可哑掉。
  const text = buildSystemInboundText("", "", "window_open", "failure", { promptOverride: "" });
  assert.match(text, /System trigger type: window_open\./u);
  assert.match(text, /不要汇报你读了什么/u);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("坏 sourceType 与超大文件都不加载", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "huge.md"), "x".repeat(MAX_PROMPT_BYTES + 1), "utf8");
  assert.equal(loadTriggerPrompt({ dir, sourceType: "huge" }), "");

  // sourceType 目前来自代码内常量，但闸门先立着：哪天它被接上外部输入，
  // 这里就是路径穿越的唯一入口。
  fs.writeFileSync(path.join(dir, "window_open.md"), "覆盖", "utf8");
  for (const bad of ["../window_open", "win/../dow", "WINDOW OPEN", "a".repeat(65), ""]) {
    assert.equal(loadTriggerPrompt({ dir, sourceType: bad }), "", `${bad} 不该被加载`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test("落在 Fluffy-SelfHood\\prompts 的那份现货能被解析，且保住了 JSON 契约", () => {
  // 路径从 CYBERLINK_ROOT 派生，不写死盘符：portability 检查器会拦，而且
  // 这份测试要在 CI 的 D 盘 runner 上也能跑（那里根本没有这个目录，跳过即可）。
  const root = (process.env.CYBERLINK_ROOT || "").trim();
  if (!root) return;
  const dir = path.join(root, "Fluffy-SelfHood", "prompts");
  if (!fs.existsSync(path.join(dir, "window_open.md"))) return; // 别的机器上跳过

  const override = loadTriggerPrompt({ dir, sourceType: "window_open" });
  assert.match(override, /\S/u);
  // 删了这几行她说的话就发不出去——README 里写明要保留，这里钉住。
  assert.match(override, /\{"action":"send_message"/u);
  assert.equal(override.includes("<!--"), false);
});
