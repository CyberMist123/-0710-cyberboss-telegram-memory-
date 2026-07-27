# 离线回放器（Replay Harness）工程规格

```text
Status: supplemental
Authority: none
Scope: 离线回放器工程规格
Last reviewed: 2026-07-27
Current authority: docs/CURRENT_STATUS.md
```

> This document may change independently. It is supporting material, not current project truth or an approved decision.
>
> 本文可以独立更新，只提供参考或证据；它不是当前状态，也不是已经批准的决定。


> Soft Retrieval 第一个允许实现的组件。实现时机：阶段 0–4 全部通过 + 用户确认。
> 代码位置：`tools/soft-retrieval-replay/`（src/ 与 tests/）。文档目录里只放文档。
> 它是一个测试台：用固定输入离线运行"检索 → 判定 → 载荷生成"链，比较不同配置的成绩。
> 它不连 Telegram、不读实时对话、不写任何记忆、不注入任何回复、不启动常驻进程。
> 代码写错的最大代价是实验作废，不是伤害真实对话。

---

## 1. 它回答什么问题

- RRF 和 dynamic α，哪个把该找到的记忆排得更靠前？
- 新版 Admission prompt 有没有比旧版更克制、更准？
- **生成的载荷是否守规矩**——STANCE 有没有泄露事件细节、有没有偷偷写成结论或指令？
- 改动一个参数后，以前做对的案例有没有变错（回归）？

任何公式或 prompt 改动，必须先在回放器上出报告，才允许进入 SHADOW 配置。

## 2. 输入

**记忆快照**：可信 Episodes 的只读副本（真实数据放私有目录；进仓库的只能是脱敏样例）。回放器只接受"快照路径"参数，参数指向正式 episodes.jsonl 本体时拒绝启动。

**测试案例**（cases 文件，jsonl，每行一条）：

```json
{
  "case_id": "c-0001",
  "case_type": "explicit_recall | implicit_cue | chitchat_zero | related_but_no |
                superseded | time_scoped | emotional_bait | private_code | near_dup_crowd",
  "context": ["最近几轮对话原文，按序"],
  "query": "当前这轮用户消息",
  "expected_mode": "NONE | STANCE | LIGHT | EXPLICIT | HIGHLIGHT",
  "positive_ids": ["该被找到并放行的 episode id"],
  "negative_ids": ["语义相关但不该放行的 episode id"],
  "reason": "为什么该 / 不该",
  "label_source": "human | reviewed_ai | synthetic",
  "vintage": "2026-07"
}
```

案例分三个集合，物理分开存放，**可见性规则不同**（见第 7 节）：

```text
dev_cases        日常调参。可随意查看，报告可显示逐案例明细。
test_cases       冻结。报告只输出聚合分数，不显示 case_id、正文、标签或具体失败项。
challenge_cases  难例：修正链、过期理解、强情绪诱饵、隐性线索等。可显示明细。
synthetic_*      由 Episode 自动派生的合成案例，只进 dev，禁止进入冻结集。
```

`vintage` 必填：用户语言会随系统变好而变省略，评测集需要按时期重采。

以上是物理存放与命名的组织约定；实现层面 `report`/`compare` 是否按冻结集处理
（见第 7 节）由每条 case 自带的 `case_set_frozen` 元数据字段判定，不读文件名——
文件名可以被改名绕过或误判，见独立审计修复。

## 3. 运行流程与命令行接口

```text
replay index  --episodes <快照路径> --config <yaml>     # 建索引（embedding + BM25）
replay run    --config <yaml> --cases <cases路径> --out <run_id>
replay compare <run_id_A> <run_id_B>                    # 两份配置的成绩对比报告
replay report <run_id>                                  # 单次运行报告
```

`run` 的内部流程，每条案例依次执行：

```text
读 context + query
→ 候选检索（配置指定的融合方案）
→ 多样化压到 10 条
→ Admission 调用（一次调用判断全部候选）
→ 若放行：生成结构化载荷（至多 1 条，见 SPEC R3/R4/R5）
→ 记录：候选排名、decision、选中条目、载荷、完整输入、原始输出
→ 写入 SQLite
```

配置文件（soft_retrieval.yaml）必须完整决定一次运行的全部行为：融合方案与参数、多样化方案、admission prompt 版本、admission model、top-k 等。

## 4. SQLite 最小表结构

