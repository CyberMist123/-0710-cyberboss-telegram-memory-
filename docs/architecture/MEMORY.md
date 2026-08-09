# Continuity Architecture

```text
Status: active
Authority: stable architecture
Scope: memory-continuity 域稳定结构
Current status: docs/CURRENT_STATUS.md
```

## 目标

好的记忆系统不替 AI 决定下一句话，只让它说下一句话时不是从虚无开始。

判断标准：

- 记忆改变回应的姿态，而不是替模型规定内容；
- 当前对话始终优先；
- 普通闲聊可以没有旧记忆进入；
- 过去可以被现在重新理解和修正；
- AI 可以拥有可查阅的过去，不必把所有过去同时放进当前上下文；
- 不用大量规则制造“表演式连续性”。

## 1. 对话时模型能看到什么

### 1.1 默认硬上下文

```text
System Prompt
+ Role Card
+ 新线程首轮 Re-entry
+ 新线程首轮慢层（agreements / portrait / wandering，各自开关，默认关）
+ 轻量 Current State
+ 当前真实对话
```

规则：

- System Prompt：核心能力、安全边界与最稳定人格来源；每轮存在。
- Role Card：补充角色路径，不重复 System Prompt；通常在新线程或新 continuity epoch 加载。
- Re-entry：只在重入首轮加载一次，告诉模型最近走到哪里；不是完整历史。
- 慢层（D41）：与 Re-entry 同层、只在开窗装配一次；三项各挂独立 env 开关默认关，
  合计 ≤800 非空白字，按 agreements ≥ portrait ≥ wandering admit，装不下整项跳过、
  永不截断（`src/core/slow-layer-loader.js`，对源文件只读；导语只说明来处，不指挥使用）。
- Current State：来自 Cyberboss desire runtime，只表达短期姿态，不定义人格。
- 当前对话：最高优先级，冲突时旧记忆必须退让或求证。

### 1.2 默认隐藏的旧档

从 `episodes.jsonl` 开始，以下内容默认不自动读取、不自动注入普通对话：

- Episodes；
- Timeline；
- Portrait（例外：`CYBERBOSS_INJECT_PORTRAIT` 开着时按 1.1 的慢层在开窗缝入，D41）；
- Self-note；
- Rereadings。

默认隐藏不等于删除、遗忘或禁止访问。需要区分：

1. **自动注入**：Soft Retrieval，当前暂缓且默认关闭；
2. **用户拉线后的查询**：用户明确寻找旧事时，允许工具式翻阅；
3. **AI 主动翻阅**：以后可在有明确 `why_now`、小预算和边界约束时开放。

AI 翻到旧 Episode 后，可以像翻日记一样重新理解当时，不必假装这段内容一直处于当前意识中。

### 1.3 Soft Retrieval

未来按需加入：

```text
检索候选
→ 可选关系扩展
→ Reading Policy
→ 最多 0–3 条记忆纸条
```

Soft Retrieval 与 Re-entry 不同：

- Re-entry 服务于“醒来接回”，首轮一次；
- Soft Retrieval 服务于“这一轮是否需要旧事”，普通对话允许 0 条；
- 用户明确拉线后的工具式查询不等于自动 Soft Retrieval；
- 当前暂缓，详见 `SOFT_RETRIEVAL.md`。

## 2. 真正的数据层

### 2.1 Event Ledger / Episode

保存共同发生过的事件：

- 发生了什么；
- 时间与来源；
- 是否确认；
- 重要性；
- 后来有没有修正、补充或重新理解。

旧 `episodes.jsonl` 的叙述和情感痕迹先保留，不因架构重构而重写。

### 2.2 Re-entry

Re-entry 是 canon 的一部分，是 AI 留给下一个自己的短交接，不是程序自动拼接的第二套报告。

唯一 writer 是主体 AI。支持两种 authoring mode：

