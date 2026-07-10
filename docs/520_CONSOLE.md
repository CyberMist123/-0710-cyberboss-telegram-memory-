# 520 Console

> 状态：功能说明，尚未按新边界完成实现  
> 520 是查看、调试和审核前端，不是记忆后端。

## 一句话

关掉 520 后，Telegram、Context Builder、Desire、Closeout 和 Review 仍然应该继续运行。

## 首页要让人一眼看懂

首页只用人话回答：

```text
TG 是否正常
本轮实际加载了什么上下文
本小时 Desire 是否记录
今天 Closeout / Review 是否运行
有没有重复、缺失或失败任务
Soft Retrieval 是否关闭
```

示例：

```text
TG 正常；新线程首轮已加载 Re-entry；本小时 Desire 已记录；
今天 Closeout 尚未运行；Soft Retrieval 已关闭；没有重复任务。
```

## 页面结构

### 1. Overview

- TG / runtime 健康；
- 当前 branch、版本和 state-dir；
- 当前启用模块；
- 最近错误；
- 下一项待处理工作。

### 2. Context Trace

每轮显示：

- System Prompt / Role Card 是否加载；
- Re-entry 是否因重入加载或跳过；
- Current State 来源；
- 每块的版本、hash、字数与加载原因；
- fallback 是否发生；
- 最终上下文大小。

默认不长期保存用户消息、模型回复、私人记忆正文或完整 Prompt。

### 3. Prompt Versions

- 查看当前 Prompt；
- 显示真实 diff；
- 创建不可变新版本；
- 切换指针；
- 回退旧版本；
- 标明生效范围：下一轮、新线程或重启后。

人格来源只能有一个，不能让 runtime 模板、本地文件和网页各维护一份。

### 4. Jobs & Health

展示：

- Desire slot；
- Closeout；
- Independent Review；
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

### 5. Memory Review

查看 candidates，并执行：

- 接受；
- 拒绝；
- 延后；
- 合并；
- 修改后接受；
- 查看来源与冲突记录。

520 只调用 Review Service。正式 Episode、Timeline、Portrait、Re-entry 由唯一 writer 更新，页面不能直接改文件绕过审计。

### 6. Files / History

只读展示：

- Episodes；
- Timeline；
- Re-entry；
- Self-notes；
- 旧版本与修正关系。

第一阶段不开放任意文件编辑器。确需维护时走专门操作和 diff，而不是通用“保存文件”。

### 7. Soft Retrieval

当前只显示：

```text
状态：deferred / off
原因：先跑通硬上下文和后台循环
进展文档：SOFT_RETRIEVAL.md
```

不要为了页面完整而接一条假的 preview 检索链。

## 第一阶段必须冻结的旧能力

- 写 `state_log.jsonl`；
- 直接编辑正式 memory 文件；
- 页面内自动运行 Janitor；
- 页面直接写 candidate；
- 页面保存人格到多个位置；
- 页面成为 Desire、Closeout 或 Review 的实际调度进程；
- care、剧场等尚未接通功能冒充已实现。

## 模式

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
- Context Trace 能解释本轮加载；
- `state_log.jsonl` 不再被页面写入；
- 正式记忆不能从通用文件编辑接口修改；
- 页面崩溃不会导致 Telegram 重启或重复 poller。
