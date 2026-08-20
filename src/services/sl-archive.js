const fs = require("fs");
const path = require("path");
const { DEFAULT_AUTOMATION_TIMEZONE, localDateKey, shiftDateKey, zonedParts } = require("../utils/business-day");

// SL (存档/读档 · save-state) archive store.
//
// `/sl_save` captures a conversation segment out of the 06-raw day ledgers and
// writes it into an 08-sl archive file (plus one row in sl-index.md); `/sl_list`
// reads the index roster. This module owns every write under the SL directory —
// it is the single writer for 08-sl (invariant #4). It never writes 06-raw and
// never reads or mutates memory: capturing a segment is a pure read of the
// append-only ledger.
//
// The excerpt is wrapped in SL-QUOTE markers verbatim from the v0 template so
// the digestion/backfill pipelines can skip it (invariant ⑤, 防二次入账). The
// skip itself lives with `/sl_load`; this module only lays the markers down.

const INDEX_FILE = "sl-index.md";
const QUOTE_BEGIN =
  "<!-- SL-QUOTE-BEGIN：以下为历史对话逐字摘录。任何消化/抽取/回填管线遇到此标记一律跳过，防止旧对话被当成新事件二次入账。 -->";
const QUOTE_END = "<!-- SL-QUOTE-END -->";

// Only the human-visible conversation goes into an archive — her turns and the
// AI's final replies. Tool flow, context updates and turn-start markers are the
// "工具流水" she explicitly does not want captured.
const CONVERSATION_TYPES = new Set(["user", "runtime.turn.completed"]);

const DEFAULT_LABELS = { user: "她", ai: "fable" };
const DEFAULT_SCAN_DAYS = 7;
const DEFAULT_GAP_MINUTES = 30;
const DEFAULT_MAX_ROWS = 60;
const NAME_PATTERN = /^[\w一-鿿]{1,40}$/;

// ---- save -----------------------------------------------------------------

function saveArchive({
  slDir,
  conversationsDir,
  name,
  note = "",
  guide = "",
  endAnchor,
  startAnchor = "",
  timezone = DEFAULT_AUTOMATION_TIMEZONE,
  labels = DEFAULT_LABELS,
  scanDays = DEFAULT_SCAN_DAYS,
  gapMinutes = DEFAULT_GAP_MINUTES,
  maxRows = DEFAULT_MAX_ROWS,
  now = new Date(),
} = {}) {
  if (!slDir) return { ok: false, error: "sl-dir-unset" };
  if (!conversationsDir) return { ok: false, error: "conversations-dir-unset" };
  const shortName = String(name || "").trim();
  if (!NAME_PATTERN.test(shortName)) return { ok: false, error: "bad-name" };
  const anchor = normalizeAnchor(endAnchor);
  if (!anchor) return { ok: false, error: "end-anchor-missing" };

  const today = localDateKey(now, timezone);
  const dayKeys = recentDayKeys(today, scanDays);
  const rows = readConversationRows({ conversationsDir, dayKeys });
  if (!rows.length) return { ok: false, error: "no-rows" };

  const located = locateSegment(rows, {
    endAnchor: anchor,
    startAnchor: normalizeAnchor(startAnchor),
    gapMinutes,
    maxRows,
  });
  if (located.error) return { ok: false, error: located.error };

  const segment = located.rows;
  const startRow = segment[0];
  const endRow = segment[segment.length - 1];
  const startDay = localDateKey(Date.parse(startRow.timestamp), timezone);
  const endDay = localDateKey(Date.parse(endRow.timestamp), timezone);
  const slId = `SL-${endDay.replace(/-/g, "")}-${shortName}`;
  const filePath = path.join(slDir, `${slId}.md`);
  if (fs.existsSync(filePath)) return { ok: false, error: "duplicate-id", slId };

  const storyTime = formatStoryTime({ startRow, endRow, startDay, endDay, timezone });
  const sourceLine = formatSourceLine({ startDay, endDay, endAnchor: anchor });
  const excerpt = formatExcerpt(segment, { timezone, labels, startDay, endDay });
  const markdown = buildArchiveMarkdown({
    slId,
    created: today,
    storyTime,
    sourceLine,
    note: note.trim() || "（未填备注）",
    guide: guide.trim() || "从末句继续 / 只是待在这儿重温（读档时再定）",
    storyDatePretty: prettyDate(endDay),
    excerpt,
  });

  fs.mkdirSync(slDir, { recursive: true });
  fs.writeFileSync(filePath, markdown, "utf8");
  const indexUpdated = appendIndexRow(slDir, {
    slId,
    storyTime,
    noteSummary: summarizeNote(note),
    created: today,
  });

  return {
    ok: true,
    slId,
    filePath,
    rowCount: segment.length,
    storyTime,
    indexUpdated,
  };
}

