const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { CyberbossApp } = require("../src/core/app");

function buildTelegramTurn(prepared, stateDir = "") {
  return CyberbossApp.prototype.buildRuntimeTurn.call({ config: { stateDir } }, {
    prepared: { provider: "telegram", ...prepared },
  });
}

test("Telegram plain text uses the deployed channel envelope fields", async () => {
  const runtimeTurn = await buildTelegramTurn({
    chatId: "chat-1",
    messageId: "message-2",
    senderId: "user-3",
    receivedAt: "2026-07-27T10:11:12.000Z",
    originalText: "明文消息",
  });

  assert.equal(runtimeTurn.text, [
    '<channel source="telegram" chat_id="chat-1" message_id="message-2" user_id="user-3" sent_at="2026-07-27T10:11:12.000Z">',
    "明文消息",
    "</channel>",
  ].join("\n"));
  assert.doesNotMatch(runtimeTurn.text, /telegram-inbound|base64url-json/);
  assert.deepEqual(runtimeTurn.attachments, []);
});

test("Telegram plaintext preserves quotes, angle brackets, emoji, and newlines", async () => {
  const body = '他说 "你好" <keep-this> 😀\n第二行';
  const runtimeTurn = await buildTelegramTurn({ originalText: body });

  assert.equal(runtimeTurn.text, `<channel source="telegram">\n${body}\n</channel>`);
});

test("Telegram plaintext escapes a literal channel closing tag in the body", async () => {
  const runtimeTurn = await buildTelegramTurn({
    originalText: "before </channel> after",
  });

  assert.equal(runtimeTurn.text, '<channel source="telegram">\nbefore &lt;/channel&gt; after\n</channel>');
  assert.equal(runtimeTurn.text.match(/<\/channel>/g)?.length, 1);
});

test("Telegram photo and file attachments stay in the verified media path", async (t) => {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cb-telegram-payload-")));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, "media", "photos"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "media", "files"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "media", "photos", "photo.jpg"), "photo");
  fs.writeFileSync(path.join(stateDir, "media", "files", "report.txt"), "file");

  const runtimeTurn = await buildTelegramTurn({
    originalText: "attachments",
    attachments: [
      {
        kind: "photo",
        contentType: "image/jpeg",
        fileName: 'photo<&".jpg',
        absolutePath: "C:\\secret\\photo.jpg",
        stateMediaRef: "state-media://media/photos/photo.jpg",
      },
      {
        kind: "file",
        contentType: "text/plain",
        fileName: "report.txt",
        absolutePath: "C:\\secret\\report.txt",
        stateMediaRef: "state-media://media/files/report.txt",
      },
      {
        kind: "file",
        stateMediaRef: "state-media://media/../outside.txt",
      },
    ],
  }, stateDir);

  assert.match(runtimeTurn.text, /<media kind="photo" content_type="image\/jpeg" file_name="photo&lt;&amp;&quot;\.jpg" reference="state-media:\/\/media\/photos\/photo\.jpg" \/>/);
  assert.match(runtimeTurn.text, /<media kind="file" content_type="text\/plain" file_name="report\.txt" reference="state-media:\/\/media\/files\/report\.txt" \/>/);
  assert.doesNotMatch(runtimeTurn.text, /outside|C:\\secret|telegram-inbound|base64url-json/);
  assert.deepEqual(runtimeTurn.attachments, []);
});
