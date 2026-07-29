#!/usr/bin/env node
const { loadEnv } = require("../../src/index");
const { readConfig } = require("../../src/core/config");
const { validateStartupPreflight } = require("../../src/core/startup-preflight");
const { createRuntimeAdapter } = require("../../src/core/app");
const { authorCloseout } = require("../../src/continuity/background-author");
const {
  resolvePhase3Plan,
  shouldRunHistory,
} = require("../../src/continuity/nightly-mode");
const { runReviewCheckpointed } = require("../../src/continuity/review-checkpoint");
const { createContinuityPipeline } = require("../../src/continuity/closeout-job");

async function main() {
  loadEnv();
  const command = String(process.argv[2] || "").trim();
  const date = readFlag("--date") || shanghaiYesterday();
  const plan = resolvePhase3Plan({
    command,
    nightlyMode: process.env.CYBERBOSS_NIGHTLY_MODE,
  });
  const config = readConfig();
  validateStartupPreflight(config);
  const pipeline = createContinuityPipeline(config);
  const output = {};

  if (plan.nightly) {
    output.nightly = {
      mode: plan.mode,
      model_calls_allowed: plan.model_calls_allowed,
      canon_writes_allowed: plan.canon_writes_allowed,
    };
  }

  if (plan.closeout) {
    const runtimeAdapter = createRuntimeAdapter(config);
    try {
      output.closeout = await pipeline.runCloseoutAsync({
        date,
        author: ({ materials }) => authorCloseout({ runtimeAdapter, config, materials }),
      });
    } catch (error) {
      output.closeout = { status: "deferred", reason: error.message || String(error) };
    } finally {
      await runtimeAdapter.close().catch(() => {});
    }
  }

  if (plan.janitor) output.janitor = pipeline.runJanitor();
  if (plan.review) {
    output.review = runReviewCheckpointed(pipeline, { retryCandidateId: readFlag("--candidate-id") });
  }
  if (plan.history) {
    output.history = shouldRunHistory({ plan, reviewResult: output.review })
      ? pipeline.runHistoryWriter()
      : { status: "skipped", reason: "review_incomplete" };
  }

  console.log(JSON.stringify(output, null, 2));
}

function readFlag(name) {
  const prefix = `${name}=`;
  const item = process.argv.slice(3).find((arg) => String(arg).startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function shanghaiYesterday() {
  const now = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

main().catch((error) => {
  console.error(`[phase3] ${error.message || String(error)}`);
  process.exitCode = 1;
});
