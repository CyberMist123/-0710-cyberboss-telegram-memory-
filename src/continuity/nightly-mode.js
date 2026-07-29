const VALID_NIGHTLY_MODES = new Set(["evidence", "shadow", "auto"]);

function normalizeNightlyMode(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return "evidence";
  if (!VALID_NIGHTLY_MODES.has(text)) {
    throw new Error(`invalid CYBERBOSS_NIGHTLY_MODE: ${text}`);
  }
  return text;
}

function resolvePhase3Plan({ command, nightlyMode } = {}) {
  const normalizedCommand = normalizeText(command).toLowerCase();

  if (normalizedCommand === "closeout") return directPlan("closeout");
  if (normalizedCommand === "janitor") return directPlan("janitor");
  if (normalizedCommand === "review") return directPlan("review");
  if (normalizedCommand === "write") return directPlan("history");

  if (!["nightly", "all"].includes(normalizedCommand)) {
    throw new Error(
      "Usage: run-phase3.js <closeout|janitor|review|write|nightly|all> [--date=YYYY-MM-DD]",
    );
  }

  const mode = normalizeNightlyMode(nightlyMode);
  if (mode === "evidence") {
    return {
      command: normalizedCommand,
      nightly: true,
      mode,
      closeout: false,
      janitor: true,
      review: false,
      history: false,
      model_calls_allowed: false,
      canon_writes_allowed: false,
    };
  }

  if (mode === "shadow") {
    return {
      command: normalizedCommand,
      nightly: true,
      mode,
      closeout: true,
      janitor: true,
      review: true,
      history: false,
      model_calls_allowed: true,
      canon_writes_allowed: false,
    };
  }

  return {
    command: normalizedCommand,
    nightly: true,
    mode,
    closeout: true,
    janitor: true,
    review: true,
    history: true,
    model_calls_allowed: true,
    canon_writes_allowed: true,
  };
}

function shouldRunHistory({ plan, reviewResult } = {}) {
  if (!plan?.history) return false;
  return !plan.review || reviewResult?.status === "success";
}

function directPlan(step) {
  return {
    command: step === "history" ? "write" : step,
    nightly: false,
    mode: "direct",
    closeout: step === "closeout",
    janitor: step === "janitor",
    review: step === "review",
    history: step === "history",
    model_calls_allowed: ["closeout", "review"].includes(step),
    canon_writes_allowed: step === "history",
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  normalizeNightlyMode,
  resolvePhase3Plan,
  shouldRunHistory,
};
