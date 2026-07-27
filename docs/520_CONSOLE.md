# 520 Console

```text
Status: active
Authority: stable architecture
Scope: 520 控制台的职责与边界
Current status: docs/CURRENT_STATUS.md
```


> 状态：Phase 4 提供受控上下文编辑与只读记忆观察；八维实时/历史数据接线已补齐，后续交互能力仍按本文分阶段开放
> 520 是查看、调试、模式切换与评测前端，不是记忆后端。

## 一句话

关掉 520 后，Telegram、Context Builder、Desire、Closeout、Auto Review 和受控记忆查询仍然应该继续运行。

## Phase 4 已实现边界

- 520 与 Telegram/watchdog 进程树隔离，watchdog 不启动或重启 520；
- `/api/module-state` 使用 `not_implemented | available | preview | on | failed`；
- Context Trace、candidate 与 decision 仅提供有上限的只读查看；
- `/api/module-state` 与 `/api/continuity/layers` 返回 `write_mode=controlled_context_write` 及 capability 列表：经 Token、冲突哈希、原子写入、备份和审计后可编辑 System / Persona、Re-entry、Live State、Memory Context 与上下文开关；
- Canon、Episode、Portrait、Desire 与候选发布仍冻结，不能通过 520 任意写入；
- deferred/rejected decision 可通过鉴权入口请求 Review service 重审；
- 文件、care/cycle、Janitor、配置以及 memory/Desire 的直接写入口统一冻结；
- 重审入口不直接写 canon 或 Desire，最终发布仍只能经过既有 Review/History writer 链。

Prompt 版本管理、撤回、评测实验室等仍是后续能力；本阶段不伪装为已实现。

Phase 5A 落地后，`memory_lookup` 模块可显示为 `available`；出现真实 `recall_log` 后显示为 `on`。这只表示用户拉线查询可用，不表示自动 Soft Retrieval 已开启。

八维数据契约：

- realtime：`CYBERBOSS_STATE_DIR/desire-state.json`，兼容当前 `drive/scores` 与旧 `drives[]`；
- history：优先 `CYBERBOSS_STATE_DIR/desire-history.jsonl`，由 Desire runtime 唯一 writer 追加；
- Claude runtime 的 `turn.completed` 八维报告与发送回调共用同一个持久化入口；同一报告只追加一条 history；
- fallback：只有 history 尚不存在时，才读取冻结的 `memory/state_log.jsonl`；
- 520 只显示 URL、来源路径、记录数、新鲜度、8/8 完整度、缺失维度和回退状态，不写上述文件。

## 首页要让人一眼看懂

首页只用人话回答：

```text
TG 是否正常
本轮实际加载了什么上下文
Re-entry 使用哪种写作模式
本小时 Desire 是否记录
今天 Closeout / Auto Review 是否运行
旧档自动注入是否关闭
有没有重复、缺失或失败任务
```

示例：

```text
TG 正常；新线程首轮已加载 Re-entry；
Re-entry 模式为 AI 自主写；本小时 Desire 已记录；
今天 Closeout 尚未运行；旧档自动注入已关闭；没有重复任务。
```

## 页面结构

### 1. Overview

- TG / runtime 健康；
- 当前 branch、版本和 state-dir；
- 当前启用模块；
- Re-entry authoring mode；
- 旧档自动注入总开关；
- 最近错误；
- 下一项待处理工作。

### 2. Context Trace

每轮显示：

- System Prompt / Role Card 是否加载；
- Re-entry 是否因重入加载或跳过；
- Current State 来源；
- Episodes、Timeline、Portrait、Self-note、Rereadings 是否被跳过；
- 若读取旧档，读取方式是用户拉线、AI 主动翻阅还是测试注入；
- 每块的版本、hash、字数与 `why_now`；
- fallback 是否发生；
- 最终上下文大小。

默认不长期保存用户消息、模型回复、私人记忆正文或完整 Prompt。评测日志只保存必要摘要、ID 和选择结果。

### 3. Prompt Versions

- 查看当前 Prompt；
- 显示真实 diff；
- 创建不可变新版本；
- 切换指针；
- 回退旧版本；
- 标明生效范围：下一轮、新线程或重启后。

