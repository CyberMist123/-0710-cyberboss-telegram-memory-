"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CliCapabilityError,
  DECLARABLE_FLAGS,
  EFFORT_VALUES,
  VERIFIED_CLI_VERSION,
  VERIFIED_PROFILE_FLAGS,
  assertLaunchArgsSupported,
  resolveCliCapabilities,
} = require("../src/adapters/runtime/claudecode/cli-capabilities");
const {
  LaunchProfileError,
  buildProfileLaunch,
  validateLaunchProfile,
} = require("../src/adapters/runtime/claudecode/launch-profile");
const {
  ProfileRoutingError,
  createTelegramProfileRouter,
} = require("../src/adapters/runtime/claudecode/telegram-profile-router");

function makeBase() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-cli-")));
  fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), "{}");
  return dir;
}

test("the effort enum matches the verified CLI, including xhigh", () => {
  assert.deepEqual([...EFFORT_VALUES], ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(VERIFIED_CLI_VERSION, "2.1.220");

  const baseDir = makeBase();
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(validateLaunchProfile({ effort }, { baseDir }).effort, effort);
  }
});

test("the verified flag set is exactly what the CLI help declares", () => {
  const caps = resolveCliCapabilities();
  for (const flag of ["--effort", "--settings", "--mcp-config", "--strict-mcp-config", "--tools", "--agents", "--system-prompt"]) {
    assert.equal(caps.supports(flag), true, `${flag} should be supported`);
    assert.equal(VERIFIED_PROFILE_FLAGS.has(flag), true);
  }
  // Undeclared by the verified help output.
  assert.equal(caps.supports("--config-dir"), false);
  assert.equal(caps.supports("--output-style"), false);
});

test("an undeclared flag fails closed before launch, not at the CLI", () => {
  const baseDir = makeBase();
  for (const [field, value] of [["configDir", "cfg"], ["outputStyle", "terse"]]) {
    assert.throws(
      () => validateLaunchProfile({ [field]: value }, { baseDir }),
      (error) => {
        assert.ok(error instanceof LaunchProfileError);
        assert.equal(error.code, "cli_flag_unsupported");
        assert.match(error.message, /CYBERBOSS_CLAUDE_CLI_CAPABILITIES_JSON/);
        return true;
      },
    );
  }
});

test("declaring a capability makes exactly that flag usable", () => {
  const baseDir = makeBase();
  const declared = resolveCliCapabilities({ declaredJson: '["--config-dir"]' });
  assert.deepEqual([...declared.declared], ["--config-dir"]);

  const profile = validateLaunchProfile({ configDir: "cfg" }, { baseDir, capabilities: declared });
  assert.equal(profile.configDir, path.join(baseDir, "cfg"));
  const launch = buildProfileLaunch({
    profile, baseCwd: baseDir, baseDir, capabilities: declared,
  });
  assert.equal(launch.args.includes("--config-dir"), true);

  // The other unverified flag is still gated.
  assert.throws(
    () => validateLaunchProfile({ outputStyle: "terse" }, { baseDir, capabilities: declared }),
    LaunchProfileError,
  );
});

test("only the known-unverified flags may be declared", () => {
  assert.deepEqual([...DECLARABLE_FLAGS].sort(), ["--config-dir", "--output-style"]);
  for (const raw of [
    '["--dangerously-skip-permissions"]',
    '["--resume"]',
    '["-p"]',
    '[""]',
    '[123]',
  ]) {
    assert.throws(
      () => resolveCliCapabilities({ declaredJson: raw }),
      (error) => {
        assert.ok(error instanceof CliCapabilityError);
        assert.equal(error.code, "undeclarable_capability");
        return true;
      },
    );
  }
});

test("a malformed or over-sized capability declaration is rejected", () => {
  for (const raw of ["{", '{"a":1}', '"--config-dir"']) {
    assert.throws(() => resolveCliCapabilities({ declaredJson: raw }), CliCapabilityError);
  }
  assert.throws(
    () => resolveCliCapabilities({ declaredJson: JSON.stringify(Array.from({ length: 40 }, () => "--config-dir")) }),
    CliCapabilityError,
  );
});

test("the final guard refuses to spawn with an unsupported flag", () => {
  const caps = resolveCliCapabilities();
  assert.equal(assertLaunchArgsSupported(["--model", "sonnet", "--effort", "low"], caps), true);
  assert.throws(
    () => assertLaunchArgsSupported(["--model", "sonnet", "--output-style", "terse"], caps),
    (error) => {
      assert.equal(error.code, "cli_flag_unsupported");
      return true;
    },
  );
  // Non-flag values are never treated as flags.
  assert.equal(assertLaunchArgsSupported(["--effort", "high", "some-value"], caps), true);
});

test("a profile using an undeclared flag blocks startup through the router", () => {
  const baseDir = makeBase();
  assert.throws(
    () => createTelegramProfileRouter({
      profilesJson: JSON.stringify({ safe: { outputStyle: "terse" } }),
      baseDir,
    }),
    (error) => {
      assert.ok(error instanceof ProfileRoutingError);
      assert.equal(error.code, "cli_flag_unsupported");
      return true;
    },
  );

  // With the capability declared, the same configuration starts.
  const router = createTelegramProfileRouter({
    profilesJson: JSON.stringify({ safe: { outputStyle: "terse" } }),
    mappingJson: JSON.stringify([
      { accountId: "telegram", chatId: "1", messageThreadId: null, profileId: "safe" },
    ]),
    baseDir,
    cliCapabilitiesJson: '["--output-style"]',
  });
  assert.equal(router.describe().profileCount, 1);
});

test("a relative profile path needs an explicit base directory", () => {
  // No current-working-directory fallback: the resolution must not depend on where the
  // bridge happened to be started.
  assert.throws(
    () => validateLaunchProfile({ cwd: "work" }, {}),
    (error) => {
      assert.ok(error instanceof LaunchProfileError);
      assert.equal(error.code, "missing_base_dir");
      return true;
    },
  );
  assert.throws(
    () => validateLaunchProfile({ settings: "settings.json" }, { baseDir: "   " }),
    LaunchProfileError,
  );
});

test("no launch path resolves against the current working directory", () => {
  // Built at runtime so this file does not match its own scan.
  const needle = `process${"."}cwd()`;
  const roots = [path.join(__dirname, "..", "src"), __dirname];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__pycache__") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js") || full === __filename) {
        continue;
      }
      fs.readFileSync(full, "utf8").split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        // Comments may name it; only executable call sites count.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
          return;
        }
        if (line.includes(needle)) {
          offenders.push(`${path.relative(path.join(__dirname, ".."), full)}:${index + 1}`);
        }
      });
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, [], `found at: ${offenders.join(", ")}`);
});
