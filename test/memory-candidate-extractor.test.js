const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeMemoryText, extractMemoryCandidatesFromText, isMeaningfulMemory } = require("../src/core/memory-candidate-extractor");

test("extracts stable preference instead of storing whole noisy sentence", () => {
  const candidates = extractMemoryCandidatesFromText("我喜欢你说话直接一点，别用奇奇怪怪的比喻");
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].category, "preferences");
  assert.equal(candidates[0].text, "偏好直接、易理解的表达");
  assert.equal(candidates[0].key, "pref_style_direct");
  assert.equal(candidates[1].text, "不喜欢奇怪比喻，偏好直接表达");
  assert.equal(candidates[1].key, "pref_no_weird_metaphor");
});

test("extracts reminder style open loop", () => {
  const candidates = extractMemoryCandidatesFromText("记得中午下班提醒我关掉免打扰，下午两点看一下基金要不要调仓");
  assert.ok(candidates.some((item) => item.category === "open_loops" && /提醒我关掉免打扰/.test(item.text) && item.key === "loop_disable_dnd"));
});

test("extracts relationship address rule as normalized value", () => {
  const candidates = extractMemoryCandidatesFromText("以后叫我哥哥，不要乱叫");
  assert.ok(candidates.some((item) => item.category === "relationships" && item.value === "哥哥" && item.key === "rel_address_哥哥"));
});

test("extracts explicit fact with stable key", () => {
  const candidates = extractMemoryCandidatesFromText("记住：我吃太辣会胃疼");
  assert.ok(candidates.some((item) => item.category === "facts" && item.key === "fact_spicy_hurts_stomach" && item.text === "吃太辣会胃疼"));
});

test("drops generic like sentence instead of saving raw quote as stable memory", () => {
  const candidates = extractMemoryCandidatesFromText("到此为止了 我确实超级无敌爆炸喜欢 这个价格其实差不多是游戏里一个多的皮肤钱");
  assert.equal(candidates.length, 0);
});

test("filters quoted text and generic questions from memory candidates", () => {
  assert.equal(isMeaningfulMemory("[Quoted: 你之前说过这个] 我喜欢这个"), false);
  assert.equal(isMeaningfulMemory("你很喜欢这个吗？"), false);
});

test("does not treat generic 计划 flirt text as project memory", () => {
  const candidates = extractMemoryCandidatesFromText("哥哥没计划我可有计划");
  assert.equal(candidates.length, 0);
});

test("analysis rejects weak chatter and accepts stable memory signal", () => {
  assert.equal(analyzeMemoryText("哈哈好的").worthy, false);
  assert.equal(analyzeMemoryText("提醒我中午关掉免打扰").worthy, true);
});
