"use strict";

// Offline Claude Code process fixture.
//
// It never reads credentials, opens a network connection or invokes a model.
// It records the ordered argv and cwd of every launch, then answers one turn:
//
//   * with `--resume <id>` it echoes that session id back, which is what makes
//     a cross-slot resume observable in the launch log;
//   * without it, it mints a fresh session id from a shared counter file, so
//     two independent lanes get provably different sessions.

const fs = require("node:fs");

const argv = process.argv.slice(2);
const logFile = process.env.CB_FAKE_LAUNCH_LOG || "";
const counterFile = process.env.CB_FAKE_COUNTER || "";

const resumeIndex = argv.indexOf("--resume");
const resumeSessionId = resumeIndex >= 0 ? String(argv[resumeIndex + 1] || "") : "";

let sessionId = resumeSessionId;
if (!sessionId) {
  let counter = 0;
  try {
    counter = Number(fs.readFileSync(counterFile, "utf8")) || 0;
  } catch {}
  counter += 1;
  try {
    fs.writeFileSync(counterFile, String(counter));
  } catch {}
  sessionId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(counter).padStart(12, "0")}`;
}

if (logFile) {
  fs.appendFileSync(logFile, `${JSON.stringify({
    argv,
    cwd: process.cwd(),
    resumeSessionId,
    sessionId,
    // Only the presence of a handful of non-secret keys is recorded.
    envFlags: {
      NO_COLOR: process.env.NO_COLOR || "",
      DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY || "",
      hasAwsKey: Boolean(process.env.AWS_ACCESS_KEY_ID),
    },
  })}\n`, "utf8");
}

process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "system", session_id: sessionId }));
  console.log(JSON.stringify({ type: "result", session_id: sessionId, result: "ok" }));
  process.exit(0);
});
