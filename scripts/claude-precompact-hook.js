const fs = require("fs");
const path = require("path");

async function main() {
  const payload = await readStdinJson();
  const stateDir = process.env.CYBERBOSS_STATE_DIR || "";
  if (!stateDir) {
    return;
  }
  const contextDir = path.join(stateDir, "context");
  fs.mkdirSync(contextDir, { recursive: true });
  const out = {
    timestamp: new Date().toISOString(),
    sessionId: readFirstString(payload, ["session_id", "sessionId", "thread_id", "threadId"]),
    trigger: readFirstString(payload, ["trigger", "source"]) || "hook_precompact",
  };
  const filePath = path.join(contextDir, "precompact-hook-last.json");
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + "\n", "utf8");
}

async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString("utf8");
  }
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function readFirstString(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

main().catch(() => {
  process.exitCode = 0;
});