```sql
-- 每次 replay run 中每条案例一行（shadow 期 case_id 换成 message_id）
CREATE TABLE shadow_runs (
  run_id TEXT, case_id TEXT,
  ts TEXT,
  conversation_snapshot_hash TEXT,
  episode_canon_version TEXT, embedding_model TEXT, index_version TEXT,
  retrieval_config_version TEXT, admission_prompt_version TEXT,
  admission_model TEXT, response_model TEXT,        -- replay 期 response_model 可为 NULL
  delivery_schema_version TEXT,
  input_payload_json TEXT,                          -- 实际送给 Admission 的完整输入，必存
  decision TEXT,                                    -- 单值：NONE/STANCE/LIGHT/EXPLICIT/HIGHLIGHT
  selected_episode_id TEXT,                         -- 至多一条；NONE 时为 NULL
  delivery_payload_json TEXT,                       -- 实际生成的结构化载荷；NONE 时为 NULL
  raw_output TEXT,                                  -- Admission 原始输出全文，必存
  PRIMARY KEY (run_id, case_id)
);

-- 每条候选一行
CREATE TABLE retrieval_candidates (
  run_id TEXT, case_id TEXT, episode_id TEXT,
  rank INTEGER, fusion_score REAL, vector_score REAL, bm25_score REAL,
  admitted INTEGER,                                 -- 0/1；每 (run_id,case_id) 至多一个 1
  reject_reason TEXT, why_now TEXT,
  would_request_full_text INTEGER,
  PRIMARY KEY (run_id, case_id, episode_id)
);

-- 复核后的可信标签（三层评测的第二层）
CREATE TABLE verified_cases (
  case_id TEXT PRIMARY KEY,
  verified_mode TEXT, verified_positive_ids TEXT, verified_negative_ids TEXT,
  verdict_source TEXT,                              -- reviewer_ai / user
  note TEXT, verified_at TEXT
);

-- 每次评测汇总
CREATE TABLE eval_runs (
  run_id TEXT PRIMARY KEY, config_hash TEXT, cases_file TEXT,
  none_rate_by_type TEXT,                           -- JSON：按 case_type 分层
  hit_at_5 REAL, hit_at_10 REAL,
  block_rate REAL, admit_rate REAL, mode_accuracy REAL,
  payload_violation_rate REAL,                      -- 载荷违规率（泄露/结论/指令）
  concentration_top1 REAL,
  created_at TEXT
);

-- 索引版本登记
CREATE TABLE index_versions (
  index_version TEXT PRIMARY KEY, embedding_model TEXT,
  episode_count INTEGER, built_at TEXT, episodes_snapshot_hash TEXT
);
```

`meta.json` 是回放器加载时使用的完整性 manifest；`index_versions` 只保留构建与审计留痕，
不参与当前加载过程的联合校验。

## 5. Admission 输入 / 输出 schema

**输入**（一次调用判断全部候选；此 JSON 即 `input_payload_json` 存档内容）：

```json
{
  "context": ["最近几轮对话"],
  "query": "当前消息",
  "explicit_recall": false,
  "candidates": [
    {
      "episode_id": "ep-x",
      "summary_key": "一句话摘要（派生键，非正文）",
      "event_time": "...",
      "lane": "episode",
      "reliability": "canon | candidate",
      "superseded_by": null
    }
  ]
}
```

**输出**（严格 JSON，解析失败按 fail-closed 处理并记录）：

```json
{
  "decision": "STANCE",
  "selected_episode_id": "ep-x",
  "delivery_payload": {
    "evidence": null,
    "question": "当前是否仍涉及需求被默认忽略，需要从本轮继续判断。",
    "constraint": "当前原因尚未确认；旧模式不得作为本轮结论。"
  },
  "per_candidate": [
    {
      "episode_id": "ep-x",
      "admit": true,
      "current_evidence": ["当前对话中的原句，放行时必填"],
      "missing_if_ignored": "不读会丢失什么；说不清则必须拒绝",
      "risk_if_used": "使用它的风险",
      "why_now": "……",
      "reject_reason": null,
      "would_request_full_text": false
    }
  ]
}
```

硬条件（写入 prompt 并由代码校验）：
- `decision` 单值；`admit=true` 至多一个；两者必须一致（decision=NONE 时 selected 与 payload 均为 null）。
- `current_evidence` 必须引用当前对话原句；`missing_if_ignored` 说不清则拒绝；只能说"可能相关"时默认拒绝。
- `delivery_payload` 遵守 SPEC R4 三字段结构与 R5 分级限制；`constraint` 是认知边界，不是行为指令。

