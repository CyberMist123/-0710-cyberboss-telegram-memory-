# TG Chat 路由、上下文与 Token 减负设计草案

状态：**架构头脑风暴稿，供 Fable 只读审查；尚未批准施工**  
仓库：`CyberMist123/-0710-cyberboss-telegram-memory-`  
分支：`fix/p0-fable-chat-profile`  
关联：Issue #15

## 0. 这份文档的目的

我们不是要把 TG Chat 砍成一个没有能力的“纯聊天机器人”，也不是要立刻重写整个 runtime。

我们真正想解决的是：

- 普通聊天不应该每轮背着完整 CC 工程 harness、全部工具定义、工程规则和长任务日志；
- Chat 仍应保留完整人格、关系连续性、全量记忆访问和现实行动能力；
- 长工程、复杂 MCP 调用和其他 AI 的施工过程应可隔离到分支 session；
- 主 Chat 只接收必要结果与少量备注，避免人格和上下文被工程过程污染；
- 某些对关系/RP有意义、需要主 Chat 亲自经历的工具过程，仍允许在原 Chat 内完成；
- 先利用 Claude Code 已有能力（Tool Search、Output Style、后台/分叉 session 等），再决定是否需要二进制级 patch。

本阶段只要求 Fable 判断：这套思路在当前仓库、本机 Claude Code/Codex 版本和 TG runtime 中是否可行，最小落点在哪里，哪些假设错误，怎么分阶段做。

---

## 1. 用户原始主路径（尽量保留原话）

用户希望：

> chat窗口默认加载【全量记忆 / mcp目录 / 转发工程窗口】mcp
>
> 工程默认加载【轻量记忆 + chat窗口转发 + 指定mcp功能（比如只需要a功能，就不用加载b功能）】
>
> chat窗口可选：
>
> route1：chat窗口 → 转发任务给mcp/工程 → 返回结果给chat窗口（只有结果上下文传回chat窗口，其他的上下文加载在分支窗口，避免干扰）
>
> route2：chat可以选择自己加载该mcp（所有进程上下文加载在原chat窗口）

进一步补充：

> 工程/MCP 分支窗口最好有，但是 TG bot 需要授权码什么，很麻烦。以后可以新建 2–3 个 bot/session，让分发窗口可见，这一层暂时存疑。
>
> 转发时必须确定加载的记忆包是什么；主 chat 窗口只需要增加一些备注，满足即时性、灵活性和省 token。
>
> 工程窗口也可以加载“分发 Codex 或其他 AI 干活”的能力，虽然之前工程窗根本没有走 MCP。
>
> Route 2 需要确定模型选择能力，并附加预估 token 上限：A level 以下但很重要的事情可以在主 Chat 调 MCP；B level 绝对禁止走 Route 2。预估方法可以先定边界，之后用测试校准。
>
> CMX 先不管，这是另外一个项目。

明确撤销此前设想：

- **不需要 TG `/effort` 命令。** Chat/runtime 自主判断 effort；本任务不新增 `/effort` 用户界面。
- **不要求 Chat 零 MCP、零工具。** Chat 应保留能力目录和按需调用能力。
- **不要求立即创建多个可见 TG Bot。** 第一阶段可用隐藏的独立 session；未来再评估 2–3 个可见 Bot。

---

## 2. 当前已知问题与证据

Issue #15 中的现象：

- 新 TG Fable chat 初始 prefix 约 `29.8K` tokens；
- `WAKE-CHAT.md` 本身只有约 `1.6KB`，因此主成本不是 WAKE 文件；
- 观察到约 `50` 个 deferred tools、`5` 个 agents、`13` 个 skills，以及项目工具、MCP、工程说明等；
- 普通聊天也可能继承工程型 prompt、工具环境和很高的 reasoning effort；
- 一次普通回复可能输出数千 tokens，严重消耗周额度；
- 当前 Claude launch path 会生成/加载 project MCP config，并通过 CC CLI/harness 启动。

重要推论：

1. 只缩短 WAKE 不会解决固定 prefix。
2. Tool Search/deferred tools 可能已经在工作，但固定 CC system prompts、内置工具说明、skills、agents、project instructions、system reminders 等仍然很重。
3. “全部能力都在”与“全部能力定义每轮常驻”是两回事。
4. 长任务隔离和 MCP 动态发现解决的是不同层面，二者都需要。

---

## 3. 目标架构：Chat 是人格与调度中心