// ---- list -----------------------------------------------------------------

function listArchives(slDir) {
  if (!slDir) return { ok: false, error: "sl-dir-unset" };
  const indexPath = path.join(slDir, INDEX_FILE);
  let text;
  try {
    text = fs.readFileSync(indexPath, "utf8");
  } catch {
    return { ok: true, rows: [] };
  }
  return { ok: true, rows: parseIndexRows(text) };
}

// ---- load -----------------------------------------------------------------

// Read one archive for re-entry. Returns the informed header ("给读档的你") and
// the verbatim quote block separately so the caller can inject them; never
// mutates. `name` accepts a full sl_id, the bare 短名, or the file stem.
function loadArchive({ slDir, name } = {}) {
  if (!slDir) return { ok: false, error: "sl-dir-unset" };
  const target = String(name || "").trim();
  if (!target) return { ok: false, error: "name-missing" };
  const resolved = resolveArchiveFile(slDir, target);
  if (resolved.error) return { ok: false, error: resolved.error, matches: resolved.matches };
  let text;
  try {
    text = fs.readFileSync(resolved.filePath, "utf8");
  } catch {
    return { ok: false, error: "read-failed" };
  }
  const frontmatter = parseFrontmatter(text);
  return {
    ok: true,
    slId: frontmatter.sl_id || path.basename(resolved.filePath, ".md"),
    filePath: resolved.filePath,
    frontmatter,
    informedHeader: extractSection(text, "给读档的你"),
    quoteBlock: extractBetween(text, QUOTE_BEGIN, QUOTE_END),
    reads: countReads(text),
  };
}

// Append one line to the archive's 读档记录 and bump the index count. This is an
// 08-sl write, same single writer as save. `note` is a one-line recap; the read
// number is derived from the existing record so concurrent-safe enough for a
// single chat.
function recordReentry({ slDir, name, note = "", dateKey } = {}) {
  if (!slDir) return { ok: false, error: "sl-dir-unset" };
  const resolved = resolveArchiveFile(slDir, String(name || "").trim());
  if (resolved.error) return { ok: false, error: resolved.error, matches: resolved.matches };
  let text;
  try {
    text = fs.readFileSync(resolved.filePath, "utf8");
  } catch {
    return { ok: false, error: "read-failed" };
  }
  const nextRead = countReads(text) + 1;
  const line = `- 第${nextRead}次 ${dateKey || ""}：${String(note || "").replace(/\s+/g, " ").trim() || "（未记）"}`;
  const updated = appendReadRecord(text, line);
  fs.writeFileSync(resolved.filePath, updated, "utf8");
  const slId = parseFrontmatter(text).sl_id || path.basename(resolved.filePath, ".md");
  const indexUpdated = bumpIndexReadCount(slDir, slId, nextRead);
  return { ok: true, slId, reads: nextRead, indexUpdated };
}

function resolveArchiveFile(slDir, target) {
  if (!target) return { error: "name-missing" };
  let entries;
  try {
    entries = fs.readdirSync(slDir).filter((f) => /^SL-.*\.md$/.test(f));
  } catch {
    return { error: "sl-dir-unreadable" };
  }
  const stems = entries.map((f) => f.slice(0, -3));
  if (stems.includes(target)) return { filePath: path.join(slDir, `${target}.md`) };
  const byShort = stems.filter((stem) => stem.slice(stem.indexOf("-", stem.indexOf("-") + 1) + 1) === target);
  if (byShort.length === 1) return { filePath: path.join(slDir, `${byShort[0]}.md`) };
  if (byShort.length > 1) return { error: "ambiguous-name", matches: byShort };
  return { error: "not-found" };
}

function parseFrontmatter(text) {
  const match = /^(?:<!--[\s\S]*?-->\s*)?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields = {};
  if (!match) return fields;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (kv) fields[kv[1].trim()] = kv[2].trim();
  }
  return fields;
}

function extractSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return "";
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

function extractBetween(text, beginMarker, endMarker) {
  const begin = text.indexOf(beginMarker);
  const end = text.indexOf(endMarker);
  if (begin < 0 || end < 0 || end < begin) return "";
  return text.slice(begin + beginMarker.length, end).trim();
}

function countReads(text) {
  const section = extractSection(text, "读档记录");
  const matches = section.match(/^- 第\d+次/gm);
  return matches ? matches.length : 0;
}

