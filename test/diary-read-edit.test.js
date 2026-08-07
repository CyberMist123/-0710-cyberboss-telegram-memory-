"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { DiaryService } = require("../src/services/diary-service");
const { registeredProjectTools } = require("../src/tools/tool-host");
const { resolveToolset } = require("../src/tools/tool-catalog-manifest");

function service() {
  const diaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-diary-"));
  return {
    diaryDir,
    diary: new DiaryService({ config: { diaryDir, automationTimezone: "Australia/Sydney" } }),
  };
}

test("she can read back the day she just wrote, and an untouched day reads empty", async () => {
  const { diary } = service();
  await diary.append({ text: "江边风很大。", date: "2026-08-07", time: "09:00" });

  const today = await diary.read({ date: "2026-08-07" });
  assert.equal(today.exists, true);
  assert.match(today.text, /江边风很大。/u);

  // Reading a day she never wrote is not an error -- it is just empty.
  const empty = await diary.read({ date: "2026-08-06" });
  assert.equal(empty.exists, false);
  assert.equal(empty.text, "");
});

test("editing replaces exactly the passage named and leaves the rest byte-identical", async () => {
  const { diary } = service();
  await diary.append({ text: "早上去了江边。", date: "2026-08-07", time: "09:00" });
  await diary.append({ text: "晚上煮了面。", date: "2026-08-07", time: "21:00" });
  const before = (await diary.read({ date: "2026-08-07" })).text;

  const result = await diary.edit({
    date: "2026-08-07",
    find: "早上去了江边。",
    replace: "早上去了江边，风比想的大。",
  });
  assert.equal(result.replaced, 1);
  assert.equal(result.removed, false);

  const after = (await diary.read({ date: "2026-08-07" })).text;
  assert.match(after, /早上去了江边，风比想的大。/u);
  assert.equal(after.includes("晚上煮了面。"), true, "the other entry must be untouched");
  assert.equal(after, before.replace("早上去了江边。", "早上去了江边，风比想的大。"));

  // The pre-edit text stays recoverable without going to the whole-memory snapshot.
  assert.equal(fs.readFileSync(result.backupPath, "utf8"), before);
});

test("an ambiguous or absent passage refuses rather than guessing which one she meant", async () => {
  const { diary } = service();
  await diary.append({ text: "同一句。", date: "2026-08-07", time: "09:00" });
  await diary.append({ text: "同一句。", date: "2026-08-07", time: "21:00" });
  const before = (await diary.read({ date: "2026-08-07" })).text;

  await assert.rejects(
    () => diary.edit({ date: "2026-08-07", find: "同一句。", replace: "改过的。" }),
    /appears 2 times/u,
  );
  await assert.rejects(
    () => diary.edit({ date: "2026-08-07", find: "根本没写过的话", replace: "x" }),
    /not in the 2026-08-07 diary/u,
  );
  await assert.rejects(
    () => diary.edit({ date: "2026-08-07", find: "   " }),
    /needs `find` text/u,
  );
  await assert.rejects(() => diary.read({ date: "07-08-2026" }), /YYYY-MM-DD/u);

  // Every refusal above must be fail-closed: nothing on disk moved.
  assert.equal((await diary.read({ date: "2026-08-07" })).text, before);
});

test("an empty replacement deletes the passage instead of writing the string 'undefined'", async () => {
  const { diary } = service();
  await diary.append({ text: "留下的。", date: "2026-08-07", time: "09:00" });
  await diary.append({ text: "要删掉的。", date: "2026-08-07", time: "21:00" });

  const result = await diary.edit({ date: "2026-08-07", find: "要删掉的。" });
  assert.equal(result.removed, true);

  const after = (await diary.read({ date: "2026-08-07" })).text;
  assert.equal(after.includes("要删掉的。"), false);
  assert.equal(after.includes("undefined"), false);
  assert.equal(after.includes("留下的。"), true);
});

test("both new diary tools register and are authorized in the chat toolset", () => {
  const tools = registeredProjectTools({});
  for (const name of ["cyberboss_diary_read", "cyberboss_diary_edit"]) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `${name} must register`);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  // The toolset is the fail-closed authorization gate: visible in the catalog
  // but missing here would mean she can see the tool and never call it.
  const toolset = resolveToolset("chat-core@1");
  assert.equal(toolset.members.has("cyberboss_diary_read"), true);
  assert.equal(toolset.members.has("cyberboss_diary_edit"), true);
});
