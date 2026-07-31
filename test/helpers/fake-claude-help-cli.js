"use strict";

// Offline fixture for scripts/audit/cli-capability-snapshot.js.
const flags = ["--bare", "--disable-slash-commands", "--setting-sources", "--settings", "--mcp-config", "--strict-mcp-config", "--tools", "--effort", "--config-dir", "--output-style"];
if (process.argv.includes("--version")) { process.stdout.write("0.0.0-fake\n"); process.exit(0); }
if (process.argv.includes("--help")) {
  for (const flag of flags) if (!(process.env.CB_FAKE_HELP_MODE === "missing-strict" && flag === "--strict-mcp-config")) process.stdout.write(`  ${flag}\n`);
  process.exit(0);
}
process.exit(2);
