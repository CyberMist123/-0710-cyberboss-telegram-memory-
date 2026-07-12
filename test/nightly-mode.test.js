const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeNightlyMode,
  resolvePhase3Plan,
} = require("../src/continuity/nightly-mode");

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

function pick(plan) {
  return {
    closeout: plan.closeout,
    janitor: plan.janitor,
    review: plan.review,
    history: plan.history,
  };
}