1. AI 根据最近对话自主写；
2. 系统整理事实、未完事项和来源作为材料，再由 AI 起草。

Auto Review 只检查：

- 是否有事实依据；
- 是否超过长度预算；
- 是否违反安全或格式边界；
- 是否把不确定内容写成确定事实。

Auto Review 不改写 AI 的措辞。

Re-entry 只保留：

- 最近走到哪里；
- 少量悬着的钩子；
- 近期仍相关的确认边界；
- 一项明确的不确定。

不新增独立 Living State 文件。系统提取的待办与事实可以作为生成材料，用完即弃、留在候选记录中，或经同一条发布链落进账本（见 2.5，账本不注入、不常驻，因此不是 Living State）。

**超预算时降级，不静默归零**（issue #76）。注入侧预算是 300 非空白字，唯一来源是
`src/core/reentry-loader.js` 的 `REENTRY_CHAR_BUDGET`；发布侧（Review 的 `length_ok`
与 History writer 的发布前闸门）引用同一个常量，不允许各写一份数字。超预算时：

- **不截断、不改写、不回写** `reentry.md`（D16 / D19：重写的人是原作者）；
- 整块换用上一份预算内的有效正文（last-known-good 副本，落在
  `<continuityDir>/.jobs/reentry-last-known-good.json`，属机制状态不属 canon，
  唯一 writer 是 loader 自己，只在「当前正文预算内且真的被注入」那一刻写）；
- 副本每次使用都重新过滤期限钩子、重新比预算，落盘值不当可信输入；
- 连副本都没有时仍 fail-open 返回空（不变量 5）。

`missing` / `expired` **不**降级：主体 AI 清空 Re-entry 是一个有权限的决定，
用旧副本盖回去等于替她撤销那次决定。

Trace 必须把「门」和「实际吃进去的东西」分开：opening 行带 `configured`（gate 开没开）
与 `effective`（`current` / `fallback` / `none`），降级时另带 `degraded_reason`。
门开着但正文进不去，不得再显示成正常 `loaded`。

### 2.3 Self-note

保存 AI 自己的选择、误读、修正、兴趣、疑问和重读。

规则：

- AI 是唯一 writer；
- 第一人称、只追加、可以被后来修正；
- 不需要用户逐条审批；
- 不自动转化成用户画像；
- 不写成永久人格宣言；
- 普通对话不注入 Self-note 原文。

Closeout / Reflect 可以低频回读近期 Self-note，形成自我修正闭环。更新 Self Portrait 时必须引用 Episode 等外部事件证据，不能让 Self-note 自证 Self-note。

Self-note 可以记录“想起但没有说”的选择，但这类记录只供未来 Reflect 使用。

### 2.4 Boundary / Task

边界、承诺和任务可以作为 Episode 类型、候选字段或 Re-entry 钩子表达，但不能在多个文件里复制同一句真相。

### 2.5 账本（details）

判据是 `MEMORY_CONSTITUTION.md` 第三条「账本另有人管，我才敢只写感情」：偏好、日程、
纪念日、项目状态、待办这类**客观细节**属账本层，结构化、无人格色彩，
**只进抽屉（默认隐藏 + lookup），永不穿身上**。

落地形态（issue #76）：

- 文件：`<continuityDir>/details.jsonl`，append-only，行键与 `episodes.jsonl` 对齐
  （`detail_id` / `candidate_id` / `decision_id` / `source_ref` / 权限元数据）。
- 分档：**第三档「完全按需」**（`SYSTEM_OVERVIEW.md` 第四节）。不常驻注入、上下文里
  连目录都没有；`hard-context.js` / `reentry-loader.js` / `shared-instructions.js`
  一个字都不读它，由 phase2 的源码边界测试钉住。
- 读取：只走既有受控工具 `memory_lookup`（Phase 5A，`memory-lookup-service.js`），
  沿用它的调用预算与正文截断，不新增工具注册、不新增开关。同分命中时账本排在
  Episode 之后 —— 「我记得的那一次」优先于「查得到的那条细节」。
