const crypto = require("crypto");
const path = require("path");

const { readJsonl } = require("../continuity/continuity-store");
const { runReviewCheckpointed } = require("../continuity/review-checkpoint");
const { ensureEmptyEpisodeIndex, listEpisodeFiles } = require("../continuity/episode-materializer");

const OVERDUE_RETRY_MS = 60_000;

class PipelineScheduler {
  constructor(options = {}) {
    this.config = options.config || {};
    this.queueStore = options.queueStore || null;
    this.accountId = options.accountId || "";
    this.senderId = options.senderId || "";
    this.workspaceRoot = options.workspaceRoot || this.config.workspaceRoot || "";
    this.pipeline = options.pipeline || null;
    this.createPipeline = options.createPipeline || (() => require("../continuity/closeout-job").createContinuityPipeline(this.config));
    this.runReview = options.runReview || runReviewCheckpointed;
    this.clock = options.clock || { now: () => Date.now() };
    this.timers = options.timers || { setTimeout, clearTimeout };
    this.timer = null;
    this.started = false;
    this.stopped = false;
    this.tickInFlight = null;
    this.nextRunAt = Number.isFinite(Number(options.nextRunAt)) ? Number(options.nextRunAt) : null;
  }

  get enabled() {
    return this.config.pipelineScheduleEnabled === true;
  }

  get intervalMs() {
    return Math.max(5, Number(this.config.pipelineIntervalMinutes) || 60) * 60_000;
  }

  start() {
    if (!this.enabled || this.started) return false;
    this.started = true;
    this.stopped = false;
    this.nextRunAt = this.nextRunAt ?? (this.clock.now() + this.intervalMs);
    void this.scheduleTick();
    return true;
  }

  async stop() {
    this.stopped = true;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    return this.tickInFlight || undefined;
  }

  async scheduleTick() {
    if (this.stopped || !this.enabled) return;
    try {
      const now = Number(this.clock.now());
      const delay = Number(this.nextRunAt) - now;
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        void this.runScheduledTick();
      }, delay > 0 ? delay : OVERDUE_RETRY_MS);
    } catch (error) {
      console.warn(`[automation] pipeline scheduling failed: ${error?.message || String(error)}`);
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        void this.runScheduledTick();
      }, this.intervalMs);
    }
  }

  async runScheduledTick() {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (error) {
      console.warn(`[automation] pipeline tick failed: ${error?.stack || error?.message || String(error)}`);
    } finally {
      this.nextRunAt = Number(this.clock.now()) + this.intervalMs;
      await this.scheduleTick();
    }
  }

  async tick() {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.runTick().finally(() => { this.tickInFlight = null; });
    return this.tickInFlight;
  }

  async runTick() {
    let pipeline;
    try {
      pipeline = this.pipeline || this.createPipeline();
    } catch (error) {
      console.warn(`[automation] pipeline unavailable: ${error?.message || String(error)}`);
      return { status: "skipped", reason: "pipeline_unavailable" };
    }
    const candidates = readPipelineRows(pipeline?.paths?.candidates);
    if (!candidates.length) {
      ensureEmptyIndex(pipeline);
      return { status: "skipped", reason: "no_candidates" };
    }
    let review;
    try {
      review = this.runReview(pipeline);
    } catch (error) {
      console.warn(`[automation] pipeline review failed: ${error?.message || String(error)}`);
      return { status: "skipped", reason: "review_error" };
    }
    if (review?.status !== "success") return { status: "skipped", reason: review?.reason || "review_incomplete", review };
    let history;
    try {
      history = pipeline.runHistoryWriter();
    } catch (error) {
      console.warn(`[automation] pipeline history failed: ${error?.message || String(error)}`);
      return { status: "skipped", reason: "history_error", review };
    }
    if (history?.status !== "success") {
      return { status: "skipped", reason: history?.reason || "history_incomplete", review, history };
    }
    ensureEmptyIndex(pipeline);
    const receipt = this.enqueueReceipt({ pipeline, candidates, review, history });
    return { status: "success", review, history, receipt };
  }

  enqueueReceipt({ pipeline, candidates, review, history }) {
    if (this.config.memoryReceiptEnabled !== true || !this.queueStore || !this.accountId || !this.senderId || !this.workspaceRoot) {
      return { status: "skipped", reason: "disabled_or_target_unavailable" };
    }
    if (this.queueStore.hasPendingForAccount(this.accountId, {
      shouldInclude: (message) => message?.sourceType === "memory_receipt",
    })) return { status: "skipped", reason: "overlap" };
    const text = buildMemoryReceiptText({ pipeline, candidates, decisions: review?.decisions, written: history?.written });
    if (!text) return { status: "skipped", reason: "no_terminal_decision" };
    const id = `memory-receipt:${crypto.randomUUID()}`;
    this.queueStore.enqueue({
      id,
      accountId: this.accountId,
      senderId: this.senderId,
      workspaceRoot: this.workspaceRoot,
      text,
      sourceType: "memory_receipt",
      createdAt: new Date(this.clock.now()).toISOString(),
    });
    return { status: "queued", id };
  }
}

function readPipelineRows(filePath) {
  return filePath ? readJsonl(filePath) : [];
}

function ensureEmptyIndex(pipeline) {
  if (!pipeline?.paths?.episodes || !pipeline?.continuityDir) return;
  ensureEmptyEpisodeIndex({
    episodesDir: path.join(pipeline.continuityDir, "episodes"),
    canonRecords: readPipelineRows(pipeline.paths.episodes),
  });
}

function buildMemoryReceiptText({ pipeline, candidates = [], decisions = [], written = [] } = {}) {
  const candidatesById = new Map(candidates.map((candidate) => [candidate?.candidate_id, candidate]));
  const writtenSet = new Set(Array.isArray(written) ? written : []);
  const episodesByCandidateId = new Map(
    pipeline?.continuityDir
      ? listEpisodeFiles(path.join(pipeline.continuityDir, "episodes"))
        .map((entry) => [entry.frontmatter.candidate_id, entry.frontmatter.seq])
      : [],
  );
  const lines = [];
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const candidate = candidatesById.get(decision?.candidate_id);
    if (!candidate) continue;
    const title = candidateTitle(candidate);
    if (decision.result === "accepted" && writtenSet.has(decision.decision_id)) {
      lines.push(`你${whenLeft(candidate.ts)}留的那条『${title}』已经入册（${episodesByCandidateId.get(candidate.candidate_id) || "episode"}）。`);
    } else if (decision.result === "rejected") {
      lines.push(`你留的那条『${title}』审核没过（${oneLine(decision.reason) || "原因未明"}），原文还在候选区，想改可以再交。`);
    }
  }
  return lines.join("\n");
}

function candidateTitle(candidate) {
  return oneLine(String(candidate?.body || "").split(/\r?\n/u).find((line) => line.trim()) || "未命名").slice(0, 40) || "未命名";
}

function oneLine(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function daysAgo(value, now = Date.now()) {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((Number(now) - then) / 86_400_000));
}

// 回执是说给她听的，不是报表。「你 0 天前留的那条」没人会这么讲话——
// 跨夜投的稿第二天入册就正好落在 0 天上（2026-08-11 首条 ep001 就是）。
// 时间说不清楚时干脆不说，句子照样通顺。
function whenLeft(value, now = Date.now()) {
  const days = daysAgo(value, now);
  if (!Number.isFinite(Date.parse(value))) return "";
  if (days <= 0) return "刚才";
  if (days === 1) return "昨天";
  return ` ${days} 天前`;
}

module.exports = { PipelineScheduler, OVERDUE_RETRY_MS, buildMemoryReceiptText };
