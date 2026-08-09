const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildOpeningTurnText } = require("../src/adapters/runtime/shared-instructions");
const { computeHardContextFingerprint } = require("../src/adapters/runtime/claudecode");
const { prepareOpeningContext } = require("../src/core/hard-context");
const { countNonWhitespace } = require("../src/core/reentry-loader");
const { loadSlowLayer } = require("../src/core/slow-layer-loader");

test("all slow-layer switches off preserve the old opening, trace, and fingerprint", () => {
  const root = fixtureRoot();
  const files = slowLayerFiles(root);
  fs.writeFileSync(files.agreementsFile, "示例约定：先喝水再说话", "utf8");
  fs.writeFileSync(files.aiPortraitFile, "示例画像：今天保持好奇", "utf8");
  fs.writeFileSync(files.wanderingFile, "示例问号：还想继续探索", "utf8");

  const noSlowConfig = {};
  const offConfig = {
    ...files,
    injectAgreements: false,
    injectPortrait: false,
    injectWandering: false,
  };
  const sessionStore = { getReentryInjection: () => null };
  const oldContext = prepareOpeningContext({ config: noSlowConfig, sessionStore, threadId: "fixture-off" });
  const offContext = prepareOpeningContext({ config: offConfig, sessionStore, threadId: "fixture-off" });

  const oldText = buildOpeningTurnText(noSlowConfig, "示例用户消息", oldContext);
  const offText = buildOpeningTurnText(offConfig, "示例用户消息", offContext);
  assert.equal(offText, oldText);
  assert.deepEqual(offContext, oldContext);
  for (const type of ["agreements", "portrait", "wandering"]) {
    assert.equal(offContext.blocks.some((item) => item.type === type), false);
    assert.equal(offContext.skipped.some((item) => item.type === type), false);
  }
  assert.equal(computeHardContextFingerprint(offConfig), computeHardContextFingerprint(noSlowConfig));
});