- 写入：与 Re-entry 同一条发布链 —— candidate（`type: details`）→ Auto Review →
  **History writer 唯一写入**。权限门槛与 `self_note` / `reentry_draft` 相同
  （`author_role: subject_ai` + `semantic_authority: high`），后台代理与提取器只能提
  候选、必须过主体复核（D16）。不新增第二 writer。
- Review：账本条目**豁免祈使句式闸门**（`imperative-style.js` 的
  `IMPERATIVE_EXEMPT_TYPES`）—— 「下次复查 2026-08-03」在账本里是一个字段，
  不是写给明天的我的规则。

账本存在的意义是让 Re-entry 敢只写感情：细节有人接住，遗言就不必清点财产。
**账本里放什么由主体 AI 决定**，本仓库不做自动提取或搬运。

D28 旧后台候选同属第三档：只读 join 原候选与 G2-7 companion，且仅 `EXACTLY_RECOVERABLE` 在当前 `routeToken` / `laneKey` 双匹配时经既有 `memory_lookup` 返回；命中标为「旧后台存量、非你的笔迹」，不进 Re-entry / Current State / `memory_context`，不自动升格。

## 3. 阅读视图，不是第二套真相

### Timeline / Long View

低频整理事件的发展过程，方便人和 AI 回看。

- 不进入普通对话热路径；
- 不与 Episode 两边各写一份真相；
- 不需要每天重建；
- 原始事件和修正关系始终可追溯。

### Rereadings

保存对旧 Episode 的新理解：

- 必须引用原 Episode；
- 追加新理解，不覆盖原事件；
- 默认不进入普通对话；
- 可以在 Reflect 后间接影响 Re-entry 的姿态与措辞。

### Portrait

若继续保留，只能是有证据的当前理解视图：

- 写“反复在意什么”，少写“她是什么人”；
- 画像性 claim 不由 Review AI 替用户确认；
- 需要确认时，在自然对话中求证，用户回答成为证据；
- 被纠正时保留修复史，不静默覆盖。

## 4. 后台过程

### Closeout

每天最多一次，允许无产出。

只提出候选：

- 0–2 条 Episode；
- 0–1 条 Self-note；
- Re-entry 更新建议或 AI 原稿。

### Auto Review

与 Closeout 分开运行，默认由独立 AI 完成。用户不承担日常审核工作。

负责：

- 接受、拒绝、延后或合并；
- 核对来源、重复、冲突和修正关系；
- 检查格式、长度与安全；
- 判断是否需要在自然对话中向用户求证。

Auto Review 是海关，不是编辑：

- 不替主体 AI 决定什么有意义；
- 不按自己的品味重写 Re-entry 或 Self-note；
- 不替用户确认“她是什么样的人”；
- 不覆盖用户确认过的长期边界、重大关系定义或修复解释。

**祈使句式闸门**（issue #36）：以祈使式开头的候选（「以后 / 下次 / 必须 / 要记得 / 别 / 凡是……就」等）
一律打回，决定里带机器可读原因 `imperative_style`，重写的人是原作者。
模式清单在 `src/continuity/imperative-style.js`，是本地正则判断，不由审查模型覆盖。
账本 / `details` 一类结构化条目豁免；引号内转述用户原话不计入。
闸门只改 `result` / `reason`，一个字都不碰候选正文（D16「Review 只拦格式」）。

同一 Candidate 的重复 Review 形成 decision revision 链：新记录带递增的 `review_revision` 与指向前一有效 head 的 `supersedes_decision_id`；旧记录在读取侧按 revision 1、无前驱解释，不重写历史。effective-decision selector 只承认同 Candidate、revision 单调、无缺失前驱、无环且唯一 head 的链；任何歧义都记录 `effective_decision_ambiguous`，History 对该 Candidate fail-closed、不写 canon。

