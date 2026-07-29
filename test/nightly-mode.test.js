const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeNightlyMode,
  resolvePhase3Plan,
} = require("../src/continuity/nightly-mode");
const { readConfig } = require("../src/core/config");

test("config defaults CYBERBOSS_NIGHTLY_MODE to evidence", () => {
  withNightlyMode(undefined, () => {
    assert.equal(readConfig().nightlyMode, "evidence");
  });
});

test("config rejects an invalid CYBERBOSS_NIGHTLY_MODE", () => {
  withNightlyMode("automatic", () => {
    assert.throws(
      () => readConfig(),
      /invalid CYBERBOSS_NIGHTLY_MODE: automatic/,
    );
  });
});

test("config preserves every legal nightly mode and its existing plan", () => {
  const expectedPlans = {
    evidence: {
      closeout: false,
      janitor: true,
      review: false,
      history: false,
      model_calls_allowed: false,
      canon_writes_allowed: false,
    },
    shadow: {
      closeout: true,
      janitor: true,
      review: true,
      history: false,
      model_calls_allowed: true,
      canon_writes_allowed: false,
    },
    auto: {
      closeout: true,
      janitor: true,
      review: true,
      history: true,
      model_calls_allowed: true,
      canon_writes_allowed: true,
    },
  };

  for (const [mode, expected] of Object.entries(expectedPlans)) {
    withNightlyMode(mode, () => {
      const configuredMode = readConfig().nightlyMode;
      assert.equal(configuredMode, mode);
      assert.deepEqual(
        pickPlan(resolvePhase3Plan({ command: "nightly", nightlyMode: configuredMode })),
        expected,
      );
    });
  }
});

test("nightly defaults to evidence-only and performs no model or canon work", () => {
  for (const command of ["nightly", "all"]) {
    const plan = resolvePhase3Plan({ command, nightlyMode: "" });
    assert.equal(plan.mode, "evidence");
    assert.equal(plan.closeout, false);
    assert.equal(plan.janitor, true);
    assert.equal(plan.review, false);
    assert.equal(plan.history, false);
    assert.equal(plan.model_calls_allowed, false);
    assert.equal(plan.canon_writes_allowed, false);
  }
});

test("shadow runs automatic authoring and review but blocks canon writes", () => {
  const plan = resolvePhase3Plan({ command: "nightly", nightlyMode: "shadow" });
  assert.equal(plan.mode, "shadow");
  assert.equal(plan.closeout, true);
  assert.equal(plan.janitor, true);
  assert.equal(plan.review, true);
  assert.equal(plan.history, false);
  assert.equal(plan.model_calls_allowed, true);
  assert.equal(plan.canon_writes_allowed, false);
});

test("auto is the steady-state fully automatic nightly pipeline", () => {
  const plan = resolvePhase3Plan({ command: "nightly", nightlyMode: "auto" });
  assert.equal(plan.mode, "auto");
  assert.equal(plan.closeout, true);
  assert.equal(plan.janitor, true);
  assert.equal(plan.review, true);
  assert.equal(plan.history, true);
  assert.equal(plan.model_calls_allowed, true);
  assert.equal(plan.canon_writes_allowed, true);
});

test("invalid nightly mode fails closed instead of silently enabling automation", () => {
  assert.throws(
    () => normalizeNightlyMode("automatic"),
    /invalid CYBERBOSS_NIGHTLY_MODE: automatic/,
  );
});

test("explicit maintenance commands remain individually callable", () => {
  assert.deepEqual(
    pick(resolvePhase3Plan({ command: "closeout" })),
    { closeout: true, janitor: false, review: false, history: false },
  );
  assert.deepEqual(
    pick(resolvePhase3Plan({ command: "janitor" })),
    { closeout: false, janitor: true, review: false, history: false },
  );
  assert.deepEqual(
    pick(resolvePhase3Plan({ command: "review" })),
    { closeout: false, janitor: false, review: true, history: false },
  );
  assert.deepEqual(
    pick(resolvePhase3Plan({ command: "write" })),
    { closeout: false, janitor: false, review: false, history: true },
  );
});

function pickPlan(plan) {
  return {
    closeout: plan.closeout,
    janitor: plan.janitor,
    review: plan.review,
    history: plan.history,
    model_calls_allowed: plan.model_calls_allowed,
    canon_writes_allowed: plan.canon_writes_allowed,
  };
}

function withNightlyMode(value, callback) {
  const original = process.env.CYBERBOSS_NIGHTLY_MODE;
  try {
    if (typeof value === "undefined") {
      delete process.env.CYBERBOSS_NIGHTLY_MODE;
    } else {
      process.env.CYBERBOSS_NIGHTLY_MODE = value;
    }
    return callback();
  } finally {
    if (typeof original === "undefined") {
      delete process.env.CYBERBOSS_NIGHTLY_MODE;
    } else {
      process.env.CYBERBOSS_NIGHTLY_MODE = original;
    }
  }
}

function pick(plan) {
  return {
    closeout: plan.closeout,
    janitor: plan.janitor,
    review: plan.review,
    history: plan.history,
  };
}
