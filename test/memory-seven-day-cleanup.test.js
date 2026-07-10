const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryService } = require("../src/services/memory-service");

test("cleanupSevenDayMemory physically removes expired and non-active entries", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-memory-seven-day-"));
  const service = new MemoryService({ memoryDir });
  service.ensureFiles();
  fs.writeFileSync(service.sevenDayFile, [
    "# 7-Day Memory",
    "",
    "## 记录规则",
    "- 这里只记录最近 7 天内会影响后续回应的关键事件摘要，不记录普通流水账。",
    "- 长期 memory 默认只从这里晋升；未标 KEY 的条目到期后可清理。",
    "- `summary` 用一句话概括事件；`quoted` 最多保留一句关键原话。",
    "",
    "## 2026-06-01",
    "- id: `evt_expired`",
    "- type: `event`",
    "- category: `projects`",
    "- summary: 昨天只推进了一小块工作",
    "- keywords: `推进工作`",
    "- quoted: `只推进了一小块`",
    "- emotion: `medium`",
    "- factual: `medium`",
    "- key: `no`",
    "- status: `active`",
    "- expires_at: `2026-06-03`",
    "- promote_to: ``",
    "- suggested_category: `projects`",
    "- source: `wechat_segment_summary`",
    "",
    "## 2026-06-05",
    "- id: `evt_rejected`",
    "- type: `event`",
    "- category: `preferences`",
    "- summary: 不喜欢奇怪比喻",
    "- keywords: `奇怪比喻`",
    "- quoted: `别用奇怪比喻`",
    "- emotion: `medium`",
    "- factual: `high`",
    "- key: `yes`",
    "- status: `rejected`",
    "- expires_at: `2026-06-12`",
    "- promote_to: `preferences`",
    "- suggested_category: `preferences`",
    "- source: `wechat_segment_summary`",
    "",
    "- id: `evt_keep`",
    "- type: `event`",
    "- category: `profile`",
    "- summary: 今天眼睛疼，回复里少施压",
    "- keywords: `眼睛疼, 少施压`",
    "- quoted: `今天眼睛疼`",
    "- emotion: `high`",
    "- factual: `medium`",
    "- key: `yes`",
    "- status: `active`",
    "- expires_at: `2026-06-12`",
    "- promote_to: ``",
    "- suggested_category: `profile`",
    "- source: `wechat_segment_summary`",
    "",
  ].join("\n"), "utf8");

  const result = service.cleanupSevenDayMemory({ today: "2026-06-05" });
  assert.equal(result.removed, 2);

  const rows = service.readSevenDayMemory({ status: "", limit: 20 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "evt_keep");
});