显式开启 `CYBERBOSS_REVIEW_ARTIFACTS_ENABLED` 后，effective `deferred` / `rejected`
在同一个 `review-writer` lease 内同步物化两份 append-only artifact：先写第三档「完全按需」
的 `review/rejection-cases.jsonl`，成功后才写可供未来投递的
`handoffs/envelopes.jsonl`。任一缺口都使本次结果保持 `artifact_complete=false`；后续仍由
同一 Review writer 幂等补齐，不能让 dispatcher 代写。新 envelope schema v2 的
`subject_route` 必填且必须通过 `src/continuity/subject-route.js` 的 EXACT 校验；缺任一
continuity binding / route lane / session 身份都不物化可投递 envelope，不补空对象或默认值。
G2-3 期 schema v1 的缺 route 旧行只在读侧标记为 non-routeable legacy，保留审计可见性，
不得成为 dispatcher 输入。

effective `accepted` 在 decision 与其 decision chain 所需的 envelope/case 全部物化后，
由同一个 Review writer 追加
`decisions/publication-intents.jsonl`。intent ID 由 Candidate + effective decision
稳定派生，携带 candidate lineage root、lineage publication key，以及
decision + candidate + source proof 的 digest；Review 重跑或崩溃补跑只会幂等补齐，
不会改写旧行。该写入面与上述 artifact 共用
`CYBERBOSS_REVIEW_ARTIFACTS_ENABLED` 显式门控，仓库默认关闭。

History writer **只按 intent 发布**，不再扫描 accepted decision 当作交接协议。消费前重新
验证 effective head、digest 与 lineage 唯一性；stale intent、多个 lineage leaf 或 digest
不符都不写 canon。canon 与 History 自己的
`.jobs/history-writer-state.json` 由 History writer 写，intent 永不被 History 回填；
canon 行保存 lineage publication key，因此 History 在 canon append 后崩溃或 writer state
重放时仍能恢复为 exactly-once。`history_publish_refused` 保持为通过上述校验后的最后发布闸
诊断，只写 History state，不与 Review 的 case/intent 合并。

投递与 ack 只在此阶段定义记录边界：`.jobs/handoff-delivery-events.jsonl` 唯一 writer
是 handoff dispatcher，`.jobs/handoff-ack-events.jsonl` 唯一 writer 是 subject context
injector。它们不属于 Review writer 写入面，也不能与 envelope 合成一个多 writer store。
dispatcher、注入与 ack 回路不由 artifact 物化器实现。

520 只提供查看、撤回和异常重审入口，不把用户变成审批员。

### Reflect / Consolidation

低频运行，有足够新证据时才做：

- 重新理解旧 Episode；
- 回读近期 Self-note，发现延续、矛盾或修正；
- 追加 Rereading；
- 更新 Timeline 或 Portrait 视图。

无变化是正常结果。

### Janitor

只负责断档补漏，不是正常的高频记忆作者。

- 扫描漏掉的会话；
- 只写 candidates / extracted；
- 没有断档时不调用模型；
- 不直接写正式 Episode、Timeline、Portrait、Self-note 或 Re-entry。

## 5. Desire 状态

Desire 属于 Cyberboss runtime，不属于关系正史。

- 只有一个 writer；
- `state_log.jsonl` 作为旧历史冻结；
- 520、Closeout、Janitor、关系记忆都禁止写 Desire；
- Current State 可以轻量进入上下文，但不能把数值变成人格规则。

## 6. 520 的位置

520 是可关闭的前端与调试台：

- 查看模块状态与 Context Trace；
- 管理 Prompt 版本；
- 查看后台任务和 Auto Review 决策；
- 切换 Re-entry authoring mode；
- 手动开启测试用的记忆来源滑块；
- 填写 `why_now` 反馈与评测样本；
- 查看、撤回或重审异常记录。

滑块默认关闭，并只控制测试注入/来源开放，不取消用户拉线后的工具式查询能力。

