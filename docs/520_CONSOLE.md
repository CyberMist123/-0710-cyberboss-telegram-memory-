# 520 Console

> 状态：Phase 4 只读观察边界已实现；八维实时/历史数据接线已补齐，后续交互能力仍按本文分阶段开放
> 520 是查看、调试、模式切换与评测前端，不是记忆后端。

## 一句话

关掉 520 后，Telegram、Context Builder、Desire、Closeout、Auto Review 和受控记忆查询仍然应该继续运行。

## Phase 4 已实现边界

- 520 与 Telegram/watchdog 进程树隔离，watchdog 不启动或重启 520；
- `/api/module-state` 使用 `not_implemented | available | preview | on | failed`；
- Context Trace、candidate 与 decision 仅提供有上限的只读查看；
- deferred/rejected decision 可通过鉴权入口请求 Review service 重审；
- 文件、care/cycle、Janitor、配置以及 memory/Desire 的直接写入口统一冻结；
- 重审入口不直接写 canon 或 Desire，最终发布仍只能经过既有 Review/History writer 链。

Prompt 版本管理、撤回、评测实验室等仍是后续能力；本阶段不伪装为已实现。

Phase 5A 落地后，`memory_lookup` 模块可显示为 `available`；出现真实 `recall_log` 后显示为 `on`。这只表示用户拉线查询可用，不表示自动 Soft Retrieval 已开启。

八维数据契约：

- realtime：`CYBERBOSS_STATE_DIR/desire-state.json`，兼容当前 `drive/scores` 与旧 `drives[]`；
- history：优先 `CYBERBOSS_STATE_DIR/desire-history.jsonl`，由 Desire runtime 唯一 writer 追加；
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
