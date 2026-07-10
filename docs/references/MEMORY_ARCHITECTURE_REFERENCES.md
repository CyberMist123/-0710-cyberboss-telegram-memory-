# Memory Architecture References

> 用途：保存本项目做架构判断时参考过的来源、原作者、链接和可借鉴边界。  
> 原则：这是“参考目录”，不是待办清单，更不是把所有框架拼进项目。

## 目录

1. [最相关的开源项目](#1-最相关的开源项目)
2. [用户提供的小红书参考包](#2-用户提供的小红书参考包)
3. [参考包提到的其他框架](#3-参考包提到的其他框架)
4. [我们准备借什么，不借什么](#4-我们准备借什么不借什么)
5. [来源完整性说明](#5-来源完整性说明)

---

## 1. 最相关的开源项目

### 1.1 Anchor Memory

- 项目：[`limen-threshold/anchor-memory`](https://github.com/limen-threshold/anchor-memory)
- 作者 / 维护者：GitHub 用户 [`limen-threshold`](https://github.com/limen-threshold)
- 定位：图结构记忆、Hebbian 共激活、情绪权重、遗忘与 dream consolidation、跨窗口 wakeup / session state。

值得参考：

- pinned + recent + recall 的跨窗口醒来方式；
- 记忆关系比单条文本更重要；
- memory search debug，能看见召回为什么发生；
- plain Markdown continuity state；
- switch ledger：换模型时记录什么断了、什么保留、什么重建。

暂不照搬：

- 召回即自动强化连接；
- 情绪越强越容易浮现；
- 14 天自动删除 short memory；
- daily dream 直接改变结构。

原因：这些机制容易形成自我强化循环。当前项目先解决“权威来源、上下文预算和修正链”，再谈联想图和遗忘。

### 1.2 Ombre Brain（原版）

- 项目：[`P0luz/Ombre-Brain`](https://github.com/P0luz/Ombre-Brain)
- 作者 / 维护者：GitHub 用户 [`P0luz`](https://github.com/P0luz)
- 定位：面向 Claude 的长期情绪记忆 MCP；Markdown bucket、情绪坐标、遗忘曲线、Dashboard、向量 / 模糊检索。

值得参考：

- Markdown bucket 作为人和 AI 都能读的单元；
- 事件、反思、情绪锚点分开；
- 记忆生命周期、归档和 Dashboard 可视化；
- 工具式按需读取，不把全部历史硬加载。

暂不照搬：

- 把情绪强度直接当作召回优先级；
- 在当前主线旁边再部署一套完整独立记忆运行时；
- 在数据契约未收敛前先做遗忘曲线。

### 1.3 Haven-Ombre（扩展 fork）

- 项目：[`Yinglianchun/Haven-Ombre`](https://github.com/Yinglianchun/Haven-Ombre)
- 作者 / 维护者：GitHub 用户 [`Yinglianchun`](https://github.com/Yinglianchun)
- 上游：`P0luz/Ombre-Brain`
- 定位：在 Ombre 基础上增加 Gateway 自动注入、Portrait / Handoff、Persona State、短时上下文、原文保险箱、Memory Moment / Edge、Darkroom、Dream Context 等。

值得参考：

- 新窗口 handoff 与普通记忆查询分开；
- Just Now Context 与长期记忆分开；
- 原始对话保险箱与提炼记忆分开；
- moment（事件）和 reflection（理解）分开；
- profile fact 先候选、确认后再写；
- 能检查实际注入了什么。

暂不照搬：

- Persona、Portrait、Handoff、Dream、Darkroom、Relationship Weather 同时进入第一版；
- Gateway、MCP、Dashboard 多入口同时拥有写权限；
- 大量隐藏注入默认开启。

Haven-Ombre 证明很多能力可以做，但也提醒本项目：功能过多时，必须先有唯一数据契约和上下文预算。

### 1.4 延音截图中的 Context Core

- 展示名：`context-core · 窗口 / 情感 / 记忆`
- 图中作者署名：延音
- 来源：用户提供的小红书网页截图
- 原始帖子链接：压缩包中未包含，当前不猜测、不伪造。

图中值得参考的概念：

- one context-core, every surface：CLI、chatroom、Telegram、手机端使用同一份连续性核心；
- 自主情感 / 想要应由近期证据、长期未触发和状态计算产生，而不是预写台词；
- 记忆在存入时即分类；
- 检索使用关键词、语义、关系、新旧、重要度等多信号排序。

风险：跨端统一不等于所有端都硬加载同一大包上下文。统一的应是数据与身份来源，出口仍需按端和任务裁剪。

---

## 2. 用户提供的小红书参考包

### 2.1 包信息

- 本地文件名：`Downloads(1).zip`
- SHA-256：`fc8c768f3279fa3adb49875616667e80721b7385484c4991263297550107e39a`
- 文件数：38
- 内容：37 张网页长截图 + 1 份文本导出
- 主要作者署名：`momo`、`延音`

为避免在 GitHub 中重新传播整套网页截图，仓库保存：

- 来源目录；
- 文件清单；
- 关键观点摘要；
- 对本项目的采用 / 不采用判断。

原始截图继续保留在用户本地参考包中。

### 2.2 `momo`：AI 陪伴 / 人机恋长期记忆系统实现方案

文件：8 张截图。

核心内容：

- L0 原始消息、L1 对话摘要、L2 关键事件、L3 高层概览的分层存储；
- 关键事件保留 80–200 字、直接引语和情感因果链；
- 关键词 + 向量混合检索；
- 软边界切割对话 batch，避免从因果链中间劈开；
- 新旧偏好使用版本链，而不是删掉旧状态；
- 不追求“完全记住”，而是记住情感锚点；
- 模型路由降低提取成本。

对本项目最有价值：

- 保留原话和来龙去脉，不压成标签；
- 冲突要有时间轨迹；
- 提取比存储和检索更难；
- 小规模时简单分层通常胜过复杂图。

需要克制：

- 100–150 条关键事件永驻 system prompt 对本项目过重；
- 高层概览和关键事件都常驻容易污染表达；
- “情绪匹配召回”可能让低落时反复想起低落记忆。

### 2.3 `momo`：怎么让陪伴型 AI 不再转头就忘

文件：11 张截图 + 1 份文本导出。

核心内容：

- 调研 Mem0、Graphiti、Letta、MemU、MemoBase、LangMem、SillyTavern、AIRI；
- 用真实关键记忆比较分层、卡片网络、多图结构；
- 小数据量下简单四层系统整体优于复杂图；
- 许多“记忆问题”实际是调用链没有把已有记录送到正确模块；
- 认知心理学中的自传记忆、闪光灯记忆、间隔效应、情绪一致性回忆、脚本偏离可转成工程启发；
- 选择记住什么，本身就是对关系重要性的判断。

对本项目最有价值：

- 先修上下文路由，再怪检索；
- 小房间不需要城市地图；
- 调试时要记录模型当轮到底看到了什么；
- 高情绪事件需要保留场景，但不能无限复制所有相关提及。

需要克制：

- 认知心理学只能当设计隐喻，不能证明系统具有人的记忆或情感；
- 召回强化、情绪匹配和闪光灯保护都可能造成循环偏置。

### 2.4 `momo`：AI 陪伴记忆架构 v3——从认知心理学到工程实现

文件：9 张截图。

核心内容：

- key events 体量会比预期增长快；
- 字符级去重无法识别同义事件，embedding 更合适；
- 按日期组织会线性膨胀，日常使用更需要按主题理解；
- 新分层：Identity / Narrative / Key Events / Dynamic Context / Messages；
- 上层不重复下层内容；
- Narrative 定期按主题重建；
- LLM 关系边比纯 embedding 相似边更能发现暗语和因果；
- 混合召回优于单一路径；
- 被频繁召回的内容可能形成死循环。

对本项目最有价值：

- 身份、叙事、事件、动态状态、近期消息必须不重叠；
- timeline 不适合作为唯一主组织方式；
- 叙事应该是可重建视图；
- 语义相似不等于关系意义相关。

需要克制：

- Narrative 如果直接常驻，仍可能变成角色卡和用户档案；
- 自动重建必须保留来源和修正链，不能无痕改写历史。

### 2.5 `momo`：多 AI 角色群聊 + 自主行为

文件：8 张截图（编号 6–13）。

核心内容：

- Life Tick：AI 在无人对话时自主选择活动和下一次唤醒时间；
- 自主研究、主动消息、内心独白；
- tick 链断裂后的自愈调度；
- 最贵模型只用于用户直接感知的回复和重要决策；
- 工具调用、文件维护和自我维护；
- 多进程写文件、JSON 截断、stdout 缓冲、向量 dtype 等工程坑。

对本项目最有价值：

- “活”不能只靠记忆，还涉及自主活动和自己的未完成问题；
- 后台活动若不进入自我历史，就不会真正成为 AI 的经历；
- 主动行为需要频率上限、自愈和清楚成本边界。

当前不进入 memory v2 第一阶段：

- Life Tick；
- 主动消息；
- 内心独白自动持久化；
- AI 修改自身代码。

原因：这些能力会放大任何尚未解决的数据权威和上下文污染问题。

### 2.6 `延音`：开源仓库记忆系统更新

文件：1 张截图。

图中概念：

- 同一 context core 对多个 surface；
- continuity → computation → structure；
- “想要”由近期证据、recency 和 dormancy 计算；
- 记忆存入时完成类型、时间、情绪、重要度、关联对象分类；
- 召回多信号并行排序。

对本项目最有价值：

- 数据核心统一、出口裁剪；
- 动态意图必须有近期证据；
- 召回需要多个信号，而不是只看 embedding。

---

## 3. 参考包提到的其他框架

以下项目由参考材料提到。本目录只记录其官方入口，不表示本项目计划接入。

| 项目 | 官方仓库 / 维护组织 | 本项目关注点 |
|---|---|---|
| Mem0 | [`mem0ai/mem0`](https://github.com/mem0ai/mem0) · Mem0 | 原子事实、ADD / UPDATE / NOOP、通用 memory API |
| Graphiti | [`getzep/graphiti`](https://github.com/getzep/graphiti) · Zep | 时间感知知识图谱、实体与关系 |
| Letta / MemGPT | [`letta-ai/letta`](https://github.com/letta-ai/letta) · Letta | 让 agent 自主管理 memory、虚拟内存隐喻 |
| LangMem | [`langchain-ai/langmem`](https://github.com/langchain-ai/langmem) · LangChain | 长期记忆与 procedural memory |
| SillyTavern | [`SillyTavern/SillyTavern`](https://github.com/SillyTavern/SillyTavern) · SillyTavern | 角色卡、上下文拼装、前端生态 |
| AIRI | [`moeru-ai/airi`](https://github.com/moeru-ai/airi) · moeru-ai | 虚拟角色、语音与具身呈现 |
| MemU | 参考材料称 `MemU`；本次未确认唯一官方仓库 | 三层记忆与双模检索 |
| MemoBase | 参考材料称 `MemoBase`；本次未确认唯一官方仓库 | 结构化用户画像与事件时间线 |
| A-MEM | 参考材料提到的论文方向 | Zettelkasten 式动态关联记忆 |
| MAGMA | 参考材料提到的论文方向 | 语义 / 时间 / 因果 / 实体多图 |

未确认唯一官方来源的项目不附猜测链接，后续核验后再补。

---

## 4. 我们准备借什么，不借什么

### 4.1 准备借

- Anchor 的 wakeup / pinned / search debug 思路；
- Ombre 的 Markdown 单元和事件 / 反思分离；
- Haven-Ombre 的 handoff、raw vault、注入可观察性；
- momo 的“事件保留原话和因果链”“小规模先简单”“层之间不要重复”；
- 延音的“一份 context core，多端裁剪”和多信号排序；
- Letta 的“AI 能管理自己的部分记忆”，但权限要分层；
- Mem0 的候选去重和更新判定；
- Graphiti 的关系边作为远期索引，而不是第一版主存储。

### 4.2 不准备借

- 大量关键事件永驻 system prompt；
- 情绪越强就自动越常召回；
- 被召回越多就无条件增强；
- 自动遗忘直接删除正史；
- 一开始就上知识图谱 / 多图；
- Persona、Portrait、Dream、Darkroom、Life Tick 同时接入；
- 多个入口都能写 canon；
- 把用户画像当 AI 连续性的主体。

### 4.3 本项目自己的中心

本项目最重要的不是某个检索算法，而是：

```text
最小身份锚点
+ 叙事带痕迹的事件
+ 可修正的理解
+ 极少硬加载
+ 按需召回
+ AI 自己的自叙述空间
+ 用户当前表达永远优先
```

---

## 5. 来源完整性说明

- GitHub 项目链接均指向对应公开仓库；
- 小红书截图中的作者名按文件名和页面署名记录；
- 用户提供包未包含原帖子 URL，因此不伪造链接；
- 截图和文本的著作权归原作者，仓库仅保存研究目录和摘要；
- 后续得到原帖子链接时，应补到本页对应条目；
- 任何架构结论都需要回到本项目真实使用和 A/B 测试验证，不能仅凭 star 数或论文指标决定。

---

## 附录：用户参考包文件清单

<details>
<summary>展开 38 个文件名</summary>

```text
AI陪伴_人机恋长期记忆系统实现方案_1_momo_来自小红书网页版.jpg
AI陪伴_人机恋长期记忆系统实现方案_2_momo_来自小红书网页版.jpg
AI陪伴_人机恋长期记忆系统实现方案_3_momo_来自小红书网页版.jpg
AI陪伴_人机恋长期记忆系统实现方案_4_momo_来自小红书网页版.jpg
AI陪伴_人机恋长期记忆系统实现方案_5_momo_来自小红书网页版.jpg
AI陪伴_人机恋长期记忆系统实现方案_6_momo_来自小红书网页版.jpg
AI陪伴_人机恋长期记忆系统实现方案_7_momo_来自小红书网页版.jpg
AI陪伴_人机恋长期记忆系统实现方案_8_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_1_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_2_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_3_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_4_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_5_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_6_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_7_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_8_momo_来自小红书网页版.jpg
AI陪伴记忆架构v3 从认知心理学到工程实现_9_momo_来自小红书网页版.jpg
多AI角色群聊 + 自主行为：让AI陪伴不只是_6_momo_来自小红书网页版.jpg
多AI角色群聊 + 自主行为：让AI陪伴不只是_7_momo_来自小红书网页版.jpg
多AI角色群聊 + 自主行为：让AI陪伴不只是_8_momo_来自小红书网页版.jpg
多AI角色群聊 + 自主行为：让AI陪伴不只是_9_momo_来自小红书网页版.jpg
多AI角色群聊 + 自主行为：让AI陪伴不只是_10_momo_来自小红书网页版.jpg
多AI角色群聊 + 自主行为：让AI陪伴不只是_11_momo_来自小红书网页版.jpg
多AI角色群聊 + 自主行为：让AI陪伴不只是_12_momo_来自小红书网页版.jpg
多AI角色群聊 + 自主行为：让AI陪伴不只是_13_momo_来自小红书网页版.jpg
开源仓库记忆系统更新_1_延音_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_1_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_2_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_3_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_4_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_5_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_6_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_7_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_8_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_9_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_10_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_11_momo_来自小红书网页版.jpg
怎么让陪伴型AI不再转头就忘？_1_momo_来自小红书网页版.txt
```

</details>
