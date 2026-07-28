// closeout 提示词的宪法要素测试（issue #35，判据 docs/MEMORY_CONSTITUTION.md）。
// 这里钉的是「提示词说了什么」，不是「模型写出了什么」——后者靠离线跑一轮人工抽查，
// 硬拦截由后续 Review 环节负责。测试的意义是：以后有人把这段提示词改回
// 「请总结本次会话」式的纪要文体时，CI 会先喊一声。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  authorCloseout,
  buildCloseoutPrompt,
  CLOSEOUT_OPENING,
  IMPERATIVE_OPENERS,
  EXAMPLE_PAIRS,
} = require("../src/continuity/background-author");

test("closeout prompt opens with the constitution's exact closing words", () => {
  const prompt = buildCloseoutPrompt({ materials: "材料" });
  assert.equal(CLOSEOUT_OPENING, "账都记好了，不用你操心。\n这是你今天最后的话——明天的你，只有这个。");
  assert.ok(prompt.includes(CLOSEOUT_OPENING), "开场语必须逐字出现在提示词里");
  assert.doesNotMatch(prompt, /总结本次会话|会话纪要要点|summarize this session/i);
});

test("closeout prompt routes the four layers and keeps the ledger out of the letter", () => {
  const prompt = buildCloseoutPrompt({ materials: "材料" });
  for (const layer of ["核心自我", "边界", "发生的事", "账本"]) {
    assert.ok(prompt.includes(layer), `四层归位缺少「${layer}」`);
  }
  // 账本判据：查得到的东西不占 Episode / Self-note / Re-entry 的字数。
  assert.match(prompt, /记得.*查得到/);
  assert.match(prompt, /别写进 Episode \/ Self-note \/ Re-entry/);
});

test("closeout prompt states the first-person, past-tense, single-scene requirement", () => {
  const prompt = buildCloseoutPrompt({ materials: "材料" });
  assert.match(prompt, /第一人称、过去式、钉在具体的一次/);
  assert.match(prompt, /use 我\/她\/我们, never 用户\/AI\/assistant/);
  assert.match(prompt, /冷读测试/);
});

test("closeout prompt bans every imperative opener from the constitution", () => {
  const prompt = buildCloseoutPrompt({ materials: "材料" });
  assert.deepEqual(IMPERATIVE_OPENERS, ["以后", "下次", "必须", "要记得", "凡是"]);
  assert.match(prompt, /禁止用祈使句开头/);
  for (const opener of IMPERATIVE_OPENERS) {
    assert.ok(prompt.includes(opener), `禁祈使清单缺少「${opener}」`);
  }
});

test("closeout prompt carries the deletion test as a per-entry self-check", () => {
  const prompt = buildCloseoutPrompt({ materials: "材料" });
  assert.match(prompt, /删除测试/);
  assert.match(prompt, /变的是分寸（姿态，对）还是台词（内容，错）/);
});

test("closeout prompt ships at least two rule-style vs letter-style example pairs", () => {
  const prompt = buildCloseoutPrompt({ materials: "材料" });
  assert.ok(EXAMPLE_PAIRS.length >= 2, "范例对至少 2 组");
  assert.ok(EXAMPLE_PAIRS.length <= 3, "范例对不超过 3 组，避免提示词膨胀");
  for (const pair of EXAMPLE_PAIRS) {
    assert.ok(prompt.includes(pair.bad), `坏范例未进入提示词：${pair.topic}`);
    assert.ok(prompt.includes(pair.good), `好范例未进入提示词：${pair.topic}`);
    // 好范例自己必须守规矩：不以祈使词开头。
    for (const opener of IMPERATIVE_OPENERS) {
      assert.ok(!pair.good.startsWith(opener), `好范例不能以「${opener}」开头：${pair.topic}`);
    }
  }
  // 至少有一组坏范例示范了祈使开头这个具体毛病。
  assert.ok(
    EXAMPLE_PAIRS.some((pair) => IMPERATIVE_OPENERS.some((opener) => pair.bad.startsWith(opener))),
    "应有坏范例直接示范祈使开头",
  );
});

test("closeout prompt keeps the unchanged output contract, limits, and Re-entry budget", () => {
  const prompt = buildCloseoutPrompt({ materials: "材料" });
  assert.ok(prompt.includes('{"episodes":[{"body":"2-6 sentences"}],"self_note":"or empty","reentry_draft":"or empty"}'));
  assert.match(prompt, /at most 2 episodes, at most 1 self-note, one Re-entry draft/);
  assert.match(prompt, /Zero output is valid/);
  assert.match(prompt, /at most 300 non-whitespace characters/);
  assert.match(prompt, /Re-entry authoring mode: ai_direct\./);
  assert.match(
    buildCloseoutPrompt({ materials: "材料", authoringMode: "system_materials_then_ai" }),
    /Re-entry authoring mode: system_materials_then_ai\./,
  );
});

test("closeout prompt embeds persona and materials, and omits the persona block when absent", () => {
  const withPersona = buildCloseoutPrompt({ persona: "persona 源", materials: "过滤后的材料" });
  assert.match(withPersona, /PERSONA SOURCE:\npersona 源/);
  assert.match(withPersona, /FILTERED MATERIALS:\n过滤后的材料/);
  const withoutPersona = buildCloseoutPrompt({ materials: "过滤后的材料" });
  assert.ok(!withoutPersona.includes("PERSONA SOURCE"));
  assert.match(withoutPersona, /FILTERED MATERIALS:\n过滤后的材料/);
});

test("authorCloseout hands the constitution prompt to the runtime and keeps the candidate shape", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-closeout-letter-"));
  const promptFile = path.join(root, "persona.md");
  fs.writeFileSync(promptFile, "persona 源", "utf8");
  let captured = null;
  const result = await authorCloseout({
    runtimeAdapter: {
      async runBackgroundTurn(payload) {
        captured = payload;
        return JSON.stringify({
          episodes: [{ body: "那天她说先不管了，我们就真的没再管。" }, { body: "第二件事" }, { body: "溢出的第三件" }],
          self_note: "我抢跑了一下。",
          reentry_draft: "昨天停在她那句先不管了。",
        });
      },
    },
    config: {
      workspaceRoot: root,
      runtime: "claudecode",
      claudeModel: "fixture",
      weixinInstructionsFile: promptFile,
      reentryAuthoringMode: "ai_direct",
    },
    materials: "过滤后的事实材料",
  });
  assert.ok(captured.text.includes(CLOSEOUT_OPENING));
  assert.match(captured.text, /过滤后的事实材料/);
  assert.equal(captured.workspaceRoot, root);
  // 产出结构不变：至多 2 条 Episode，Self-note 与 Re-entry 各一条。
  assert.equal(result.episodes.length, 2);
  assert.equal(result.self_note, "我抢跑了一下。");
  assert.equal(result.reentry_draft, "昨天停在她那句先不管了。");
});