520 不能成为第二个记忆后端，也不能在页面代码中直接发明历史、写 Desire 或绕过唯一 writer 修改 canon。

## 7. 写入权与防重复

- 原始会话：系统自动写，唯一事实来源。
- candidates：Closeout / Janitor 等自动流程写；主体签署候选的唯一可写进程 owner 是主 bridge 内的 `SubjectCandidateService`。`tool-mcp-server` child 只经窄鉴权 IPC 请求主进程复核并落候选，不持有 registry 或可写 service。原始一次性 capability 只在主进程内存中存在，不进 IPC、argv、env、runtime-context、磁盘或日志（D31）。
- `candidates/legacy-candidate-route-bindings.jsonl`：仅离线 `classify-legacy-candidates.js --apply` migration writer 追加；现有 Review / History / dispatcher / closeout 均不写、不读，未来读者还必须受默认关闭的 `CYBERBOSS_LEGACY_CANDIDATE_BINDING_ENABLED` 门控。
- Episode canon：唯一 History writer 按已验证的 publication intent 写。
- 账本 `details.jsonl`：唯一 History writer 按已验证的 publication intent 写（内容仍由主体 AI 执笔）。
- Re-entry：主体 AI 唯一执笔，Auto Review 只校验；canon 有 History writer 发布与 520
  人工保存两个整文件写入点，二者必须共用同一把跨语言 writer lease。
- Re-entry 的 last-known-good 副本（`.jobs/reentry-last-known-good.json`）：唯一 writer 是
  注入侧 loader；属机制状态，不是 canon，不许被当成正史引用。
- 打回 envelope、rejection case 与 publication intent：唯一 Review writer 在同一 lease
  内 append-only 写；History 只读 intent。
- History 消费账 `.jobs/history-writer-state.json`：唯一 History writer 写；不得与
  publication intent 合成一份多 writer store。
- handoff delivery event：唯一 handoff dispatcher 写；handoff ack event：唯一 subject
  context injector 写；二者都不属于 Review writer。
- Self-note：主体 AI 唯一 writer。它有两个写入点（Closeout→Review→History writer 的
  `publishSelfNote`，和聊天中的 `memory_note` 工具），两者共用**同一把** writer lease
  （`CYBERBOSS_WRITER_LEASE_FILE`，缺省 `<continuityDir>/.jobs/MEMORY_WRITER_LEASE.json`，
  由 `src/orchestration/memory-writer-lease.js` 统一解析）。同一份文件出现第二把锁等于没有锁；
  两侧写入都必须**只追加**，不许整读整写回 —— 整写回会把并发落下的那一行连同其余内容盖掉。
- Re-entry 的 History writer 与 Python 520 保存端点共用同一路径契约：显式
  `CYBERBOSS_WRITER_LEASE_FILE` 优先，否则唯一缺省是
  `<continuityDir>/.jobs/MEMORY_WRITER_LEASE.json`。Python 只以排他创建获取、按
  `lease_id` 校验释放；撞锁立即 409，不重试、不判活、不回收。失效 lease 的判活与
  回收权只归 Node writer。
- Desire：唯一 Desire service 写。
- Timeline / Rereadings / Portrait：受控 Reflect writer 更新。
- 520：只调用后端服务，不直接改正式文件。

同一条信息只能有一个事实来源。其他文件若出现，只能作为引用、候选、视图或修正记录。

## 8. 当前实施边界

当前优先跑通硬上下文、Re-entry、后台候选与 Auto Review 边界、Desire 单 writer 和 520 收口。

暂不实现自动 Soft Retrieval、reranker、Memory Family 或 GraphRAG。旧 Episodes 先保证可读、来源不丢、运行不双写，再考虑统一 schema。

关于“记忆如何被体验和使用”的探索记录见 `MEMORY_LIVENESS_NOTES.md`，但该文件不覆盖本文规则。
