"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Episode 的人面视图（batch/episode-md）：
// canon 真相仍是 episodes.jsonl（签名守卫、reentry 元数据、lookup 都读它，本模块一概不碰）。
// 这里只在发布后做两件事：
//   1. 一条 episode 物化成一个 md 文件（写一次，之后永不重生成——正文按 D16 不可改写，
//      所以没有同步问题；文件尾部的「附注」区属于她，物化之后归 annotate 通道追加）。
//   2. 重生成 index.md 目录（每次发布全量重建，手改无效；这是唯一会被覆盖的文件）。
// 物化失败绝不打断发布：canon 已落账，视图掉了可以随时补，错误记进 .jobs 供巡检。

const INDEX_FILE = "index.md";
const ERROR_LOG = "episode-materializer-errors.jsonl";
const ANNOTATIONS_HEADING = "## 附注";
const STATUSES = ["active", "superseded", "pinned", "archived"];
// 文件名里标题截到这个长度：够认出是哪条，不至于生成没法看的长文件名。
const SLUG_MAX_CHARS = 24;
const TITLE_MAX_CHARS = 40;

function materializeEpisode({ episodesDir, jobsDir, record }) {
  try {
    fs.mkdirSync(episodesDir, { recursive: true });
    const existing = listEpisodeFiles(episodesDir);
    if (existing.some((item) => item.frontmatter.publication_key === record.publication_key)) {
      return { status: "skipped", reason: "already_materialized" };
    }
    const seq = nextSequence(existing);
    const title = extractTitle(record.body);
    const fileName = `${seq}-${slugify(title)}.md`;
    const filePath = path.join(episodesDir, fileName);
    fs.writeFileSync(filePath, renderEpisode({ seq, title, record }), "utf8");
    regenerateIndex({ episodesDir });
    return { status: "written", file: fileName, seq };
  } catch (error) {
    recordMaterializerError(jobsDir, record, error);
    return { status: "error", message: String(error && error.message) };
  }
}

function regenerateIndex({ episodesDir }) {
  const entries = listEpisodeFiles(episodesDir)
    .sort((a, b) => a.frontmatter.seq.localeCompare(b.frontmatter.seq));
  const byMonth = new Map();
  const retired = [];
  for (const entry of entries) {
    const target = entry.frontmatter.status === "superseded" || entry.frontmatter.status === "archived"
      ? retired
      : monthBucket(byMonth, entry);
    target.push(entry);
  }
  const lines = [
    "# Episodes 目录",
    "",
    "<!-- History writer 发布时自动重生成，手改会被覆盖。想留话请写进各条的「附注」区。 -->",
    "",
  ];
  for (const [month, monthEntries] of [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    lines.push(`## ${month}`, "");
    for (const entry of monthEntries) lines.push(indexLine(entry));
    lines.push("");
  }
  if (retired.length) {
    lines.push("## 已沉降（superseded / archived）", "");
    for (const entry of retired) lines.push(indexLine(entry));
    lines.push("");
  }
  fs.writeFileSync(path.join(episodesDir, INDEX_FILE), `${lines.join("\n").trimEnd()}\n`, "utf8");
}

function indexLine(entry) {
  const { seq, status, day } = entry.frontmatter;
  const marker = status === "pinned" ? "📌 " : "";
  const label = `${seq} · ${entry.frontmatter.title}`;
  const text = status === "superseded" ? `~~${label}~~` : label;
  return `- ${marker}[${text}](${encodeURI(entry.fileName)}) — ${day}`;
}

function renderEpisode({ seq, title, record }) {
  const day = String(record.ts || "").slice(0, 10);
  const frontmatter = [
    "---",
    `seq: ${seq}`,
    `ep_id: ${record.ep_id}`,
    `title: ${yamlText(title)}`,
    `time: ${yamlText(record.ts || "")}`,
    "status: active",
    "tags: []",
    `type: ${record.type || "episode"}`,
    `supersedes: ${record.supersedes ? yamlText(record.supersedes) : "null"}`,
    `origin: ${yamlText(record.origin || "")}`,
    `author_role: ${yamlText(record.author_role || "")}`,
    `publication_key: ${yamlText(record.publication_key)}`,
    `candidate_id: ${yamlText(record.candidate_id || "")}`,
    "---",
  ];
  return [
    ...frontmatter,
    "",
    `# ${title}`,
    "",
    `> ${day} · 经 候选→Review→History 发布；正文为主体亲笔，按 D16 不改写。`,
    "",
    "## 正文",
    "",
    record.body,
    "",
    ANNOTATIONS_HEADING,
    "",
    "<!-- 回看时的评论追加在这里；正文不改，改看法就在这留痕。 -->",
    "",
  ].join("\n");
}

function listEpisodeFiles(episodesDir) {
  if (!fs.existsSync(episodesDir)) return [];
  const items = [];
  for (const fileName of fs.readdirSync(episodesDir)) {
    if (!/^ep\d{3,}-.*\.md$/u.test(fileName)) continue;
    const frontmatter = parseFrontmatter(path.join(episodesDir, fileName));
    if (frontmatter && frontmatter.seq) items.push({ fileName, frontmatter });
  }
  return items;
}

// 只解析本模块自己写出的扁平 frontmatter；不引第三方 YAML 库（仓库纪律：核心零依赖）。
function parseFrontmatter(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const divider = line.indexOf(":");
    if (divider < 1) continue;
    const key = line.slice(0, divider).trim();
    let value = line.slice(divider + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value);
    fields[key] = value;
  }
  if (!STATUSES.includes(fields.status)) fields.status = "active";
  fields.day = String(fields.time || "").slice(0, 10);
  fields.title = fields.title || fields.seq || "";
  return fields;
}

function nextSequence(existing) {
  let max = 0;
  for (const item of existing) {
    const parsed = Number.parseInt(String(item.frontmatter.seq).replace(/^ep/u, ""), 10);
    if (Number.isInteger(parsed) && parsed > max) max = parsed;
  }
  return `ep${String(max + 1).padStart(3, "0")}`;
}

// 标题 = 正文第一个非空行。guide 约定第一行写短标题；没写也能工作，只是标题长一点被截断。
function extractTitle(body) {
  const firstLine = String(body || "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find((line) => line.length > 0) || "未命名";
  return firstLine.length > TITLE_MAX_CHARS ? `${firstLine.slice(0, TITLE_MAX_CHARS)}…` : firstLine;
}

function slugify(title) {
  const cleaned = title
    .replace(/[\\/:*?"<>|#[\]()`'’“”。，、；：！？…~\s]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
  const sliced = [...cleaned].slice(0, SLUG_MAX_CHARS).join("");
  return sliced || "episode";
}

function monthBucket(byMonth, entry) {
  const month = entry.frontmatter.day.slice(0, 7) || "未知月份";
  if (!byMonth.has(month)) byMonth.set(month, []);
  return byMonth.get(month);
}

function yamlText(value) {
  return JSON.stringify(String(value));
}

function recordMaterializerError(jobsDir, record, error) {
  try {
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.appendFileSync(
      path.join(jobsDir, ERROR_LOG),
      `${JSON.stringify({ ts: new Date().toISOString(), publication_key: record?.publication_key, error: String(error && error.message) })}\n`,
      "utf8",
    );
  } catch {
    // 错误日志本身失败就只能放弃：视图层绝不反向影响发布。
  }
}

module.exports = { materializeEpisode, regenerateIndex, ANNOTATIONS_HEADING, listEpisodeFiles, parseFrontmatter };
