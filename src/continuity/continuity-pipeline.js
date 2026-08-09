const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { acquireWriterLease, releaseWriterLease } = require("../orchestration/writer-lease");
const { memoryWriterLeaseArchiveDir } = require("../orchestration/memory-writer-lease");
const { REENTRY_CHAR_BUDGET, countNonWhitespace } = require("../core/reentry-loader");
const { DEFAULT_AUTOMATION_TIMEZONE, businessDayForDate } = require("../utils/business-day");
const { stripConversationArtifacts } = require("./conversation-purity");
const {
  authorityFailureReason,
  canPublishCandidate,
  normalizeCandidateMetadata,
} = require("./candidate-authority");
const { createDetailEntry, detailsFileFor } = require("./detail-ledger");
const { materializeEpisode } = require("./episode-materializer");
const { IMPERATIVE_STYLE_REASON, detectImperativeStyle } = require("./imperative-style");
const {
  EFFECTIVE_DECISION_AMBIGUOUS,
  selectEffectiveDecisionForCandidate,
  selectEffectiveDecisions,
} = require("./effective-decision");
const {
  REVIEW_WRITER,
  materializeReviewArtifacts,
  reviewArtifactPaths,
} = require("./review-artifacts");
const {
  INVALID_INTENT_EVENT,
  STALE_INTENT_EVENT,
  analyzeCandidateLineages,
  materializePublicationIntents,
  validatePublicationIntent,
} = require("./publication-intent");
const { canonicalSerialize, createSubjectRoute, resolveMaterialRoute } = require("./subject-route");
const {
  createCloseoutMaterialPack,
  persistCloseoutMaterialPack,
} = require("./closeout-material-pack");
const {
  appendJsonlUnique,
  backupFile,
  loadJson,
  readJsonl,
  replaceTextAtomic,
  sha256,
  writeJsonAtomic,
} = require("./continuity-store");

const POST_PUBLISH_DECISION_CONFLICT = "post_publish_decision_conflict";

