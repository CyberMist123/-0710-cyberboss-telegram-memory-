"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  RoutingCounters,
  laneToken,
  opaqueToken,
  profileToken,
  sanitizeRoutingTelemetry,
  slotToken,
} = require("../src/core/route-telemetry");
const { buildTelegramRouteLane } = require("../src/core/route-lane");
const { ProfileRoutingError } = require("../src/adapters/runtime/claudecode/telegram-profile-router");

function withStateDir(run) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-startup-"));
  const previous = process.env.CYBERBOSS_STATE_DIR;
  process.env.CYBERBOSS_STATE_DIR = stateDir;
  try {
    delete require.cache[require.resolve("../src/core/config")];
    const { readConfig } = require("../src/core/config");
    return run(readConfig(), stateDir);
  } finally {
    if (previous === undefined) {
      delete process.env.CYBERBOSS_STATE_DIR;
    } else {
      process.env.CYBERBOSS_STATE_DIR = previous;
    }
  }
}

function buildApp(config) {
  const { CyberbossApp } = require("../src/core/app");
  return new CyberbossApp(config);
}

test("an invalid profile mapping blocks startup instead of falling back", () => {
  withStateDir((config) => {
    assert.throws(
      () => buildApp({
        ...config,
        claudeLaunchProfilesJson: "{}",
        telegramProfileMappingJson: JSON.stringify([
          { accountId: "telegram", chatId: "1", messageThreadId: null, profileId: "missing" },
        ]),
      }),
      (error) => {
        assert.ok(error instanceof ProfileRoutingError);
        assert.equal(error.code, "unknown_profile");
        return true;
      },
    );
  });
});

test("a duplicate route and a non-canonical id each block startup", () => {
  withStateDir((config) => {
    assert.throws(() => buildApp({
      ...config,
      claudeLaunchProfilesJson: JSON.stringify({ safe: {} }),
      telegramProfileMappingJson: JSON.stringify([
        { accountId: "telegram", chatId: "1", messageThreadId: null, profileId: "safe" },
        { accountId: "telegram", chatId: 1, messageThreadId: null, profileId: "safe" },
      ]),
    }), ProfileRoutingError);

    assert.throws(() => buildApp({
      ...config,
      claudeLaunchProfilesJson: JSON.stringify({ safe: {} }),
      telegramProfileMappingJson: JSON.stringify([
        { accountId: "telegram", chatId: 1.5, messageThreadId: null, profileId: "safe" },
      ]),
    }), ProfileRoutingError);
  });
});

test("malformed profile JSON blocks startup", () => {
  withStateDir((config) => {
    assert.throws(
      () => buildApp({ ...config, claudeLaunchProfilesJson: "{not json" }),
      ProfileRoutingError,
    );
  });
});

test("with no mapping the router is disabled and no profile is ever selected", () => {
  withStateDir((config) => {
    const app = buildApp({
      ...config, runtime: "claudecode", claudeLaunchProfilesJson: "", telegramProfileMappingJson: "",
    });
    assert.equal(app.telegramProfileRouter.isEnabled(), false);
    const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 1, messageThreadId: null });
    assert.equal(app.resolveLaunchProfileForLane(lane), null);
  });
});

test("a valid mapping selects per lane and never for a system lane", () => {
  withStateDir((config) => {
    const app = buildApp({
      ...config,
      channel: "telegram",
      runtime: "claudecode",
      claudeLaunchProfilesJson: JSON.stringify({ safe: { effort: "low" } }),
      telegramProfileMappingJson: JSON.stringify([
        { accountId: "telegram", chatId: 500, messageThreadId: 9, profileId: "safe" },
      ]),
    });
    assert.equal(app.telegramProfileRouter.isEnabled(), true);

    const mapped = buildTelegramRouteLane({ accountId: "telegram", chatId: 500, messageThreadId: 9 });
    const unmapped = buildTelegramRouteLane({ accountId: "telegram", chatId: 500, messageThreadId: null });
    assert.equal(app.resolveLaunchProfileForLane(mapped)?.effort, "low");
    assert.equal(app.resolveLaunchProfileForLane(unmapped), null);

    const { buildSystemRouteLane } = require("../src/core/route-lane");
    assert.equal(app.resolveLaunchProfileForLane(buildSystemRouteLane("closeout")), null);
    assert.equal(app.resolveLaunchProfileForLane(buildSystemRouteLane("system-message")), null);
    assert.equal(app.resolveLaunchProfileForLane(null), null);
  });
});