## 6. 指标定义

```text
none_rate_by_type  按 case_type 分层的 NONE 占比。诊断指标，不设统一目标。
                   期望：chitchat_zero 接近 1.0；explicit_recall 接近 0；superseded 旧版本放行率接近 0。
hit@k              positive_ids 出现在候选前 k 名的比例（检索层）
admit_rate         positive_ids 被放行的比例（判定层）
block_rate         negative_ids 被拒绝的比例（关键指标）
mode_accuracy      expected_mode 与 decision 一致的比例
payload_violation  载荷违规率：STANCE 泄露实体 / 出现结论或指令句式 / 超出模式内容范围
concentration      单一 episode 被放行的最高占比（回音壁预警）
```

## 7. 冻结集可见性规则

- `dev_cases / challenge_cases`：`report` 与 `compare` 可显示逐案例差异与全部明细。
- `test_cases`：任何命令只输出聚合分数。不显示 case_id、正文、标签、具体失败项或逐案例差异。
- 最终验收测试可由独立 evaluator（另一个 AI 实例）运行并只回传聚合结果，实现者不接触答案。
- 实现细节：判定依据是每条 case 的 `case_set_frozen: true` 元数据字段（只要
  cases 文件里任意一条声明为 true，整份按冻结集处理），不是文件名——冻结集
  换个文件名不会失去保护，dev 集也不会因为文件名撞上 `test_cases` 而被误保护。

**目的** `compare` 的逐案例差异是最有信息量的调参输入——这正是它绝不能碰冻结集的原因，否则测试集迟早被调参调成训练集。

## 8. 测试清单（实现时的单元测试底线）

```text
 1. 融合确定性：同 config 同输入，两次运行候选排名完全一致
 2. 中文分词：自定义词典中的暗语不被切碎（用占位假暗语测试）
 3. 分数隔离：BM25 与 cosine 分数不直接相加（RRF 只消费排名）
 4. JSON 兜底：Admission 返回畸形输出 → 记录失败、判 NONE、不崩溃
 5. 单条放行守卫：admit=true 超过 1 个 → 判违规输出，按 fail-closed 处理并记录
 6. 载荷裁剪：STANCE 载荷 evidence 必为 null，且全文不含所选 Episode 的任何实体词
 7. 载荷句式：delivery_payload 三字段通过 schema 校验；抽样检查无结论/指令句式
 8. 只读守卫：运行全程对 episodes 快照无写操作（以只读权限打开）
 9. 快照完整：每条运行记录的版本字段与 input_payload_json 全部非空
10. 冻结集保护：对 case_set_frozen 元数据为 true 的案例集，任何命令不输出逐条明细
11. embedding 版本守卫：索引的 embedding_model 与 config 不一致时拒绝运行
12. UTF-8：含中文与 emoji 的案例全链无乱码
13. 目录守卫：episodes 参数指向正式库路径时拒绝启动
```

## 9. 验收标准

可复现性分三档，不混为一谈：

- **检索排名**：完全确定性。同 config + 同快照 + 同 cases，任何机器上排名逐位一致。
- **Admission 单元测试**：使用固定 mock / fixture，必须完全复现。
- **真实模型回放**：输入必须可完整复述（input_payload_json）；输出与指标只要求落在允许偏差范围内——托管 LLM 即使 temperature 0 也不保证逐字复现，原始输出必存即为此。

其余验收：

- 全部单元测试通过。
- 用 20 条人工标注案例（每种 case_type 至少 1 条）跑通 `index → run → report → compare` 全流程。
- `compare` 能对 RRF 与 dynamic α 两份配置给出分组指标，并对 dev/challenge 集列出逐案例差异。
- 全程未产生对快照目录与仓库的任何写入（除 SQLite 输出目录）。

## 10. 禁止事项（与 SPEC 一致，此处重申给实现者）

```text
连接 Telegram 或任何实时对话
读取或写入正式 episodes.jsonl 本体
写入任何记忆结构（episodes / candidates / patterns）
将 Trace 作为检索源
实现独立证据判定、模式置信度等模式治理逻辑（字段埋，算法不做）
注入主模型
启动常驻进程
将真实记忆数据或 Trace 提交进 Git
代码放入 docs/ 目录
```
