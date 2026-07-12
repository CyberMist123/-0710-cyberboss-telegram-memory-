# Cyberboss 项目更新日志

> 这是整个 Cyberboss 项目的统一版本本，不只记录记忆流水线。
>
> 请勿删除历史条目。发现旧记录有误时，追加“修正”说明，不静默覆盖。

## 这份日志怎么看

状态标记：

- ✅ 已完成并有验证结果
- 🟡 已提交到 GitHub，等待本地验证
- 🔒 尚未部署到运行环境
- ⚠️ 有已知限制或风险
- 🧪 仅使用临时数据 / Mock 测试

每次更新至少记录：

1. 日期与版本；
2. 改了什么；
3. 涉及的模块与文件；
4. Git 分支和提交 SHA；
5. 测试结果；
6. 是否部署；
7. 回滚点；
8. 尚未完成的事项。

## 当前项目位置

- 正式默认分支：`main`
- 当前实施分支：`impl/codex-cheap-prework-20260711-170034`
- 长期设计分支：`design/living-memory-rfc`
- `main` 当前仍不是最新实施代码，不能直接把实施分支删除。
- 当前工作原则：GitHub 小步提交 → 本地同步 → 离线测试 → 明确验收 → 再部署。
- 真实 119 条候选记忆暂不批量运行。
- Nightly 自动 Review / 发布在模式门完成前保持停用。

---

## 2026-07-12 · v0.4 · 模型可读时间格式

**状态：🟡 🧪 🔒**

### 修了什么

给模型看的时间统一显示为：

```text
YYYY-MM-DD HH:mm
```

例如：

```text
2026-07-11T23:59:59+08:00
→ 2026-07-11 23:59
```

本次只修改显示层：

- Closeout 给后台模型看的对话材料；
- `memory.lookup` 返回给主体模型的 Episode 时间。

没有迁移旧记忆，没有重写内部日志，也没有做时区换算。

### 提交

- `e0a97a0`：增加统一时间显示工具；
- `633a873`：Closeout Prompt 使用易读时间；
- `310e1de`：记忆查询结果使用易读时间；
- `cae16c1`：增加离线测试。

### 主要文件

- `src/core/readable-time.js`
- `src/continuity/background-author.js`
- `src/services/memory-lookup-service.js`
- `test/readable-time.test.js`

### 测试与部署

- GitHub 侧：代码与测试文件已提交；
- 本地测试：尚待运行确认；
- 真实模型调用：没有；
- Runtime 部署：没有。

### 回滚点

- 改动前：`51beea95fe5bbe72048d2c2a5be196775ab1a9c7`
- 当前版本：`cae16c194b7724a1cffae0585bdcd9d0c8e85918`

### 开发者碎碎念

这次故意不做“大一统时区系统”。先把模型看到的时间改得顺眼、易读，避免为了小显示问题翻修整个 Dashboard 和历史数据。

---

## 2026-07-12 · v0.3 · Review 中断续跑 V1

**状态：🟡 🧪 🔒**

### 修了什么

旧 Review 会先在内存里处理整批 Candidate，全部结束后才统一写 Decision。中途停止时，已经完成的审核也会丢失。

V1 改为 checkpoint 方式：

```text
一条 Candidate
→ 生成一条 Decision
→ 立即落盘
→ 再处理下一条
```

重跑时跳过已有 `candidate_id` 的 Decision。

### 提交

- `13b4d74`：建立初版记忆 loop 工作记录；
- `51beea9`：Phase 3 runner 接入 checkpoint Review。

### 主要文件

- `src/continuity/review-checkpoint.js`
- `scripts/continuity/run-phase3.js`
- `test/phase3-review-checkpoint.test.js`

### 测试与部署

- 测试设计已覆盖：中断保存、续跑、避免重复、指定 Candidate 重试；
- 本地测试：尚待正式确认；
- 真实 Candidate：没有处理；
- 真实模型 API：没有调用；
- Runtime 部署：没有。

### 回滚点

- 改动前：`13b4d7483db570d2ba00354b27eac4c50a16f193`
- V1：`51beea95fe5bbe72048d2c2a5be196775ab1a9c7`

### 已知限制

当前 Nightly 仍可能调用 `run-phase3.js all`。在 `manual | shadow | auto` 模式门完成前，不部署这条新流水线到真实运行环境。

---

## 2026-07-12 · v0.2 · Writer Lease 死进程恢复

**状态：✅ ⚠️**

### 修了什么

当旧 writer 进程已死亡但 lease 文件残留时，后台记忆任务会一直认为写入权被占用。

现在支持：

- 死 PID 的 stale lease 安全恢复；
- 活着的 owner 不被抢占；
- 损坏 lease 不被冒险删除；
- stale lease 归档后再继续。

### 提交

- `bac410f74bebd0f04c37d15cdeb37188089b9261`

### 验证记录

已有阶段报告记录 writer-lease、Phase 3 和 Dashboard 冻结测试通过；这份全项目日志建立时没有重新执行这些测试。

### 部署状态

writer-lease 修复曾同步到本地 runtime 文件；Telegram 是否已由该 SHA 重启加载，需要单独确认，不能仅凭文件存在认定已生效。

---

## 2026-07-11 至 2026-07-12 · 历史实施节点

**状态：⚠️ 待补齐证据**

这些节点已有提交，但旧阶段的测试、部署和回滚信息尚未完整搬进本日志：

- `8c47734`：上下文 gates、poller 与 Desire 相关修复；
- `e97fde1`：记忆连接相关实施；
- `bac410f`：writer lease 恢复与安全边界；
- `13b4d74`：建立局部 worklog；
- `51beea9`：Review checkpoint；
- `cae16c1`：模型可读时间显示。

后续只在找到可核对的提交、测试输出或部署记录后补写，不凭印象扩写历史。

---

## 接下来

### v0.5 · Nightly 模式门

计划加入：

```text
manual | shadow | auto
```

默认 `manual`：只收集材料，不自动 Review，不发布正式记忆。

### v0.6 · Candidate 来源与语义权限

需要区分：

- 活跃对话中的主体 AI 原稿；
- Nightly 同人格后台草稿；
- Janitor 小模型提取的证据材料。

Janitor 应负责发现和保住漏档，不应默认替主体 AI 写正式 Episode。

### v0.7 · 小规模完整链路测试

使用虚构 Candidate 测试：

- accepted；
- deferred；
- duplicate / merged；
- 重跑不重复发布。

真实 119 条 Candidate 继续冻结，直到 Prompt、权限和模式门明确。

---

## 通用回滚规则

本地尚未共享的改动，可以回到已接受 SHA：

```powershell
git -C "C:\Users\18717\Documents\cyberlink\cyberboss-codex-cheap-prework-20260711-170034" reset --hard <accepted-sha>
```

已经推送并被其他环境使用的提交，优先：

```powershell
git revert <bad-commit-sha>
```

禁止对 `main` 强制推送。
