const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveBodyInput } = require("../src/services/text-input");

function createTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-command-test-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("reminder body can be loaded from --text-file", async () => {
  const filePath = createTempFile("reminder.txt", "  remember me  \n");
  const body = await resolveBodyInput({ text: "", textFile: filePath });
  assert.equal(body, "remember me");
});

test("diary body can be loaded from --text-file", async () => {
  const filePath = createTempFile("diary.md", "\nline one\nline two\n");
  const body = await resolveBodyInput({ text: "", textFile: filePath });
  assert.equal(body, "line one\nline two");
});
