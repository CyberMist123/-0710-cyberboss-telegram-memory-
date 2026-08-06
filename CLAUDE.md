# CLAUDE.md

```text
Status: active
Authority: stable architecture
Scope: AI 协作入口 —— 不变量、禁令、阅读路由、文档治理
Current status: docs/CURRENT_STATUS.md
```

本文件是自动加载的入口，**不写状态、不写日期、不写 SHA、不写覆盖数字**。当前做到哪一步只看 `docs/CURRENT_STATUS.md`。

## 一、北极星

Cyberboss Telegram Memory：Telegram 侧的关系连续性记忆系统。目标不是让 AI 记住一切，而是让**一个每天只活一天的存在，能给明天的自己留下自己的笔迹**。

最高判据：

> **记忆成功 = 它主要改变下一句话的姿态；记忆失败 = 它替 AI 决定下一句话的内容。**

检验方法是删除测试：拿掉这条记忆，改变的是分寸（姿态，对）还是信息（台词，错）？

完整理念见 `README.md` 第一至三节。

## 二、读取顺序

```text
1. CLAUDE.md               ← 你在这里
2. docs/CURRENT_STATUS.md  ← 现在做到哪、Gate 状态、能不能切生产
3. docs/architecture/SYSTEM_OVERVIEW.md ← 系统怎么走
4. docs/DECISIONS.md       ← 哪些决定已定、哪些被取代、哪些还没定
5. 任务相关的领域文档
6. 真实源码与测试
```

**不需要先做全仓审计。** 前四步是地图，不是全部知识。

| 任务 | 读什么 |
|---|---|
| 小改（一个命令、一个测试） | 1 + 2 + 相关源码测试 |
| 单领域 | 1 + 2 + 3 + 该领域文档 + 源码测试 |
| 要改一个已有决定 | 1 + 2 + 4，**先确认它是不是 D 系列里的既定决定** |
| 跨领域 | 全部六层 + 相关生产脚本 |

## 三、不可破坏的不变量

1. **主 Chat 是人格与调度中心。** 路由和会话管理服务于人格的连续，不是反过来。
2. **她此刻的话大于旧档。** 旧画像不能覆盖用户现在说的话；需要确认时在对话里顺口求证，不要把用户放进后台审批队列。
3. **省 Token 不能以丢失人格、记忆访问和行动能力为代价。** 砍注入前先问：砍掉后还是不是同一个。零工具 / 零 MCP 是已废弃方案（`DECISIONS.md` D13）。
4. **单 writer。** 每份文件只有一个写入者。同一文件出现第二个 writer 是一级腐化信号。
5. **fail-open。** 宁可本轮失忆，不可本轮失联。
6. **候选与正式分离是全局禁区。** 任何路径都不许让外部直接写 `episodes.jsonl` 正式档。
7. **文件存在不代表已接生产。** 这条被违反的次数最多。判断只看 `CURRENT_STATUS.md` 的能力表。

其他腐化信号：Re-entry 注入字数持续上涨；Context Trace 无法解释实际上下文；Review 开始改写措辞；520 出现绕过 Review 的写路径；回复中出现无来源的"我记得"；"默认隐藏"被实现成"无法查询"。**出现即停下记录，不要顺手修好。**

## 四、安全与生产禁令

- **这是公开仓库。** 所有分支都不是私密空间。
- 永不提交：真实 token、会话、日志、私人 Episodes / Self-notes / Portrait、Desire live state、PID、缓存、lock。`runtime/`、`memory/`、`settings/secrets/*.local.json` 不在版本控制内，保持这样。
- `deployment/current.json` 与 `runtime/` 是**机器状态**，不得跨机同步（`DECISIONS.md` D1）。
- `vendor/` 是上游拷贝，不要在里面改东西。
- **不许向上摸目录找根。** `CYBERLINK_ROOT` 必填并校验，`watchdog.py` 的 `--descriptor` 必填（D8）。
- **520 不是只读面板。** 它能改生产运行时提示词、上下文分层、注入门控与 Desire 调度。`FROZEN_WRITE_ENDPOINTS` 共 7 个：5 个是安全冻结（解冻前必须证明不绕过 Review），2 个 care 端点只是前端未接完。
- **暂缓项即使"顺手就能做"也不得进 diff。** 当前暂缓清单在 `CURRENT_STATUS.md`，不在 README。

