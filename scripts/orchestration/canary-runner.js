#!/usr/bin/env node
const path = require("path");
const { runCanary } = require("../../src/orchestration/canary-runner");

const values = process.argv.slice(2);
const get = (name, fallback = "") => {
  const prefix = `--${name}=`;
  const item = values.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
};
const sources = values.filter((value) => value.startsWith("--source=")).map((value) => value.slice(9));
runCanary({
  statePath: path.resolve(get("state", path.join(__dirname, "..", "..", "..", "MEMORY_CANARY_STATE.json"))),
  sources,
  resume: values.includes("--resume"),
  pollIntervalMs: Number(get("poll-ms", "5000")),
  timeoutMs: Number(get("timeout-ms", "300000")),
}).then((result) => {
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "VERIFIED" ? 0 : 3;
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