test("all three enabled slow-layer files render in order and carry trace evidence", () => {
  const root = fixtureRoot();
  const files = slowLayerFiles(root);
  const reentryFile = path.join(root, "reentry.md");
  const currentStateFile = path.join(root, "current-state.md");
  fs.writeFileSync(files.agreementsFile, "示例约定：先喝水再说话", "utf8");
  fs.writeFileSync(files.aiPortraitFile, "示例画像：允许慢慢确认", "utf8");
  fs.writeFileSync(files.wanderingFile, "示例问号一\n示例问号二", "utf8");
  fs.writeFileSync(reentryFile, "示例交接：从这里继续", "utf8");
  fs.writeFileSync(currentStateFile, "示例当前状态：先看清楚再回答", "utf8");

  const config = {
    ...files,
    reentryFile,
    currentStateOverrideFile: currentStateFile,
    injectAgreements: true,
    injectPortrait: true,
    injectWandering: true,
  };
  const context = prepareOpeningContext({
    config,
    sessionStore: { getReentryInjection: () => null },
    threadId: "fixture-on",
  });
  const rendered = buildOpeningTurnText(config, "示例用户消息", context);
  const positions = [
    "<<<CB_CTX:REENTRY",
    "<<<CB_CTX:AGREEMENTS",
    "<<<CB_CTX:PORTRAIT",
    "<<<CB_CTX:WANDERING",
    "<<<CB_CTX:CURRENT_STATE",
  ].map((marker) => rendered.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(rendered, /7 月版画像，认领与否由你/u);
  assert.match(rendered, /你上次留了这几个问号/u);

  for (const type of ["agreements", "portrait", "wandering"]) {
    const trace = context.blocks.find((item) => item.type === type);
    assert.equal(trace.loaded, true);
    assert.ok(trace.chars > 0);
    assert.match(trace.hash, /^[a-f0-9]{64}$/u);
    assert.notEqual(trace.src_mtime, "");
  }
});

test("missing, empty, and comment-only enabled files are skipped without blocking other items", () => {
  for (const [label, prepareTarget] of [
    ["missing", (filePath) => assert.equal(fs.existsSync(filePath), false)],
    ["empty", (filePath) => fs.writeFileSync(filePath, "", "utf8")],
    ["comments", (filePath) => fs.writeFileSync(filePath, "<!-- 示例说明：这里只是注释 -->", "utf8")],
  ]) {
    const root = fixtureRoot();
    const files = slowLayerFiles(root);
    const target = label === "missing" ? files.agreementsFile : files.aiPortraitFile;
    prepareTarget(target);
    for (const [type, filePath] of Object.entries(files)) {
      if (filePath !== target) fs.writeFileSync(filePath, `示例${type}内容：保持可读`, "utf8");
    }
    const config = {
      ...files,
      injectAgreements: true,
      injectPortrait: true,
      injectWandering: true,
    };
    const context = prepareOpeningContext({
      config,
      sessionStore: { getReentryInjection: () => null },
      threadId: `fixture-${label}`,
    });
    assert.deepEqual(context.skipped.find((item) => item.type === (label === "missing" ? "agreements" : "portrait")), {
      type: label === "missing" ? "agreements" : "portrait",
      reason: "missing",
      configured: "on",
      effective: "none",
    });
    for (const type of ["agreements", "portrait", "wandering"]) {
      if (type !== (label === "missing" ? "agreements" : "portrait")) {
        assert.equal(context.blocks.some((item) => item.type === type && item.loaded === true), true);
      }
    }
    assert.doesNotThrow(() => buildOpeningTurnText(config, "示例用户消息", context));
  }
});

test("wandering strips comments, takes at most three lines, and stops at the 100-char tail budget", () => {
  const root = fixtureRoot();
  const filePath = path.join(root, "wandering.md");
  fs.writeFileSync(filePath, [
    "<!-- 示例说明：跳过 -->",
    "示例问号一",
    "",
    "<!-- 示例说明：仍然跳过 -->",
    "示例问号二",
    "示例问号三",
    "示例问号四",
    "示例问号五",
  ].join("\n"), "utf8");
  const firstThree = loadSlowLayer({ config: { injectWandering: true, wanderingFile: filePath } });
  assert.equal(firstThree.blocks[0].text, "示例问号一\n示例问号二\n示例问号三");

  fs.writeFileSync(filePath, [
    "<!-- 示例说明：跳过 -->",
    "示例问号一",
    "<!-- 示例说明：第二行之后仍按正文计数 -->",
    `示例超长问号：${"字".repeat(101)}`,
    "示例问号三",
  ].join("\n"), "utf8");
  const firstOnly = loadSlowLayer({ config: { injectWandering: true, wanderingFile: filePath } });
  assert.equal(firstOnly.blocks[0].text, "示例问号一");
});

test("over-budget admission skips the lower-priority portrait without rewriting its source", () => {
  const root = fixtureRoot();
  const files = slowLayerFiles(root);
  const agreements = "约".repeat(700);
  const portrait = "像".repeat(200);
  fs.writeFileSync(files.agreementsFile, agreements, "utf8");
  fs.writeFileSync(files.aiPortraitFile, portrait, "utf8");
  const portraitBefore = fs.readFileSync(files.aiPortraitFile);
  const result = loadSlowLayer({
    config: {
      agreementsFile: files.agreementsFile,
      aiPortraitFile: files.aiPortraitFile,
      injectAgreements: true,
      injectPortrait: true,
    },
  });

  assert.equal(result.blocks.find((item) => item.type === "agreements").chars, 700);
  assert.deepEqual(result.skipped.find((item) => item.type === "portrait"), {
    type: "portrait",
    reason: "over_budget",
  });
  assert.deepEqual(fs.readFileSync(files.aiPortraitFile), portraitBefore);
  assert.equal(fs.readFileSync(files.aiPortraitFile, "utf8"), portrait);
  assert.equal(countNonWhitespace(agreements), 700);
});

test("enabled file changes affect the hard-context fingerprint, while disabled changes do not", () => {
  const root = fixtureRoot();
  const filePath = path.join(root, "agreements.md");
  fs.writeFileSync(filePath, "示例约定：版本一", "utf8");
  const offConfig = { agreementsFile: filePath, injectAgreements: false };
  const offBefore = computeHardContextFingerprint(offConfig);
  fs.writeFileSync(filePath, "示例约定：版本二", "utf8");
  assert.equal(computeHardContextFingerprint(offConfig), offBefore);

  const onConfig = { agreementsFile: filePath, injectAgreements: true };
  const onBefore = computeHardContextFingerprint(onConfig);
  fs.writeFileSync(filePath, "示例约定：版本三", "utf8");
  assert.notEqual(computeHardContextFingerprint(onConfig), onBefore);
});

function slowLayerFiles(root) {
  return {
    agreementsFile: path.join(root, "agreements.md"),
    aiPortraitFile: path.join(root, "portrait.md"),
    wanderingFile: path.join(root, "wandering.md"),
  };
}

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-slow-layer-"));
}
