const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { acquireWriterLease, releaseWriterLease } = require("../orchestration/writer-lease");
const { countNonWhitespace } = require("../core/reentry-loader");
const { stripConversationArtifacts } = require("./conversation-purity");
const {
  authorityFailureReason,
  canPublishCandidate,
  normalizeCandidateMetadata,
} = require("./candidate-authority");
const {
  appendJsonlUnique,
  backupFile,
  loadJson,
  readJsonl,
  replaceTextAtomic,
  sha256,
  writeJsonAtomic,
} = require("./continuity-store");

class ContinuityPipeline {
  constructor(options = {}) {
    this.continuityDir = path.resolve(requireText(options.continuityDir, "continuityDir"));
    this.conversationDir = path.resolve(requireText(options.conversationDir, "conversationDir"));
    this.writerLeaseFile = path.resolve(requireText(options.writerLeaseFile, "writerLeaseFile"));
    this.python = options.python || process.env.PYTHON || "python";
    this.reviewScript = path.resolve(requireText(options.reviewScript, "reviewScript"));
    this.janitorScript = options.janitorScript ? path.resolve(options.janitorScript) : "";
    this.transcriptDir = options.transcriptDir ? path.resolve(options.transcriptDir) : "";
    this.leaseDetails = {
      model: options.model || "configured-runtime",
      phase: "phase3",
      branch: options.branch || "unknown-branch",
      worktree: requireText(options.worktree, "worktree"),
      base_sha: options.baseSha || "0".repeat(40),
    };
    this.leaseOptions = {
      recoverStale: options.recoverStaleWriterLease !== false,
      isProcessAlive: options.isProcessAlive,
      staleArchiveDir: path.resolve(options.writerLeaseArchiveDir || path.join(this.continuityDir, ".backups", "writer-leases")),
    };
    this.paths = {
      candidates: path.join(this.continuityDir, "candidates", "episodes.candidates.jsonl"),
      decisions: path.join(this.continuityDir, "decisions", "decisions.jsonl"),
      episodes: path.join(this.continuityDir, "episodes.jsonl"),
      reentry: path.join(this.continuityDir, "reentry.md"),
      selfNotes: path.join(this.continuityDir, "ai_self_notes.md"),
      jobs: path.join(this.continuityDir, ".jobs"),
      backups: path.join(this.continuityDir, ".backups"),
      writerState: path.join(this.continuityDir, ".jobs", "history-writer-state.json"),
    };
  }

  runCloseout({ date, author, candidateMetadata = {} }) {
    const day = normalizeDate(date);
    const ledgerPath = path.join(this.paths.jobs, `closeout-${day}.json`);
    if (fs.existsSync(ledgerPath)) return { status: "no_output", reason: "already_ran", author_called: false };
    return this.withLease("closeout-writer", () => {
      if (fs.existsSync(ledgerPath)) return { status: "no_output", reason: "already_ran", author_called: false };
      const materials = this.loadFilteredMaterials(day);
      if (!materials.entries.length) {
        writeJsonAtomic(ledgerPath, { date: day, status: "no_output", candidate_ids: [] });
        return { status: "no_output", reason: "no_materials", author_called: false };
      }
      if (typeof author !== "function") throw new Error("closeout author is required");
      const authored = author({ date: day, materials: materials.text, entries: materials.entries });
      if (authored && typeof authored.then === "function") {
        throw new Error("runCloseout author must be synchronous; use runCloseoutAsync for runtime authoring");
      }
      return this.publishCloseout(day, materials, authored, ledgerPath, candidateMetadata);
    });
  }

  async runCloseoutAsync({ date, author, candidateMetadata = {} }) {
    const day = normalizeDate(date);
    const ledgerPath = path.join(this.paths.jobs, `closeout-${day}.json`);
    if (fs.existsSync(ledgerPath)) return { status: "no_output", reason: "already_ran", author_called: false };
    return this.withLeaseAsync("closeout-writer", async () => {
      if (fs.existsSync(ledgerPath)) return { status: "no_output", reason: "already_ran", author_called: false };
      const materials = this.loadFilteredMaterials(day);
      if (!materials.entries.length) {
        writeJsonAtomic(ledgerPath, { date: day, status: "no_output", candidate_ids: [] });
        return { status: "no_output", reason: "no_materials", author_called: false };
      }
      const authored = await author({ date: day, materials: materials.text, entries: materials.entries });
      return this.publishCloseout(day, materials, authored, ledgerPath, candidateMetadata);
    });
  }

