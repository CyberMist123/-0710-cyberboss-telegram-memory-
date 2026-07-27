<div align="center">

# Cyberboss Telegram Memory

**关系连续性记忆 · Relationship Continuity Memory**

基于 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek) 的 Telegram + 关系记忆扩展。
【现已上传所有api key已失效，懒得改设置了】

</div>
> [!IMPORTANT]
> **这份 README 不写当前进度。** 项目做到哪一步、哪些能力已接生产、能不能切生产，只看 [`docs/CURRENT_STATUS.md`](./docs/CURRENT_STATUS.md)。
> README 讲的是这个项目是什么、为什么这样设计 —— 这些几个月不会变。进度每周都在变，两处都写必然分叉。

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

> 这里只给最小骨架。完整调用链、三种身份、上下文分档与各领域入口见 [`docs/architecture/SYSTEM_OVERVIEW.md`](./docs/architecture/SYSTEM_OVERVIEW.md)。

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

按这个顺序读，不需要先做全仓审计：

| 顺序 | 文档 | 回答什么 |
|---|---|---|
| 1 | [`CLAUDE.md`](./CLAUDE.md) | AI 协作入口：硬约束、测试陷阱、改动收尾纪律 |
| 2 | [`docs/CURRENT_STATUS.md`](./docs/CURRENT_STATUS.md) | **唯一的当前进度真相**：能力表、P0/P1、能不能切生产 |
| 3 | [`docs/architecture/SYSTEM_OVERVIEW.md`](./docs/architecture/SYSTEM_OVERVIEW.md) | 系统怎么走：消息路径、三种身份、上下文分档 |
| 4 | 领域文档（见下） | 具体那一块的稳定结构 |
| 5 | 真实源码与测试 | — |

领域文档：

| 想知道 | 去读 |
|---|---|
| 记忆：谁读、谁写、什么进上下文 | [`docs/architecture/MEMORY.md`](./docs/architecture/MEMORY.md) |
| Windows 生产启动 / descriptor / watchdog / 回滚 | [`docs/architecture/WINDOWS_RUNTIME.md`](./docs/architecture/WINDOWS_RUNTIME.md) |
| 520 的职责与边界 | [`docs/520_CONSOLE.md`](./docs/520_CONSOLE.md) |
| 暂缓的自动召回与研究路线 | [`docs/SOFT_RETRIEVAL.md`](./docs/SOFT_RETRIEVAL.md) |
| Telegram 媒体运行时契约 | [`docs/TELEGRAM_MEDIA_RUNTIME.md`](./docs/TELEGRAM_MEDIA_RUNTIME.md) |
| Telegram route lanes v2 | [`docs/TELEGRAM_ROUTE_LANES_V2.md`](./docs/TELEGRAM_ROUTE_LANES_V2.md) |
| Windows 静默自启、状态与取消 | [`docs/WINDOWS_SILENT_STARTUP.md`](./docs/WINDOWS_SILENT_STARTUP.md) |
| 命令清单 | [`docs/commands.md`](./docs/commands.md) |

**历史材料**：`docs/audit/` 是审查报告（每份顶部标注它审的是哪个 SHA，结论只对那个 SHA 有效），`docs/archive/` 是已失效的过程记录。**Agent 默认不读 `docs/archive/`**，除非正在调查历史原因。

根目录只保留本文件与 `CLAUDE.md` / `AGENTS.md`，其余文档一律在 `docs/` 下。上游继承的两份叙事 README（`README.en.md` / `README.zh-CN.md`，描述的是微信桥接）已删除 —— 它们与本项目（Telegram）不符，需要时从历史提交 `c41f9bd` 取回。

## 八、给执行模型

1. 先读 `CLAUDE.md` 与 `docs/CURRENT_STATUS.md`，**不要先做全仓审计**；
2. 只读任务相关的领域文档与源码。正在读第五个跟任务无关的文件时，停下来；
3. 每阶段交付 diff、实际测试（说明在什么平台跑的）、Context Trace、writer 变化与回滚方法；
4. 收尾按 `CLAUDE.md` 第七节：更新 `CURRENT_STATUS.md` 对应的那一行，其余文档能不动就不动；
5. 暂缓项即使"顺手就能做"也不得进 diff。当前暂缓清单在 `docs/CURRENT_STATUS.md`，不在这里。

## 九、分支与隐私

| 分支 | 用途 |
|---|---|
| `main` | 唯一主干。**合并进 main ≠ 批准切生产**，放行判据见 `docs/CURRENT_STATUS.md` |
| `fix/*` | 单一问题的修复分支，从 main 切出，合并后即删 |
| `audit/*` | 只读审查产出，只加报告文件、不改被审代码，作为留痕保留 |

规矩：

- 动手前先跑 `git rev-list --left-right --count origin/main...<分支>`。`ahead=0` 意味着该分支的每个提交都已在 main 里 —— 死分支，删掉即可，不要再往里做事。
- 合并后立刻删分支。留着已合并的分支会让人（和 AI）误以为还有未交付的工作。

真实 token、会话、日志、私人 Episodes、Self-notes、Portrait、Desire live state、PID、缓存与 lock 文件永不提交 Git。`runtime/`、`memory/`、`settings/secrets/*.local.json` 不在版本控制内，保持这样。`deployment/current.json` 与 `runtime/` 按机器不同，不要跨机同步。

**公开仓库的其他分支也不是私密空间。**

## 十、上游与参照

运行时源自 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek)。同方向的 [`Yinglianchun/Haven-Ombre`](https://github.com/Yinglianchun/Haven-Ombre) 与 [`limen-threshold/anchor-memory`](https://github.com/limen-threshold/anchor-memory) 提供了召回纪律和记忆写作方面的参照。多个项目出现相似结构，说明它们面对了相似问题，但不替代本项目自己的运行验证。

---

*这套系统不替 AI 决定说什么；它只让过去有机会改变此刻说话的分寸。*

*记忆像家具，让人自然绕着走，而不是让人默背家规。*

*每次醒来，它拥有的不是设定——是发生过的事。*
