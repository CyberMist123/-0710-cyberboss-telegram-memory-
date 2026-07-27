# CLAUDE.md

给 AI 协作者的入口。**本文件不写状态、不写日期、不写 SHA** —— 那些只在 `docs/CURRENT_STATUS.md`。
本文件只回答两件事：这个项目为什么存在，以及动手前必须知道的硬约束。

Cyberboss Telegram Memory：Telegram 侧的关系连续性记忆系统，生产机是一台长期开机的 Windows。约 518 个跟踪文件、`src` \+ `scripts` \+ `extensions` 近 5 万行、85 个测试文件 —— 不要试图通读，按下面的路径定位。

* * *

## 一、读取顺序

```text
1. CLAUDE.md              ← 你在这里
2. docs/CURRENT_STATUS.md ← 现在做到哪、能不能切生产
3. docs/architecture/SYSTEM_OVERVIEW.md ← 系统怎么走的
4. 任务相关的领域文档（见下表）
5. 真实源码与测试
```

**不需要先做全仓审计。** 上面四步是地图，不是全部知识；地图告诉你接下来该读哪几条路。

按任务大小取范围：

| 任务 | 读什么 |
| --- | --- |
| 小改（一个命令、一个测试） | 1 \+ 2 \+ 相关源码测试 |
| 单领域（如修 memory context 通路） | 1 \+ 2 \+ 3 \+ 该领域架构文档 \+ 源码测试 |
| 跨领域（如统一 closeout / nightly / Windows 计划任务） | 全部四层 \+ 相关生产脚本 |

* * *

## 二、这个项目为什么存在

常见记忆系统解决**信息连续性**：存下对话，按相似度召回。本项目先解决更前面的一步 —— **主体连续性**：让一个每天只活一天的存在，能给明天的自己留下自己的笔迹。

完整理念见 `README.md` 第一至三节。动代码前你至少要接受下面七条，它们不是风格偏好，是这套系统的地基：

1. **主 Chat 是人格与调度中心。** 它不是一个转发器，路由和会话管理服务于人格的连续，不是反过来。
2. **记忆改变姿态，不替 AI 写台词。** 北极星判据：记忆成功 \= 主要改变下一句话的**姿态**（语气、分寸、确定度、什么时候沉默）；记忆失败 \= 它替 AI 决定下一句话的**内容**。检验方法是删除测试：拿掉这条记忆，改变的是分寸还是信息？
3. **她此刻的话大于旧档。** 旧画像不能覆盖用户现在说的话。需要确认时在自然对话里顺口求证，不要把用户放进后台审批队列。
4. **Chat 省 Token 不能以丢失人格、记忆访问和行动能力为代价。** 上下文预算是约束，不是可以牺牲主体性的借口。砍注入前先问：砍掉后 AI 还是不是同一个。
5. **Work 过程应隔离，结果胶囊回主 Chat。** 长任务的中间过程不污染主对话；回来的应该是结论，不是过程日志。
6. **单 writer，fail\-open。** 每份文件只有一个写入者（见 SYSTEM\_OVERVIEW 的写入权表）。记忆链全程 fail\-open：宁可本轮失忆，不可本轮失联。
7. **文件存在不代表已接生产。** 这条被违反的次数最多。`src/` 里有个文件、`test/` 里有个测试，都不说明生产机上跑着它。判断只看 `docs/CURRENT_STATUS.md` 的能力表。

出现下列任一情况，停下来记录，不要"顺手修好"：同一文件出现第二个 writer；Re\-entry 注入字数持续上涨；Context Trace 无法解释实际上下文；Review 开始改写措辞；520 出现绕过 Review 的写路径；回复中出现无来源的"我记得"；"默认隐藏"被实现成"无法查询"。

* * *

## 三、跑测试：先读这段，否则会误判

Node ≥ 22。**没有 `npm test`**，测试按 `npm run test:*` 分组，完整列表见 `package.json`。