  publishCloseout(day, materials, authored = {}, ledgerPath, candidateMetadata = {}) {
    const sourceRef = materials.source_ref;
    const drafts = [];
    for (const episode of (Array.isArray(authored?.episodes) ? authored.episodes : []).slice(0, 2)) {
      const body = normalizeBody(typeof episode === "string" ? episode : episode?.body);
      if (body) drafts.push({ type: "episode", body });
    }
    const selfNote = normalizeBody(authored?.self_note);
    if (selfNote) drafts.push({ type: "self_note", body: selfNote });
    const reentry = normalizeBody(authored?.reentry_draft);
    if (reentry) drafts.push({ type: "reentry_draft", body: reentry });

    const defaults = {
      origin: "nightly_closeout",
      authorRole: "background_proxy",
      authorModel: this.leaseDetails.model,
      contextScope: "daily_materials",
      semanticAuthority: "medium",
      ...candidateMetadata,
    };
    const candidates = drafts.map((draft) => createCandidate({
      date: day,
      type: draft.type,
      author: "closeout",
      body: draft.body,
      sourceRef,
      ...defaults,
      needsSubjectReview: typeof defaults.needsSubjectReview === "boolean"
        ? defaults.needsSubjectReview
        : (["self_note", "reentry_draft"].includes(draft.type) && defaults.authorRole !== "subject_ai"),
    }));
    const added = appendJsonlUnique(this.paths.candidates, candidates, "candidate_id");
    writeJsonAtomic(ledgerPath, {
      date: day,
      status: added.length ? "success" : "no_output",
      candidate_ids: added.map((item) => item.candidate_id),
    });
    return { status: added.length ? "success" : "no_output", candidates: added, author_called: true };
  }

  loadFilteredMaterials(day) {
    const filePath = path.join(this.conversationDir, `${day}.jsonl`);
    const rows = readJsonl(filePath);
    const entries = rows.map((row, index) => ({
      ...row,
      line: index + 1,
      text: stripConversationArtifacts(row?.text),
    })).filter((row) => row.text && isConversationType(row.type));
    return {
      entries,
      text: entries.map((row) => `[${row.timestamp || ""}] ${row.type}: ${row.text}`).join("\n"),
      source_ref: { file: filePath, window: entries.length ? `${entries[0].line}-${entries[entries.length - 1].line}` : "" },
    };
  }

  runReview({ env = process.env, retryCandidateId = "" } = {}) {
    return this.withLease("review-writer", () => {
      const candidates = readJsonl(this.paths.candidates).map(normalizeCandidateMetadata);
      const existing = readJsonl(this.paths.decisions);
      const decided = new Set(existing.map((item) => item.candidate_id));
      const primaryByBody = new Map();
      for (const candidate of candidates) {
        const bodyKey = sha256(`${candidate.type}\n${normalizeBody(candidate.body)}`);
        if (!primaryByBody.has(bodyKey)) primaryByBody.set(bodyKey, candidate.candidate_id);
      }
      const decisions = [];
      for (const candidate of candidates) {
        if (retryCandidateId && candidate.candidate_id !== retryCandidateId) continue;
        if (!retryCandidateId && decided.has(candidate.candidate_id)) continue;
        const bodyKey = sha256(`${candidate.type}\n${normalizeBody(candidate.body)}`);
        if (primaryByBody.get(bodyKey) !== candidate.candidate_id) {
          decisions.push(createDecision(candidate, {
            result: "merged",
            reason: "duplicate_candidate",
            checks: buildLocalChecks(candidate, true),
            merged_into: primaryByBody.get(bodyKey),
          }));
          continue;
        }
        const sourceLocated = locateSourceRef(candidate.source_ref);
        const result = runPythonReview({
          python: this.python,
          script: this.reviewScript,
          candidate,
          sourceLocated,
          env,
        });
        const localChecks = buildLocalChecks(candidate, sourceLocated);
        const combinedChecks = { ...localChecks, ...(result.checks || {}) };
        combinedChecks.source_ref_located = localChecks.source_ref_located;
        combinedChecks.length_ok = localChecks.length_ok;
        combinedChecks.imperative_warning = localChecks.imperative_warning || result.checks?.imperative_warning === true;
        combinedChecks.publication_allowed = localChecks.publication_allowed;
        let enforced = { ...result };
        if (!combinedChecks.source_ref_located) enforced = { ...enforced, result: "deferred", reason: "source_ref_missing" };
        if (!combinedChecks.length_ok) enforced = { ...enforced, result: "deferred", reason: "over_budget" };
        if (combinedChecks.safety_ok === false && enforced.result === "accepted") {
          enforced = { ...enforced, result: "rejected", reason: "safety_failed" };
        }
        if (!combinedChecks.publication_allowed) {
          enforced = { ...enforced, result: "deferred", reason: authorityFailureReason(candidate) };
        }
        decisions.push(createDecision(candidate, { ...enforced, checks: combinedChecks }));
      }
      const added = appendJsonlUnique(this.paths.decisions, decisions, "decision_id");
      return { status: "success", decisions: added };
    });
  }

