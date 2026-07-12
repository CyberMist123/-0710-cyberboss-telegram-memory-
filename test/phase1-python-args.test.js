const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const kitDir = path.join(repoRoot, "extensions", "relationship-memory", "memory-kit");

test("janitor refuses to guess transcript input when args are missing", () => {
  const result = runPython(path.join(kitDir, "janitor.py"), ["--dry-run"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /缺少 --input|CYBERBOSS_CLAUDE_TRANSCRIPT_DIR|refus/i);
});

test("extractor refuses missing required input", () => {
  const result = runPython(path.join(kitDir, "extract_memory.py"), ["--dry-run"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /required|--input/i);
});

function runPython(script, args) {
  const env = { ...process.env };
  delete env.CYBERBOSS_CLAUDE_TRANSCRIPT_DIR;
  delete env.CYBERBOSS_MEMORY_DIR;
  return spawnSync("python", [script, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}
