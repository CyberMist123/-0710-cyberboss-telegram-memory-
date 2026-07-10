# Cyberboss Telegram Memory — 人话版项目介绍

> 这是一份给“不想先读代码、只想先搞懂项目到底在干嘛”的说明。
>
> 看完它，你应该能回答：
>
> - 这个项目对我有什么用；
> - 它的几个核心功能分别怎么实现；
> - 哪些真的跑通过；
> - 哪些还只是半成品；
> - 下一步为什么先修这些，而不是继续加新功能。

更细的状态表看：[`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md)  
记忆系统和 520 面板的详细结构图看：[`MEMORY_520_MAP.md`](./MEMORY_520_MAP.md)

---

## 1. 这个项目到底是什么

最简单地说，它是一个“住在 Telegram 里的本地 AI”。

你在 Telegram 里给它发消息，它会把消息交给电脑上的 Cyberboss，再由 Claude Code 调用 DeepSeek 或其他兼容模型生成回复，最后把回复发回 Telegram。

但它不只想做一个“能聊天的机器人”。它还想解决一个更具体的问题：

> 换窗口、`/new`、模型重启以后，对面不要像刚出生一样，完全不认识你，也不认识你们之间发生过什么。

所以这个项目在 Cyberboss 外面又加了三层：

```text
关系记忆
520 本地面板
Windows 启动与维护工具
```

它的核心目标不是“记住越多越好”，而是：

> 记住真正会影响以后怎么接话的事情，同时不要把模型变成背诵档案的机器。

---

## 2. 你实际使用时，会看到什么

理想状态下，你只会感受到这几件事：

1. 在 Telegram 里正常聊天；
2. 换窗口以后，它还大概知道最近发生了什么；
3. 明确提到旧事时，它能去翻真正的关系记录；
4. 漏掉的聊天可以被 Janitor 补成候选记忆；
5. 你可以在 520 面板里查看这些记忆有没有坏掉；
6. 重要记忆不会被自动偷偷写进“正史”，而是要经过整理或确认。

你不应该感受到：

- 每句话都在引用旧档案；
- AI 一直汇报“我记得你说过……”；
- 面板和后台偷偷同时写两套记忆；
- 自动脚本在你不知道的时候不断调用 API；
- 为了修重复回复，又制造更多重复和丢消息。

---

## 3. 整个系统怎么走

### 3.1 最核心的一条链

```text
你在 Telegram 发消息
        ↓
Cyberboss 收到消息
        ↓
Claude Code 调用 DeepSeek
        ↓
模型生成回复
        ↓
Cyberboss 把回复发回 Telegram
```

这条是“聊天主干”。

关系记忆、520 面板、Janitor 都应该只是挂在主干旁边，不能把主干改得越来越复杂。

### 3.2 记忆怎么加入

```text
新窗口启动
   ↓
只读一小份 reentry.md
   ↓
模型知道“最近我们走到哪里了”
   ↓
真的提到旧事时，再按需读 timeline / episodes / portraits
```

不是每轮都把所有记忆塞进去。

### 3.3 漏记了怎么办

```text
原始会话日志
   ↓
Janitor 扫描没处理过的新内容
   ↓
生成候选 episodes.candidates.jsonl
   ↓
生成一份 reentry.extracted.md 参考稿
   ↓
以后由人或 AI 决定要不要进入正式记忆
```

自动系统只负责“提出候选”，不负责“宣布正史”。

### 3.4 520 面板做什么

```text
读取 memory/ 下的文件
读取 Janitor 状态
读取 desire 状态
展示 timeline / episodes / reentry
允许维护时编辑、触发 Janitor、改部分配置
```

所以 520 其实不只是展示页，更像一个本地维护控制台。

---

## 4. 核心功能一：Telegram 聊天入口

### 你会看到什么

你在 Telegram 里发文字，AI 回复你。

### 背后怎么实现

```text
Telegram Bot API
→ Cyberboss Telegram adapter
→ Claude Code runtime adapter
→ DeepSeek Anthropic-compatible endpoint
→ 回复发送回 Telegram
```

Cyberboss 负责消息接收、会话状态、模型调用和消息发送。

### 现在做到哪一步

- `legacy-current`：这条链真实跑通过；
- `main`：保留了更干净的上游核心，但还没有在全新目录重新做完整 smoke test；
- 历史上叠加的代理、去重、offset 刷新、单实例锁等补丁，不准备默认带回新主线。

### 为什么现在不继续加补丁

因为这些补丁大多是在“重复回复、409、代理失败”之后一层层补出来的。它们可能暂时压住一个问题，却改变了原版流式和发送逻辑。

新主线的策略是：

> 先恢复原版行为，只在能稳定复现问题时加一个最小修复。

---

## 5. 核心功能二：关系连续性记忆

### 你会看到什么

换窗口以后，AI不会完全失忆，但也不会把你当档案念。

### 背后怎么实现

关系记忆不是一个大数据库，而是一组不同职责的文件：

```text
reentry.md
  最近这一段关系走到哪里，给新窗口的一小口背景

episodes.jsonl
  具体发生过的关系事件，像证据档案

relationship_timeline.md
  把重要事件串成故事

user_portrait.md
  记录你反复在意的主题，不写死“你是什么人”

ai_self_portrait.md / ai_self_notes.md
  AI 对自己的长期理解和写给未来自己的话

home.md
  说明这套记忆为什么这样运转

closeout_guide.md
  每晚整理时用的三问模板
```

### 现在做到哪一步

已经有：

- 文件结构；
- 本地真实内容；
- reentry、episodes、timeline、portrait 的使用记录；
- closeout 的人工模板；
- “自动只写 candidate，canon 需要确认”的设计边界。

还没完全跑通：

- TG 是否每次都读到了正确版本的 prompt；
- 从 `main` 全新 clone 后，模板和 state-dir 路径是否正确；
- closeout 还不是稳定自动流程；
- candidate 还没有完整审核与晋升界面。

### 现在最大的 bug

记忆同步工具默认可能写到：

```text
~/.cyberboss
```

但 TG 实际用的是：

```text
~/.cyberboss-deepseek-test
```

所以过去可能出现：

> 文件看起来同步成功了，但实际改的不是 TG 正在使用的那一份。

这就是为什么下一步要先修“显式 state-dir”，而不是继续加记忆功能。

---

## 6. 核心功能三：Janitor 自动补记

### 你会看到什么

某次聊天因为 `/new`、崩窗、忘记 closeout 没进入记忆，Janitor 可以把这些断档整理成候选。

### 背后怎么实现

```text
扫描会话 JSONL
→ 找出上次位点之后的新行
→ 按内容切块
→ 调用提取模型
→ 生成 candidate episode
→ 写入 episodes.candidates.jsonl
→ 同时生成 reentry.extracted.md 参考稿
```

它有两层去重：

```text
文件行数位点
内容哈希缓存
```

所以同一段内容连续跑两次，第二次理论上不会重复调用 API。

### 现在做到哪一步

已跑通：

- 增量扫描；
- dry-run；
- 位点；
- 内容缓存；
- 失败块不推进；
- 自动只写 candidates；
- 测试记录 18/18 通过。

没跑通：

```text
candidate
→ 去重
→ 合并同一事件
→ 看原始证据
→ 接受 / 拒绝 / 延后
→ 晋升正式 episodes
→ 同步 timeline / portrait / reentry
→ 可撤回
```

也就是说，Janitor 已经会“捡东西”，但系统还不会“整理入库”。

---

## 7. 核心功能四：520 本地面板

### 你会看到什么

浏览器打开：

```text
http://127.0.0.1:520
```

可以查看：

- 系统健康度；
- reentry；
- timeline；
- episodes；
- Janitor 状态；
- 八维状态；
- 记忆文件；
- 关怀和剧场的页面外壳。

### 背后怎么实现

它是一个 Python 单文件本地 HTTP 服务：

```text
dashboard.py
→ HTTPServer
→ 本地 HTML + JavaScript
→ /api/* 读取 memory 文件和状态
→ 写操作使用 X-Api-Token
```

它不依赖外部前端框架，主要直接读写本地文件。

### 现在做到哪一步

已经跑通：

- 页面打开；
- 文件查看；
- timeline 展示；
- JSONL 卡片展示；
- 文件编辑前 diff；
- 保存前备份；
- Janitor 状态；
- 手动触发 Janitor；
- 本地 token 保护写接口。

还没收敛：

- 设计说 `reentry` 约 300 字，代码仍按 800 字检查；
- 设计说 `state_log.jsonl` 已冻结，面板仍允许写；
- desire 当前值和旧 state_log 历史同时存在，权威来源不清；
- 面板一边叫“展示页”，一边又能改配置、写文件、启动任务；
- 关怀和剧场主要还是页面和数据外壳。

### 更准确的定位

520 不是“纯展示页”。

它现在实际上是：

```text
查看器
+ 编辑器
+ Janitor 调度器
+ 配置页
+ 本地 API 桥
```

未来应该分成两种模式：

```text
普通模式：默认只读
维护模式：明确开启后才能编辑、review、改配置
```

---

## 8. 核心功能五：Desire 八维状态

### 你会看到什么

Cyberboss 会维持一份当前的八维状态，520 面板可以展示。

### 背后怎么实现

正确的新设计是：

```text
Cyberboss desire runtime
→ desire-state.json
```

关系记忆不再负责手写八维。

旧的：

```text
memory/state_log.jsonl
```

只应该作为历史存档。

### 现在做到哪一步

设计已经收敛，但实现没完全跟上：

- `desire-state.json` 是当前实时来源；
- `state_log.jsonl` 仍被面板当历史曲线读取；
- 面板甚至仍允许继续写 state_log。

所以现在存在两个“看起来都像权威”的来源。

首版应该先简单处理：

```text
desire-state.json = 当前值
state_log.jsonl = 冻结历史，只读
```

以后需要历史曲线，再单独做 desire-history service。

---

## 9. 核心功能六：Windows 本地启动

### 你会看到什么

双击脚本，TG、面板或相关服务在后台启动，不弹一堆窗口。

### 背后怎么实现

```text
PowerShell
+ .bat
+ .vbs
+ Node hidden child process
```

脚本会找 Claude CLI、设置 state-dir、读取 `.env`、写日志、启动 Cyberboss。

### 现在做到哪一步

已经有：

- 隐藏启动；
- Claude CLI 路径发现；
- start / stop 脚本；
- 日志；
- watchdog。

还没收敛：

- 路径硬编码在当前电脑；
- 启动入口太多；
- 部分脚本默认开启旧 memory background write；
- 混入代理探测、PID、stale process 等历史逻辑；
- watchdog 可能在故障时不断重启，放大问题。

目标不是保留所有脚本，而是收成：

```text
一个配置文件
+ 一个主启动入口
+ 一个停止入口
+ 少量诊断工具
```

---

## 10. 哪些功能只是“看起来已经有了”

### 10.1 自动 closeout

已有：

- `closeout_guide.md`；
- 三问模板；
- canon 文件。

没有：

- 稳定触发；
- 自动生成 diff；
- 审核；
- 失败补偿；
- 自动提交正史。

所以它现在主要是人工流程，不是自动功能。

### 10.2 Candidate 审核

已有：

- candidates 文件；
- 520 基础页面；
- 文件编辑能力。

没有：

- 去重；
- 合并；
- 原始证据；
- 接受/拒绝/延后；
- 晋升；
- 回滚。

### 10.3 关怀

已有：

- 520 关怀页；
- config；
- cycle 录入。

没有：

- 天气数据；
- 明确授权；
- 提醒频率；
- 对话集成；
- 不进入 portrait / episodes 的自动保护。

### 10.4 剧场

已有：

- `theater/` 模板；
- 剧本索引；
- 520 只读页面。

没有：

- 战役开始/结束；
- NPC 状态；
- Telegram 接线；
- 戏内/戏外记忆自动隔离。

### 10.5 语音转文字

目前还是计划阶段，没有接入 Whisper 或 API。

---

## 11. 为什么现在要先收敛，而不是继续加功能

因为现在最大的风险不是“功能少”，而是：

```text
同一个东西有两套路径
同一个状态有两个来源
面板既读又写
文档说冻结，代码还能追加
legacy 跑过，但 main 还没验证
文件存在，但 TG 不一定真的读到了
```

如果继续往上加天气、语音、主动消息，只会让以后更难判断“到底是谁在起作用”。

所以当前顺序是：

```text
先让读取链唯一
→ 再让 520 默认只读
→ 再做 candidate 审核闭环
→ 最后才加关怀、剧场、语音等产品功能
```

---

## 12. 下一版最小目标

首个稳定版本只需要做到：

```text
原版 Cyberboss
+ 最小 Windows Claude 启动兼容
+ 明确 state-dir
+ 正确读取 v2 memory prompt
+ 旧 memory background write 关闭
+ Janitor 只写 candidates
+ 520 默认只读
+ 一个启动入口
```

它不需要马上拥有：

- 自动 closeout；
- desire history；
- 关怀；
- 剧场；
- 语音转文字；
- 主动消息；
- 向量检索。

先把一条主线跑得干净、可解释、可回滚，比一次性做完所有功能更重要。

---

## 13. 当前项目状态，一句话版

```text
聊天主干：跑通过
关系记忆文件：有真实使用
Janitor：前半条跑通
520：能用，但职责混乱
Desire：设计收敛，实现半迁移
Windows 启动：能用，但不便迁移
Candidate → canon：未闭环
关怀 / 剧场 / 语音：外壳或计划阶段
GitHub main：结构干净，但尚未重新部署验证
```

这就是当前项目最真实的样子。