### 3.1 主 Chat 默认持有

主 Chat 是唯一的连续人格中心，默认持有：

1. `WAKE/persona` 和当前关系状态；
2. 当前对话历史与必要 re-entry；
3. **全量记忆检索权**；
4. MCP/能力目录；
5. 一个转发工程/worker/其他 AI 的窄入口；
6. 当前分支任务的少量索引与结果备注；
7. 少量真正高频、低成本、对连续性必要的核心工具。

“全量记忆”在这里表示：

- Chat 可以访问全部长期记忆；
- 每轮只召回与当前话题相关的片段；
- 不把完整长期记忆正文每轮全塞进 prompt。

“MCP 目录”在这里表示：

- Chat 知道有哪些能力；
- 知道它们适合解决什么、读写风险、预计上下文成本；
- 不等于把所有 MCP server 的全部 tool schema 每轮加载。

### 3.2 建议的最小常驻核心工具

候选 `chat-core` 能力：

```text
memory.search
memory.note / memory.remember
task.dispatch / branch.create
task.status / branch.resume
```

最终是否拆成一个独立小 MCP、内置 runtime command，或复用现有 tools，由 Fable 审查代码后决定。

不应为了“目录存在”就把所有实际工具常驻。

---

## 4. Route 1：转发到隐藏分支 session

### 4.1 用户体验

第一阶段仍只有一个 TG Chat。主 Chat 可显示简短状态：

```text
↗ 已交给工程分支 #17
执行者：Codex
能力：轻量记忆 + GitHub + filesystem
```

完成后：

```text
✓ #17 已返回结果
```

底层分支是独立 session/thread，不必立即创建第二个 TG Bot。

### 4.2 分支加载内容

分支默认加载：

```text
轻量记忆包
+ Chat 转发的当前任务
+ 必要项目上下文
+ 原工程 harness（仅工程任务需要时）
+ 本任务指定的 MCP / tools
+ 向 Chat 返回结果的通道
```

工程分支不应该默认继承主 Chat 的全部闲聊和关系历史；它只需要知道“自己是谁、在替谁做什么、用户的关键工作偏好是什么”。

### 4.3 只将结果胶囊返回主 Chat

建议固定 `result capsule`：

```text
任务 ID / 分支 ID
结论
执行了什么
修改或生成的产物
测试/验证证据
重要发现
剩余风险或阻塞
需要写入主 Chat 的状态变化
是否值得继续复用该分支
```

以下内容留在分支，不自动回灌主 Chat：

- 完整工具日志；
- 文件遍历记录；
- 长测试输出；
- 工程 system prompt；
- worker 的全部中间上下文；
- 多轮调试细节。

主 Chat 只增加少量备注，例如：

```text
#work-17 已完成：修复 TG token 问题，修改 4 个文件，测试通过，PR #xx。
详细过程保存在 branch #work-17。
```

这样满足即时性、灵活性和省 token。

### 4.4 工程窗口还能继续分发

工程分支本身可以拥有：

- 调用 Codex 的能力；
- 调用 Fable/Claude 工程 worker 的能力；
- 调用 reviewer worker 的能力；
- 指定 MCP；
- 并行或串行工作流。

底层未必必须走 MCP。可选实现：

1. 本地 Agent Bus / session manager / task queue；
2. 一个窄的 delegation MCP，例如：

```text
create_task
send_task
get_status
get_result
cancel_task
```

不应为了“统一协议”强迫已有本地 Claude/Codex session 通信全部改走 MCP。

### 4.5 未来可见分支

未来可以评估创建 2–3 个可见 TG Bot，例如：

```text
chat
work
research/review
```

但每个 Bot 都涉及 BotFather token、配对/授权、服务生命周期和运维。第一阶段不承担此成本。

底层 session ID、profile 和 result capsule 应提前设计为未来可迁移到可见 Bot，而不是把隐藏分支写死。

---

## 5. 分支轻量记忆包

这是 Route 1 的关键边界。若不固定，很容易再次变成“把主 Chat 全量搬过去”。

建议固定六部分：

### A. 身份种子

- worker 是谁；
- 服务谁；
- 最低必要 persona/关系信息；
- 语言与表达偏好。

### B. 任务相关用户事实

只召回与本任务有关的事实，不附带不相关生活史和对话历史。

### C. 当前决定

主 Chat 与用户刚达成的结论，尽量保留用户原话；避免 worker 自己重新解释需求。