test("routing tokens are salted per process, so they are not offline-enumerable", () => {
  const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 123456789, messageThreadId: 7 });
  const token = laneToken(lane);

  assert.equal(token.length, 12);
  assert.equal(token, laneToken(lane), "stable inside one process");
  assert.equal(token.includes("123456789"), false);

  // The unsalted sha256 of the same material -- what a naive implementation
  // would emit -- must not be what we emit, because a numeric chat id is
  // trivially brute-forced against a fixed hash.
  const naive = require("node:crypto")
    .createHash("sha256").update(lane.laneKey, "utf8").digest("hex").slice(0, 12);
  assert.notEqual(token, naive);

  // Namespaces do not collide with each other.
  assert.notEqual(opaqueToken("lane", "x"), opaqueToken("profile", "x"));
  assert.notEqual(profileToken("safe"), slotToken("safe"));
  assert.equal(laneToken(null), "");
  assert.equal(profileToken(""), "");
});

test("telemetry rejects any field that is not on the allowlist", () => {
  assert.throws(() => sanitizeRoutingTelemetry({ event: "x", accountId: "telegram" }), /not allowed/);
  assert.throws(() => sanitizeRoutingTelemetry({ event: "x", chatId: "500" }), /not allowed/);
  assert.throws(() => sanitizeRoutingTelemetry({ event: "x", topicId: "9" }), /not allowed/);
  assert.throws(() => sanitizeRoutingTelemetry({ event: "x", profileId: "safe" }), /not allowed/);
  assert.throws(() => sanitizeRoutingTelemetry({ event: "x", prompt: "..." }), /not allowed/);
  assert.throws(() => sanitizeRoutingTelemetry({ event: "x", cwd: "/w" }), /not allowed/);
  assert.throws(() => sanitizeRoutingTelemetry({ event: "x", env: {} }), /not allowed/);
  assert.throws(() => sanitizeRoutingTelemetry({ event: "x", configPath: "/c" }), /not allowed/);
  assert.throws(() => sanitizeRoutingTelemetry(null), TypeError);
});

test("an accepted telemetry event carries only shapes, counts and salted tokens", () => {
  const lane = buildTelegramRouteLane({ accountId: "telegram", chatId: 987, messageThreadId: 3 });
  const event = sanitizeRoutingTelemetry({
    event: "telegram_profile_select",
    outcome: "matched",
    laneToken: laneToken(lane),
    laneKind: lane.kind,
    topicShape: "topic",
    profileToken: profileToken("safe"),
    count: 1,
  });
  const serialized = JSON.stringify(event);
  for (const forbidden of ["987", "telegram_chat", "safe", "/"]) {
    assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}`);
  }
  assert.equal(Object.isFrozen(event), true);
});

test("routing counters are pure counts keyed by shape", () => {
  const counters = new RoutingCounters();
  counters.increment("telegram_profile_select:matched");
  counters.increment("telegram_profile_select:matched");
  counters.increment("telegram_profile_select:unmapped");
  counters.increment("");

  assert.deepEqual({ ...counters.snapshot() }, {
    "telegram_profile_select:matched": 2,
    "telegram_profile_select:unmapped": 1,
  });
  counters.reset();
  assert.deepEqual({ ...counters.snapshot() }, {});
});
