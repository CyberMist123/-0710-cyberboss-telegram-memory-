"use strict";

// Offline CLI snapshot schema. It records only version, hashes and flag names:
// never the help transcript, binary path, environment values, or timestamps.
const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const REQUIRED_FLAGS = ["--bare", "--disable-slash-commands", "--setting-sources", "--settings", "--mcp-config", "--strict-mcp-config", "--tools", "--effort"];
const OPTIONAL_FLAGS = ["--config-dir", "--output-style"];
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function snapshot({ bin }) {
  if (!bin) throw new Error("provide --bin <path> or CLAUDE_BIN");
  const spawnOptions = { encoding: "utf8", shell: process.platform === "win32" };
  const version = spawnSync(bin, ["--version"], spawnOptions);
  const help = spawnSync(bin, ["--help"], spawnOptions);
  if (version.error || help.error || version.status !== 0 || help.status !== 0) throw new Error("CLI capability probe failed");
  const helpText = `${help.stdout || ""}${help.stderr || ""}`;
  const required_flags = Object.fromEntries(REQUIRED_FLAGS.map((flag) => [flag, helpText.includes(flag)]));
  return { schema_version: 1, generated_by: "scripts/audit/cli-capability-snapshot.js", cli_version: String(version.stdout || version.stderr || "").trim(), help_sha256: hash(helpText), binary_path_sha256: hash(fs.readFileSync(bin)), required_flags, missing_flags: REQUIRED_FLAGS.filter((flag) => !required_flags[flag]), observed_optional_flags: OPTIONAL_FLAGS.filter((flag) => helpText.includes(flag)), captured_at: "1970-01-01T00:00:00.000Z" };
}

function main(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--bin"); const bin = index >= 0 ? argv[index + 1] : process.env.CLAUDE_BIN;
  const out = argv.indexOf("--out"); const value = `${JSON.stringify(snapshot({ bin }), null, 2)}\n`;
  if (out >= 0) fs.writeFileSync(argv[out + 1], value, "utf8"); else process.stdout.write(value);
  if (argv.includes("--fail-on-missing") && JSON.parse(value).missing_flags.length) process.exitCode = 1;
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { REQUIRED_FLAGS, snapshot, main };