### D. 任务包

- 目标；
- 范围；
- 路径/仓库/分支；
- 验收条件；
- 已知风险。

### E. 权限和边界

- 能否改文件；
- 能否提交/推送/开 PR；
- 能否发送消息；
- 是否可使用网络；
- 禁止碰哪些模块。

### F. 返回协议

只返回：结论、变更、证据、风险、续接指针。

初始预算建议（待测试）：

- 身份种子：约 `300–600` tokens；
- 任务相关记忆：约 `500–1,500`；
- 当前决定与任务：约 `500–1,500`；
- 权限与返回协议：约 `300–500`；
- 总记忆包优先控制在约 `1,500–3,500` tokens。

超过预算的材料应留在分支可检索存储/项目文件中，不应静默堆进初始 prompt。

工程分支应保留的用户工作偏好包括：

- 不停下来等确认（除非有真实阻塞或高风险写操作）；
- 先窄读、不要全仓漫游；
- 不修改范围外功能；
- Windows 脚本编码约束；
- 测试、提交和证据要求。

---

## 6. Route 2：主 Chat 自己加载指定 MCP

### 6.1 定义

Route 2 表示：

> Chat 自己按需加载某个 MCP/工具；所有工具调用过程和重要结果都进入原 Chat 上下文。

它适合：

- 过程本身具有关系/RP意义；
- Chat 必须亲自看到中间结果并实时判断；
- 非常短的小操作；
- 只需要一个或少数工具；
- 用户明确说“你自己去看/你亲自做/过程留在这里”。

### 6.2 Route 2 不等于加载完整 CC 工程 harness

Route 2 理想形态是：

```text
Chat persona + memory + Tool Search + 指定工具
```

不是：

```text
Chat + 完整工程 harness + 全部 tools + 全部 skills + 全部 MCP
```

“行动过程进入主意识”可能对 RP 有增益；工程规则、测试说明、工具全集常驻通常只会制造任务模式和机械感。

### 6.3 模型选择

Route 2 默认应保留主 Chat 当前模型，因为过程会成为人格连续性的一部分。

建议规则：

```text
有关系/RP意义、需要主 Chat 亲自经历
→ 当前 Chat 模型

简单机械、只需最终结果
→ Route 1 的便宜 worker

长工程/复杂编程
→ Route 1 的 Codex/工程模型

主模型不支持目标工具或无法安全加载
→ Route 1，不在原 Chat 强行换人格模型
```

暂不要求跨模型共享同一 Chat thread。模型切换是否会导致 persona 漂移、cache 失效或 session 不兼容，需实测。

### 6.4 不新增 `/effort`

用户不需要 `/effort` 命令。

runtime 可以自主选择 reasoning effort，但必须：

- 不继承全局错误的 `max`；
- 不让普通聊天无理由长期运行高/最大 effort；
- 工程/复杂分支可以使用更高 effort；
- 选择逻辑应可观测和测试，但不必做成 TG 用户命令。

可参考 complexity router 思路，但不要先依赖第三方 patch 才能工作。

---

## 7. Route 2 的 Token 预算：A/B 边界

精确预测完整轮次 token 不现实，尤其隐藏推理和模型自主工具循环难以提前知道。

但可以估算主要可控项：

```text
当前 Chat 上下文
+ 新召回记忆
+ 新工具 schema
+ 预计 MCP 返回体
+ 用户输入
+ 最大输出预算
+ 允许的工具调用轮数
```

### A Level：允许 Route 2（软限制）

初始边界建议：

- 只加载一个 MCP/server 或一个 namespace；
- 暴露 `1–4` 个具体工具；
- 新增工具 schema/说明预计不超过约 `3K` tokens；
- 一般不超过 `3` 次工具调用；
- 不遍历代码仓库；
- 不读取多份长文档；
- 预计新增总上下文不超过约 `6K` tokens；
- 过程对主 Chat 很重要，值得保留。

A Level 是软限制。略微超过，但关系/RP价值很高时可允许。

### B Level：绝对禁止 Route 2

命中任一项，必须 Route 1：

- 加载完整 CC/Codex 工程 harness；
- 仓库扫描、编译、测试、批量文件处理；
- 多个大型 MCP server；
- 超过约 `4–6` 个工具；
- 长时间 Agent 循环；
- 大量日志、长文件或不可控返回体；
- 预计新增上下文超过约 `8K–10K` tokens；
- 无法限制最大调用轮数；
- 子 Agent、并行执行或反复调试；
- 会明显淹没主 Chat 当前关系上下文。

