"use strict";

const REQUIRED = [
  "--bare", "--disable-slash-commands", "--setting-sources", "--settings",
  "--mcp-config", "--strict-mcp-config", "--tools", "--effort",
  "--config-dir", "--output-style",
];

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