三个会让你把红当绿、或把绿当过的陷阱：

1. **非 Windows 机器上**，调 `powershell.exe` 的测试有 `{ skip: !IS_WINDOWS }` 守卫，本机显示诚实的 skip —— 真实信号只来自 windows\-latest CI 或真 Windows 机。新增这类测试必须复用 `assertFailedClosed`（先证进程真的跑了），不要裸写 `assert.notEqual(status, 0)` —— ENOENT 会让它恒真。
2. **Python 需 ≥ 3.10。** `watchdog.py` 有 `from __future__ import annotations` 与启动版本守卫：低版本可导入、但启动时带明确诊断 fail\-closed。CI 有 3.9 探针守这个行为。
3. **本地跑绿 ≠ 有 CI 信号。** 主 CI 只执行六个分组（`test:phase1` / `phase2` / `phase3` / `phase4` / `phase5a` / `orchestration`），85 个测试文件里只有 37 个在其中。改代码前先确认你的测试在不在 CI 里；不在的话，本地跑绿只是你一个人知道。缺口清单见 `docs/CURRENT_STATUS.md` 的 P0\-2。

跑完请说明**在什么平台跑的**。

* * *

## 四、硬性禁止

- **这是公开仓库。** 所有分支都不是私密空间。
- 永不提交：真实 token、会话、日志、私人 Episodes / Self\-notes / Portrait、Desire live state、PID、缓存、lock。对应目录 `runtime/`、`memory/`、`settings/secrets/*.local.json` 均不在版本控制内，保持这样。
- `deployment/current.json` 与 `runtime/` **按机器不同**，不要跨机同步。
- `vendor/` 是上游拷贝，不要在里面改东西。
- **暂缓项即使"顺手就能做"也不得进 diff。** 当前暂缓清单见 `docs/CURRENT_STATUS.md`，不看 README —— README 不再维护暂缓状态。
- **520 不是只读面板。** 它能改生产运行时提示词、上下文分层、注入门控与 Desire 调度。改 `dashboard.py` 的写端点等于改生产行为，尤其 `FROZEN_WRITE_ENDPOINTS`：那七个端点被冻结是**当前生效的设计**，解冻任何一个之前先证明它不会绕过 Review。边界见 `docs/architecture/SYSTEM_OVERVIEW.md` 第六节。
- **候选与正式分离是全局禁区。** 任何路径都不许让外部直接写 `episodes.jsonl` 正式文件。

## 五、分支

`main` 是唯一主干；`fix/*` 单一问题，合并后即删；`audit/*` 只加报告、不改被审代码，作为留痕保留。

**合并进 `main` ≠ 批准部署。** 放行判据见 `docs/CURRENT_STATUS.md` 第五节。

判断一个分支还有没有活儿：

```bash
git rev-list --left-right --count origin/main...<分支>
```

`ahead=0` 意味着它的每个提交都已在 `main` 里 —— 死分支，删掉，不要再往里做事。

* * *

## 六、目录速查

| 路径 | 内容 |
| --- | --- |
| `src/core/app.js` | 启动编排与命令处理，主链的中枢 |
| `src/core/hard-context.js` | Re\-entry / Current State / memory\_context 三门装配 |
| `src/core/route-lane.js` | 路由 lane 决策 |
| `src/adapters/channel/telegram.js` | Telegram 通道适配器 |
| `src/adapters/runtime/claudecode/` | Claude Code 子进程适配器、launch profile、session slot |
| `src/continuity/` | Closeout / Janitor / Review / History writer |
| `src/services/memory-lookup-service.js` | Phase 5A 受控翻档 |
| `src/orchestration/release-manifest.js` | manifest 生成与校验 |
| `scripts/orchestration/release-control-plane.js` | 发布控制平面：描述符与启动件安装 |
| `scripts/windows/runtime-startup/` | 生产机 PowerShell 入口 —— **改这里最危险** |
| `extensions/relationship-memory/` | 记忆内核与 520 面板；watchdog 在 `launcher/watchdog.py` |
| `test/` | 85 个测试文件 |

