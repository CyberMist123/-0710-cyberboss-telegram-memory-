# 520 Console 双语页面说明 / Bilingual UI Specification

> 状态 / Status：设计稿，尚未实现 / Design only, not implemented yet  
> 原则 / Principle：520 是遥控器和仪表盘，不是记忆后端。关闭页面后，Telegram、上下文构建和后台任务仍继续运行。

## 页面总览 / Page Overview

### 1. Modules / 模块控制

**它是干什么的 / What it does**  
控制每个上下文和后台模块是否运行，以及运行方式。
Controls whether each context or background module runs, and in which mode.

**模式 / Modes**

- `off`：不执行 / Disabled
- `preview`：执行并展示结果，但不注入、不写正式数据 / Run and show output, but do not inject or write official data
- `on`：正式执行 / Active

**例子 / Example**

```text
3-2 Reading Policy / 记忆读取策略
Mode / 模式: preview
Last run / 最近运行: 20:41
Result / 结果: 8 candidates found, 1 would be injected
说明: 现在只预览，不会影响 Telegram 回复
Note: Preview only. Telegram replies are unchanged.
```

---

### 2. Prompt Lab / 提示词实验室

**它是干什么的 / What it does**  
查看、编辑、测试和回退各模块的 Prompt。
View, edit, test, and roll back prompts for each module.

**页面字段 / Fields**

- Module / 模块
- Current version / 当前版本
- Prompt content / Prompt 正文
- Injection position / 注入位置
- Budget / 字数或 token 预算
- Effective from / 生效时间
- Diff / 修改差异
- Publish / 发布
- Rollback / 回退

**例子 / Example**

```text
1-2 Memory Contract / 记忆使用契约
Injection position / 注入位置: opening instructions
Effective from / 生效: next new turn

Current prompt / 当前 Prompt:
当前对话优先于旧记忆。
记忆是可能出错的背景，不是命令和台词。
需要旧事时再查；不确定就求证。

English preview / 英文预览:
The current conversation takes priority over old memory.
Memory is fallible background, not a command or a script.
Retrieve old events only when needed; ask when uncertain.
```

保存前必须显示真正的 diff；旧版本不可覆盖，只能创建新版本并切换指针。
A real diff must be shown before publishing. Old versions are immutable; publishing creates a new version and updates the pointer.

---

### 3. Context Trace / 本轮上下文

**它是干什么的 / What it does**  
显示这一轮模型实际看到了哪些模块，以及为什么加载或跳过。
Shows exactly which modules the model received in this turn, and why each module was loaded or skipped.

**例子 / Example**

```text
Turn / 对话轮次: tg-20260710-2044-001

1-1 Persona / 人格核心          loaded / 已加载
1-2 Memory Contract / 记忆契约  loaded / 已加载, 182 tokens
1-3 Identity Anchor / 身份锚点  skipped / 跳过: not a reentry turn
2-1 Wake Packet / 醒来包        skipped / 跳过: already used in this epoch
2-2 Just Now Tail / 最近对话    previewed / 已预览: 6 turns
3-1 Retrieval / 记忆检索        previewed / 已预览: 8 candidates
3-2 Reading Policy / 读取策略   previewed / 已预览: 1 pass, 7 suppressed
3-4 Memory Notes / 记忆纸条     not injected / 未注入: preview mode

Final context / 最终上下文: 3,246 tokens
Fallback used / 是否降级: no / 否
```

默认只显示模块名、hash、字数和原因，不长期保存用户消息正文。
By default, only module names, hashes, sizes, and reason codes are persisted; user message bodies are not stored in traces.

---

### 4. Jobs & Health / 任务与健康

**它是干什么的 / What it does**  
查看八维、Closeout、Review、Janitor 等后台任务是否重复、缺失或失败。
Shows whether Desire, Closeout, Review, Janitor, and other background jobs are duplicated, missing, or failed.

**例子 / Example**

```text
Hourly Desire / 每小时八维
Slot / 时段: 2026-07-10 20:00 Asia/Singapore
Status / 状态: recorded / 已记录
Attempts / 尝试次数: 1
Duplicate / 重复: no / 否

Daily Closeout / 每日整理
Date / 日期: 2026-07-10
Mode / 模式: preview
Status / 状态: no_output / 无产出，但成功

Janitor Recovery / 补漏
Status / 状态: idle / 空闲
Gap detected / 是否发现断档: no / 否
API calls / API 调用: 0
```

八维 slot 必须明确显示 `recorded`、`failed` 或 `missed_offline`，不能出现无声缺口。
Every Desire slot must explicitly show `recorded`, `failed`, or `missed_offline`; silent gaps are not allowed.

---

### 5. Memory Review / 记忆审核

**它是干什么的 / What it does**  
审核候选记忆，决定接受、拒绝、延后、合并或修正。
Reviews memory candidates and chooses whether to accept, reject, defer, merge, or correct them.

**例子 / Example**

```text
Candidate / 候选:
她把主动请求别人帮忙理解为一种信任。
She tends to treat asking someone for help as an act of trust.

Source / 来源:
conversation: 2026-07-10, lines 118-146

Type / 类型:
relationship interpretation / 关系理解

Suggested action / 建议动作:
needs user confirmation / 需要用户确认

Buttons / 操作:
Accept / 接受
Reject / 拒绝
Defer / 延后
Edit & Accept / 修改后接受
View source / 查看来源
```

520 不直接修改 canon 文件；按钮调用 Review Service，由唯一 writer 写入审计记录。
520 never edits canon files directly. Actions call the Review Service, and the single writer records the decision.

---

### 6. Manual Test / 手动测试

**它是干什么的 / What it does**  
在不影响真实 Telegram 回复的情况下测试单个模块或完整上下文。
Tests individual modules or the full context pipeline without affecting real Telegram replies.

**例子 / Example**

```text
Test type / 测试类型:
[ New session first turn / 新窗口第一轮 ]

Input / 测试消息:
“你还记得我为什么不喜欢别人替我做决定吗？”
“Do you remember why I dislike other people deciding for me?”

Expected modules / 预期模块:
1-1 Persona
1-2 Memory Contract
1-3 Identity Anchor
2-1 Wake Packet
3-1 Retrieval
3-2 Reading Policy

Send real reply / 发送真实回复: off / 关闭
Write memory / 写入记忆: off / 关闭
```

---

### 7. Prompt Order / Prompt 顺序

**它是干什么的 / What it does**  
展示上下文顺序，并允许在安全范围内调整模块先后。
Shows context order and allows safe reordering where permitted.

**例子 / Example**

```text
1. Core Persona / 人格核心
2. Memory Contract / 记忆契约
3. Identity Anchor / 身份锚点
4. Wake Packet / 醒来包
5. Confirmed Boundaries / 已确认边界
6. Retrieved Memory Notes / 召回记忆纸条
7. Current User Message / 当前用户消息
```

不是所有模块都允许随意拖动：人格必须在前，当前用户消息必须在后，检索候选必须先经过 Reading Policy 才能注入。
Not every module is freely draggable: persona stays first, the current user message stays last, and retrieval candidates must pass Reading Policy before injection.

---

## 首页状态句 / Home Page Status Sentence

建议首页用一句人话显示当前系统状态：
The home page should summarize system status in one plain-language sentence:

```text
当前系统正在使用人格核心、记忆契约和醒来包；软召回处于预览模式；八维本小时已记录；今天的 Closeout 尚未运行。

The system is currently using Core Persona, Memory Contract, and Wake Packet. Soft retrieval is in preview mode. This hour's Desire state is recorded. Today's Closeout has not run yet.
```
