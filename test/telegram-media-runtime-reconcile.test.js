const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

test("Telegram runtime exposes both photo and voice paths in one structured text bridge", async () => {
  const runtimeTurn = await CyberbossApp.prototype.buildRuntimeTurn.call({}, {
    prepared: {
      provider: "telegram",
      text: "[voice] caption",
      originalText: "[voice] caption",
      attachments: [
        { kind: "photo", type: "photo", absolutePath: "C:\\temp\\photo.jpg", contentType: "image/jpeg" },
        { kind: "voice", type: "voice", absolutePath: "C:\\temp\\voice.oga", contentType: "audio/ogg" },
      ],
    },
  });

  assert.match(runtimeTurn.text, /<media kind="photo"/);
  assert.match(runtimeTurn.text, /<media kind="voice"/);
  assert.match(runtimeTurn.text, /C:\\temp\\photo\.jpg/);
  assert.match(runtimeTurn.text, /C:\\temp\\voice\.oga/);
  assert.deepEqual(runtimeTurn.attachments, []);
});
