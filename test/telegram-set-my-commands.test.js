const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildTelegramBotCommands } = require("../src/core/command-registry");

test("buildTelegramBotCommands returns Telegram-valid {command, description} objects", () => {
  const commands = buildTelegramBotCommands();
  assert.ok(Array.isArray(commands));
  assert.ok(commands.length > 0, "expected a non-empty command list");
  for (const entry of commands) {
    // Telegram Bot API: command names are 1-32 chars of lowercase a-z / 0-9 / underscore.
    assert.match(entry.command, /^[a-z0-9_]{1,32}$/, `invalid Telegram command name: ${entry.command}`);
    assert.equal(typeof entry.description, "string");
    assert.ok(
      entry.description.length >= 1 && entry.description.length <= 256,
      `description out of range for /${entry.command}`
    );
  }
});

test("command names are unique (deduped)", () => {
  const names = buildTelegramBotCommands().map((c) => c.command);
  assert.equal(new Set(names).size, names.length, "duplicate command names present");
});

test("core commands present; arg/subcommand forms fold to the base name", () => {
  const names = new Set(buildTelegramBotCommands().map((c) => c.command));
  for (const expected of ["status", "new", "help", "model", "effort", "yes", "no", "always", "bind", "reread", "stop"]) {
    assert.ok(names.has(expected), `expected /${expected} in the menu`);
  }
  // "/model" and "/model <id>" both fold to "model".
  assert.ok(names.has("pause_heartbeat"), "expected /pause_heartbeat in the menu");
  assert.ok(names.has("continue_heartbeat"), "expected /continue_heartbeat in the menu");
});

test("hidden commands never reach the Telegram menu (front-end invisible, handler retained)", () => {
  const names = new Set(buildTelegramBotCommands().map((c) => c.command));
  for (const hidden of ["star", "checkin", "chunk", "compact", "memory"]) {
    assert.ok(!names.has(hidden), `expected /${hidden} to be hidden from the menu`);
  }
});

test("names with characters Telegram forbids (spaces, angle-args, hyphens) never leak in", () => {
  for (const entry of buildTelegramBotCommands()) {
    assert.ok(!entry.command.includes(" "), `command contains space: ${entry.command}`);
    assert.ok(!entry.command.includes("<"), `command contains '<': ${entry.command}`);
    assert.ok(!entry.command.includes("-"), `command contains hyphen: ${entry.command}`);
  }
});
