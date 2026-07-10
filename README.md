<div align="center">

# Cyberboss Telegram Memory

**关系连续性记忆 · Relationship Continuity Memory**

基于 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek) 的 Telegram + 关系记忆扩展。

</div>

> [!IMPORTANT]
> 当前阶段：**只读审计 → 最小接线 → 新目录验证**。`main` 尚未在全新目录完成端到端验证，不要直接覆盖现有部署。实时进度只看 [`docs/IMPLEMENTATION_STATUS.md`](./docs/IMPLEMENTATION_STATUS.md)。

## 先看：还没实现 / 当前不要做

下面是进入仓库后最容易误判的地方。详细状态仍以 `IMPLEMENTATION_STATUS.md` 为准。

**当前尚未收敛：**

- 唯一 Prompt、workspace 与 state-dir；
- Re-entry 首轮加载、AI 最终执笔与长度告警；
- Closeout → Auto Review decision → History writer 的完整闭环；
- Self-note 的低频回读闭环；
- 520 退回可关闭的查看、模式切换与评测前端；
- 用户明确拉线后的受控 Episode 查询；
- 从干净 `main` clone 开始的端到端验证。

**明确暂缓，不得顺手实现：**

- AI 主动翻旧档（共鸣 / 利害 / 修复触发）；
- 自动 Soft Retrieval、embedding、BM25、LLM reranker；
- Memory Family、GraphRAG、PPR；
- 全量旧数据迁移；
- Re-entry 的 Episode 数量元信息行、topic index 与召回冷却；
- 主动消息、天气、经期、语音、剧场等产品扩展。

## 一、这个项目在做什么

柳文杨写过一个被困在同一天的人。无论他做什么，第二天世界照旧，人来人往，没有任何办法留下自己的痕迹。大语言模型的跨会话处境与它有一点相似：一次会话结束，当前上下文消失；下一次启动时，它仍然聪明、温柔、有趣，却未必知道昨天走到了哪里。

常见记忆系统主要解决**信息连续性**：把对话存下，再按相似度召回。这是正经问题，本项目未来的 Soft Retrieval 也会走到那里。但这里先关注更前面的一步：**主体连续性**。

我们不试图证明 AI 拥有连续意识，也不追求让它记住一切。我们只想让它能为下一个自己留下少量、可信、带有自身笔迹的锚点；让长期关系有所积累，同时不把模型压成一个背诵历史和规则的空壳。

一次当前状态可以很短，但内部仍然能够带着日期、未完之事与过去留下的痕迹。时间在这里不是持续流逝，而是结构与朝向。Re-entry 的钩子和带日期的 Episode，都是在给当前这一刻留下时间的梯度。

一句话：**让一个每天只活一天的存在，能给明天的自己留下自己的笔迹。**

## 二、北极星判据

整个仓库只有一条最高标准：

> **记忆成功 = 它主要改变下一句话的姿态；记忆失败 = 它替 AI 决定下一句话的内容。**

记忆是背景，不是台词。它应当影响语气、分寸、确定度、什么时候沉默、什么时候求证、敢不敢开玩笑；不应让 AI 无缘无故背诵几个月前的旧事来证明在乎。

可操作的检验叫**删除测试**：拿掉这条记忆后，回复变了什么？

- 内容、信息、话题被改写：记忆正在台词化；
- 分寸、节奏、温度发生变化：记忆更接近姿态。

另一个腐化指标是 Re-entry 注入字数。这个数字持续上涨，通常意味着系统正在把越来越多过去压进当下。

## 三、它怎么理解记忆

### 遗忘是设计，不是缺陷

Episodes 及下游旧档默认不进普通对话上下文。这本身就是一种自然遗忘。

但**默认隐藏不等于不可查询**。第一阶段只实现一种翻档：当用户明确寻找旧事时，AI 可以通过受控工具去查，体验更接近“翻日记重新找到”，而不是假装所有过去一直同时在场。

