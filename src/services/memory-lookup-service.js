const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("../orchestration/atomic-json");
const { hashThreadId } = require("../core/context-trace");
const { formatReadableTime } = require("../core/readable-time");

const MAX_CALLS_PER_SESSION = 5; // Fault-loop guard, not a relational or posture budget.
const MAX_HITS = 3;
const MAX_NON_WHITESPACE_CHARS = 500;

class MemoryLookupService {
  constructor({ continuityDir, readEpisodes, readSources } = {}) {
    this.continuityDir = normalizeText(continuityDir);
    this.episodesFile = this.continuityDir ? path.join(this.continuityDir, "episodes.jsonl") : "";
    this.timelineFile = this.continuityDir ? path.join(this.continuityDir, "relationship_timeline.md") : "";
    this.topicsFile = this.continuityDir ? path.join(this.continuityDir, "topics.md") : "";
    this.recallLogFile = this.continuityDir ? path.join(this.continuityDir, "recall_log.jsonl") : "";
    this.budgetFile = this.continuityDir ? path.join(this.continuityDir, ".jobs", "memory-lookup-budget.json") : "";
    this.lockFile = this.continuityDir ? path.join(this.continuityDir, ".jobs", "memory-lookup.lock") : "";
    this.readEpisodes = typeof readEpisodes === "function" ? readEpisodes : () => readJsonl(this.episodesFile);
    this.readSources = typeof readSources === "function" ? readSources : () => ({
      episodes: this.readEpisodes(),
      timeline: readTimeline(this.timelineFile),
      topics: readText(this.topicsFile),
    });
  }

  lookup({ query, trigger, reason } = {}, context = {}) {
    const normalizedTrigger = normalizeText(trigger);
    if (!ALLOWED_TRIGGERS.has(normalizedTrigger)) return { error: "invalid_trigger" };
    const session = buildSession(context);
    if (!this.continuityDir || !session) return { hits: [], error: "lookup_failed" };
    const normalizedQuery = normalizeText(query);
    let release;
    try { release = acquireLock(this.lockFile); } catch { return { hits: [], error: "lookup_failed" }; }
    if (!release) return { hits: [], error: "lookup_failed" };
    try {
      const budget = loadBudget(this.budgetFile);
      const budgetKey = hashText(session.key);
      const previous = budget.sessions[budgetKey] || {};
      const used = Math.max(0, Number(previous.count) || 0);
      if (used >= MAX_CALLS_PER_SESSION) {
        this.appendRecall({ session: session.traceSession, trigger: normalizedTrigger, query: normalizedQuery, hitIds: [], budgetLeft: 0 });
        return { error: "budget_exhausted" };
      }
      const intentionalUsed = Math.max(0, Number(previous.intentional_count) || 0);
      if ((normalizedTrigger === "resonance" || normalizedTrigger === "stakes") && intentionalUsed >= 1) {
        this.appendRecall({ session: session.traceSession, trigger: normalizedTrigger, query: normalizedQuery, hitIds: [], budgetLeft: 0 });
        return { error: "budget_exhausted" };
      }
      const budgetLeft = MAX_CALLS_PER_SESSION - used - 1;
      budget.sessions[budgetKey] = {
        count: used + 1,
        intentional_count: intentionalUsed + (normalizedTrigger === "resonance" || normalizedTrigger === "stakes" ? 1 : 0),
        updated_at: new Date().toISOString(),
      };
      writeJsonAtomic(this.budgetFile, budget);
      try {
        const sources = this.readSources();
        const hits = searchMemorySources(sources, normalizedQuery);
        this.appendRecall({
          session: session.traceSession,
          trigger: normalizedTrigger,
          query: normalizedQuery,
          hitIds: hits.map((hit) => hit.ep_id),
          budgetLeft,
        });
        return { hits, empty: hits.length === 0, budget_left: budgetLeft };
      } catch {
        this.appendRecall({ session: session.traceSession, trigger: normalizedTrigger, query: normalizedQuery, hitIds: [], budgetLeft });
        return { hits: [], error: "lookup_failed" };
      }
    } catch {
      return { hits: [], error: "lookup_failed" };
    } finally {
      release();
    }
  }

