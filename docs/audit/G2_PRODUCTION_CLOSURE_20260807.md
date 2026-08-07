# G2 生产闭环：episode 写链首次真机全链通过

```text
Status: active
Date: 2026-08-07
Base SHA: 9060b75（main）；上机 SHA 见下方各次交付
Audited SHA: 9060b75
Current authority: docs/CURRENT_STATUS.md
```

## 结论

**她第一次自己签出一条 episode，并经 Review → History 落进正档。**

`memory\candidates\episodes.candidates.jsonl` 此前 127 条全是后台 `live_closeout`，
带 `content_sha256` 的 **0 条**。这次那条是第 128 条：`origin=live_subject`，
**史上第一条带服务端 provenance 的候选**。

## 五步 durable identity（不看 exit code，只追同一个 id）

| # | 判据 | 实测 |
|---|---|---|
| 1 | 候选落盘 | `cand-540fc316ec05df7868f4`，`origin=live_subject`，`author_role=subject_ai`，`semantic_authority=high` |
| 2 | 服务端取证 | `source_ref` 含 `source_entry_ids` / `source_entry_hashes` / `content_sha256`，`file` 指向真实会话档 |
| 3 | Review | `accepted`，**`source_ref_located=true`**（此前每条 live 候选恒判 `source_ref_missing`） |
| 4 | publication intent | `intent-85e9d254275a878341d8` |
| 5 | History → 正档 | `written` 含 `decision-ca87a18cdb22ac1216e3`；`episodes.jsonl` 出现该 candidate_id |

## 修了三处，都是「离线全绿、生产走别的路」

### 1. 取证入口（第五处接线债）

D35 把候选出处改成主进程随记随取证，但那段只写在 `handleIncomingMessage` —— **那是微信入口**。
生产走 `handleTelegramMessage`，只调 `recordInboundMessage` 就走、返回值丢掉。
于是 `subjectSourceEntryId` 恒空 → capability 永不签发 → 子进程 submit 死在
`subject_signing_turn_unknown`，err.log 每条消息打一次 `subject_source_entry_id_missing`。

取证移进 `recordInboundMessage`：录制是两个入口唯一都会走的一步。

### 2. 登记时序竞态（GPT 审出）

`dispatchPreparedTurn` 是 `await sendTurn()` 返回后才签发 capability、再写 active context；
而 claudecode 的 `sendTurn()` 在返回**之前**已执行 `sendUserMessage()`——消息那时已进子进程。
`SubjectSigningBroker.submit()` 却要求 active context 已存在且 `turnActive=true`，
再用它里面的 threadId+turnId 查 capability。命中时是偶发的
`subject_signing_turn_inactive` / `subject_signing_turn_unknown`，普通纯文本一样中招。

改法只动时序：`process-client.sendUserMessage` 在 turnId/threadId 已定、`stdin.write`
未发生处加 before-write seam。新会话的 threadId 要等子进程回报，此时**主动弃权**而非
半登记（半登记会让 broker 吃 `subject_signing_thread_missing`），由原有 post-send 登记兜底。

### 3. exactly-once 冷启动缺口（本次开关打开时当场发生）

已发布判据只认 `publication_key`，而旧机制写的正档行只有 `candidate_id` + `decision_id`。
`CYBERBOSS_REVIEW_ARTIFACTS_ENABLED` 首次打开时，Review 给每条 accepted 决定新造 intent
（含早已发布的），History 一看 intent 没消费过就照发——**两条 7 月 episode 与一条 self-note
被写进正档第二遍**。

`publishedCandidates` 本就从 canon 行自身重建，一直被算出来却没参与判断；现把守卫另一半接上。

**数据已修复**：`episodes.jsonl` 去重回到 20 行（原 19 行逐行原样 + 本次 canary 那条），
`ai_self_notes.md` 按备份还原，各留 `.bak-20260807-preduperepair`。
`reentry.md` 被同一次发布改写，按 Owner 裁定还原为占位符，被发布那版留
`reentry.md.bak-20260807-published-draft`。

## 生产配置变更（各留备份）

| 行 | 说明 |
|---|---|
| `CYBERBOSS_REVIEW_ARTIFACTS_ENABLED=1` | 任务书批次 A 明列 |
| `MEM_PROVIDER` / `DS_API_KEY` / `DS_MODEL=deepseek-v4-flash` | Auto Review 模型；同批删去 `CYBERBOSS_AUTO_REVIEW_MODEL=off` |
| `CYBERBOSS_WINDOW_OPEN_GREETING_ENABLED` | `/new` 主动第一句；**当晚发现路由错误后改回 0**——系统消息走独立 sys lane（legacy profile），那句话没有人格也没有开窗上下文，详见 `workdesk\20260807-window-handover-w20.md` |
| `CYBERBOSS_TRIGGER_PROMPTS_DIR` | 触发提示词可编辑目录 |

**首次跑 Review 的追溯效应**：122 条遗留 deferred 决定一次性 materialize
（121 条 `subject_route_partial` + 1 条 `reason_code_not_machine_determinable`）——
那批 7 月 `live_closeout` 候选早于 `subject_route` schema，结构上产不出 handoff envelope。
不是新缺陷。`shouldRunHistory` 只看 `status==="success"`、不看 `artifact_complete`，故不阻塞发布。

## 交付与验证

| 交付 | SHA | D5 逐字节比对 |
|---|---|---|
| 第二十次 | `ef926cf` | 159 文件 0 差异 |
| 第二十一次 | `aaf2f74` | 159 文件 0 差异 |
| 第二十二次 | `47b62b3` | 159 文件 0 差异 |
| 第二十三次 | `9060b75` | 160 文件 0 差异 |

每次 bridge 唯一实例、`tool-mcp-server` 存活、watchdog `healthy`、err.log 增量仅一行 startup。
本机 PowerShell 13 组阻塞测试 13/13 绿 + precheck。

**descriptor 的 `deployed_sha` 全程谎报 `fa59679`**（issue #77），判部署真相只看 D5。

## 仍缺

- G2-7 真实存量执行、G2-8 睡眠兜底
- nightly 仍为 evidence 档：**不跑 Review/History**，需 `scripts/continuity/run-phase3.js review|write` 手动入口
- 122 条遗留候选的 handoff envelope 永远产不出（缺 `subject_route`）
- Review 的 deferred **粘住**：候选一旦有决定，普通 `review` 即跳过，必须 `--candidate-id=<id>` 显式重试