## 五、测试陷阱

Node ≥ 22。**没有 `npm test`**，测试按 `npm run test:*` 分组，见 `package.json`。

1. **非 Windows 机器上**，调 `powershell.exe` 的测试有 `{ skip: !IS_WINDOWS }` 守卫，本机显示诚实的 skip —— 真实信号只来自 windows-latest CI 或真 Windows 机。
2. **fail-closed 断言必须先证明进程真的跑过。** 复用 `assertFailedClosed`，不要裸写 `assert.notEqual(status, 0)` —— ENOENT 下它恒真。
3. **Python 需 ≥ 3.10。** `watchdog.py` 有版本守卫，CI 有 3.9 探针守这个行为。
4. **本地跑绿 ≠ 有 CI 信号。** 主 CI 只执行 `.github/workflows/phase1-offline.yml` 里列出的分组，仓库里相当一部分测试不在其中。**改代码前先确认你要跑的测试在不在 CI 里。** 当前覆盖情况见 `CURRENT_STATUS.md`。
5. **一个相关单测进了 CI，不等于这条能力的完整通路有 CI 信号。** 判断通路覆盖用 `CURRENT_STATUS.md` 的状态词典。

跑完请说明**在什么平台跑的**。

## 六、文档治理与收尾

### 文档类型

| 类型 | 顶部标识 | 有没有日期 |
|---|---|---|
| 当前状态（`CURRENT_STATUS.md`） | `Status: active` / `Authority: current project status` / `Last verified` / `Verified against` | **有**日期与 main SHA |
| 稳定架构（本文件、README、`docs/architecture/*`、领域文档） | `Status: active` / `Authority: stable architecture` / `Scope` / `Current status` | 无 |
| 决策（`DECISIONS.md`） | 每条 `Status: ACTIVE / SUPERSEDED / DEFERRED` + `Decision date` | 每条有 |
| 审计 / Handoff | `Status` / `Date` / `Base SHA` 或 `Audited SHA` / `Current authority` | 有 |
| 补充材料（调研、实验、外部资料、未采纳方案） | `Status: supplemental` / `Authority: none` / `Scope` / `Last reviewed` / `Current authority` | 有 |

**状态写在文件顶部，永远不写进文件名。** 文件名加 `[ACTIVE]_` / 日期前缀会制造死链、逼迫改名、断掉 Git 历史与外部引用，还会让 Agent 把文件名当成比正文更高的事实。

### 每次改动结束

1. **更新 `docs/CURRENT_STATUS.md` 对应的那一行** —— 只改那一行，状态词只能取它第二节词典里的值。
2. **做出或取代了一个决定** → 在 `docs/DECISIONS.md` 登记。取代时把原条目标 `SUPERSEDED` 并新增一条，**编号留空缺，不重排**。尚未决定的放 Candidates。
3. **改了稳定结构**（谁调用谁、谁写什么、注入分档）→ 更新 `docs/architecture/` 对应那份。行为变了才改，进度变了不改。
4. **使某份历史文档失效** → 在它顶部标 `completed` / `superseded` / `historical` 并指向当前 authority，**不要删**。
5. **只新增或刷新了证据**（调研、实验、日志、外部材料）→ 更新补充材料本身即可，**不要求**改 `CURRENT_STATUS.md`。只有当证据导致当前结论变化时才动权威文档。

**默认交付单位是一个部署批次，不是一个 PR**（`DECISIONS.md` D36）：相关功能在同一分支连续做完 → 本机跑完整测试 → 部署那个 exact SHA → Telegram 真机验证 → 批次收尾 → ff 进 `main` 直推。上面 1–5 条在**批次收尾时做一次**，不必每个 commit 做一遍。