  runJanitor({ env = process.env } = {}) {
    if (!this.janitorScript || !this.transcriptDir) {
      return { status: "skipped", reason: "janitor_not_configured" };
    }
    return this.withLease("janitor-writer", () => {
      const proc = spawnSync(this.python, [
        this.janitorScript,
        "--input", this.transcriptDir,
        "--outdir", this.continuityDir,
      ], {
        encoding: "utf8",
        env: { ...env, CYBERBOSS_WRITER_LEASE_HELD: "1", PYTHONUTF8: "1" },
        timeout: 120_000,
      });
      if (proc.status !== 0) {
        return { status: "deferred", reason: "janitor_failed", exit_code: proc.status };
      }
      return { status: "success", output: proc.stdout.trim() };
    });
  }

  runHistoryWriter() {
    return this.withLease("history-writer", () => {
      const candidates = new Map(
        readJsonl(this.paths.candidates)
          .map(normalizeCandidateMetadata)
          .map((item) => [item.candidate_id, item]),
      );
      const decisions = readJsonl(this.paths.decisions);
      const state = loadJson(this.paths.writerState, { applied_decision_ids: [] });
      const applied = new Set(state.applied_decision_ids || []);
      const written = [];
      const skipped = [];
      for (const decision of decisions) {
        if (applied.has(decision.decision_id) || !["accepted", "merged"].includes(decision.result)) continue;
        if (decision.result === "merged") {
          applied.add(decision.decision_id);
          written.push(decision.decision_id);
          writeJsonAtomic(this.paths.writerState, { applied_decision_ids: [...applied] });
          continue;
        }
        const candidate = candidates.get(decision.candidate_id);
        if (!candidate) continue;
        if (!canPublishCandidate(candidate)) {
          skipped.push({ decision_id: decision.decision_id, reason: authorityFailureReason(candidate) });
          continue;
        }
        if (candidate.type === "episode") this.publishEpisode(candidate, decision);
        if (candidate.type === "self_note") this.publishSelfNote(candidate, decision);
        if (candidate.type === "reentry_draft") this.publishReentry(candidate, decision);
        applied.add(decision.decision_id);
        written.push(decision.decision_id);
        writeJsonAtomic(this.paths.writerState, { applied_decision_ids: [...applied] });
      }
      return { status: "success", written, skipped };
    });
  }

  publishEpisode(candidate, decision) {
    const existing = readJsonl(this.paths.episodes);
    if (existing.some((item) => item.decision_id === decision.decision_id)) return;
    backupFile(this.paths.episodes, this.paths.backups);
    appendJsonlUnique(this.paths.episodes, [{
      ep_id: `ep-${sha256(decision.decision_id).slice(0, 16)}`,
      ts: candidate.ts,
      type: candidate.supersedes ? "correction" : "episode",
      body: candidate.body,
      source_ref: candidate.source_ref,
      candidate_id: candidate.candidate_id,
      decision_id: decision.decision_id,
      supersedes: candidate.supersedes || null,
      origin: candidate.origin,
      author_role: candidate.author_role,
      author_model: candidate.author_model,
      context_scope: candidate.context_scope,
      semantic_authority: candidate.semantic_authority,
    }], "decision_id");
  }

  publishSelfNote(candidate, decision) {
    const marker = `<!-- decision:${decision.decision_id} -->`;
    const current = safeReadText(this.paths.selfNotes);
    if (current.includes(marker)) return;
    backupFile(this.paths.selfNotes, this.paths.backups);
    fs.mkdirSync(path.dirname(this.paths.selfNotes), { recursive: true });
    fs.appendFileSync(this.paths.selfNotes, `${current ? "\n" : ""}${marker}\n${candidate.body}\n`, "utf8");
  }

  publishReentry(candidate) {
    const current = safeReadText(this.paths.reentry);
    if (current === candidate.body) return;
    backupFile(this.paths.reentry, this.paths.backups);
    replaceTextAtomic(this.paths.reentry, candidate.body);
  }