  appendRecall({ session, trigger, query, hitIds, budgetLeft }) {
    const record = {
      ts: new Date().toISOString(),
      session,
      trigger,
      query,
      hit_ids: Array.isArray(hitIds) ? hitIds.slice(0, MAX_HITS) : [],
      budget_left: Math.max(0, Number(budgetLeft) || 0),
    };
    try {
      fs.mkdirSync(path.dirname(this.recallLogFile), { recursive: true });
      fs.appendFileSync(this.recallLogFile, `${JSON.stringify(record)}\n`, "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

const ALLOWED_TRIGGERS = new Set(["user_pull", "resonance", "stakes", "repair"]);

function searchMemorySources(sources, query) {
  const normalizedSources = sources && typeof sources === "object" ? sources : {};
  const expandedQuery = expandQueryAliases(query, normalizedSources.topics);
  const rows = [
    ...(Array.isArray(normalizedSources.episodes) ? normalizedSources.episodes : []),
    ...(Array.isArray(normalizedSources.timeline) ? normalizedSources.timeline : []),
  ];
  return searchEpisodes(rows, expandedQuery);
}

function expandQueryAliases(query, topicsText) {
  const normalizedQuery = normalizeText(query);
  const key = normalizedQuery.toLocaleLowerCase();
  if (!key || typeof topicsText !== "string") return normalizedQuery;
  for (const rawLine of topicsText.split(/\r?\n/u)) {
    const [left, right] = rawLine.split(/[:：=]/u, 2);
    if (!right) continue;
    const aliases = [left, right].flatMap((part) => String(part).split(/[,，|]/u))
      .map(normalizeText).filter(Boolean);
    if (aliases.some((alias) => alias.toLocaleLowerCase() === key)) {
      return [...new Set([normalizedQuery, ...aliases])].join(" ");
    }
  }
  return normalizedQuery;
}

function searchEpisodes(rows, query) {
  if (!query) return [];
  const normalizedQuery = query.toLocaleLowerCase();
  // 整句必须作为连续子串出现的老规则让两个词以上的查询几乎必空手；
  // 改为按空白分词打分：整句命中 > 全词命中 > 部分词命中，同分保持文件序。
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  const episodes = (Array.isArray(rows) ? rows : []).map(normalizeEpisode).filter(Boolean);
  const correctionByOriginal = new Map();
  for (const episode of episodes) {
    if (episode.supersedes && !correctionByOriginal.has(episode.supersedes)) {
      correctionByOriginal.set(episode.supersedes, episode);
    }
  }
  const scored = [];
  for (const episode of episodes) {
    const fullMatch = episode.searchText.includes(normalizedQuery);
    const hitCount = tokens.filter((token) => episode.searchText.includes(token)).length;
    if (!fullMatch && hitCount === 0) continue;
    const score = (fullMatch ? 1000 : 0) + (hitCount === tokens.length ? 100 : 0) + hitCount;
    scored.push({ episode, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const results = [];
  const seen = new Set();
  for (const { episode } of scored) {
    if (results.length >= MAX_HITS) break;
    pushEpisode(results, seen, episode, correctionByOriginal.get(episode.ep_id)?.ep_id || episode.superseded_by);
    const correction = correctionByOriginal.get(episode.ep_id);
    if (correction) pushEpisode(results, seen, correction, null);
  }
  return results.slice(0, MAX_HITS);
}

function normalizeEpisode(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const epId = normalizeText(row.ep_id || row.id);
  if (!epId) return null;
  const body = normalizeText(row.body) || [
    row.title, row.what_happened, row.why_it_mattered,
    ...(Array.isArray(row.anchor_quotes) ? row.anchor_quotes : []),
    row.future_effect,
  ].map(normalizeText).filter(Boolean).join("\n");
  return {
    ep_id: epId,
    ts: formatReadableTime(normalizeText(row.ts || row.time)),
    body,
    searchText: JSON.stringify(row).toLocaleLowerCase(),
    supersedes: normalizeText(row.supersedes),
    superseded_by: normalizeText(row.superseded_by) || null,
  };
}

function pushEpisode(results, seen, episode, supersededBy) {
  if (!episode || seen.has(episode.ep_id) || results.length >= MAX_HITS) return;
  seen.add(episode.ep_id);
  results.push({
    ep_id: episode.ep_id,
    ts: episode.ts,
    body: truncateBody(episode.body, episode.ep_id),
    register: "lookup",
    superseded_by: supersededBy || null,
  });
}

function truncateBody(value, epId) {
  const text = String(value || "");
  let count = 0;
  let end = text.length;
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/u.test(text[index])) count += 1;
    if (count > MAX_NON_WHITESPACE_CHARS) {
      end = index;
      break;
    }
  }
  if (end === text.length) return text;
  return `${text.slice(0, end)}[截断,完整条目 ${epId}]`;
}

function buildSession(context = {}) {
  const channel = normalizeText(context.provider || context.channel);
  const account = normalizeText(context.accountId);
  const thread = normalizeText(context.threadId);
  if (!channel || !account || !thread) return null;
  return {
    key: `${channel}\n${account}\n${thread}`,
    traceSession: hashThreadId(thread),
  };
}

function loadBudget(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object") {
      return { sessions: parsed.sessions };
    }
  } catch {}
  return { sessions: {} };
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function readTimeline(filePath) {
  const text = readText(filePath);
  if (!text) return [];
  return text.split(/\r?\n\s*\r?\n/u).map((paragraph, index) => {
    const body = paragraph.trim();
    return body ? { ep_id: `timeline-${index + 1}`, ts: "", body, source: "relationship_timeline" } : null;
  }).filter(Boolean);
}

function readText(filePath) {
  try { return filePath ? fs.readFileSync(filePath, "utf8") : ""; } catch { return ""; }
}

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(handle, String(process.pid), "utf8");
      fs.closeSync(handle);
      return () => {
        try { fs.unlinkSync(lockFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error.code !== "EEXIST") return null;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > 30_000) fs.unlinkSync(lockFile);
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return null;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  MAX_CALLS_PER_SESSION,
  MAX_HITS,
  MAX_NON_WHITESPACE_CHARS,
  ALLOWED_TRIGGERS,
  MemoryLookupService,
  buildSession,
  expandQueryAliases,
  searchMemorySources,
  searchEpisodes,
  truncateBody,
};