人格来源只能有一个，不能让 runtime 模板、本地文件和网页各维护一份。

### 4. Re-entry

提供三种 authoring mode：

```text
ai_direct
system_materials_then_ai
paused
```

页面显示：

- 系统整理的事实与未完事项材料；
- AI 原稿；
- Auto Review 的事实、长度与安全检查；
- 最终发布版本；
- 字数预算与超限告警。

Auto Review 不得改写 AI 原稿。用户可以查看 diff、撤回异常版本或要求重审，但不承担日常批准工作。

### 5. Jobs & Health

展示：

- Desire slot；
- Closeout；
- Auto Review；
- Reflect；
- Janitor recovery；
- orphan / duplicate 检查。

每个 job 至少有：

```text
job_key
状态
开始与结束时间
尝试次数
输入 watermark / hash
输出位置
错误原因
```

`no_output` 是成功状态，不应显示成失败。

### 6. Auto Review Log

默认只读展示：

- candidate；
- 原始证据引用；
- accepted / rejected / deferred / merged；
- 决策理由；
- 冲突与修正关系；
- 最终 writer 输出位置。

用户只保留：

- 撤回；
- 异常重审；
- 查看证据与 diff；
- 对明显错误给反馈。

520 不提供日常“待我审批”队列，也不允许页面直接改 canon 绕过 History writer。

### 7. Memory Access Lab

从 `episodes.jsonl` 开始的来源默认全部关闭：

```text
Episodes        [off]
Timeline        [off]
Portrait        [off]
Self-note       [off]
Rereadings      [off]
```

这些滑块用于：

- 手动测试某类来源进入上下文后的效果；
- 采集真实 `why_now` 数据；
- 对比“读取 / 不读取”结果；
- 验证 Context Trace 与预算。

滑块只控制测试注入和来源开放范围。用户明确寻找旧事时的受控工具式查询不应被总滑块封死。

禁止把整个文件直接塞进上下文。即使手动开启，也必须显示实际选中的条目和 token / 字数预算。

### 8. why_now 输入

页面提供空白框：

```text
此刻希望哪段记忆在场？
[自由输入]

○ 应该想起
○ 幸好没有想起
○ 想起了，但方式不对
○ 翻到了，但只该改变姿态
```

自动附带：

- 当前话题摘要；
- 开启的来源；
- 实际读取的 memory ID；
- 读取或跳过理由；
- 后续反馈。

写入结构化评测 JSONL，不写进 Episode 正史。

### 9. Files / History

只读展示：

- Episodes；
- Timeline；
- Re-entry；
- Self-notes；
- Rereadings；
- 旧版本与修正关系。

第一阶段不开放任意文件编辑器。确需维护时走专门操作和 diff，而不是通用“保存文件”。

### 10. Soft Retrieval

当前只显示：

```text
状态：deferred / off
自动召回：关闭
用户拉线后的工具查询：规划中
why_now 样本：N 条
进展文档：SOFT_RETRIEVAL.md
```

不要为了页面完整而接一条假的 preview 检索链。

## 第一阶段必须冻结的旧能力

- 写 `state_log.jsonl`；
- 直接编辑正式 memory 文件；
- 页面内自动运行 Janitor；
- 页面直接写 candidate；
- 页面保存人格到多个位置；
- 页面成为 Desire、Closeout 或 Auto Review 的实际调度进程；
- 用户必须逐条审核才能让 canon 生长；
- care、剧场等尚未接通功能冒充已实现。

## 模式与真实状态

模块可使用：

- `off`：完全不运行；
- `preview`：真实运行但不注入、不写 canon；
- `on`：正式运行。

但页面不能把“存在一个开关”当成模块已经实现。状态必须区分：

```text
not_implemented
available
preview
on
failed
```

## 第一阶段验收

- 520 可以独立启动与关闭；
- 关闭后 TG 和后台服务不受影响；
- 首页状态与实际运行数据一致；
- Context Trace 能解释本轮加载、跳过与查询原因；
- Re-entry 模式切换不产生双 writer；
- 所有旧档测试滑块默认关闭；
- why_now 输入能形成结构化日志；
- `state_log.jsonl` 不再被页面写入；
- 正式记忆不能从通用文件编辑接口修改；
- 页面崩溃不会导致 Telegram 重启或重复 poller。