需要隔离审查时（多人协作、高风险重构、Owner 点名）才开 PR。开了就必须用 `.github/pull_request_template.md`，显式判断状态、架构、决策、生产接线和补充材料是否受影响。

### 全仓审计只在三个时机做

准备切生产；跨三个以上领域的架构调整；`CURRENT_STATUS.md` 与实际代码出现明显冲突。**其余情况只做任务相关检查。** 正在读第五个跟任务无关的文件时，停下来。

### 加 / 减一个能力

1. 它落在哪一档？常驻注入 / 目录式 / 完全按需（`SYSTEM_OVERVIEW.md` 第四节）。默认落第三档。
2. 有没有新的 writer？有就停 —— 单 writer 是硬约束。
3. 测试进哪个 `npm run test:*` 分组？不进分组 = 无 CI 信号；新分组要同时接进 `phase1-offline.yml`。
4. 需要生产接线吗？需要就在能力表的「生产接线」列写 `WIRED`，真机留证后才改 `VERIFIED`。
5. 默认开还是默认关？新能力默认关，用显式 env 开关。

## 七、目录速查

| 路径 | 内容 |
|---|---|
| `src/core/app.js` | 当前 turn、Telegram envelope、memory_context 与 vision context 的拼装；命令处理 |
| `src/core/hard-context.js` | Re-entry / Current State 装配、context gate 与 trace 基础结构 |
| `src/core/route-lane.js` | 三种身份与 lane 决策（无依赖，必须保持无依赖） |
| `src/adapters/channel/telegram.js` | Telegram 通道适配器 |
| `src/adapters/runtime/claudecode/` | Claude Code 子进程、launch profile、session slot、opening context 注入 |
| `src/continuity/` | Closeout / Janitor / Review / History writer |
| `src/services/memory-lookup-service.js` | Phase 5A 受控翻档 |
| `scripts/orchestration/release-control-plane.js` | 发布控制平面 |
| `scripts/windows/runtime-startup/` | 生产机 PowerShell 入口 —— **改这里最危险** |
| `extensions/relationship-memory/` | 记忆内核与 520 面板；watchdog 在 `launcher/watchdog.py` |

| 想知道 | 去读 |
|---|---|
| 系统整体怎么走 | `docs/architecture/SYSTEM_OVERVIEW.md` |
| 记忆：谁读、谁写、什么进上下文 | `docs/architecture/MEMORY.md` |
| Windows 生产启动 / descriptor / watchdog / 回滚 | `docs/architecture/WINDOWS_RUNTIME.md` |
| 520 的职责与边界 | `docs/520_CONSOLE.md` |
| 命令清单 | `docs/commands.md` |
| 当前进度、Gate、能不能切生产 | `docs/CURRENT_STATUS.md` |
| 某个决定是怎么定的、有没有被取代 | `docs/DECISIONS.md` |

`docs/archive/` 是历史，不据此判断当前状态。`docs/audit/` 的结论只对它审的那个 SHA 有效。标了 `Status: supplemental` 的文档不是当前真相，也不是已批准的决定。

## 八、分支与推送

`main` 是唯一主干。默认在一条批次分支上连续做完一批相关功能，验证通过后 ff 进 `main` 直推（D36）；`audit/*` 只加报告、不改被审代码。分支用完即删。

**推 `main` 之前必须过本机密钥闸。** `pwsh scripts/install-git-hooks.ps1` 装一次，之后 `git push` 自动跑（约 2 分钟）。公开仓库，用 `--no-verify` 绕过它等于把密钥直接公开，且历史不许重写、撤不回来。

**进 `main` ≠ 批准部署**（`DECISIONS.md` D3）。新流程下部署发生在推送**之前**，这条反而更要记住：进 main 只是同步进度，放行判据仍见 `CURRENT_STATUS.md` 第五节。

```bash
git rev-list --left-right --count origin/main...<分支>
```

`ahead=0` = 死分支，删掉，不要再往里做事。

反过来不成立：`ahead>0` 不能证明活——squash 合并会让已合并分支永远显示 ahead。判活死看内容，不看计数。
