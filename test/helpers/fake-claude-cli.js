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
  // Allocate a fresh session number atomically. Several children are spawned
  // concurrently in the isolation tests, and a read-modify-write counter would
  // hand two of them the same id -- a fixture artefact that would look exactly
  // like a genuine cross-lane session leak.
  sessionId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(allocateSessionNumber()).padStart(12, "0")}`;
}

function allocateSessionNumber() {
  const dir = `${counterFile}.d`;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  for (let candidate = 1; candidate < 10000; candidate += 1) {
    try {
      // mkdir is atomic: exactly one process can create a given name.
      fs.mkdirSync(`${dir}/${candidate}`);
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("fake claude cli ran out of session numbers");
}

if (logFile) {
  fs.appendFileSync(logFile, `${JSON.stringify({
    argv,
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

// A real CLI stays up and serves many turns on one session. The default here is
// to exit after one, which forces a relaunch and makes `--resume` observable in
// the launch log; CB_FAKE_KEEP_ALIVE=1 models the long-lived process instead.
const keepAlive = process.env.CB_FAKE_KEEP_ALIVE === "1";
const turnDelayMs = Number(process.env.CB_FAKE_TURN_DELAY_MS || 0) || 0;
const execLog = process.env.CB_FAKE_EXEC_LOG || "";

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    // One record per user message actually received, so a test can prove a turn
    // was executed exactly once.
    if (execLog) {
      fs.appendFileSync(execLog, `${JSON.stringify({ sessionId, line })}\n`, "utf8");
    }
    const respond = () => {
      console.log(JSON.stringify({ type: "system", session_id: sessionId }));
      console.log(JSON.stringify({ type: "result", session_id: sessionId, result: "ok" }));
      if (!keepAlive) {
        process.exit(0);
      }
    };
    if (turnDelayMs > 0) {
      setTimeout(respond, turnDelayMs);
    } else {
      respond();
    }
  }
});