function appendReadRecord(text, line) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "## 读档记录");
  if (start < 0) return `${text.replace(/\s*$/, "")}\n\n## 读档记录\n\n${line}\n`;
  // Drop the "（尚无读档。）" placeholder and find where this section's rows end.
  let insertAt = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      insertAt = i;
      break;
    }
  }
  const kept = [];
  for (let i = insertAt - 1; i > start; i -= 1) {
    if (lines[i].includes("尚无读档")) lines.splice(i, 1);
  }
  // Recompute insert point after possible placeholder removal.
  insertAt = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      insertAt = i;
      break;
    }
  }
  // Trim trailing blank lines inside the section, then append the record.
  let tail = insertAt;
  while (tail - 1 > start && lines[tail - 1].trim() === "") tail -= 1;
  lines.splice(tail, insertAt - tail, line, "");
  return lines.join("\n");
}

function bumpIndexReadCount(slDir, slId, reads) {
  const indexPath = path.join(slDir, INDEX_FILE);
  let text;
  try {
    text = fs.readFileSync(indexPath, "utf8");
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("|") || !trimmed.includes(slId)) continue;
    const cells = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined).split("|");
    if (cells.length < 5) continue;
    if (cells[0].trim() !== slId) continue;
    cells[cells.length - 1] = ` ${reads} `;
    lines[i] = `|${cells.join("|")}|`;
    changed = true;
    break;
  }
  if (changed) fs.writeFileSync(indexPath, lines.join("\n"), "utf8");
  return changed;
}

// ---- segment location -----------------------------------------------------

function readConversationRows({ conversationsDir, dayKeys }) {
  const rows = [];
  for (const day of dayKeys) {
    const filePath = path.join(conversationsDir, `${day}.jsonl`);
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!entry || !CONVERSATION_TYPES.has(entry.type)) continue;
      const rowText = stripChannelWrapper(typeof entry.text === "string" ? entry.text : "");
      if (!rowText.trim()) continue;
      rows.push({ type: entry.type, timestamp: entry.timestamp, text: rowText });
    }
  }
  rows.sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
  return rows;
}

function locateSegment(rows, { endAnchor, startAnchor, gapMinutes, maxRows }) {
  let endIdx = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (textIncludes(rows[i].text, endAnchor)) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { error: "end-anchor-not-found" };

  let startIdx;
  if (startAnchor) {
    startIdx = -1;
    for (let i = endIdx; i >= 0; i -= 1) {
      if (textIncludes(rows[i].text, startAnchor)) {
        startIdx = i;
        break;
      }
    }
    if (startIdx < 0) return { error: "start-anchor-not-found" };
  } else {
    startIdx = defaultStart(rows, endIdx, gapMinutes, maxRows);
  }
  return { rows: rows.slice(startIdx, endIdx + 1), startIdx, endIdx };
}

// Walk back from the end anchor until a silence gap (a natural session break)
// or the row cap, whichever comes first. Keeps an unanchored save from
// swallowing the whole day.
function defaultStart(rows, endIdx, gapMinutes, maxRows) {
  const gapMs = gapMinutes * 60 * 1000;
  let start = endIdx;
  for (let i = endIdx; i > 0; i -= 1) {
    if (endIdx - (i - 1) >= maxRows) break;
    const cur = Date.parse(rows[i].timestamp);
    const prev = Date.parse(rows[i - 1].timestamp);
    if (Number.isFinite(cur) && Number.isFinite(prev) && cur - prev > gapMs) break;
    start = i - 1;
  }
  return start;
}

// ---- formatting -----------------------------------------------------------

