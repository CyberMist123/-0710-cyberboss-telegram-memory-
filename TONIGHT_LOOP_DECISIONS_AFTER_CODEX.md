# 今晚连续性循环：Codex 审计后的唯一决策稿

> 状态：当前实现决策 / authoritative for tonight  
> 分支：`design/living-memory-rfc`  
> 来源：GPT-5.6 Sol xhigh 对四分支与现有源码的只读审计  
> 原则：今晚先跑骨架循环；不碰旧部署，不重写 Telegram，不完整上线长期记忆闭环。

## 1. 总结

Codex 判定为：**GO WITH CUTS**。

今晚可实现：

```text
Prompt Registry
+ Context Trace
+ 最小 Context Builder hook
+ 1-2 Memory Contract
+ 1-3 Identity Anchor
+ 2-1 现有 Wake Packet 只读注入
+ 幂等 Job Ledger
+ Desire 唯一 writer
+ 新的薄 520 Console
+ Closeout / Review / Retrieval 的 preview 链
```

今晚不实现：

```text
GraphRAG / Memory Family 正式功能
Timeline / Family Consolidation
Canon 自动发布
Wake 自动发布
Janitor 自动运行
正式检索注入
真实旧数据迁移
旧 dashboard.py 大改
watchdog
legacy Telegram 代理 / offset / 去重 / 关流式补丁
```

“循环跑通”的定义是：所有模块能经过真实调用链、留下 trace 和幂等 job 结果；其中高风险写入模块先只产 preview artifact，不改 canon。

## 2. Codex 发现的四个 P0 根因

1. 当前设计分支只有文档，没有 Context Builder、Registry、Trace 或 Job Ledger 实现。
2. Telegram 当前绕过现有 memory-context 装配，不能假设旧 hook 对 TG 有效。
3. 旧 Cyberboss MemoryService 不仅后台写 memory，还会改写或拦截最终回复；仅关闭 background write 不够。
4. 旧 520 是文件写入者、配置器和 Janitor 调度器，不是可关闭的纯前端。

因此新循环必须独立于旧 memory 决策层和旧 520 后端。

## 3. 用户侧五项决策

### 3.1 Core Persona 唯一来源

今晚采用：

```text
当前实际运行的 Cyberboss 人格内容
→ 只读导入 Prompt Registry，发布为不可变 v1
```

规则：

- 不直接修改上游 `templates/weixin-instructions.md`；
- 不同时维护仓库模板、live instructions 和另一个可变人格文件；
- 网页编辑 1-1 后只对新 thread / 新 continuity epoch 生效；
- 旧版本永久可回退；
- 真实人格正文留在本地私密 state，不提交 GitHub。

### 3.2 今晚接受 system 语义而非真实 system role

当前 Claude Code adapter 通过 opening user turn 前缀承载 instructions。

今晚接受这一协议限制：

```text
system semantic block
≠ API 原生 system role
```

先测行为与连续性，不为追求协议形式改 runtime adapter。未来需要真正 role-separated messages 时单独立项。

### 3.3 Desire 时区与运行窗口

- 时区必须来自显式配置，不能依赖 Windows 当前默认时区；
- 今晚默认 `Asia/Shanghai`，与当前 +08 运行历史兼容；
- 用户赴悉尼后在配置中切换 `Australia/Sydney`；
- slot identity 永远使用 UTC，因此切时区不会产生重复；
- 默认按 24 小时建立 slot；电脑离线时记录 `missed_offline`，不补造八维。

### 3.4 Review 与 Canon 权限

未来允许独立 Review 自动接受并发布：

- 有稳定 source refs 的客观共同事件；
- thread 的完成 / 延后状态；
- AI 自己的追加式 self note。

必须用户确认：

- 长期边界 / 雷区；
- 用户画像 claim；
- 重大关系定义；
- 对冲突与修复史的最终解释；
- permanent anchor；
- 改写或退役用户曾确认的内容。

今晚 Review 只写 decision preview，不发布 canon 或 Wake。

### 3.5 接受今晚 cuts

确认：

- 1-2、1-3、2-1 可正式 `on`；
- 2-2、2-3、3-1、3-2、3-4、4-1、4-2 先 `preview`；
- 3-3、4-4、4-5 正式调度为 `off`；
- 4-3 只有完成唯一 writer 和幂等 slot 后才允许 `on`。

## 4. Context Builder 的唯一接点

推荐形态：relationship-memory extension 内的 optional provider。

调用链：

```text
Telegram adapter（保持原样）
→ prepareIncomingMessageForRuntime
→ buildRuntimeTurn
→ continuityProvider.prepareTurn
→ runtimeAdapter.sendTurn
→ continuityProvider.finalizeTrace
→ stream-delivery（保持原样）
```

唯一接点：`dispatchPreparedTurn()` 内，`buildRuntimeTurn()` 之后、`sendTurn()` 之前。

明确禁止修改：

```text
telegram.js
telegram-utils.js
telegram-service.js
stream-delivery.js
proxy
Telegram offset
inbound / outbound dedupe
原版 delta 流式
```

故障策略：**fail open**。Context Builder 出错时发送原始 `runtimeTurn.text`，只记录失败 trace，不能阻断 TG。

## 5. 模块顺序修正

正确顺序：

```text
3-1 Retrieval
→ 3-3 Graph / Family Expansion
→ 3-2 Reading Policy
→ 3-4 Memory Note Injection
```