---

## 写权限分两层

> 本节是 520 端点的**权威描述**。`docs/architecture/SYSTEM_OVERVIEW.md` 第六节只给骨架并链接过来，不复制这里的表格。

**活跃写端点**（全部需要 `X-Api-Token`；只读端点因只绑本机而免 token）：

| 端点 | 改什么 | 保护 |
|---|---|---|
| `/api/runtime-prompt/save`、`/restore` | **生产运行时提示词正文** | sha256 乐观锁、自动备份、历史版本下拉回滚、保存前 diff 预览 |
| `/api/context-layout/save`、`/snapshot`、`/restore` | 上下文分层布局与逐模块开关 | 快照 + 回滚 |
| `/api/context-gates` | 运行时三门 `reentry` / `current_state` / `memory_context` | 不重启 TG 进程即时生效 |
| `/api/desire-schedule` | Desire 调度配置（时区、夜间跳过等） | revision 乐观锁、自动备份、审计日志 `desire_schedule_saved` |
| `/api/context-source/save` | 上下文源 | — |
| `/api/todo/save` | Todo / Current Focus | — |
| `/api/review/retry` | 重跑单条 Review（调 `scripts/continuity/run-phase3.js review --candidate-id=`） | 候选 id 白名单正则 |

**冻结写端点** —— 一律 403 `write_frozen`，由 `test_dashboard_write_freeze.py` 守卫。名单在 `dashboard.py` 的 `FROZEN_WRITE_ENDPOINTS`，其中混着两种性质完全不同的东西，**不要一视同仁**：

| 端点 | 性质 |
|---|---|
| `/api/save`（任意文件写） | **安全冻结** —— 解冻前必须先证明不绕过 Review |
| `/api/state_log`（八维状态史追加） | 安全冻结 |
| `/api/episode_candidate`（Episode 候选追加） | 安全冻结 |
| `/api/janitor/run`（触发 janitor） | 安全冻结 |
| `/api/config`（chat provider / model） | 安全冻结 |
| `/api/care/config` | **工程未完成** —— 关怀页读路径已通，写路径待补前端；不是安全边界，补前端时一并解冻 |
| `/api/care/cycle` | 工程未完成，同上 |

剧场页（`/api/theater/scripts`）目前纯展示只读，没有写端点。

## 上下文分层：520 能关掉的模块

`DEFAULT_CONTEXT_LAYOUT` 定义四组，每组每模块各有独立 `enabled` 开关，组级 `runtime_gate` 映射到硬上下文三门：

| 组 | 含义 | runtime_gate | 模块 |
|---|---|---|---|
| Base | 稳定层 | 无（恒在最前） | 人物卡 / AI Identity、关系 / 情感注入、Tool / AI 自主活动规则 |
| Re-entry | 慢变化层 | `reentry` | Boundary、History / Timeline 摘要、AI Portrait、User Portrait |
| Live State | 鲜活状态层 | `current_state` | 最近状态摘要 / 小纸条、**八维 / Desire**、承诺、Todo / Current Focus、Health / 手机 Monitor、Location / Weather、RP 预设 / Overlays |
| Cache | 会话连续层 | 无 | 上一会话摘要、上一会话原文 / 最近 N 轮 |

「八维开关」就是 Live State 组里的 `desire` 模块开关。布局落 `context-layout.json`，门控落 `context-gates.json`，两者都在 `CYBERBOSS_STATE_DIR`，TG 进程下一轮重建上下文时读到。

`compute_module_state()` 另外给出记忆链各模块的运行态（`on` / `available` / `preview` / `not_implemented`），依据是对应文件在不在，不是配置声明。

## 八维页的数据源

优先读 `desire-history.jsonl`（Desire 唯一 writer 追加）；只有连续历史不存在时才只读回退到冻结的 `state_log.jsonl`。页面显示数据源、路径、新鲜度、维度完整度与回退状态。八维曲线是内联 canvas 手绘，无外部 CDN。
