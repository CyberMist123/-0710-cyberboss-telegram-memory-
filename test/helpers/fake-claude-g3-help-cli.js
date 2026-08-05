"use strict";

const fs = require("node:fs");

const REQUIRED = [
  "--bare", "--disable-slash-commands", "--setting-sources", "--settings",
  "--mcp-config", "--strict-mcp-config", "--tools", "--effort",
  "--config-dir", "--output-style",
];

// `auth status --json`: fixture for the default production auth probe. Records
// the CLAUDE_CONFIG_DIR it was invoked with (so a test can prove the probe
// carried the profile-exact config root) and answers per CB_FAKE_AUTH:
// logged-in (default) | logged-out | nonzero | garbage.
if (process.argv[2] === "auth" && process.argv[3] === "status") {
  const configDir = String(process.env.CLAUDE_CONFIG_DIR || "");
  if (process.env.CB_FAKE_AUTH_ENV_LOG) fs.writeFileSync(process.env.CB_FAKE_AUTH_ENV_LOG, configDir, "utf8");
  // CB_FAKE_AUTH controls direct calls; through the profiled launch the probe
  // env is allowlist-filtered so CB_FAKE_AUTH is stripped -- there the outcome
  // rides on a marker inside the (preserved) config-root path.
  const mode = process.env.CB_FAKE_AUTH
    || (/loggedout/i.test(configDir) ? "logged-out"
      : /authnonzero/i.test(configDir) ? "nonzero"
      : /authgarbage/i.test(configDir) ? "garbage"
      : "logged-in");
  if (mode === "nonzero") process.exit(1);
  if (mode === "garbage") { process.stdout.write("not-json"); process.exit(0); }
  process.stdout.write(JSON.stringify({ loggedIn: mode === "logged-in", authMethod: "fake" }));
  process.exit(0);
}

const requestedMissing = process.argv[2]?.startsWith("--missing=")
  ? process.argv[2].slice("--missing=".length)
  : "";
const arg = requestedMissing ? (process.argv[3] || "") : (process.argv[2] || "");
if (arg === "--version") {
  process.stdout.write("fake-claude 1.0.0\n");
  process.exit(0);
}
if (arg === "--help") {
  const missing = new Set(requestedMissing.split(",").filter(Boolean));
  process.stdout.write(REQUIRED.filter((flag) => !missing.has(flag)).join("\n"));
  process.exit(0);
}
process.exit(2);