Graph Expansion 必须在 Reading Policy 前，否则新增的图扩展内容会绕过筛选。

今晚 3-3 保持 `off`，因此 preview 路径为：

```text
3-1 Retrieval preview
→ 3-2 Reading Policy preview
→ 3-4 Injection preview
```

## 6. Prompt Registry

使用：

```text
continuity/
├─ registry.json
├─ prompts/
│  └─ <module-id>/<version-id>-<sha256>.md
└─ state/continuity.sqlite
```

规则：

- prompt version 文件不可变；
- registry 只指向当前版本；
- 回退只切指针；
- mode、budget、prompt pointer 使用同一个 registry generation；
- 更新需要 expected generation / parent hash；
- Builder 一整轮固定使用同一个 generation；
- 热更新只影响下一轮；
- 1-1 只对新 thread 生效；
- Identity、Wake、Boundaries 是私人状态，不是 prompt 正文。

## 7. Context Trace

每轮至少记录：

```text
trace_id
continuity_epoch
lifecycle reason
registry generation
模块 mode / decision / reason
source version / content hash
chars / token estimate
retrieval candidate / passed / suppressed 数量
fallback_used
runtime / model / status / error
```

默认不持久化用户消息、私人 memory、prompt 正文或模型回复正文。

520 默认只看 metadata、hash、字数和原因。实际内容只允许短 TTL 调试展开。

## 8. Desire 幂等

唯一 key：

```text
desire:<scope-id>:<slot-start-utc>
```

唯一 writer：Desire Activity Service。

状态：

```text
queued → running → recorded
                 ↘ failed
missed_offline
```

禁止写 Desire 的模块：

- `app.js` 旧直接写路径；
- 520；
- Closeout；
- Janitor；
- watchdog；
- `state_log.jsonl` API。

SQLite 是历史事实源；`desire-current.json` 只是可重建兼容视图。`state_log.jsonl` 冻结只读。

## 9. Closeout / Review Preview

今晚：

```text
Closeout
→ 冻结 input watermark
→ 生成不可变 candidate-set preview
→ 允许 0 产出

Independent Review
→ 独立 job
→ 独立模型调用
→ 生成 append-only decision preview
→ 不写 canon / timeline / portrait / Wake
```

幂等 key：

```text
closeout:<scope>:<calendar-id>:<local-date>
review:<scope>:<candidate-set-hash>:<review-policy-version>
```

提取与审核必须是两个不同模型请求。

## 10. 新 520 的边界

今晚新建薄 520，不直接改旧 `dashboard.py` 后端。

复用：

- 本机 `127.0.0.1:520` 人类入口；
- 页面导航、卡片和部分视觉结构。

新 520 只通过 Continuity Backend API：

- Modules；
- Prompt versions / diff / rollback；
- Context preview / trace；
- Jobs / health；
- Desire slot 状态；
- Closeout / Review preview；
- orphan scan。

冻结旧端点：

```text
/api/save
/api/state_log
/api/episode_candidate
/api/janitor/run
/api/config
care 写端点
任意正式 memory 文件编辑
旧 dashboard 内自动 Janitor
```

关闭 520 前端后，TG、Context Builder、Activity Worker 和 job ledger 必须继续运行。

## 11. 实现顺序

```text
Step 0  干净目录基线 + 旧部署冻结
Step 1  Continuity Backend + SQLite + 全模块 off
Step 2  Prompt Registry + generation / immutable versions
Step 3  Context Builder trace-only，outbound text 完全不变
Step 4  开启 1-2、1-3、2-1
Step 5  Activity Worker + Desire 唯一 writer / slot ledger
Step 6  Closeout / Review preview
Step 7  新薄 520
Step 8  orphan scan + 全链路 smoke test
```

任何一步若要求修改 Telegram adapter、stream、offset、proxy 或 dedupe，立即停止。

## 12. 今晚 Definition of Done

### Telegram

- 十条普通消息各回复一次；
- 两条完全相同文本也都回复；
- 原版流式不变；
- Context/520 关闭后 TG 仍可用。

### Context

- 单一 optional provider 接点；
- Builder 失败时 fail-open；
- Wake 同一 continuity epoch 只注入一次；
- 正式注入只开 1-2、1-3、2-1；
- 其他模块有真实 preview trace。

### Desire

- 唯一 writer；
- 同一 UTC slot 并发触发只执行一次；
- retry 沿用同一 key；
- 离线为 `missed_offline`；
- `state_log.jsonl` 字节不变。

### Closeout / Review

- 只做 preview；
- 0 产出是成功；
- 提取与审核是两次独立请求；
- 不写 canon / Wake；
- 同一 input 重跑返回相同 artifact。

### 520 / 数据健康

- 520 只是 API 客户端；
- 关闭后核心继续；
- 旧写端点和 auto Janitor 不启用；
- continuity root orphan scan 为 0；
- watchdog 不启用；
- 不读取或迁移真实旧 memory。

## 13. 下一步

本文件优先级高于早期 `TONIGHT_LOOP_FRAMEWORK.md` 中与之冲突的内容。

下一步先让 Fable 只审：

- 1-1 / 1-2 / 1-3 / 2-1 的内容预算；
- 这些模块是否会造成表演式连续性；
- 哪些边界应该进入 Wake；
- preview 的 Reading Policy 是否符合“该想起时想起，不该提时闭嘴”。

Fable 不审数据库和调度实现，也不改代码。