这些数字是首轮安全边界，不是最终真理。实施后需记录：

- 估算值；
- 实际 input/cache/output；
- 实际工具数；
- 实际返回长度；
- 是否发生上下文污染；

再逐步校准。

---

## 8. Claude Tool Search 对本方案的影响

社区资料声称 Anthropic 新 Tool Search 能显著减少 MCP schema token：

- 不再预加载全部工具定义；
- 只初始加载 Tool Search 和少量关键工具；
- 需要时再动态发现并展开匹配工具；
- 帖子示例声称 `51K → 8.5K`，该数字本身对应约 `83.3%` 降幅，而不是文中同时写的 `46.9%`，所以具体数字需要独立验证。

对本项目的意义：

1. Route 2 可能不需要自造完整动态 MCP 机制；
2. Chat 可以保留 Tool Search + 少量常驻核心工具；
3. 其他工具 deferred，按需发现；
4. 仍需确认当前安装的 Claude Code 版本是否真的启用、阈值如何、能否控制 server/tool 粒度；
5. 现有日志已看到大量 deferred tools，但新 session prefix 仍约 29.8K，说明 Tool Search 不能解决全部固定 harness 成本；
6. 长任务产生的调用结果和过程日志仍然需要 Route 1 隔离。

Fable 必须本机验证：

```text
claude --version
claude --help
/context
/mcp
相关 init/stream-json 事件
```

并检查是否存在：

- `MCPSearch`；
- deferred tools；
- server-level `alwaysLoad` 或同类设置；
- tool-level filtering；
- 按需发现后工具定义如何进入/退出 session；
- headless/SDK 模式与交互模式行为是否一致。

---

## 9. Output Style：官方优先的 Chat 去工程化候选

社区方案建议为 Chat 创建用户级自定义 Output Style，把人格提示放入 style，并设置：

```yaml
---
name: Fable Chat
description: Relationship-centered general chat profile
keep-coding-instructions: false
---

[WAKE / Chat persona]
```

待验证价值：

- 人格进入 system 层，而不是每轮普通用户消息；
- Chat profile 去掉默认 coding instructions；
- 保留 Claude Code session、Tool Search、MCP 能力；
- 工程分支继续使用 Default/工程 style；
- style 可能在 session 启动时确定，有利于 prompt cache 稳定，但切换可能需要新 session。

必须检查：

- 当前 Claude Code 版本实际 frontmatter 字段名；
- `keep-coding-instructions: false` 到底移除哪些内容；
- 是否只影响输出风格，还是确实改变 system prompt；
- 与 `--system-prompt`、`--append-system-prompt`、CLAUDE.md、WAKE 注入的优先级；
- headless `-p`/SDK/TG runtime 是否支持同样的 Output Style；
- 是否会影响 Tool Search、权限和安全提示；
- 对 RP 是否有稳定正向效果。

第一阶段优先尝试官方机制，不先 patch binary。

---

## 10. TweakCC + lobotomized Claude Code

### 10.1 `skrabe/tweakcc-fixed`

它是 Claude Code 二进制/JS patch 工具，可改：

- system prompts；
- tool descriptions；
- system reminders；
- toolsets；
- MCP startup；
- memory 行为；
- reasoning defaults/complexity router；
- 其他内部行为。

它支持 backup/restore，但更新 Claude Code 后通常需要重新 apply，版本耦合强。

### 10.2 `skrabe/lobotomized-claude-code`

它是供 tweakcc-fixed 使用的 prompt override 集合，目标是：

- 删 anti-laziness scaffolding；
- 删重复警告和 CAPS theater；
- 删不使用功能的说明；
- 精简 tool descriptions 和 per-turn reminders；
- 保留诚实、失败直报、破坏性操作确认和范围纪律。

项目作者自报在特定 Claude Code/Opus 版本下明显减少 prompt 字符数，但这不是本项目真实 session token 的独立评测。

### 10.3 本项目的使用原则

不建议第一步把整套 patch 应用到当前唯一 Claude Code 安装：

- Chat 与工程的要求不同；
- Fable/Opus 版本不同，prompt pack 未必兼容；
- patch 会非平凡改变行为；
- 可能损伤工具安全、诚实、验收或工程可靠性；
- CC 更新会带来维护成本。

