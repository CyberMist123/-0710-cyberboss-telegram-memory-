# Decisions

> **这份文件记录当前有效的决定，以及被翻转过的决定。**
> 它不记录进度（那在 `CURRENT_STATUS.md`），也不记录结构（那在 `docs/architecture/`）。
> 存在的理由：这个项目的决定翻转过好几次，没有这份清单，下一个 Agent 只能从 Design、Review、Handoff 和 issue 时间线里猜。
>
> 规则：一条决定改变时，**在原条目上标 `已翻转` 并新增一条**，不要原地改写。翻转本身是信息。

---

## D1 · 生产机单后端，Windows 是唯一 owner

**有效。** Windows 机长期开机充当服务器。跨机同步 `deployment/current.json` 或 `runtime/` 暂时不做。

## D2 · 状态真相唯一：`docs/CURRENT_STATUS.md`

**有效。** README、`CLAUDE.md`、架构文档都不写「做到哪一步 / 能不能切生产」，只链接过去。同一结论写在多处必然分叉 —— 这是本项目已经发生过的事故，不是假设。

## D3 · 合并进 `main` ≠ 批准部署

**有效。** 放行判据只在 `CURRENT_STATUS.md` 第五节。审计报告的结论只对它审的那个 SHA 有效。

## D4 · 单 writer；记忆链 fail-open

**有效。** 每份文件只有一个写入者（写入权表见 `docs/architecture/SYSTEM_OVERVIEW.md`）。同一文件出现第二个 writer 是一级腐化信号。

链路全程 fail-open：**宁可本轮失忆，不可本轮失联。**

## D5 · 候选与正式分离是全局禁区

**有效。** 任何路径都不许让外部直接写 `episodes.jsonl` 正式档。520 的 API 桥因此冻结了 `/api/save`、`/api/state_log`、`/api/episode_candidate`、`/api/janitor/run`、`/api/config` 五个端点。

（同名单里的两个 `care` 端点是前端未接完，不属于本条决定。）

## D6 · 记忆检索用纯规则槽位，不用 embedding / 相似度

**有效。** `memory-intent-classifier.js` 用正则表决定六个槽位（`identity` / `relationship` / `preference` / `project` / `pattern` / `pending_promise`），`memory-resolver.js` 据此选 `skip` / `state_only` / `targeted`。

选择理由是便宜、可解释、可测试。自动 Soft Retrieval、embedding 召回、BM25、reranker、GraphRAG 属 Phase 5B，**暂缓**。

注：`src/services/embedding-service.js` 存在且被 `app.js` 调用 —— 这与本条的边界关系待裁决，见 `CURRENT_STATUS.md` P1-4。

## D7 · 默认隐藏 ≠ 不可查询；只开放 `user_pull` 一种翻档

**有效。** Episodes 及下游旧档默认不进普通对话上下文。用户明确寻找旧事时，AI 可通过 `memory_lookup` 受控查询。

AI 自己因共鸣、利害或修复需要主动翻档，**仍是设计候选，未开放** —— 必须等真实 `why_now`、查询日志与翻错案例。后续可考虑增加模糊检索，但现在不做。

## D8 · 不许向上摸目录找根

**有效。** `start-telegram.ps1` / `start-dashboard.ps1` 删除祖先回溯，`CYBERLINK_ROOT` 必填并校验；`watchdog.py` 删除 `DEFAULT_DESCRIPTOR`，`--descriptor` 必填。

来源是 R4 F4：祖先回溯让一个诱饵目录就能决定被执行的 Python 文件与密钥路径。

## D9 · Telegram 送给模型的信封是明文

**有效。** `formatTelegramRuntimeText()` 产出 `<channel source="telegram" …>` 信封 + 用户原文 + `<media>` 引用。用户打的字就是模型读到的字，只转义可能提前闭合信封的序列。
后续考虑把对话脱水成md格式，只留简写工具调用，作为记忆检索等材料。

**这条与 G1（memory_context 断链）耦合**：修 G1 时改的是同一段代码，必须显式决定 memory_context 拼在信封哪一侧，并配一条钉住信封格式的测试。见 `CURRENT_STATUS.md` P0-1。

## D10 · 旧 launch-profile plumbing / selector 分支不倒灌 `main`

**有效。** 该方向已被 main 的 route lanes v2 超集重写替代。仓库与工作区不存在等待集成的 launch-profile 补丁，origin 上没有对应分支。**历史分支不得 cherry-pick 回 main。**

d11删了，感觉没用。

## D12 · 暂缓项清单只在 `CURRENT_STATUS.md`（**已翻转**）

**原做法：写在 README 的「明确暂缓，不得顺手实现」一节。** 该清单与实际代码出现过五处冲突（语音、天气、经期/关怀、剧场、embedding），已随本次文档收口从 README 移除。

**现规则：README 不参与能力状态判定。README 是宪法级不变文件。** 暂缓与否只看 `CURRENT_STATUS.md`。

---

## 待裁决

下列是**尚未做出**的决定，不要当成已定：

- 语音 / 天气 / embedding：承认已实现，还是承认越界撤掉？（`CURRENT_STATUS.md` P1-4）做了一半，备注即可，
- 后台 memory owner 与 nightly closeout 的边界；nightly 三个开关何时默认开启。
- 子代理运行时是否接 Codex；子代理输出如何胶囊化。待考察
- 多 Bot、Route 1 / Route 2、Apple Watch、CMX —— 当前一律 DEFERRED，未排期。
