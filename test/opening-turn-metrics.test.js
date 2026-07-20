const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { measureOpeningTurn } = require("../src/adapters/runtime/opening-turn-metrics");

test("opening-turn fixture reports bounded cwd and does not claim implicit reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-opening-metrics-"));
  const memory = path.join(root, "memory");
  fs.mkdirSync(memory);
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "runtime"));
  fs.writeFileSync(path.join(root, "package.json"), "{}", "utf8");
  try {
    const before = measureOpeningTurn({ prompt: "Opening context", contextBlocks: ["persona", "reentry"], cwd: root });
    const after = measureOpeningTurn({ prompt: "Opening context", contextBlocks: ["persona", "reentry"], cwd: memory });
    assert.equal(before.opening_prompt_chars, after.opening_prompt_chars);
    assert.equal(before.opening_context_blocks, after.opening_context_blocks);
    assert.equal(before.explicit_files_read_before_start, 0);
    assert.equal(after.explicit_files_read_before_start, 0);
    assert.equal(after.cwd_top_level_entries, 0);
    assert.ok(before.cwd_top_level_entries > after.cwd_top_level_entries);
    assert.equal(after.encourages_project_exploration, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