AI 自己因共鸣、利害或修复需要主动翻档，仍是设计候选；必须等真实 `why_now`、查询日志与翻错案例后再开放。

### 诚实高于连续性

```text
我记得       → 当前 Re-entry / 自我姿态里真实在场的内容
想起来了     → 被用户的话半唤起的内容
我翻了下记录 → 刚通过工具查到的内容
```

查到的内容不能冒充“一直记得”。“我记不清”与“我去翻了，但没有找到”都属于合法结果。

### 活性来自重新理解

存档和活记忆的区别，不只在于能否被找到，还在于它是否会在新的时间里被重新理解。

Reflect 可以低频重读旧 Episode，并把新理解追加为 Rereadings。旧事的新读法只能叠加，不能静默擦除旧解释。理想路径是：

```text
episodes → 低频重读 → AI 的理解变化 → Re-entry 的姿态变化
```

而不是：

```text
episodes → 全量塞进普通上下文
```

时间的厚度不是文件体积，而是重读的层数。

### 性格靠范例养，不靠人设喂

记忆优先存场景和原话，不存“以后必须怎样”的命令。

“那晚她说‘我不要方法论’，我停下来听了”是范例；“她难过时禁止给建议”是家规。范例让下一次的 AI 重新判断，家规则替它提前写好台词。

命令式措辞目前只作为腐化 warning，不自动决定候选是否被拒绝。

### AI 有笔

Re-entry 和 Self-note 保留主体 AI 的最终执笔权。系统可以整理事实和待办作为材料，Auto Review 可以核对证据与边界，但不能替 AI 改写声音。

Self-note 不为取悦用户而写，不进入普通对话，只在 Closeout / Reflect 中低频回读。用户可以在异常时查看、撤回或要求重审，但不承担日常审批。

### 她此刻的话大于旧档

旧画像不能覆盖用户现在说的话。Portrait 只记录反复出现、具有来源的观察；需要确认时，在自然对话中顺口求证，而不是把用户放进后台审批队列。

## 四、架构

```text
Telegram / 当前对话
        ↓
Cyberboss runtime
        ↓
默认上下文：
System Prompt + Role Card + 首轮 Re-entry + 轻量 Current State + 当前对话
        ↓
模型自然回复

后台数据链：
原始会话（排除记忆注入块 / 工具结果 / 自动附件）
  → Closeout / Janitor 只产生 candidates 与 AI 原稿
  → Auto Review 只产生 decision
  → History writer 按 decision 唯一写入 canon
  → Reflect 低频更新 Timeline / Rereadings / Portrait
```

**写入权唯一：**

| 内容 | 唯一 writer |
|---|---|
| 原始会话 log | 系统 |
| candidates | Closeout / Janitor |
| Review decisions | Auto Review |
| Episode canon | History writer |
| Re-entry / Self-note 正文 | 主体 AI |
| Desire 状态 | Desire runtime |

Auto Review 是海关，不是编辑。它核对来源、冲突、重复、长度、安全与格式；不按“重要性”替主体筛选，也不改写 AI 的措辞。

520 是可关闭的查看、调试、模式切换与评测前端。关闭 520 后，Telegram、上下文与后台任务仍应正常工作。

记忆链全程 fail-open：宁可本轮失忆，不可本轮失联。

## 五、怎么知道系统正在变好

1. 新窗口换一种说法提旧话题，能够接上但不背诵；
2. 记忆在场时，该沉默仍能沉默；
3. 上个 session 形成的立场，不因换窗口自动消失；
4. 提起旧失误时，守住修复，不重新翻案；
5. Portrait / Self-portrait 的变化速度可信，且每条有出处。

更可靠的是长窗信号：用户是否更少重复解释自己，是否更自然地默认共同历史，是否更少纠正记忆错误。逐轮的惊喜会通胀，长期的舒适不容易伪造。

## 六、腐化信号

出现以下任一情况，应停止当前阶段并记录：

