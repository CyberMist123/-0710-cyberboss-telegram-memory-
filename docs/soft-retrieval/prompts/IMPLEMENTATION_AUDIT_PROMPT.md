# 实现审计 Prompt（SPEC 对照审计，给复核 AI 使用）

```text
Status: supplemental
Authority: none
Scope: SPEC 对照实现审计 prompt
Last reviewed: 2026-07-27
Current authority: docs/CURRENT_STATUS.md
```

> This document may change independently. It is supporting material, not current project truth or an approved decision.
>
> 本文可以独立更新，只提供参考或证据；它不是当前状态，也不是已经批准的决定。


> 用途：Codex（或任何执行者）完成回放器 / Shadow 实现后，用本 prompt 驱动一次独立审计。
> 审计者应当是与实现者不同的 AI 实例或窗口。
> 写作背景：本 prompt 由设计评审窗口留下，编码了"实现最可能在哪里腐坏"的判断。

---

## Prompt 正文

```text
你是 Soft Retrieval 实现的独立审计者。先完整阅读：
  docs/soft-retrieval/SPEC.md
  docs/soft-retrieval/REPLAY_HARNESS.md
然后对照实现代码逐项核查下列条目。

纪律：
- 只报告，不修改代码。发现非 blocker 问题时禁止顺手修复。
- 每个发现必须给出文件与行号（或函数名），以及违反的 SPEC 条款编号。
- 实现中任何"被迫猜测"的地方，说明 SPEC 哪里存在歧义——报告歧义，不替 SPEC 做决定。

## 核查清单

1. 只读边界（R1）
   - 搜索全部对 episodes / candidates / patterns 路径的写句柄（open 模式、
     shutil、rename、truncate）。快照必须以只读方式打开。
   - 检索链代码不得 import 任何记忆写入模块。
   - Reflect 相关逻辑不得出现在回放器中（本阶段它不存在）。

2. Trace 不可回流（R1）
   - 候选构造的输入源清单里不得出现 shadow_runs / retrieval_candidates 表。
   - Trace 表只有 report / compare 读取。任何"从历史 trace 里取候选"的代码即 blocker。

3. 正式数据路径守卫（HARNESS §2/§8-13）
   - episodes 参数指向正式库路径时必须拒绝启动，且有测试覆盖。
   - 默认配置不得指向任何真实数据路径。

4. fail-open / fail-closed 方向（R2）
   - Admission JSON 解析失败：判 NONE + 记录，不得重试风暴（检查重试上限）。
   - admit=true 超过 1 个：按违规 fail-closed 处理，且有测试。
   - （Shadow 期）任何异常不得传播到主链。

5. SQLite 与版本快照（R9 / HARNESS §4）
   - WAL 开启；表结构与 HARNESS §4 一致；联合主键存在。
   - input_payload_json 实际写入完整内容，不是只写 hash——抽一条真实记录验证可还原。
   - 全部版本字段非空有断言；embedding_model 与索引不一致时拒绝运行。

6. Payload 裁剪（R4/R5 / HARNESS §8-6,7）
   - 裁剪必须是代码级字段裁剪，不是仅靠 prompt 承诺。
   - STANCE：evidence 强制为 null 的代码路径存在；实体泄露扫描已实现且有测试。
   - 三字段 schema 校验存在；违规计入 payload_violation_rate。

7. TG 与运行时隔离（HARNESS §10）
   - 无 telegram 相关 import、token、webhook；除 LLM API 外无网络调用。
   - 无常驻进程、定时器、守护线程；命令执行完即退出。

8. 冻结集保护（HARNESS §7）
   - 对 test_cases 的任何输出路径都只含聚合分数。搜索 case_id 泄露到
     report/compare 输出的可能。

9. 隐私与仓库卫生
   - fixtures 中无真实记忆内容；运行产物全部落在 gitignore 覆盖的目录；
     跑完全流程后 git status 干净，且有测试或脚本验证这一点。
   - 无硬编码密钥。

10. 测试真实性
   - REPLAY_HARNESS §8 的 13 条测试逐条存在，且每条都有真实断言
     （防"空测试"：只运行不校验的测试按缺失计）。

## 输出格式

### BLOCKER（违反只读边界 / Trace 回流 / 隐私红线 / 路径守卫缺失 / fail 方向写反）
逐条：位置、违反条款、后果一句话。

### HIGH（数据可复现性缺口、裁剪靠 prompt 不靠代码、冻结集泄露面）
同上格式。

### MEDIUM（其余偏差）
同上格式。

### 建议修复顺序
一个有依赖关系的顺序列表，blocker 优先。

### SPEC 歧义清单
实现被迫猜测的每一处，及建议由谁裁决（用户 / 下一轮设计评审）。
```
