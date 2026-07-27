```{=html}
<div align="center">
```

# Cyberboss Telegram Memory

**关系连续性记忆 · Relationship Continuity Memory**

基于 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek) 的 Telegram + 关系记忆扩展。
真实密钥永不入库；历史安全状态以 secret audit 为准。

```{=html}
</div>
```

```text
Status: active
Authority: stable architecture
Scope: 项目定位、北极星判据、记忆理念、文档地图
Current status: docs/CURRENT_STATUS.md
```

> [\!IMPORTANT]
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

> **记忆成功 \= 它主要改变下一句话的姿态；记忆失败 \= 它替 AI 决定下一句话的内容。**

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

**写入权唯一**：每份文件只有一个写入者，谁写什么见 [`docs/architecture/MEMORY.md`](./docs/architecture/MEMORY.md) 第 7 节。Auto Review 是海关不是编辑 —— 它核对来源、冲突、重复、长度、安全与格式，不按"重要性"替主体筛选，也不改写 AI 的措辞。

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
| --- | --- | --- |
| 1 | [`CLAUDE.md`](./CLAUDE.md) | AI 协作入口：硬约束、测试陷阱、改动收尾纪律 |
| 2 | [`docs/CURRENT_STATUS.md`](./docs/CURRENT_STATUS.md) | **唯一的当前进度真相**：能力表、Gate、能不能切生产 |
| 3 | [`docs/architecture/SYSTEM_OVERVIEW.md`](./docs/architecture/SYSTEM_OVERVIEW.md) | 系统怎么走：消息路径、三种身份、上下文分档 |
| 4 | [`docs/DECISIONS.md`](./docs/DECISIONS.md) | 当前有效的决定，以及被取代的决定 |
| 5 | 领域文档（见下） | 具体那一块的稳定结构 |
| 6 | 真实源码与测试 | — |

### 领域文档：什么任务读哪一份

不要按标题猜，按**你手上的活**对号入座。

| 你要做的事 | 去读 | 类型 |
| --- | --- | --- |
| 改 Re-entry / Current State / Episode 的读写；判断某条记忆该不该进上下文；新增一个 writer 前确认写入权 | [`docs/architecture/MEMORY.md`](./docs/architecture/MEMORY.md) | 稳定架构 |
| 改生产机启动脚本、release descriptor、watchdog、计划任务；准备切换或回滚一个 release | [`docs/architecture/WINDOWS_RUNTIME.md`](./docs/architecture/WINDOWS_RUNTIME.md) | 稳定架构 |
| 改 520 面板的任何写端点、上下文分层开关、提示词编辑、八维页；想解冻某个冻结端点 | [`docs/520_CONSOLE.md`](./docs/520_CONSOLE.md) | 稳定架构 |
| 改 Telegram 收图片 / 语音 / 文件的处理，或 `<media>` 引用与 state media 落盘 | [`docs/TELEGRAM_MEDIA_RUNTIME.md`](./docs/TELEGRAM_MEDIA_RUNTIME.md) | 稳定架构 |
| 动 lane 隔离、turn gate、profile 路由、同一 chat 多 topic 的会话归属 | [`docs/TELEGRAM_ROUTE_LANES_V2.md`](./docs/TELEGRAM_ROUTE_LANES_V2.md) | 稳定架构 |
| 配置生产机开机自启、查看或取消 520 与 watchdog 的计划任务 | [`docs/WINDOWS_SILENT_STARTUP.md`](./docs/WINDOWS_SILENT_STARTUP.md) | 稳定架构 |
| 新增 / 修改**聊天里的斜杠命令**（`/effort`、`/compact` 等）或**终端命令**（`cyberboss start`、`login`、`doctor` 等），或想知道模型能调的 project tools 有哪些 | [`docs/commands.md`](./docs/commands.md) | 稳定架构 |
| 想搞清楚"自动召回为什么暂缓"、Phase 5B 的边界在哪、以后要开需要什么证据 | [`docs/SOFT_RETRIEVAL.md`](./docs/SOFT_RETRIEVAL.md) | **补充材料** |

关于命令，三个面各有归属，不要找错地方：

| 面 | 例子 | 在哪 |
| --- | --- | --- |
| 聊天斜杠命令 | `/effort`、`/compact`、`/help` | `docs/commands.md`；注册表在 `src/core/command-registry.js` |
| 终端命令 | `cyberboss start` / `login` / `doctor` / `shared status` | `docs/commands.md` 的 Terminal Commands 一节 |
| 520 的 HTTP 端点 | `/api/context-gates`、`/api/runtime-prompt/save` | **不在 `commands.md`**，在 [`docs/520_CONSOLE.md`](./docs/520_CONSOLE.md) |

> ⚠️ **命名陷阱**：`docs/commands.md` 里聊天命令那一节叫 "WeChat Commands"，`command-registry.js` 里的键也叫 `weixin` —— 这是从上游继承的**历史名字**。实际生效的通道是 **Telegram**：`command-registry.js` 渲染聊天命令清单时读的就是 `action.weixin`。看到 `weixin` 不要以为那段代码与本项目无关。

**「稳定架构」是当前结构说明，可以据此动手；「补充材料」只是研究与证据，不代表已实现、也不是已批准的决定。** 每份文档顶部都标了自己的类型，以文件顶部为准。

## 八、给执行模型

1. 先读 `CLAUDE.md` 与 `docs/CURRENT_STATUS.md`，**不要先做全仓审计**；
2. 只读任务相关的领域文档与源码。正在读第五个跟任务无关的文件时，停下来；
3. 每阶段交付 diff、实际测试（说明在什么平台跑的）、Context Trace、writer 变化与回滚方法；
4. 收尾按 `CLAUDE.md` 第七节：更新 `CURRENT_STATUS.md` 对应的那一行，其余文档能不动就不动；
5. 暂缓项即使"顺手就能做"也不得进 diff。当前暂缓清单在 `docs/CURRENT_STATUS.md`，不在这里。

## 九、分支与隐私

`main` 是唯一主干，`fix/*` 合并后即删，`audit/*` 作为留痕保留。**合并进 main ≠ 批准切生产。** 分支纪律与死分支判定见 [`CLAUDE.md`](./CLAUDE.md) 第八节，这里不复制。

真实 token、会话、日志、私人 Episodes、Self-notes、Portrait、Desire live state、PID、缓存与 lock 文件永不提交 Git。`runtime/`、`memory/`、`settings/secrets/*.local.json` 不在版本控制内，`deployment/current.json` 与 `runtime/` 按机器不同、不跨机同步。

**公开仓库的其他分支也不是私密空间。**

## 十、上游与参照

运行时源自 [`AngeliaSama/cyberboss-deepseek`](https://github.com/AngeliaSama/cyberboss-deepseek)。同方向的 [`Yinglianchun/Haven-Ombre`](https://github.com/Yinglianchun/Haven-Ombre) 与 [`limen-threshold/anchor-memory`](https://github.com/limen-threshold/anchor-memory) 提供了召回纪律和记忆写作方面的参照。多个项目出现相似结构，说明它们面对了相似问题，但不替代本项目自己的运行验证。

* * *

*这套系统不替 AI 决定说什么；它只让过去有机会改变此刻说话的分寸。*

*记忆像家具，让人自然绕着走，而不是让人默背家规。*

*每次醒来，它拥有的不是设定——是发生过的事。*