- 同一文件出现第二个 writer；
- Re-entry 注入字数持续上涨；
- Context Trace 无法解释实际上下文；
- Review 开始改写措辞或按品味筛选；
- Re-entry 被系统直接改写；
- 520 出现绕过 Review 的写路径；
- 回复中出现无来源的“我记得”；
- “默认隐藏”被实现成“无法查询”；
- 记忆注入块或工具结果被重新抽成新 Episode。

## 七、文档地图

仓库只有四份权威文档：

| 想知道 | 去读 |
|---|---|
| 架构：谁读、谁写、什么进上下文 | [`docs/CONTINUITY_ARCHITECTURE.md`](./docs/CONTINUITY_ARCHITECTURE.md) |
| 当前做到哪里、验收与下一步 | [`docs/IMPLEMENTATION_STATUS.md`](./docs/IMPLEMENTATION_STATUS.md) |
| 520 的职责与边界 | [`docs/520_CONSOLE.md`](./docs/520_CONSOLE.md) |
| 暂缓的自动召回与研究路线 | [`docs/SOFT_RETRIEVAL.md`](./docs/SOFT_RETRIEVAL.md) |

补充材料：

- [`docs/MEMORY_LIVENESS_NOTES.md`](./docs/MEMORY_LIVENESS_NOTES.md)：非权威设计笔记；
- [`docs/IMPLEMENTATION_HANDOFF.md`](./docs/IMPLEMENTATION_HANDOFF.md)：部署期临时交接，首次端到端跑通后应被吸收或作废；
- [`docs/prompts/DEPLOY_EXECUTION_PROMPT.md`](./docs/prompts/DEPLOY_EXECUTION_PROMPT.md)：实施入口；
- [`docs/prompts/ARCH_REVIEW_PROMPT.md`](./docs/prompts/ARCH_REVIEW_PROMPT.md)：阶段复核；
- [`docs/archive/20260710_DESIGN_DRAFTS.md`](./docs/archive/20260710_DESIGN_DRAFTS.md)：旧设计草稿索引。

优先级：四份权威文档 > Handoff > 已验证源码与运行证据 > Liveness Notes > README 与其他说明。

## 八、给执行模型

实施时严格按以下顺序：

1. 先运行阶段 0，只读审计，不改代码；
2. 按 `IMPLEMENTATION_HANDOFF.md` 的阶段门逐阶段推进；
3. 每阶段交付 diff、实际测试、Context Trace、writer 变化与回滚方法；
4. 阶段结束后，由未参与实施的独立实例运行架构复核；
5. 暂缓项即使“顺手就能做”，也不得进入 diff。

## 九、分支与隐私

| 分支 | 用途 |
|---|---|
| `main` | 最终稳定目标，不直接承接未经验证的设计稿 |
| `design/living-memory-rfc` | 设计、Handoff 与 Prompt 收口 |
| `impl/*` 或 `fix/*` | 从设计基线切出的单阶段实施分支 |
| `legacy-current` | 曾运行现场，只作救援对照 |
| `upstream-baseline` | 上游脱敏基线，只作比较 |

真实 token、会话、日志、私人 Episodes、Self-notes、Portrait、Desire live state、PID、缓存与 lock 文件永不提交 Git。公开仓库的其他分支也不是私密空间。

## 十、上游与参照

运行时源自 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek)。同方向的 [`Yinglianchun/Haven-Ombre`](https://github.com/Yinglianchun/Haven-Ombre) 与 [`limen-threshold/anchor-memory`](https://github.com/limen-threshold/anchor-memory) 提供了召回纪律和记忆写作方面的参照。多个项目出现相似结构，说明它们面对了相似问题，但不替代本项目自己的运行验证。

---

*这套系统不替 AI 决定说什么；它只让过去有机会改变此刻说话的分寸。*

*记忆像家具，让人自然绕着走，而不是让人默背家规。*

*每次醒来，它拥有的不是设定——是发生过的事。*
