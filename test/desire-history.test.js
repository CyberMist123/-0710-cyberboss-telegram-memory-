const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DesireService } = require("../src/services/desire-service");

test("Desire sole writer appends an eight-dimensional dashboard history row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-desire-history-"));
  const config = {
    desireStateFile: path.join(root, "desire-state.json"),
    desireHistoryFile: path.join(root, "desire-history.jsonl"),
    desireThoughtsFile: path.join(root, "desire-thoughts.json"),
    memoryDir: path.join(root, "memory"),
    desireDriven: false,
    desireThoughtMax: 80,
  };
  const service = new DesireService(config);
  service.save();

  const rows = fs.readFileSync(config.desireHistoryFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(rows.length >= 2);
  for (const key of ["attachment", "curiosity", "reflection", "duty", "social", "fatigue", "libido", "stress"]) {
    assert.equal(typeof rows.at(-1)[key], "number");
  }
  assert.equal(rows.at(-1).note, "desire-runtime");
});