class ContinuityPipeline {
  constructor(options = {}) {
    this.continuityDir = path.resolve(requireText(options.continuityDir, "continuityDir"));
    this.conversationDir = path.resolve(requireText(options.conversationDir, "conversationDir"));
    this.writerLeaseFile = path.resolve(requireText(options.writerLeaseFile, "writerLeaseFile"));
    this.python = options.python || process.env.PYTHON || "python";
    this.automationTimezone = options.automationTimezone || DEFAULT_AUTOMATION_TIMEZONE;
    this.reviewScript = path.resolve(requireText(options.reviewScript, "reviewScript"));
    this.janitorScript = options.janitorScript ? path.resolve(options.janitorScript) : "";
    this.transcriptDir = options.transcriptDir ? path.resolve(options.transcriptDir) : "";
    this.now = typeof options.now === "function" ? options.now : () => new Date();
    this.reviewArtifactsEnabled = options.reviewArtifactsEnabled === true;
    this.subjectSigningEnabled = options.subjectSigningEnabled === true;
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
      // issue #74：失效 lease 的归档目录与 memory_note 共用一处解析，
      // 同一把锁被不同 writer 回收时归档不会分叉。
      staleArchiveDir: memoryWriterLeaseArchiveDir({
        continuityDir: this.continuityDir,
        writerLeaseArchiveDir: options.writerLeaseArchiveDir,
      }),
    };
    this.paths = {
      candidates: path.join(this.continuityDir, "candidates", "episodes.candidates.jsonl"),
      decisions: path.join(this.continuityDir, "decisions", "decisions.jsonl"),
      episodes: path.join(this.continuityDir, "episodes.jsonl"),
      details: detailsFileFor(this.continuityDir),
      reentry: path.join(this.continuityDir, "reentry.md"),
      selfNotes: path.join(this.continuityDir, "ai_self_notes.md"),
      jobs: path.join(this.continuityDir, ".jobs"),
      backups: path.join(this.continuityDir, ".backups"),
      writerState: path.join(this.continuityDir, ".jobs", "history-writer-state.json"),
      ...reviewArtifactPaths(this.continuityDir),
    };
  }

  runCloseout({ date, author, candidateMetadata = {}, windowClosed = false, subjectRoute = null }) {
    const day = normalizeDate(date);
    const businessDay = businessDayForDate(day, this.automationTimezone);
    const ledgerPath = path.join(this.paths.jobs, `closeout-${businessDay?.dateKey || day}.json`);
    const terminal = terminalCloseoutResult(ledgerPath);
    if (terminal) return terminal;
    return this.withLease("closeout-writer", () => {
      const claimedTerminal = terminalCloseoutResult(ledgerPath);
      if (claimedTerminal) return claimedTerminal;
      const materials = this.loadFilteredMaterials(day);
      if (!materials.entries.length) {
        return recordEmptyCloseout(ledgerPath, day, windowClosed, "no_materials", false);
      }
      if (this.subjectSigningEnabled) {
        return this.publishMaterialPack(day, materials, ledgerPath, { windowClosed, subjectRoute });
      }
      if (typeof author !== "function") throw new Error("closeout author is required");
      const authored = author({
        date: day,
        materials: materials.text,
        entries: materials.entries,
        routeStatus: materials.route_status,
        route: materials.route,
        sourceEntryIds: materials.source_ref.source_entry_ids,
      });
      if (authored && typeof authored.then === "function") {
        throw new Error("runCloseout author must be synchronous; use runCloseoutAsync for runtime authoring");
      }
      return this.publishCloseout(day, materials, authored, ledgerPath, candidateMetadata, {
        businessDay,
        windowClosed,
      });
    });
  }

  async runCloseoutAsync({ date, author, candidateMetadata = {}, windowClosed = false, subjectRoute = null }) {
    const day = normalizeDate(date);
    const businessDay = businessDayForDate(day, this.automationTimezone);
    const ledgerPath = path.join(this.paths.jobs, `closeout-${businessDay?.dateKey || day}.json`);
    const terminal = terminalCloseoutResult(ledgerPath);
    if (terminal) return terminal;
    return this.withLeaseAsync("closeout-writer", async () => {
      const claimedTerminal = terminalCloseoutResult(ledgerPath);
      if (claimedTerminal) return claimedTerminal;
      const materials = this.loadFilteredMaterials(day);
      if (!materials.entries.length) {
        return recordEmptyCloseout(ledgerPath, day, windowClosed, "no_materials", false);
      }
      if (this.subjectSigningEnabled) {
        return this.publishMaterialPack(day, materials, ledgerPath, { windowClosed, subjectRoute });
      }
      const authored = await author({
        date: day,
        materials: materials.text,
        entries: materials.entries,
        routeStatus: materials.route_status,
        route: materials.route,
        sourceEntryIds: materials.source_ref.source_entry_ids,
      });
      return this.publishCloseout(day, materials, authored, ledgerPath, candidateMetadata, {
        businessDay,
        windowClosed,
      });
    });
  }

  publishCloseout(day, materials, authored = {}, ledgerPath, candidateMetadata = {}, options = {}) {
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
      semanticAuthority: "none",
      ...candidateMetadata,
    };
    const candidates = drafts.map((draft) => createCandidate({
      date: day,
      candidateTimestamp: options.businessDay?.candidateTimestamp,
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
    if (!added.length) {
      return recordEmptyCloseout(ledgerPath, day, options.windowClosed, "author_empty", true);
    }
    writeJsonAtomic(ledgerPath, {
      date: day,
      status: "success",
      candidate_ids: added.map((item) => item.candidate_id),
    });
    return { status: "success", candidates: added, author_called: true };
  }

  publishMaterialPack(day, materials, ledgerPath, { windowClosed = false, subjectRoute = null } = {}) {
    const exactRoute = subjectRoute || findMaterialSubjectRoute(
      materials.entries,
      materials.source_ref?.source_entry_ids,
    );
    if (!exactRoute) {
      return recordEmptyCloseout(ledgerPath, day, windowClosed, "material_route_ambiguous", false);
    }
    const materialPack = createCloseoutMaterialPack({
      businessDate: day,
      materials,
      subjectRoute: exactRoute,
    });
    if (!materialPack) {
      return recordEmptyCloseout(ledgerPath, day, windowClosed, "no_materials", false);
    }
    const added = persistCloseoutMaterialPack({
      continuityDir: this.continuityDir,
      materialPack,
    });
    writeJsonAtomic(ledgerPath, {
      date: day,
      status: "success",
      candidate_ids: [],
      material_pack_id: materialPack.material_pack_id,
    });
    return {
      status: "MATERIAL_READY",
      material_pack: added[0] || materialPack,
      candidates: [],
      author_called: false,
    };
  }

  loadFilteredMaterials(day) {
    const filePath = path.join(this.conversationDir, `${day}.jsonl`);
    const rows = readConversationRowsWithEvidence(filePath);
    const entries = rows.map((row) => ({
      ...row,
      text: stripConversationArtifacts(row?.text),
    })).filter((row) => row.text && isConversationType(row.type));
    const materialRoute = resolveMaterialRoute(entries);
    const sourceEntryHashes = entries
      .filter((entry) => typeof entry.id === "string" && entry.id.trim())
      .map((entry) => ({
        entry_id: entry.id.trim(),
        sha256: entry.sourceLineSha256,
      }));
    return {
      entries,
      text: entries.map((row) => `[${row.timestamp || ""}] ${row.type}: ${row.text}`).join("\n"),
      route_status: materialRoute.status,
      ...(materialRoute.route ? { route: materialRoute.route } : {}),
      source_ref: {
        file: filePath,
        window: entries.length ? `${entries[0].line}-${entries[entries.length - 1].line}` : "",
        source_entry_ids: materialRoute.sourceEntryIds,
        source_entry_hashes: sourceEntryHashes,
      },
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
      const diagnostics = [];
      for (const candidate of candidates) {
        if (retryCandidateId && candidate.candidate_id !== retryCandidateId) continue;
        if (!retryCandidateId && decided.has(candidate.candidate_id)) continue;
        const existingForCandidate = existing.filter((item) => item.candidate_id === candidate.candidate_id);
        const selected = selectEffectiveDecisionForCandidate(existing, candidate.candidate_id);
        if (existingForCandidate.length && !selected.decision) {
          diagnostics.push(selected.event);
          continue;
        }
        const reviewRevision = selected.decision ? selected.decision.review_revision + 1 : 1;
        const supersedesDecisionId = selected.decision?.decision_id || null;
        const bodyKey = sha256(`${candidate.type}\n${normalizeBody(candidate.body)}`);
        if (primaryByBody.get(bodyKey) !== candidate.candidate_id) {
          decisions.push(createDecision(candidate, {
            result: "merged",
            reason: "duplicate_candidate",
            checks: buildLocalChecks(candidate, true),
            merged_into: primaryByBody.get(bodyKey),
            review_revision: reviewRevision,
            supersedes_decision_id: supersedesDecisionId,
          }));
          continue;
        }
        const sourceLocated = locateSourceRef(candidate.source_ref);
        const localChecks = buildLocalChecks(candidate, sourceLocated);
        const result = isReviewModelDisabled(env)
          ? localReviewResult(localChecks)
          : runPythonReview({
            python: this.python,
            script: this.reviewScript,
            candidate,
            sourceLocated,
            env,
          });
        const combinedChecks = { ...localChecks, ...(result.checks || {}) };
        combinedChecks.source_ref_located = localChecks.source_ref_located;
        combinedChecks.length_ok = localChecks.length_ok;
        combinedChecks.imperative_warning = localChecks.imperative_warning || result.checks?.imperative_warning === true;
        // 祈使句式闸门是本地格式判断，不接受审查模型的覆盖：模型可以看错，
        // 但「这条以什么词开头」是确定的，交给正则守住（D16：Review 只拦格式）。
        combinedChecks.imperative_style = localChecks.imperative_style;
        combinedChecks.imperative_pattern = localChecks.imperative_pattern;
        combinedChecks.imperative_exempt = localChecks.imperative_exempt;
        combinedChecks.publication_allowed = localChecks.publication_allowed;
        let enforced = { ...result };
        if (!combinedChecks.source_ref_located) enforced = { ...enforced, result: "deferred", reason: "source_ref_missing" };
        if (!combinedChecks.length_ok) enforced = { ...enforced, result: "deferred", reason: "over_budget" };
        // 格式打回：沿用既有 deferred 语义（可重试），原因码机器可读。
        // 排在 publication_allowed 之前——权限缺失是更根本的拦截，让它最后覆盖。
        // 本分支只改 result/reason，绝不触碰 candidate.body（宪法第五条第 4 款）。
        if (combinedChecks.imperative_style === true) {
          enforced = { ...enforced, result: "deferred", reason: IMPERATIVE_STYLE_REASON };
        }
        if (combinedChecks.safety_ok === false && enforced.result === "accepted") {
          enforced = { ...enforced, result: "rejected", reason: "safety_failed" };
        }
        if (!combinedChecks.publication_allowed) {
          enforced = { ...enforced, result: "deferred", reason: authorityFailureReason(candidate) };
        }
        decisions.push(createDecision(candidate, {
          ...enforced,
          checks: combinedChecks,
          review_revision: reviewRevision,
          supersedes_decision_id: supersedesDecisionId,
        }));
      }
      const added = appendJsonlUnique(this.paths.decisions, decisions, "decision_id");
      const allDecisions = [...existing, ...added];
      const artifacts = this.materializeEffectiveReviewArtifacts(candidates, allDecisions);
      const intents = this.materializeEffectivePublicationIntents(candidates, allDecisions);
      return {
        status: "success",
        decisions: added,
        diagnostics,
        artifact_complete: artifacts.artifact_complete,
        artifact_errors: artifacts.errors,
        handoff_ids: artifacts.handoff_ids,
        rejection_case_ids: artifacts.case_ids,
        publication_intent_complete: intents.publication_intent_complete,
        publication_intent_errors: intents.errors,
        publication_intent_ids: intents.publication_intent_ids,
      };
    });
  }

  /**
   * Must be called while the caller holds the unified review-writer lease.
   * Keeping the materializer lease-free lets runReview and the checkpointed
   * authority gate persist decision + artifacts in one synchronous lease scope.
   */
  materializeEffectiveReviewArtifacts(candidates, decisions) {
    const byCandidate = new Map(
      (Array.isArray(candidates) ? candidates : [])
        .map(normalizeCandidateMetadata)
        .map((candidate) => [candidate.candidate_id, candidate]),
    );
    const selected = selectEffectiveDecisions(decisions);
    const combined = {
      artifact_complete: true,
      errors: [],
      handoff_ids: [],
      case_ids: [],
    };
    const rejected = requiredReviewArtifactDecisions(selected, decisions);

    if (!this.reviewArtifactsEnabled) {
      combined.artifact_complete = rejected.length === 0;
      combined.errors = rejected.map((decision) => ({
        artifact: "review_artifacts",
        candidate_id: decision.candidate_id,
        effective_decision_id: decision.decision_id,
        code: "review_artifacts_disabled",
        message: "review artifact materialization is disabled",
      }));
      return combined;
    }

    for (const decision of rejected) {
      const candidate = byCandidate.get(decision.candidate_id);
      if (!candidate) {
        combined.artifact_complete = false;
        combined.errors.push({
          artifact: "review_artifacts",
          candidate_id: decision.candidate_id,
          effective_decision_id: decision.decision_id,
          code: "candidate_missing",
          message: "effective decision candidate is missing",
        });
        continue;
      }
      const outcome = materializeReviewArtifacts({
        writer: REVIEW_WRITER,
        paths: this.paths,
        candidate,
        effectiveDecision: decision,
        createdAt: normalizeTimestamp(this.now()),
      });
      combined.artifact_complete = combined.artifact_complete && outcome.artifact_complete;
      combined.errors.push(...outcome.errors);
      combined.handoff_ids.push(...outcome.handoff_ids);
      combined.case_ids.push(...outcome.case_ids);
    }
    return combined;
  }

  /**
   * Must run inside the review-writer lease and after required Review artifacts.
   * Intents are append-only Review output; History never calls this method.
   */
  materializeEffectivePublicationIntents(candidates, decisions) {
    const state = loadJson(this.paths.writerState, {
      applied_decision_ids: [],
      published_candidate_ids: [],
    });
    return materializePublicationIntents({
      writer: REVIEW_WRITER,
      paths: this.paths,
      candidates,
      decisions,
      publishedCandidateIds: loadPublishedCandidateIds(this.paths, decisions, state),
      // Reuse G2-3's explicit default-off gate. This keeps the whole
      // Review handoff surface behind one switch instead of allowing a
      // publishable intent while its prerequisite artifact writer is off.
      enabled: this.reviewArtifactsEnabled,
      createdAt: normalizeTimestamp(this.now()),
    });
  }

  repairReviewArtifacts() {
    return this.withLease(REVIEW_WRITER, () => {
      const candidates = readJsonl(this.paths.candidates).map(normalizeCandidateMetadata);
      const decisions = readJsonl(this.paths.decisions);
      const artifacts = this.materializeEffectiveReviewArtifacts(candidates, decisions);
      const intents = this.materializeEffectivePublicationIntents(candidates, decisions);
      return {
        status: "success",
        artifact_complete: artifacts.artifact_complete,
        artifact_errors: artifacts.errors,
        handoff_ids: artifacts.handoff_ids,
        rejection_case_ids: artifacts.case_ids,
        publication_intent_complete: intents.publication_intent_complete,
        publication_intent_errors: intents.errors,
        publication_intent_ids: intents.publication_intent_ids,
      };
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
    if (!this.reviewArtifactsEnabled) {
      return { status: "skipped", reason: "review_artifacts_disabled" };
    }
    return this.withLease("history-writer", () => {
      const candidateRows = readJsonl(this.paths.candidates).map(normalizeCandidateMetadata);
      const candidates = new Map(candidateRows.map((item) => [item.candidate_id, item]));
      const decisions = readJsonl(this.paths.decisions);
      const decisionsById = new Map(decisions.map((item) => [item.decision_id, item]));
      const selected = selectEffectiveDecisions(decisions);
      let intents;
      try {
        intents = readJsonl(this.paths.publicationIntents);
      } catch (error) {
        return {
          status: "success",
          written: [],
          skipped: [{
            reason: "publication_intent_store_unavailable",
            message: error.message || String(error),
          }],
          diagnostics: [],
        };
      }
      const state = loadJson(this.paths.writerState, {
        applied_decision_ids: [],
        published_candidate_ids: [],
        published_candidate_lineage_roots: [],
        applied_publication_keys: [],
        intent_consumptions: [],
        diagnostic_events: [],
      });
      const applied = new Set(state.applied_decision_ids || []);
      const publishedCandidates = loadPublishedCandidateIds(this.paths, decisions, state);
      const publishedPublicationKeys = loadPublishedPublicationKeys(this.paths, state);
      const publishedLineageRoots = new Set(state.published_candidate_lineage_roots || []);
      for (const intent of intents) {
        if (publishedPublicationKeys.has(normalizeBody(intent?.publication_key))) {
          const rootId = normalizeBody(intent?.candidate_lineage_root_id);
          if (rootId) publishedLineageRoots.add(rootId);
        }
      }
      const lineages = analyzeCandidateLineages(candidateRows, {
        publishedCandidateIds: publishedCandidates,
      });
      const intentConsumptions = new Map(
        (state.intent_consumptions || []).map((item) => [item.publication_intent_id, item]),
      );
      const diagnosticEvents = new Map(
        (state.diagnostic_events || []).map((event) => [event.event_id, event]),
      );
      const written = [];
      const skipped = [];
      const diagnostics = [];
      let stateChanged = false;

      for (const ambiguous of selected.ambiguous) {
        const event = createDiagnosticEvent(ambiguous);
        diagnostics.push(event);
        skipped.push({
          candidate_id: event.candidate_id,
          reason: EFFECTIVE_DECISION_AMBIGUOUS,
          event_id: event.event_id,
        });
        if (!diagnosticEvents.has(event.event_id)) {
          diagnosticEvents.set(event.event_id, event);
          stateChanged = true;
        }
      }

      for (const candidateId of publishedCandidates) {
        const effectiveDecision = selected.effectiveByCandidate.get(candidateId);
        if (!effectiveDecision || effectiveDecision.result === "accepted") continue;
        const event = createPostPublishDecisionConflictEvent(candidateId, effectiveDecision);
        diagnostics.push(event);
        skipped.push({
          candidate_id: candidateId,
          decision_id: effectiveDecision.decision_id,
          reason: POST_PUBLISH_DECISION_CONFLICT,
          event_id: event.event_id,
        });
        if (!diagnosticEvents.has(event.event_id)) {
          diagnosticEvents.set(event.event_id, event);
          stateChanged = true;
        }
      }

      for (const intent of intents) {
        const intentId = normalizeBody(intent?.publication_intent_id);
        if (intentId && intentConsumptions.has(intentId)) continue;
        const candidate = candidates.get(normalizeBody(intent?.candidate_id));
        const decision = decisionsById.get(normalizeBody(intent?.effective_decision_id));
        const effectiveDecision = candidate
          ? selected.effectiveByCandidate.get(candidate.candidate_id)
          : null;
        const validation = validatePublicationIntent({
          intent,
          candidate,
          decision,
          effectiveDecision,
          lineage: candidate ? lineages.byCandidate.get(candidate.candidate_id) : null,
        });
        if (!validation.ok) {
          const event = createIntentDiagnosticEvent(intent, validation);
          diagnostics.push(event);
          skipped.push({
            publication_intent_id: intentId,
            candidate_id: normalizeBody(intent?.candidate_id),
            reason: validation.event,
            event_id: event.event_id,
          });
          if (!diagnosticEvents.has(event.event_id)) {
            diagnosticEvents.set(event.event_id, event);
            stateChanged = true;
          }
          if (validation.event === STALE_INTENT_EVENT && intentId) {
            intentConsumptions.set(intentId, createIntentConsumption(intent, "stale_intent"));
            stateChanged = true;
          }
          continue;
        }
        if (!canPublishCandidate(candidate)) {
          skipped.push({
            publication_intent_id: intentId,
            decision_id: decision.decision_id,
            reason: authorityFailureReason(candidate),
          });
          continue;
        }
        // Two ways to already be in canon. The publication key only exists on
        // rows this outbox wrote; canon rows from the older mechanism carry
        // `candidate_id` + `decision_id` and nothing else, so keying the guard
        // on the key alone made them invisible here. `publishedCandidates` is
        // rebuilt from the canon rows themselves and sees both.
        //
        // 2026-08-07 live evidence: the first time
        // `CYBERBOSS_REVIEW_ARTIFACTS_ENABLED` was switched on in production,
        // Review minted fresh intents for long-published accepted decisions and
        // this guard waved them through -- two July episodes and one self-note
        // were written into her canon a second time.
        if (publishedPublicationKeys.has(intent.publication_key)
          || publishedCandidates.has(candidate.candidate_id)) {
          applied.add(decision.decision_id);
          publishedCandidates.add(candidate.candidate_id);
          publishedLineageRoots.add(lineageRootId(intent));
          intentConsumptions.set(intentId, createIntentConsumption(intent, "already_published"));
          skipped.push({ decision_id: decision.decision_id, reason: "candidate_already_published" });
          stateChanged = true;
          continue;
        }
        // 发布前预算硬闸门（issue #76 目标 3）。Review 已经在 checks.length_ok 上
        // 拦过一次；这里再拦一次不是冗余 —— canon 的最后一个写入点必须自己证明
        // 它没有把超预算正文写进 reentry.md。decisions.jsonl 被手改、Review 被绕过、
        // 预算常量漂移，都只有这一道能挡住。
        //
        // 语义按 D17：**同步打回**（当场拒绝、原因机器可读），按 D19 只做机器可判定
        // 检查，按 D16 绝不截断也绝不改写正文 —— 正文原样留在候选层等原作者重写。
        // 刻意**不**把 decision 记进 applied：改写后重交能再次走到这里，打回可重试。
        const refusal = publicationRefusal(candidate);
        if (refusal) {
          const event = createPublishRefusalEvent(candidate, decision, refusal);
          diagnostics.push(event);
          skipped.push({
            decision_id: decision.decision_id,
            candidate_id: candidate.candidate_id,
            reason: refusal.reason,
            event_id: event.event_id,
          });
          if (!diagnosticEvents.has(event.event_id)) {
            diagnosticEvents.set(event.event_id, event);
            stateChanged = true;
          }
          continue;
        }
        if (candidate.type === "episode") this.publishEpisode(candidate, decision, intent);
        if (candidate.type === "self_note") this.publishSelfNote(candidate, decision, intent);
        if (candidate.type === "reentry_draft") this.publishReentry(candidate, decision, intent);
        if (candidate.type === "details") this.publishDetails(candidate, decision, intent);
        applied.add(decision.decision_id);
        publishedCandidates.add(candidate.candidate_id);
        publishedPublicationKeys.add(intent.publication_key);
        publishedLineageRoots.add(lineageRootId(intent));
        intentConsumptions.set(intentId, createIntentConsumption(intent, "published"));
        written.push(decision.decision_id);
        stateChanged = true;
        writeHistoryWriterState(
          this.paths.writerState,
          state,
          applied,
          publishedCandidates,
          publishedLineageRoots,
          publishedPublicationKeys,
          intentConsumptions,
          diagnosticEvents,
        );
      }
      if (stateChanged) {
        writeHistoryWriterState(
          this.paths.writerState,
          state,
          applied,
          publishedCandidates,
          publishedLineageRoots,
          publishedPublicationKeys,
          intentConsumptions,
          diagnosticEvents,
        );
      }
      return { status: "success", written, skipped, diagnostics };
    });
  }

  publishEpisode(candidate, decision, intent) {
    const existing = readJsonl(this.paths.episodes);
    if (existing.some((item) => item.publication_key === intent.publication_key)) return;
    backupFile(this.paths.episodes, this.paths.backups);
    const canonSupersedes = normalizeBody(candidate.canon_supersedes);
    const record = {
      ep_id: `ep-${sha256(intent.publication_key).slice(0, 16)}`,
      ts: candidate.ts,
      type: canonSupersedes ? "correction" : "episode",
      body: candidate.body,
      source_ref: candidate.source_ref,
      candidate_id: candidate.candidate_id,
      decision_id: decision.decision_id,
      publication_intent_id: intent.publication_intent_id,
      publication_key: intent.publication_key,
      supersedes: canonSupersedes || null,
      origin: candidate.origin,
      author_role: candidate.author_role,
      author_model: candidate.author_model,
      context_scope: candidate.context_scope,
      semantic_authority: candidate.semantic_authority,
    };
    appendJsonlUnique(this.paths.episodes, [record], "publication_key");
    // 人面视图（md 单条 + index 目录）在 canon 落账后物化；失败只记 .jobs，不打断发布。
    materializeEpisode({
      episodesDir: path.join(this.continuityDir, "episodes"),
      jobsDir: this.paths.jobs,
      record,
    });
  }

  /**
   * 账本条目发布（issue #76 目标 1）。账本是第三档「完全按需」：
   * 只落 `details.jsonl`，不进任何注入通路，读取只走 `memory_lookup`。
   * 与 Episode 同一套 lineage publication key 与同一个 writer（History writer）。
   */
  publishDetails(candidate, decision, intent) {
    const existing = readJsonl(this.paths.details);
    if (existing.some((item) => item.publication_key === intent.publication_key)) return;
    backupFile(this.paths.details, this.paths.backups);
    appendJsonlUnique(this.paths.details, [{
      ...createDetailEntry(candidate, decision, { sha256 }),
      publication_intent_id: intent.publication_intent_id,
      publication_key: intent.publication_key,
    }], "publication_key");
  }

  /**
   * Self-note 发布。`ai_self_notes.md` 还有第二个 writer（主体 AI 的 `memory_note`
   * 工具，`src/services/memory-note-service.js`），issue #74 已把它收敛到**同一把**
   * `writerLeaseFile` 上；两边都必须保持**只追加**：任何一侧改回整读整写回，
   * 都会在锁交替的间隙把对方刚落的行盖掉。
   */
  publishSelfNote(candidate, decision, intent) {
    const publicationMarker = `<!-- publication:${intent.publication_key} intent:${intent.publication_intent_id} -->`;
    const marker = `<!-- decision:${decision.decision_id} -->`;
    const current = safeReadText(this.paths.selfNotes);
    if (current.includes(publicationMarker)) return;
    backupFile(this.paths.selfNotes, this.paths.backups);
    fs.mkdirSync(path.dirname(this.paths.selfNotes), { recursive: true });
    fs.appendFileSync(
      this.paths.selfNotes,
      `${current ? "\n" : ""}${publicationMarker}\n${marker}\n${candidate.body}\n`,
      "utf8",
    );
  }

  // 预算已在 runHistoryWriter 的 publicationRefusal() 里拦过；走到这里的正文一定
  // 在预算内。这里不做第二次判断也不截断 —— 只有一个判断点，才不会出现两套预算。
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
      if (/already held|lease is unreadable/.test(error.message)) {
        return { status: "skipped", reason: "lease_unavailable" };
      }
      throw error;
    }
    try { return fn(); } finally { releaseWriterLease(this.writerLeaseFile, lease.lease_id); }
  }

  async withLeaseAsync(writer, fn) {
    let lease;
    try {
      lease = acquireWriterLease(this.writerLeaseFile, { writer, ...this.leaseDetails }, this.leaseOptions);
    } catch (error) {
      if (/already held|lease is unreadable/.test(error.message)) {
        return { status: "skipped", reason: "lease_unavailable" };
      }
      throw error;
    }
    try { return await fn(); } finally { releaseWriterLease(this.writerLeaseFile, lease.lease_id); }
  }
}

