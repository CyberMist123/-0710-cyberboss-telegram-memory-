const fs = require("fs");
const path = require("path");

function measureOpeningTurn({ prompt = "", contextBlocks = [], cwd = "" } = {}) {
  const text = String(prompt || "");
  return {
    opening_prompt_chars: text.length,
    opening_context_blocks: Array.isArray(contextBlocks) ? contextBlocks.filter(Boolean).length : 0,
    explicit_files_read_before_start: 0,
    cwd_top_level_entries: countTopLevelEntries(cwd),
    encourages_project_exploration: /(?:scan|explore|browse|read).{0,30}(?:project|directory|source)/iu.test(text),
  };
}

function countTopLevelEntries(cwd = "") {
  try {
    return fs.readdirSync(path.resolve(cwd)).length;
  } catch {
    return 0;
  }
}

module.exports = { measureOpeningTurn };