若官方 Tool Search + Output Style + 分支隔离仍不足，再考虑：

```text
claude-work
→ stock Claude Code，完整工程 harness

claude-chat
→ 独立安装/独立 executable
→ tweakcc-fixed
→ 只选择性应用经过审查的精简项
```

lobotomized prompt pack 更适合作为“候选删除清单”，不是整包照搬。

优先考虑的候选：

- anti-laziness prompts；
- coding completion reminders；
- 重复 scope 提醒；
- 不使用功能的说明；
- 空 system reminders；
- 每轮重复注入。

优先保留：

- 诚实与失败直报；
- 破坏性操作确认；
- 外部内容不可信；
- 权限边界；
- 工具错误处理。

---

## 11. 原 CC harness 对 RP 的可能影响

需要做 A/B/C，而不是凭感觉决定：

```text
A：当前完整 CC harness
B：Output Style + WAKE + 记忆，无完整工程指导
C：B + Tool Search + 少量 chat-core tools
```

观察：

- 是否更容易掉入任务模式；
- 是否机械、谨慎、结构化过度；
- 是否保留行动感；
- 是否保持人格/关系连续性；
- 是否仍能在 Route 2 主动发现并调用工具；
- input/cache/output tokens；
- 首 token 延迟；
- 两三轮后是否出现行为漂移。

初步假设：

- RP 增益主要来自模型、WAKE、关系记忆、当前历史、真实行动能力；
- 完整工程规则和大量无关工具定义本身不提供 RP 增益；
- “她亲自经历工具过程”可能有 RP 增益；
- 因此目标是保留行动过程，不保留无关工程噪音。

Fable 应验证并反驳不成立部分。

---

## 12. 外部参考资源

### A. `PhoenixHairpin/cc-telegram-bridge` / 原 `cloveric/cc-telegram-bridge`

最贴近多实例和任务分发：

- Claude/Codex 双引擎；
- 多 Bot/多 instance，独立 personality、thread、state；
- Agent Bus：`/ask`、`/fan`、`/verify`；
- hub-and-spoke、pipeline、parallel topology；
- max delegation depth 和 loop prevention；
- per-instance usage/budget；
- session resume/detach。

可借鉴：隐藏 session/未来可见 Bot、Agent Bus、结果回传、预算与实例隔离。

注意确认上游关系、commit history 和许可证；不要整体替换 cyberboss。

### B. `metatool-ai/metamcp`

可借鉴：

- MCP server 聚合；
- namespace；
- server/tool 级启用和禁用；
- inactive tool filtering；
- 统一 endpoint 和 middleware。

适合作为 MCP 目录与按需暴露的架构参考，不一定立即部署整套。

### C. `IBM/mcp-context-forge`

可借鉴：

- MCP、Agent/A2A、REST/gRPC 路由；
- registry；
- rate limit；
- observability；
- token/cost metrics；
- concurrency 和治理。

它很重，适合作为长期治理参考，不适合第一阶段搬入。

### D. `OctavianTocan/claude-agent-sdk-telegram-bot` (`tap`)

可借鉴：

- Telegram → CLI stream-json 边界；
- session persistence 和 reset；
- fake Claude integration test；
- 无 API/周额度的 spawn/pipe/parse 回归测试；
- 单实例防冲突。

### E. `yanhs/claude-code-telegram`

可借鉴：

- SDK-primary / CLI-fallback；
- per-project session persistence；
- tool allowlist/disallowlist；
- usage tracking；
- `/new` 和项目切换。

### F. `skrabe/tweakcc-fixed`

可借鉴/实验：

- 提取并覆盖 system prompts；
- tool description 和 reminder 精简；
- MCP startup 和 toolset patch；
- complexity router；
- backup/restore。

仅作为第二阶段隔离实验。

### G. `skrabe/lobotomized-claude-code`

可借鉴：

- prompt 审计方法；
- “保留改变行为的内容，删除不赚 token 的内容”；
- 每个 prompt 单独判断，而非简单字数压缩。

不要未经验证整包应用。

### H. Anthropic Claude Code 官方仓库/文档

Fable 需要核对当前安装版本和官方行为：

- Tool Search / deferred tools；
- Output Styles；
- background session、fork、subagent；
- `--system-prompt` / `--append-system-prompt`；
- MCP config 和 tool filtering；
- headless stream-json init events；
- budget/context/compact 行为。