function terminalCloseoutResult(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return null;
  const ledger = loadJson(ledgerPath, null);
  if (!ledger || !["success", "sealed_no_output"].includes(ledger.status)) return null;
  return {
    status: ledger.status,
    reason: "already_ran",
    candidates: [],
    author_called: false,
  };
}

function recordEmptyCloseout(ledgerPath, day, windowClosed, reason, authorCalled) {
  const status = windowClosed ? "sealed_no_output" : "retryable_no_output";
  writeJsonAtomic(ledgerPath, {
    date: day,
    status,
    reason,
    candidate_ids: [],
  });
  return { status, reason, candidates: [], author_called: authorCalled };
}

function createCandidate({
  date,
  candidateTimestamp,
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
  const sourceIdentity = Array.isArray(sourceRef.source_entry_ids)
    ? JSON.stringify({
      file: sourceRef.file,
      source_entry_ids: sourceRef.source_entry_ids,
      source_entry_hashes: sourceRef.source_entry_hashes,
    })
    : `${sourceRef.file}:${sourceRef.window}`;
  const idempotencyKey = sha256(`${date}\n${sourceIdentity}\n${normalizedBody.replace(/\s+/g, " ")}`);
  return normalizeCandidateMetadata({
    candidate_id: `cand-${idempotencyKey.slice(0, 20)}`,
    ts: candidateTimestamp || businessDayForDate(date, DEFAULT_AUTOMATION_TIMEZONE)?.candidateTimestamp
      || `${date}T23:59:59.000Z`,
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
  const reviewRevision = Number.isInteger(value.review_revision) && value.review_revision > 0
    ? value.review_revision
    : 1;
  const supersedesDecisionId = normalizeBody(value.supersedes_decision_id) || null;
  const reason = normalizeBody(value.reason) || "review_unavailable";
  const seed = [
    candidate.candidate_id,
    result,
    reason,
    reviewRevision,
    supersedesDecisionId || "",
    "review-writer",
    JSON.stringify(candidate.source_ref || {}),
    mergedInto || "",
  ].join("\n");
  const pushedToUser = value.pushed_to_user === true
    && ["reject_conflict", "boundary_touch"].includes(reason);
  return {
    decision_id: `decision-${sha256(seed).slice(0, 20)}`,
    candidate_id: candidate.candidate_id,
    review_revision: reviewRevision,
    supersedes_decision_id: supersedesDecisionId,
    result,
    reason,
    checks: value.checks || buildLocalChecks(candidate, false),
    merged_into: mergedInto,
    pushed_to_user: pushedToUser,
  };
}

/** History writer 侧的发布前拒绝原因。空 = 允许发布。 */
const PUBLISH_REFUSED_EVENT = "history_publish_refused";

function publicationRefusal(candidate = {}) {
  if (candidate.type !== "reentry_draft") return null;
  const chars = countNonWhitespace(candidate.body);
  if (chars <= REENTRY_CHAR_BUDGET) return null;
  return { reason: "over_budget", chars, budget: REENTRY_CHAR_BUDGET };
}

/**
 * History 发布闸门诊断，与 Review 打回案例库有意共存。
 *
 * 这是 History writer 在 canon 最后写入点发现超预算时留下的诊断，不是 Review
 * writer 的 `review/rejection-cases.jsonl`。两者语义和 writer 都不同，不能合并：
 * History 只在自己的 writer state 里记原因、预算和正文摘要哈希，不复制正文，
 * 也不代 Review writer 写 envelope/case。event_id 由稳定字段哈希得出。
 */
function createPublishRefusalEvent(candidate = {}, decision = {}, refusal = {}) {
  const stable = {
    event: PUBLISH_REFUSED_EVENT,
    candidate_id: candidate.candidate_id,
    decision_id: decision.decision_id,
    type: candidate.type,
    reason: refusal.reason,
    chars: refusal.chars,
    budget: refusal.budget,
    body_sha256: sha256(candidate.body || ""),
  };
  return {
    event_id: `event-${sha256(JSON.stringify(stable)).slice(0, 20)}`,
    ...stable,
  };
}

function requiredReviewArtifactDecisions(selected, decisions) {
  const byId = new Map(
    (Array.isArray(decisions) ? decisions : [])
      .map((item) => [normalizeBody(item?.decision_id), item]),
  );
  const required = new Map();
  for (const effective of selected.effectiveByCandidate.values()) {
    const visited = new Set();
    let cursor = effective;
    while (cursor && !visited.has(cursor.decision_id)) {
      visited.add(cursor.decision_id);
      if (["deferred", "rejected"].includes(cursor.result)) {
        required.set(cursor.decision_id, cursor);
      }
      cursor = cursor.supersedes_decision_id
        ? byId.get(normalizeBody(cursor.supersedes_decision_id))
        : null;
    }
  }
  return [...required.values()];
}

function loadPublishedCandidateIds(paths, decisions, state) {
  const published = new Set(state.published_candidate_ids || []);
  const byDecisionId = new Map(decisions.map((item) => [item.decision_id, item]));
  for (const decisionId of state.applied_decision_ids || []) {
    const decision = byDecisionId.get(decisionId);
    if (decision?.result === "accepted" && decision.candidate_id) published.add(decision.candidate_id);
  }
  for (const episode of readJsonl(paths.episodes)) {
    if (episode.candidate_id) published.add(episode.candidate_id);
  }
  // 账本与 Episode 一样是可 join 的 canon 行：writer state 丢了也能从落盘行重建
  // 「这条候选已经发过」，避免同一条账本被发布两次。
  for (const detail of (paths.details ? readJsonl(paths.details) : [])) {
    if (detail.candidate_id) published.add(detail.candidate_id);
  }
  const selfNotes = safeReadText(paths.selfNotes);
  for (const match of selfNotes.matchAll(/<!-- decision:([^\s>]+) -->/g)) {
    const decision = byDecisionId.get(match[1]);
    if (decision?.candidate_id) published.add(decision.candidate_id);
  }
  return published;
}

function loadPublishedPublicationKeys(paths, state) {
  const published = new Set(state.applied_publication_keys || []);
  for (const episode of readJsonl(paths.episodes)) {
    if (episode.publication_key) published.add(episode.publication_key);
  }
  for (const detail of (paths.details ? readJsonl(paths.details) : [])) {
    if (detail.publication_key) published.add(detail.publication_key);
  }
  const selfNotes = safeReadText(paths.selfNotes);
  for (const match of selfNotes.matchAll(/<!-- publication:([^\s>]+) intent:[^\s>]+ -->/g)) {
    published.add(match[1]);
  }
  return published;
}

function createDiagnosticEvent(ambiguous) {
  const stable = {
    event: EFFECTIVE_DECISION_AMBIGUOUS,
    candidate_id: ambiguous.candidate_id,
    reasons: ambiguous.reasons,
    decision_ids: ambiguous.decision_ids,
  };
  return {
    event_id: `event-${sha256(JSON.stringify(stable)).slice(0, 20)}`,
    ...stable,
  };
}

function createIntentDiagnosticEvent(intent = {}, validation = {}) {
  const stable = {
    event: validation.event || INVALID_INTENT_EVENT,
    code: validation.code || "publication_intent_invalid",
    publication_intent_id: normalizeBody(intent.publication_intent_id),
    publication_key: normalizeBody(intent.publication_key),
    candidate_id: normalizeBody(intent.candidate_id),
    effective_decision_id: normalizeBody(intent.effective_decision_id),
  };
  return {
    event_id: `event-${sha256(JSON.stringify(stable)).slice(0, 20)}`,
    ...stable,
    message: validation.message || "publication intent validation failed",
  };
}

function createPostPublishDecisionConflictEvent(candidateId, decision = {}) {
  const stable = {
    event: POST_PUBLISH_DECISION_CONFLICT,
    candidate_id: normalizeBody(candidateId),
    effective_decision_id: normalizeBody(decision.decision_id),
    effective_result: normalizeBody(decision.result),
  };
  return {
    event_id: `event-${sha256(JSON.stringify(stable)).slice(0, 20)}`,
    ...stable,
  };
}

function lineageRootId(intent = {}) {
  return normalizeBody(intent.candidate_lineage_root_id);
}

function createIntentConsumption(intent = {}, status) {
  return {
    publication_intent_id: normalizeBody(intent.publication_intent_id),
    publication_key: normalizeBody(intent.publication_key),
    candidate_id: normalizeBody(intent.candidate_id),
    effective_decision_id: normalizeBody(intent.effective_decision_id),
    status,
  };
}

function writeHistoryWriterState(
  filePath,
  previous,
  applied,
  publishedCandidates,
  publishedLineageRoots,
  publishedPublicationKeys,
  intentConsumptions,
  diagnosticEvents,
) {
  writeJsonAtomic(filePath, {
    ...previous,
    applied_decision_ids: [...applied],
    published_candidate_ids: [...publishedCandidates],
    published_candidate_lineage_roots: [...publishedLineageRoots].filter(Boolean),
    applied_publication_keys: [...publishedPublicationKeys],
    intent_consumptions: [...intentConsumptions.values()],
    diagnostic_events: [...diagnosticEvents.values()],
  });
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

function isReviewModelDisabled(env = {}) {
  return String(env.CYBERBOSS_AUTO_REVIEW_MODEL || "").trim().toLowerCase() === "off";
}

function localReviewResult(checks) {
  if (!checks.source_ref_located) return { result: "deferred", reason: "source_ref_missing", checks: {} };
  if (!checks.length_ok) return { result: "deferred", reason: "over_budget", checks: {} };
  // 审查模型关掉时也要拦：格式闸门不依赖模型可用性。
  if (checks.imperative_style === true) return { result: "deferred", reason: IMPERATIVE_STYLE_REASON, checks: {} };
  if (!checks.publication_allowed) return { result: "deferred", reason: "publication_not_allowed", checks: {} };
  return { result: "accepted", reason: "model_review_disabled", checks: {} };
}

function buildLocalChecks(candidate, sourceLocated) {
  const normalized = normalizeCandidateMetadata(candidate);
  const imperativeStyle = detectImperativeStyle(normalized);
  return {
    source_ref_located: sourceLocated === true,
    // 预算常量与 loader 共用同一个来源（issue #76）：注入侧和发布侧一旦各写一个
    // 300，改了一边就会出现「发得进去但注不进去」的静默失忆。
    length_ok: normalized.type !== "reentry_draft" || countNonWhitespace(normalized.body) <= REENTRY_CHAR_BUDGET,
    safety_ok: true,
    imperative_warning: /(?:必须|务必|永远不要|记住要|\bshould\b|\bmust\b)/iu.test(normalized.body),
    // 句中软警告（上一行）与开头硬闸门（下一行）是两件事：
    // 前者只是标注，后者按 issue #36 打回。两者并存，互不覆盖。
    imperative_style: imperativeStyle.blocked,
    imperative_pattern: imperativeStyle.pattern_id,
    imperative_exempt: imperativeStyle.exempt,
    duplicate_of: null,
    publication_allowed: canPublishCandidate(normalized),
  };
}

function locateSourceRef(sourceRef = {}) {
  if (!sourceRef.file || !fs.existsSync(sourceRef.file)) return false;
  if (Array.isArray(sourceRef.source_entry_ids)) {
    return locateSourceEntriesById(sourceRef);
  }
  if (!sourceRef.window) return false;
  const [start, end] = String(sourceRef.window).split("-").map(Number);
  const lines = safeReadText(sourceRef.file).split(/\r?\n/).length;
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start && end <= lines;
}

function locateSourceEntriesById(sourceRef) {
  const ids = sourceRef.source_entry_ids;
  const hashes = Array.isArray(sourceRef.source_entry_hashes)
    ? sourceRef.source_entry_hashes
    : [];
  if (!ids.length || hashes.length !== ids.length || new Set(ids).size !== ids.length) {
    return false;
  }
  const expectedHashes = new Map();
  for (const item of hashes) {
    const entryId = normalizeBody(item?.entry_id);
    const digest = normalizeBody(item?.sha256);
    if (!entryId || !/^[0-9a-f]{64}$/u.test(digest) || expectedHashes.has(entryId)) {
      return false;
    }
    expectedHashes.set(entryId, digest);
  }

  const byId = new Map();
  for (const entry of readConversationRowsWithEvidence(sourceRef.file)) {
    const entryId = normalizeBody(entry?.id);
    if (!entryId) continue;
    if (!byId.has(entryId)) byId.set(entryId, []);
    byId.get(entryId).push(entry);
  }

  return ids.every((entryId) => {
    const normalizedId = normalizeBody(entryId);
    const matches = byId.get(normalizedId) || [];
    return normalizedId
      && matches.length === 1
      && expectedHashes.get(normalizedId) === matches[0].sourceLineSha256;
  });
}

function readConversationRowsWithEvidence(filePath) {
  const text = safeReadText(filePath);
  if (!text) return [];
  return text.split(/\r?\n/u).flatMap((line, index) => {
    if (!line) return [];
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      return [{
        ...parsed,
        line: index + 1,
        sourceLineSha256: sha256(line),
      }];
    } catch {
      return [];
    }
  });
}

function findMaterialSubjectRoute(entries = [], sourceEntryIds = []) {
  const routes = (Array.isArray(entries) ? entries : [])
    .map((entry) => entry?.meta?.subject_route)
    .filter(Boolean);
  if (!routes.length) return null;
  const first = canonicalSerialize(routes[0]);
  if (!routes.every((route) => canonicalSerialize(route) === first)) return null;
  const route = JSON.parse(JSON.stringify(routes[0]));
  delete route.route_fingerprint;
  route.source_entry_ids = sourceEntryIds;
  try { return createSubjectRoute(route); } catch { return null; }
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

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("now() must return a valid date");
  return date.toISOString();
}

function requireText(value, label) {
  const text = normalizeBody(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

module.exports = {
  ContinuityPipeline,
  POST_PUBLISH_DECISION_CONFLICT,
  PUBLISH_REFUSED_EVENT,
  buildLocalChecks,
  createCandidate,
  createDecision,
  isReviewModelDisabled,
  localReviewResult,
  locateSourceRef,
  publicationRefusal,
};