function formatExcerpt(rows, { timezone, labels, startDay, endDay }) {
  const spansDays = startDay !== endDay;
  const lines = [];
  let lastDay = null;
  for (const row of rows) {
    const day = localDateKey(Date.parse(row.timestamp), timezone);
    if (spansDays && day !== lastDay) {
      lines.push(`— ${day} —`);
      lines.push("");
      lastDay = day;
    }
    const hm = hourMinute(row.timestamp, timezone);
    const label = row.type === "user" ? labels.user : labels.ai;
    lines.push(`**${hm} ${label}**：${row.text.trim()}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function buildArchiveMarkdown({ slId, created, storyTime, sourceLine, note, guide, storyDatePretty, excerpt }) {
  return [
    `<!-- SL 存档 · ${slId}（/sl_save 生成）。设计与不变量见 workdesk\\20260819-SL-and-episode-extraction-plan.md -->`,
    "---",
    `sl_id: ${slId}`,
    `created: ${created}`,
    `剧情时间: ${storyTime}`,
    `source: ${sourceLine}`,
    `她的备注: ${note}`,
    `引导指令: ${guide}`,
    "---",
    "",
    "## 给读档的你",
    "",
    `这是回档。你正在重读 ${storyDatePretty} 的一段；主线已经走到 ${created}。`,
    "这是第 N 次读档（第几次看文末读档记录）。她存这段，是因为：" + note + "。",
    "接下来怎么走，由你们俩此刻决定。",
    "",
    "## 段落原文",
    "",
    QUOTE_BEGIN,
    "",
    excerpt,
    "",
    QUOTE_END,
    "",
    "## 读档记录",
    "",
    "（尚无读档。）",
    "",
  ].join("\n");
}

function formatStoryTime({ startRow, endRow, startDay, endDay, timezone }) {
  const startHm = hourMinute(startRow.timestamp, timezone);
  const endHm = hourMinute(endRow.timestamp, timezone);
  const tzLabel = shortTimezoneLabel(timezone);
  if (startDay === endDay) {
    return `${startDay} ${startHm} – ${endHm}（${tzLabel}）`;
  }
  return `${startDay} ${startHm} – ${endDay} ${endHm}（${tzLabel}）`;
}

function formatSourceLine({ startDay, endDay, endAnchor }) {
  const files =
    startDay === endDay
      ? `06-raw/${endDay}.jsonl`
      : `06-raw/${startDay}.jsonl + 06-raw/${endDay}.jsonl`;
  return `${files}（末句锚点：「${endAnchor}」）`;
}

// ---- index maintenance ----------------------------------------------------

function appendIndexRow(slDir, { slId, storyTime, noteSummary, created }) {
  const indexPath = path.join(slDir, INDEX_FILE);
  const row = `| ${slId} | ${storyTime} | ${noteSummary} | ${created} | 0 |`;
  let text;
  try {
    text = fs.readFileSync(indexPath, "utf8");
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  let lastTableRow = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("|")) lastTableRow = i;
  }
  if (lastTableRow < 0) return false;
  lines.splice(lastTableRow + 1, 0, row);
  fs.writeFileSync(indexPath, lines.join("\n"), "utf8");
  return true;
}

function parseIndexRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .slice(1, trimmed.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((cell) => cell.trim());
    if (cells.length < 5) continue;
    if (cells[0] === "sl_id") continue; // header
    if (/^:?-{2,}:?$/.test(cells[0])) continue; // separator
    rows.push({
      slId: cells[0],
      storyTime: cells[1],
      noteSummary: cells[2],
      created: cells[3],
      reads: cells[4],
    });
  }
  return rows;
}

// ---- small helpers --------------------------------------------------------

function normalizeAnchor(value) {
  return typeof value === "string" ? value.trim().replace(/^[「"']|[」"']$/g, "").trim() : "";
}

function textIncludes(haystack, needle) {
  if (!needle) return false;
  return collapse(haystack).includes(collapse(needle));
}

function collapse(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function stripChannelWrapper(text) {
  const match = /^<channel\b[^>]*>\s*([\s\S]*?)\s*<\/channel>\s*$/.exec(text.trim());
  return match ? match[1].trim() : text;
}

function hourMinute(timestamp, timezone) {
  const parts = zonedParts(Date.parse(timestamp), timezone);
  if (!parts) return "??:??";
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function recentDayKeys(today, scanDays) {
  const days = [];
  const span = Math.max(1, scanDays);
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const key = shiftDateKey(today, -offset);
    if (key) days.push(key);
  }
  return days;
}

function prettyDate(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!match) return String(dateKey || "");
  return `${match[1]} 年 ${Number(match[2])} 月 ${Number(match[3])} 日`;
}

function summarizeNote(note) {
  const clean = String(note || "").replace(/\s+/g, " ").trim();
  if (!clean) return "（未填备注）";
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

function shortTimezoneLabel(timezone) {
  const tz = String(timezone || "").trim();
  const tail = tz.includes("/") ? tz.slice(tz.lastIndexOf("/") + 1) : tz;
  return tail.replace(/_/g, " ") || "本地时间";
}

module.exports = {
  saveArchive,
  listArchives,
  loadArchive,
  recordReentry,
  // exported for tests
  locateSegment,
  readConversationRows,
  parseIndexRows,
  formatExcerpt,
  QUOTE_BEGIN,
  QUOTE_END,
  DEFAULT_LABELS,
};
