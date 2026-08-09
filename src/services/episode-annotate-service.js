"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { listEpisodeFiles, ANNOTATIONS_HEADING } = require("../continuity/episode-materializer");

// Episode 附注（batch/episode-md）：回看时把「现在的看法」留在那一条的身上。
// 边界与正文相反：正文是 canon（按 D16 永不改写），附注是她的旁批——append-only、
// 带时间戳、只落在单条 md 的「附注」区。不进 jsonl、不进任何注入通路，读取即翻文件。
const MAX_ANNOTATION_CHARS = 500;

class EpisodeAnnotateService {
  constructor({ continuityDir, now = () => new Date() } = {}) {
    this.episodesDir = continuityDir ? path.join(continuityDir, "episodes") : "";
    this.now = now;
  }

  append({ episode, text } = {}) {
    if (!this.episodesDir) return { error: "episodes_dir_unconfigured" };
    const body = typeof text === "string" ? text.trim() : "";
    if (!body) return { error: "empty_text" };
    if (body.length > MAX_ANNOTATION_CHARS) return { error: "text_too_long" };
    const wanted = String(episode || "").trim();
    if (!wanted) return { error: "episode_required" };
    const match = listEpisodeFiles(this.episodesDir).find((item) =>
      item.frontmatter.seq === wanted || item.frontmatter.ep_id === wanted);
    if (!match) return { error: "episode_not_found" };
    const filePath = path.join(this.episodesDir, match.fileName);
    let content = fs.readFileSync(filePath, "utf8");
    if (!content.includes(ANNOTATIONS_HEADING)) {
      content = `${content.trimEnd()}\n\n${ANNOTATIONS_HEADING}\n`;
    }
    const stamp = this.now().toISOString().slice(0, 16).replace("T", " ");
    fs.writeFileSync(filePath, `${content.trimEnd()}\n\n- ${stamp} — ${body}\n`, "utf8");
    return { file: match.fileName, seq: match.frontmatter.seq };
  }
}

module.exports = { EpisodeAnnotateService, MAX_ANNOTATION_CHARS };