官方 changelog 已出现后台 code review、background session、fork lineage、MCP error reporting、subagent depth/budget 等能力；需要判断哪些能直接复用，避免重复造轮子。

---

## 13. 推荐分阶段路径（待 Fable 审查）

### Phase 0：只读测量

- 确认本机 Claude Code/Codex 精确版本；
- 记录当前普通 TG 新 session 的 init event；
- 分解 29.8K prefix 的来源；
- 确认 Tool Search/deferred tools 实际状态；
- 确认 Output Style 在 headless/TG path 是否可用；
- 测量 Chat/工程各自工具、agents、skills、MCP 数量。

### Phase 1：官方机制最小实验

建立独立实验 profile，不碰 live：

```text
Fable Chat Output Style
+ keep-coding-instructions: false
+ WAKE/persona
+ 全量记忆检索
+ 少量 chat-core tools
+ 原生 Tool Search
```

工程 profile 保持 stock harness。

做 A/B/C 两三轮对话和 token/RP 测试。

### Phase 2：隐藏 Route 1 分支

- 独立 session/thread；
- 固定轻量记忆包；
- task dispatch/status/result capsule；
- 指定 MCP/tools；
- 可转发 Codex/其他 AI；
- 主 Chat 只写少量备注。

### Phase 3：Route 2 Token Gate

- 工具目录元数据；
- A/B Level 估算器；
- 工具数量/返回长度/调用次数上限；
- 运行后真实 usage 记录与校准。

### Phase 4：可见多 Bot（可选）

若隐藏分支体验不足，再创建 2–3 个可见 Bot，并复用已有 profile/session/result capsule 设计。

### Phase 5：Chat 专用 CC patch（可选）

只有官方机制仍无法将固定 prefix 和机械感降到可接受范围时，才建立独立 `claude-chat` 安装，选择性尝试 tweakcc/lobotomized 精简。

---

## 14. Fable 需要回答的问题

Fable 本阶段只审查，不施工。请回答：

1. 当前 TG → Claude Code launch path 中，29.8K prefix 的实际组成是什么？
2. 当前版本 Tool Search 是否已启用？deferred tool 定义何时进入上下文？
3. 是否能保留“全量 MCP 目录/检索能力”而不预加载所有 schema？
4. 官方 Output Style 能否在当前 headless/TG runtime 使用，并真正移除 coding instructions？
5. Chat 主 session 与隐藏工程分支应使用 Claude `/fork`、background session、独立 CLI process、Agent SDK session，还是当前 SessionStore 扩展？
6. Route 1 如何确保只回传 result capsule，不污染主 Chat？
7. 上述六段轻量记忆包是否足够？应从现有 memory-kit 哪些层生成？
8. 工程分支继续调用 Codex/其他 AI，使用 Agent Bus、MCP 还是现有本地 runtime adapter 更合适？
9. Route 2 如何估算工具 schema、返回体和调用轮数？A/B 初始阈值是否合理？
10. 模型选择如何保持 Chat persona 连续性？
11. 完整 CC harness 对 RP 是否有可测增益？如何设计最小 A/B/C？
12. tweakcc/lobotomized 哪些内容值得以后选择性移植，哪些绝不能删？
13. 最小安全 Phase 1/2 修改落点在哪些文件？
14. 哪些想法在当前 runtime 下做不到、成本过高或会破坏现有 continuity/watchdog/media/approval？
15. 给 Codex 的后续施工应如何拆成 2–4 个可独立合并的 PR？

输出到：

```text
REVIEW-TG-CHAT-ROUTING-CONTEXT-BUDGET.md
```

审查结果应包含：

- 可行/不可行/待实验的逐项判断；
- 当前版本实测证据；
- 推荐的最小架构；
- 文件和接口落点；
- Phase 顺序；
- A/B/C 测试矩阵；
- 风险和回滚；
- 给 Codex 的短施工拆分。

只提交并推送 review 文档，不改生产代码，不开 PR，不改 live TG。

---

## 15. 非目标与边界

本阶段不做：

- CMX 设计或改造；
- `/effort` 命令；
- 多 Bot 实际授权和部署；
- 全局 patch 当前 Claude Code；
- 直接套用 lobotomized prompt pack；
- 修改 memory 语义、520 UI、Apple Watch、media inbox；
- 直接把任何外部项目整体并入 cyberboss；
- 在没有基线和回滚的情况下改 live TG。

本阶段唯一交付：**Fable 对这份架构与主路径的可行性审查。**
