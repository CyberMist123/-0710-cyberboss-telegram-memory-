"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  saveArchive,
  listArchives,
  loadArchive,
  recordReentry,
  locateSegment,
  readConversationRows,
  parseIndexRows,
  QUOTE_BEGIN,
  QUOTE_END,
} = require("../src/services/sl-archive");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-sl-"));
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// A day file whose Sydney-local day is 2026-08-20 (UTC 00:10 → Sydney 10:10).
function writeDayLedger(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { type: "user", timestamp: "2026-08-20T00:10:00Z", text: "第一句 opening line" },
    { type: "runtime.turn.completed", timestamp: "2026-08-20T00:11:00Z", text: "回一句 a reply" },
    { type: "runtime.tool.use", timestamp: "2026-08-20T00:11:30Z", text: "TOOL FLOW should be skipped" },
    { type: "runtime.context.updated", timestamp: "2026-08-20T00:11:40Z", text: "context noise" },
    { type: "user", timestamp: "2026-08-20T00:12:00Z", text: "中间 middle turn" },
    { type: "runtime.turn.completed", timestamp: "2026-08-20T00:13:00Z", text: "收尾 the closing anchor line" },
  ];
  fs.writeFileSync(path.join(dir, "2026-08-20.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

function writeIndex(slDir) {
  fs.mkdirSync(slDir, { recursive: true });
  fs.writeFileSync(
    path.join(slDir, "sl-index.md"),
    ["# SL 存档目录", "", "| sl_id | 剧情时间 | 备注摘要 | 建档日 | 读档次数 |", "|---|---|---|---|---|", ""].join("\n"),
    "utf8",
  );
}

const NOW = new Date("2026-08-20T05:00:00Z"); // Sydney 2026-08-20 15:00

test("readConversationRows keeps only her turns and AI replies, in time order", () => {
  const root = tempRoot();
  try {
    const convDir = path.join(root, "06-raw");
    writeDayLedger(convDir);
    const rows = readConversationRows({ conversationsDir: convDir, dayKeys: ["2026-08-20"] });
    assert.deepEqual(
      rows.map((r) => r.type),
      ["user", "runtime.turn.completed", "user", "runtime.turn.completed"],
    );
    assert.ok(!rows.some((r) => /TOOL FLOW|context noise/.test(r.text)), "tool/context rows must be dropped");
  } finally {
    cleanup(root);
  }
});

test("locateSegment: end anchor is the last match; default start walks back within the session", () => {
  const convDir = tempRoot();
  try {
    writeDayLedger(convDir);
    const rows = readConversationRows({ conversationsDir: convDir, dayKeys: ["2026-08-20"] });
    const located = locateSegment(rows, {
      endAnchor: "the closing anchor",
      startAnchor: "",
      gapMinutes: 30,
      maxRows: 60,
    });
    assert.equal(located.error, undefined);
    assert.equal(located.rows.length, 4); // no gap > 30min → whole session
    assert.match(located.rows[0].text, /opening line/);
    assert.match(located.rows[located.rows.length - 1].text, /closing anchor/);
  } finally {
    cleanup(convDir);
  }
});

test("locateSegment: explicit start anchor bounds the segment", () => {
  const convDir = tempRoot();
  try {
    writeDayLedger(convDir);
    const rows = readConversationRows({ conversationsDir: convDir, dayKeys: ["2026-08-20"] });
    const located = locateSegment(rows, {
      endAnchor: "the closing anchor",
      startAnchor: "middle turn",
      gapMinutes: 30,
      maxRows: 60,
    });
    assert.equal(located.rows.length, 2);
    assert.match(located.rows[0].text, /middle turn/);
  } finally {
    cleanup(convDir);
  }
});

test("locateSegment: unknown end anchor errors", () => {
  const convDir = tempRoot();
  try {
    writeDayLedger(convDir);
    const rows = readConversationRows({ conversationsDir: convDir, dayKeys: ["2026-08-20"] });
    const located = locateSegment(rows, { endAnchor: "no such sentence", startAnchor: "", gapMinutes: 30, maxRows: 60 });
    assert.equal(located.error, "end-anchor-not-found");
  } finally {
    cleanup(convDir);
  }
});

test("saveArchive writes a compatible archive file and appends an index row", () => {
  const root = tempRoot();
  try {
    const convDir = path.join(root, "06-raw");
    const slDir = path.join(root, "08-sl");
    writeDayLedger(convDir);
    writeIndex(slDir);

    const result = saveArchive({
      slDir,
      conversationsDir: convDir,
      name: "藏歌",
      note: "第一次自动存档测试",
      endAnchor: "the closing anchor line",
      timezone: "Australia/Sydney",
      now: NOW,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.slId, "SL-20260820-藏歌");
    assert.equal(result.rowCount, 4);
    assert.equal(result.indexUpdated, true);

    const body = fs.readFileSync(result.filePath, "utf8");
    assert.match(body, /sl_id: SL-20260820-藏歌/);
    assert.ok(body.includes(QUOTE_BEGIN) && body.includes(QUOTE_END), "SL-QUOTE markers must wrap the excerpt");
    assert.match(body, /\*\*10:10 她\*\*：第一句 opening line/); // Sydney-local HH:MM + her label
    assert.match(body, /\*\*10:13 fable\*\*：收尾 the closing anchor line/); // AI label
    assert.ok(!body.includes("TOOL FLOW"), "tool flow must never enter the archive");
    assert.match(body, /## 读档记录/);
    assert.match(body, /末句锚点：「the closing anchor line」/);

    const listed = listArchives(slDir);
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].slId, "SL-20260820-藏歌");
    assert.equal(listed.rows[0].reads, "0");
  } finally {
    cleanup(root);
  }
});

test("saveArchive refuses a duplicate id and a bad name", () => {
  const root = tempRoot();
  try {
    const convDir = path.join(root, "06-raw");
    const slDir = path.join(root, "08-sl");
    writeDayLedger(convDir);
    writeIndex(slDir);
    const args = { slDir, conversationsDir: convDir, name: "夜", endAnchor: "the closing anchor line", timezone: "Australia/Sydney", now: NOW };

    assert.equal(saveArchive(args).ok, true);
    assert.equal(saveArchive(args).error, "duplicate-id");
    assert.equal(saveArchive({ ...args, name: "bad name with spaces" }).error, "bad-name");
    // No end anchor is no longer an error -- it saves up to the latest line.
    assert.equal(saveArchive({ ...args, name: "自动", endAnchor: "" }).ok, true);
  } finally {
    cleanup(root);
  }
});

test("saveArchive / listArchives report an unset SL dir instead of guessing", () => {
  assert.equal(saveArchive({ slDir: "", conversationsDir: "/x", name: "a", endAnchor: "b" }).error, "sl-dir-unset");
  assert.equal(listArchives("").error, "sl-dir-unset");
});

test("loadArchive round-trips what saveArchive wrote and resolves by 短名", () => {
  const root = tempRoot();
  try {
    const convDir = path.join(root, "06-raw");
    const slDir = path.join(root, "08-sl");
    writeDayLedger(convDir);
    writeIndex(slDir);
    const saved = saveArchive({
      slDir,
      conversationsDir: convDir,
      name: "藏歌",
      note: "往返测试",
      endAnchor: "the closing anchor line",
      timezone: "Australia/Sydney",
      now: NOW,
    });
    assert.equal(saved.ok, true);

    const byShort = loadArchive({ slDir, name: "藏歌" });
    assert.equal(byShort.ok, true);
    assert.equal(byShort.slId, "SL-20260820-藏歌");
    assert.equal(byShort.reads, 0);
    assert.match(byShort.informedHeader, /这是回档/);
    assert.match(byShort.quoteBlock, /opening line/);
    assert.ok(!byShort.quoteBlock.includes(QUOTE_BEGIN), "quoteBlock is the inner text, markers stripped");

    const byId = loadArchive({ slDir, name: "SL-20260820-藏歌" });
    assert.equal(byId.ok, true);
    assert.equal(byId.filePath, byShort.filePath);
  } finally {
    cleanup(root);
  }
});

test("recordReentry increments the count in the file and the index, dropping the placeholder", () => {
  const root = tempRoot();
  try {
    const convDir = path.join(root, "06-raw");
    const slDir = path.join(root, "08-sl");
    writeDayLedger(convDir);
    writeIndex(slDir);
    saveArchive({ slDir, conversationsDir: convDir, name: "藏歌", endAnchor: "the closing anchor line", timezone: "Australia/Sydney", now: NOW });

    const first = recordReentry({ slDir, name: "藏歌", note: "第一次读", dateKey: "2026-08-21" });
    assert.equal(first.ok, true);
    assert.equal(first.reads, 1);
    assert.equal(first.indexUpdated, true);

    const body = fs.readFileSync(path.join(slDir, "SL-20260820-藏歌.md"), "utf8");
    assert.match(body, /- 第1次 2026-08-21：第一次读/);
    assert.ok(!body.includes("尚无读档"), "placeholder must be removed on first read");
    assert.equal(listArchives(slDir).rows[0].reads, "1");
    assert.equal(loadArchive({ slDir, name: "藏歌" }).reads, 1);

    const second = recordReentry({ slDir, name: "藏歌", note: "第二次", dateKey: "2026-08-22" });
    assert.equal(second.reads, 2);
    assert.equal(listArchives(slDir).rows[0].reads, "2");
    assert.match(fs.readFileSync(path.join(slDir, "SL-20260820-藏歌.md"), "utf8"), /- 第2次 2026-08-22：第二次/);
  } finally {
    cleanup(root);
  }
});

test("loadArchive reports not-found for an unknown name", () => {
  const root = tempRoot();
  try {
    const slDir = path.join(root, "08-sl");
    writeIndex(slDir);
    assert.equal(loadArchive({ slDir, name: "不存在" }).error, "not-found");
    assert.equal(loadArchive({ slDir: "", name: "x" }).error, "sl-dir-unset");
  } finally {
    cleanup(root);
  }
});

test("parseIndexRows skips header and separator rows", () => {
  const rows = parseIndexRows(
    [
      "| sl_id | 剧情时间 | 备注摘要 | 建档日 | 读档次数 |",
      "|---|---|---|---|---|",
      "| SL-20260819-降级之夜 | 2026-08-19 | 首档 | 2026-08-19 | 2 |",
    ].join("\n"),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slId, "SL-20260819-降级之夜");
  assert.equal(rows[0].reads, "2");
});