  withLease(writer, fn) {
    let lease;
    try {
      lease = acquireWriterLease(this.writerLeaseFile, { writer, ...this.leaseDetails }, this.leaseOptions);
    } catch (error) {
      if (/already held/.test(error.message)) return { status: "skipped", reason: "lease_unavailable" };
      throw error;
    }
    try { return fn(); } finally { releaseWriterLease(this.writerLeaseFile, lease.lease_id); }
  }

  async withLeaseAsync(writer, fn) {
    let lease;
    try {
      lease = acquireWriterLease(this.writerLeaseFile, { writer, ...this.leaseDetails }, this.leaseOptions);
    } catch (error) {
      if (/already held/.test(error.message)) return { status: "skipped", reason: "lease_unavailable" };
      throw error;
    }
    try { return await fn(); } finally { releaseWriterLease(this.writerLeaseFile, lease.lease_id); }
  }
}

function createCandidate({
  date,
  type,
  author,
  body,
  sourceRef,
  origin,
  authorRole,
  authorModel,
  contextScope,
  semanticAuthority,
  needsSubjectReview,
}) {
  const normalizedBody = normalizeBody(body);
  const idempotencyKey = sha256(`${date}\n${sourceRef.file}:${sourceRef.window}\n${normalizedBody.replace(/\s+/g, " ")}`);
  return normalizeCandidateMetadata({
    candidate_id: `cand-${idempotencyKey.slice(0, 20)}`,
    ts: `${date}T23:59:59+08:00`,
    type,
    author,
    origin,
    author_role: authorRole,
    author_model: authorModel,
    context_scope: contextScope,
    semantic_authority: semanticAuthority,
    needs_subject_review: needsSubjectReview,
    body: normalizedBody,
    source_ref: sourceRef,
    idempotency_key: idempotencyKey,
  });
}

function createDecision(candidate, value = {}) {
  const result = ["accepted", "rejected", "deferred", "merged"].includes(value.result) ? value.result : "deferred";
  const mergedInto = result === "merged" ? normalizeBody(value.merged_into) : null;
  const seed = `${candidate.candidate_id}\n${result}\nreview-writer\n${JSON.stringify(candidate.source_ref || {})}\n${mergedInto || ""}`;
  const pushedToUser = value.pushed_to_user === true
    && ["reject_conflict", "boundary_touch"].includes(normalizeBody(value.reason));
  return {
    decision_id: `decision-${sha256(seed).slice(0, 20)}`,
    candidate_id: candidate.candidate_id,
    result,
    reason: normalizeBody(value.reason) || "review_unavailable",
    checks: value.checks || buildLocalChecks(candidate, false),
    merged_into: mergedInto,
    pushed_to_user: pushedToUser,
  };
}

function runPythonReview({ python, script, candidate, sourceLocated, env }) {
  const proc = spawnSync(python, [script], {
    input: JSON.stringify({ candidate, source_ref_located: sourceLocated }),
    encoding: "utf8",
    // Windows python decodes stdin as GBK by default; candidates are UTF-8.
    env: { ...env, PYTHONUTF8: "1" },
    timeout: 60_000,
  });
  if (proc.status !== 0) {
    return { result: "deferred", reason: "review_unavailable", checks: {} };
  }
  try { return JSON.parse(proc.stdout.trim()); } catch { return { result: "deferred", reason: "review_invalid_output", checks: {} }; }
}

function buildLocalChecks(candidate, sourceLocated) {
  const normalized = normalizeCandidateMetadata(candidate);
  return {
    source_ref_located: sourceLocated === true,
    length_ok: normalized.type !== "reentry_draft" || countNonWhitespace(normalized.body) <= 300,
    safety_ok: true,
    imperative_warning: /(?:必须|务必|永远不要|记住要|\bshould\b|\bmust\b)/iu.test(normalized.body),
    duplicate_of: null,
    publication_allowed: canPublishCandidate(normalized),
  };
}

function locateSourceRef(sourceRef = {}) {
  if (!sourceRef.file || !sourceRef.window || !fs.existsSync(sourceRef.file)) return false;
  const [start, end] = String(sourceRef.window).split("-").map(Number);
  const lines = safeReadText(sourceRef.file).split(/\r?\n/).length;
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start && end <= lines;
}

function isConversationType(type) {
  return type === "user" || type === "runtime.reply.completed" || type === "assistant" || type === "runtime.turn.completed";
}

function safeReadText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function normalizeBody(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDate(value) {
  const text = normalizeBody(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("date must be YYYY-MM-DD");
  return text;
}

function requireText(value, label) {
  const text = normalizeBody(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

module.exports = {
  ContinuityPipeline,
  buildLocalChecks,
  createCandidate,
  createDecision,
  locateSourceRef,
};