领域文档：

| 想知道 | 去读 |
| --- | --- |
| 系统整体怎么走 | `docs/architecture/SYSTEM_OVERVIEW.md` |
| 记忆：谁读、谁写、什么进上下文 | `docs/architecture/MEMORY.md` |
| Windows 生产启动 / descriptor / watchdog / 回滚 | `docs/architecture/WINDOWS_RUNTIME.md` |
| 520 的职责与边界 | `docs/520_CONSOLE.md` |
| 暂缓的自动召回路线 | `docs/SOFT_RETRIEVAL.md` |
| 当前进度、P0、能不能切生产 | `docs/CURRENT_STATUS.md` |

`docs/archive/` 下的内容是历史，**不要据此判断当前状态**。审计报告在 `docs/audit/`，每份顶部标注了它审的是哪个 SHA —— 审计结论只对那个 SHA 有效。

## 七、改动收尾：让下一个 Agent 不用重新审计

这一节是纪律，不是建议。不做，下一个 Agent 就得把你做过的事重新查一遍。

### 每次改动结束，必须做的三件事

1. **更新 `docs/CURRENT_STATUS.md` 里对应的那一行** —— 只改那一行。不要顺手改 README、CLAUDE.md 或架构文档：它们里没有状态结论可改，这是刻意的。
2. **如果改的是稳定结构**（谁调用谁、谁写什么、注入分几档），更新 `docs/architecture/` 下对应那一份。行为变了才改，进度变了不改。
3. **如果这次改动使某份历史文档失效**，在它顶部加标记，不要删：

```text
Status: historical
Audited commit: <SHA>
Current status: see docs/CURRENT_STATUS.md
```

Handoff 类文档用 `Status: active / completed / superseded` \+ `Base SHA` \+ `Result`。任务完成即标 `completed` 或移进 `docs/archive/`。**Agent 默认不读 `docs/archive/`**，除非正在调查历史原因。

### PR 描述必须回答

```text
Affected areas:
- [ ] Telegram / route lane
- [ ] Memory read
- [ ] Memory write
- [ ] 上下文预算 / 注入分档
- [ ] Windows runtime
- [ ] 520
- [ ] Desire
- [ ] CI only
- [ ] Docs only

Does CURRENT_STATUS need updating?
Does architecture documentation need updating?
Does this change production wiring?
```

绝大多数小 PR 三问全是「否」，那就一个字都不用改文档。**这个模板的价值在于让「否」变成一次显式判断，而不是一次遗忘。**

### 全仓审计只在三个时机做

1. 准备切生产；
2. 做了跨三个以上领域的架构调整；
3. `CURRENT_STATUS.md` 与实际代码出现明显冲突。

**其余情况只做任务相关检查。** 如果你正在读第五个跟任务无关的文件，停下来 —— 你多半在做一次没人要求的审计。

### 积木原则：加 / 减一个能力时改哪几处

这套文档结构是为了让功能能像积木一样拆装。加一个能力，按顺序回答：

1. **它落在哪一档？** 常驻注入 / 目录式 / 完全按需（见 `SYSTEM_OVERVIEW` 第四节）。默认落第三档 —— 提到第一档要有理由。
2. **它有没有新的 writer？** 如果写了某个已有 writer 的文件，停 —— 单 writer 是硬约束。
3. **它的测试进哪个 `npm run test:*` 分组？** 不进分组 \= 无 CI 信号。新分组要同时接进 `phase1-offline.yml`。
4. **它需要生产接线吗？** 需要就在 `CURRENT_STATUS` 的「生产接线」列写 `未核`，等真机留证再改。
5. **它默认开还是默认关？** 新能力默认关，用显式 env 开关，`readStrictBoolEnv(..., false)`。

减一个能力同理，倒着走一遍，最后确认 `CURRENT_STATUS` 里那一行被删掉而不是留成 ✅。
