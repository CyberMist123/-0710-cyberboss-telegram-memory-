# G1 真机留证窗口 · 操作手册（草案）

```text
Status: supplemental
Authority: none
Scope: G1（Telegram memory_context）真机留证的一次性操作步骤
Last reviewed: 2026-07-29
Fact-checked: 2026-07-29 Codex 12属实/5出入已修正
Base SHA: 0fd8f89（main 只读快照 cyberboss-main-audit）
Current authority: docs/CURRENT_STATUS.md
```

> 这是**草案**，不是已批准文档。写它的人只读了代码，没碰过生产机。
> 每一条结论后面都带了「哪个文件第几行」；凡是仓库里看不出、只能到机器上看的，写了**真机才知道**。

---

## 0. 这一趟要拿到什么

`docs/CURRENT_STATUS.md:25` 把 G1 记成 `PARTIAL`，缺的东西写在 `docs/CURRENT_STATUS.md:111`：

> 真机 Telegram 上 memory_context 实际执行并被 trace 记录的留证。

所以这一趟只要两样东西：

1. **一行 trace**：`context_trace.jsonl` 里出现 `{"type":"memory_context","loaded":true,...}`；
2. **一段 payload**：模型真收到的那条消息里，`<memory_context>` 块在 `<channel>` 信封**外面、上面**。

拿到这两样，G1 才能从 `PARTIAL` 改成 `PASS`。拿不到就不改，原样记着。

**这一趟不做的事**（做了就超出范围）：不改 `deployment/current.json`、不动任何计划任务、不跑会写正史的命令、不重启 TG 进程（除非你自己决定要改 env，见 1-5）。

---

## 1. 名词表（一句话一个）

| 名词 | 一句话 |
|---|---|
| **memory_context** | 每轮对话前，系统从你的记忆文件里挑出最相关的一两句，拼在消息前面给模型看。 |
| **信封 / `<channel>`** | Telegram 消息被包成的那层标签，写着 chat_id、发送时间、正文。 |
| **Context Trace** | 一个日志文件，每轮记一行：这轮装了什么块、跳过了什么块、为什么。 |
| **block / skipped** | trace 那一行里的两个清单：装进去的叫 block，没装的叫 skipped，skipped 里带 reason（原因）。 |
| **三门 / context-gates** | 一个 JSON 小文件，三个开关：`reentry`、`current_state`、`memory_context`，关掉哪个哪个就不注入。 |
| **descriptor** | `deployment/current.json`，写着当前跑的是哪个 release、入口在哪、回滚退到哪。 |
| **候选 / candidate** | Closeout 写出来的记忆草稿，还没进正史，需要 Review + History writer 才会正式落档。 |
| **正史 / canon** | `episodes.jsonl`，正式记忆档。**这一趟绝对不碰。** |
| **fail-open** | 记忆这段出错时不让整轮对话挂掉，宁可这轮没记忆。 |

---

## 2. 前置检查（七项，全部只读）

按顺序做。任何一项不过，**先停下**，不要往下走 —— 走了也只会拿到一条 `skipped` 的证据。

### 2-1 descriptor：现在挂的是哪个 release

```powershell
Get-Content "$env:CYBERLINK_ROOT\deployment\current.json" | ConvertFrom-Json | Select-Object active_release_id, last_verified_sha, telegram_entry
```

- 看什么：`active_release_id`（release 名）、`last_verified_sha`（40 位十六进制的 commit）、`telegram_entry`（真正被拉起的入口文件）。字段清单见 `docs/architecture/WINDOWS_RUNTIME.md:21-33`、形状示例 `deployment/current.example.json:1-23`。
- **通过**：三个字段都有值，`last_verified_sha` 是 40 位十六进制。
- **失败**：文件不在这个路径 → descriptor 位置**真机才知道**（它不入版本控制，`WINDOWS_RUNTIME.md:19`）。用 `Get-ChildItem "$env:CYBERLINK_ROOT" -Recurse -Filter current.json -ErrorAction SilentlyContinue | Select-Object FullName` 找一下。
- 注意：`last_verified_sha` 是**人写进去的**，不是自动算的。它说"这个 release 对应哪个 commit"，但**不能**证明部署区的文件真的是那个 commit —— 所以还要做 2-2。

### 2-2 部署区的代码里到底有没有 G1 修复（最关键的一项）

```powershell
Select-String -Path "$env:CYBERLINK_ROOT\runtime\app\telegram\src\core\app.js" -Pattern "buildTelegramMemoryContextLines"
```

- 为什么查这个词：G1 修复引入的就是这个函数（本仓库 `src/core/app.js:3469` 定义，`src/core/app.js:3456` 调用）。旧代码里没有这个词。
- 为什么查这个目录：`scripts/windows/runtime-startup/start-telegram.ps1:19-21` 把入口固定成 `<CYBERLINK_ROOT>\runtime\app\telegram\bin\cyberboss.js`，它旁边的 `src/` 就是真正在跑的代码。
- **通过**：至少 2 行命中（一处定义、一处调用）。
- **失败**：0 行命中 → 部署区还是旧代码，**这一趟到此为止**。先把新 release 装上去（那是另一件事，走 `install-*.ps1` 那条链，`WINDOWS_RUNTIME.md:41-59`），装完再回来。

顺手再确认一条（可选，加固）：

```powershell
Select-String -Path "$env:CYBERLINK_ROOT\runtime\app\telegram\src\core\app.js" -Pattern "runtimeTurn.memoryContext"
```

命中 1 行（对应本仓库 `src/core/app.js:870`）= 这一轮的记忆结果会被交给 trace。**没命中 = trace 那一行永远不会出现 memory_context**，等于白跑。

### 2-3 TG 进程真的在跑

```powershell
$entry = Join-Path $env:CYBERLINK_ROOT "runtime\app\telegram\bin\cyberboss.js"
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$entry*" -and $_.CommandLine -like "*start*" } | Select-Object ProcessId, CommandLine
```

- 为什么要两个条件一起卡：启动脚本自己的防重检查（`start-telegram.ps1:33-44`）就是**同时**看完整入口路径和 `start` 这个参数。只用 `*bin\cyberboss.js*` 宽匹配会把别的子命令（比如手动跑的一次性脚本）也算进来，数出来的进程数不作数。
- **通过**：恰好 1 个进程，命令行里是完整入口路径 + `start`。
- **失败（0 个）**：TG 没在跑，发消息不会有任何反应。（也可能是 `CYBERLINK_ROOT` 在你这个 shell 里没设 —— 先 `echo $env:CYBERLINK_ROOT` 看一眼有没有值。）
- **失败（2 个以上）**：两个 poller 在抢消息，证据会串。停下记录，不要顺手杀进程。

### 2-4 三个门的当前值

```powershell
Get-Content "$env:CYBERLINK_ROOT\runtime\telegram\state\context-gates.json"
```

- 路径怎么来的：`start-telegram.ps1:24` 把 `CYBERBOSS_STATE_DIR` 设成 `<root>\runtime\telegram\state`；`src/core/hard-context.js:17` 在这个目录下读 `context-gates.json`。
- **通过**：文件不存在（`hard-context.js:23-25`：读不到就三门全开），**或者** `memory_context` 不是 `false`（`hard-context.js:21`：只有显式写 `false` 才算关）。
- **失败**：`"memory_context": false` → 门被关了，这一轮一定拿到 `gated_off`。**开不开这个门是生产变更，得你先拍板**，见 6-A。
- 点击版（等价，不用敲命令）：浏览器打开 `http://127.0.0.1:520/api/context-gates`。这是只读接口，只绑本机所以不需要 token（`docs/520_CONSOLE.md:288`）。

### 2-5 CYBERBOSS_MEMORY_RETRIEVAL（最容易翻车的一项）

```powershell
Select-String -Path "$env:CYBERLINK_ROOT\settings\secrets\telegram.env" -Pattern "^\s*CYBERBOSS_MEMORY_RETRIEVAL"
```

- **通过**：值是 `1` / `true` / `yes` / `on` 之一。
- **失败**：值是 `0`、或者**这一行根本不存在**。
- 为什么这么要命：`src/core/config.js:108` 用 `readBoolEnv` 读它，而 `readBoolEnv`（`config.js:238-241`）只认 `1/true/yes/on`，**其余一律 false，没设也是 false**。然后 `src/core/app.js:975` 一看到 false 就直接返回 `mode: "disabled"` —— 真正的检索（挑句子、打分、选行）这一段被跳过了。仓库自带的示例配置里这一项写的就是 `0`（`.env.example:40`），所以生产机上大概率也是 `0` —— **真机才知道**。
- **别以为关了就不出块了**：`disabled` 不等于 trace 里看不到 `memory_context`。location-v2 那条路的 memory lines 仍然会算，所以你有可能看到一行 `{"type":"memory_context","loaded":true,"reason":"disabled"}` —— 看着像通过，其实不是。判据只认 `reason === "targeted"`，见 4-3。
- 改这一行要重启 TG 进程才生效（env 只在进程启动时读一次，`src/core/config.js:5` 的 `readConfig()` 在启动路径上）。**改生产 env + 重启进程是动生产，本手册只负责"看一眼"，改不改你定。** 如果决定改，改完从 2-3 重做一遍。

### 2-6 记忆文件里到底有没有东西

```powershell
Get-ChildItem "$env:CYBERLINK_ROOT\memory\*.md" | Select-Object Name, Length
```

- 路径怎么来的：`start-telegram.ps1:102` 把 `CYBERBOSS_MEMORY_DIR` 设成 `<root>\memory`；文件名清单在 `src/services/memory-service.js:325-334`。
- 记下**哪几个文件 Length 不是 0**。第 3 节挑句子完全看这个。
- **失败**：全是 0 → 没有任何记忆可注入，无论发什么都只能拿到 skipped。这时先想办法让记忆文件有内容（那是另一件事），或者退而求其次走 6-3。

### 2-7 有没有手动覆盖文件

```powershell
Test-Path "$env:CYBERLINK_ROOT\runtime\telegram\state\context-memory-override.md"
```

- 路径来自 `src/core/config.js:85`。
- **通过**：`False`。
- **注意**：如果是 `True` 且文件非空，`src/core/app.js:962-965` 会直接用文件里的内容当记忆，`mode` 记成 `manual_override`。这时 trace 会显示 `loaded:true` —— **但这不算 G1 证据**，因为注进去的是人手写的文件，不是真检索。要留证就先把这个文件挪走（挪之前备份）。

---

## 3. 触发：发一条会命中记忆的消息

系统只在**这句话本身命中槽位**时才去翻记忆（`src/core/memory-resolver.js:29-69`）。闲聊短句会被判成 `skip`，进度/提醒类的词会被判成 `state_only` —— 两种都不注入。所以句子要挑。

### 3-1 挑句子的规则

槽位由**正则硬匹配**决定，共六个（`src/core/memory-intent-classifier.js:6-11`），每个槽位对应一个记忆文件（`src/services/memory-service.js:4-11` + `:325-334`）：

| 槽位 | 句子里出现这些词就命中（节选） | 对应文件 |
|---|---|---|
| identity | 我是谁 / 名字 / 我叫 / 生日 / 职业 / 工作 / 外贸 / 生病 / 天气 | `profile.md`、`facts.md` |
| relationship | 关系 / 朋友 / 家人 / 叫我 / 称呼我 / 线程 / 记忆 / 连续性 / 偏爱 | `relationships.md` |
| preference | 喜欢 / 偏好 / 讨厌 / 不喜欢 / 别用 / 边界 / 表达 / 说话 / telegram / 微信 | `preferences.md` |
| project | 项目 / 计划 / 目标 / 里程碑 / 开发 / 上线 | `projects.md` |
| pattern | 总是 / 经常 / 反复 / 习惯 / 拖延 / 熬夜 / 卡住 | `patterns.md` |
| pending_promise | 答应 / 说好的 / 承诺 / 兑现 / 失约 / 还记得吗 | `pending-promises.md` |

**做法**：从 2-6 里挑一个 Length 不是 0 的文件，打开看一眼里面写的是什么，然后编一句话，**同时满足两条**：

1. 含上表里对应槽位的词（这样才会进 `targeted` 模式）；
2. 和文件里某一行**用词重合**（这样那一行才会被选中）。

第 2 条的打分规则在 `src/core/app.js:3732-3749`。中文句子按标点切词，整句不带空格时切不出短词，所以**真正稳的是那几条加分规则**：

- 句子和记忆行**都**含「喜欢 / 讨厌 / 不要 / 别用 / 表达 / 说话」→ +3（`app.js:3745`）
- 都含「线程 / 记忆 / 连续性 / 偏爱」→ +4（`app.js:3746`）
- 都含「提醒 / 下班 / 时间 / 免打扰」→ +3（`app.js:3744`）
- 都含「telegram / 微信」→ +3（`app.js:3743`）
- 都含「痛经 / 胃疼 / 拉肚子 / 生病 / 下雨 / 天气 / 工作 / 外贸」→ +3（`app.js:3747`）

分数 > 0 就会被选中；最终**最多注入 1 条**（`app.js:1010` 的 limit 传的是 `1`）。

### 3-2 现成的句子（按你 2-6 的结果二选一）

- `preferences.md` 非空 → 发：**「我不喜欢你用那种说话方式，你还记得吗」**
  （命中 preference 槽位 + 触发 `app.js:3745` 的 +3）
- `relationships.md` 非空 → 发：**「我们那条记忆线程你还留着吗」**
  （命中 relationship 槽位 + 触发 `app.js:3746` 的 +4）

**不要发**的例子（都会被判掉，白发一条）：

- 「在干嘛」「晚安」「嗯」→ `skip`（`memory-resolver.js:11-14`）
- 「今天做到哪了」「提醒我一下」→ `state_only`，不翻记忆（`memory-resolver.js:20`）

### 3-3 怎么发

- 在真实 Telegram 里，用**你平时那个 bot 对话**发（不是测试号、不是新建的 topic —— 新 topic 会多一条 Re-entry 注入，扰乱证据）。
- 发完**等到模型回完话再去看 trace**。trace 那一行是在模型返回之后才写的（`src/core/app.js:870` 在 `sendTurn` 之后）。
- 记下发送时间（分钟级就够），归档时要写。

---

## 4. 取证

### 4-1 trace 文件在哪

```
<CYBERLINK_ROOT>\memory\trace\context_trace.jsonl
```

怎么来的：`src/core/config.js:94` 定义 `contextTraceFile = <CYBERBOSS_CONTINUITY_DIR>\trace\context_trace.jsonl`；`start-telegram.ps1:103` 把 `CYBERBOSS_CONTINUITY_DIR` 设成 `<root>\memory`。

看最后几行：

```powershell
Get-Content "$env:CYBERLINK_ROOT\memory\trace\context_trace.jsonl" -Tail 3
```

### 4-2 通过的那一行长什么样

每行是一个 JSON。字段形状固定在 `src/core/context-trace.js:79-89`（整行）和 `:92-103`（block）。**通过**的行长这样（为了看清楚这里换了行，真实文件里是一行）：

```json
{
  "ts": "2026-07-29T11:22:33.456Z",
  "thread": "a1b2c3d4",
  "turn": "turn-xxxx",
  "opening": false,
  "blocks": [
    { "type": "reentry", "loaded": true, "reason": "...", "chars": 812, "hash": "...", "src_mtime": "..." },
    { "type": "memory_context", "loaded": true, "reason": "targeted", "chars": 37, "hash": "", "src_mtime": "" }
  ],
  "skipped": [
    { "type": "episodes", "reason": "default_hidden" },
    { "type": "timeline", "reason": "default_hidden" },
    { "type": "portrait", "reason": "default_hidden" },
    { "type": "self_note", "reason": "default_hidden" },
    { "type": "rereadings", "reason": "default_hidden" }
  ],
  "fallback": false,
  "total_chars": 1234,
  "recall_calls": []
}
```

几个别被吓到的地方：

- `thread` 是哈希，不是真 chat id（`context-trace.js:118-121`），这是设计。
- `memory_context` 那个 block 的 `hash` 和 `src_mtime` 是空字符串 —— 正常。写入侧只填了 type/loaded/reason/chars（`app.js:3023-3028`），其余由 `context-trace.js:99-101` 补空。
- `skipped` 里那 5 条 `default_hidden` 每行都有，是系统固定加的（`context-trace.js:5` + `:76-78`），不是出错。

### 4-3 判据

**算通过**，四条同时成立：

1. `blocks` 里有 `"type":"memory_context"`；
2. 该块 `"loaded":true`；
3. `"chars"` 大于 0；
4. `"reason"` 是 **`targeted`**。

**第 4 条是硬门槛，不能用前三条替代。** `loaded:true` 只说明"有东西被注进去了"，不说明"是检索挑出来的"。

**不算通过**（哪怕 `loaded:true`、`chars` 也大于 0）：`reason` 是 `disabled` / `gated_off` / `manual_override` —— 这三种说明注进去的东西不是真检索的产物（分别对应 `app.js:979`、`:960`、`:964`）。尤其是 `disabled`：`CYBERBOSS_MEMORY_RETRIEVAL` 关着的时候，location-v2 的 memory lines 照样会算出内容，于是这一行完全可能是 `loaded:true` + `chars>0` + `reason:"disabled"`。**它长得最像通过，但它不是。** `reason` 是 `state_only` 或 `skip` 时块会落在 `skipped` 里，见第 6 节。

### 4-4 截取那一行

```powershell
Get-Content "$env:CYBERLINK_ROOT\memory\trace\context_trace.jsonl" -Tail 30 | Select-String '"type":"memory_context","loaded":true' | Out-File -Encoding utf8 "$env:USERPROFILE\Desktop\g1-trace-line.txt"
```

（先落桌面，归档时再拷进 `docs/audit/`。`-Encoding utf8` 别省，中文会乱。）

### 4-5 payload 侧：确认块在信封外面

代码上这件事是钉死的：`src/core/app.js:3455-3461` 把顺序写成「memory_context 行 → `<channel ...>` → 正文 → `</channel>`」，而且 `src/core/app.js:3473` 规定**没记忆就一行都不出**。测试也钉了（`test/telegram-runtime-payload.test.js:165-183`）。但真机上要眼见为实。

模型收到的原文落在 Claude Code 的 transcript 里：

```
<CYBERBOSS_CLAUDE_CONFIG_DIR>\projects\<把 workspace 路径里的 \ / : 空格 全换成 - >\<threadId>.jsonl
```

路径拼法在 `src/adapters/runtime/claudecode/index.js:1235` 与 `:1238-1240`。

- `CYBERBOSS_CLAUDE_CONFIG_DIR` 设没设、设成什么 —— **真机才知道**（在 `settings\secrets\telegram.env` 里，`src/core/config.js:200`）。没设的话 transcript 才走 Claude Code 自己的默认目录（通常 `%USERPROFILE%\.claude`）。

**所以先看这一项设没设，再决定去哪个目录找 —— 别一上来就搜默认目录，设了的话那里根本没有你要的文件。**

第一步，看有没有设：

```powershell
Select-String -Path "$env:CYBERLINK_ROOT\settings\secrets\telegram.env" -Pattern "^\s*CYBERBOSS_CLAUDE_CONFIG_DIR"
```

第二步，按上一步的结果二选一：

- **设了**（命中一行，等号后面是个目录）→ 把那个目录当根，找 `<那个目录>\projects` 下面的 jsonl：

  ```powershell
  Get-ChildItem "<把上一步读到的目录粘这里>\projects" -Recurse -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Select-String -Pattern "memory_context"
  ```

- **没设**（0 行命中）→ 才去默认目录：

  ```powershell
  Get-ChildItem "$env:USERPROFILE\.claude\projects" -Recurse -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Select-String -Pattern "memory_context"
  ```

**通过**：找到的那段文本里，`<memory_context>` 和 `</memory_context>` 都出现在 `<channel source="telegram"` **之前**，中间的记忆行以 `- ` 开头，格式是 `分类: 内容`（分类前缀来自 `app.js:3698`，短横线来自 `app.js:3476`）。

**失败**：`<memory_context>` 出现在 `<channel>` **里面** → 信封被污染了，这是格式事故，停下记录，不要自己改。

> ⚠️ 这段 payload 里是你的**真实记忆正文**。仓库是公开的（`CLAUDE.md` 第四节）。归档时正文必须打码，只留结构骨架 —— 见 5-2。

---

## 5. 归档

### 5-1 证据文件放哪、什么格式

新建 `docs/audit/G1_TELEGRAM_MEMORY_CONTEXT_EVIDENCE.md`（名字里**不写状态、不写日期**，`CLAUDE.md` 第六节）。头部按审计类文档的格式来（抄 `docs/audit/R4_FINAL_CODE_REVIEW.md:1-8` 的形状）：

```text
Status: active
Date: 2026-07-XX
Base SHA: <2-1 读到的 last_verified_sha>
Current authority: docs/CURRENT_STATUS.md
```

正文至少写这几段：

1. **环境行**：机器（生产 Windows）、Node 版本（`node -v`）、`active_release_id`、跑的入口路径、发送时间。为什么要写：`WINDOWS_RUNTIME.md:124` 说得很明白 —— CI 绿不等于真机可以，所以证据必须标清楚是在哪台机器上取的。
2. **前置检查的结论**：三门的值、`CYBERBOSS_MEMORY_RETRIEVAL` 的值、2-2 那两个 grep 各命中几行。
3. **trace 原始行**：4-4 抓的那一行，原样贴。这行里没有记忆正文（只有字数），可以直接贴。
4. **payload 片段**：只贴骨架，正文打码。像这样：

   ```text
   <memory_context>
   - preferences: ██████████（14 字，已打码）
   </memory_context>
   <channel source="telegram" chat_id="…" message_id="…" sent_at="…">
   ██████（用户原话，已打码）
   </channel>
   ```

5. **判定**：`PASS` / `FAIL` 加一句理由。
6. 如果顺手采了第 7 节的东西，附在后面。

### 5-2 CURRENT_STATUS.md 改哪一行

`CLAUDE.md` 第六节：一个改动只改**对应的那一行**。这里"对应那一行"是：

- **`docs/CURRENT_STATUS.md:25`**（Gate 总表 G1 那一行）

  改前：`| G1 Telegram 核心读取路径 | \`PARTIAL\` | 代码通路与 Trace 验收结构已接通，缺真机执行证据 |`
  改后：`| G1 Telegram 核心读取路径 | \`PASS\` | 代码通路、Trace 验收结构与真机执行证据齐全 |`

  状态词只能从 `docs/CURRENT_STATUS.md:57-61` 那张词典里取，`PASS` 在里面，可以用。

跟着这一行一起变、但属于同一件事的直接结论（建议同一个 PR 里一并改，并在 PR 描述里说明为什么不止一行）：

- `docs/CURRENT_STATUS.md:111`（证据锚点里「仍缺什么」那一段）—— 改成指向新归档的 `docs/audit/G1_...md`；
- `docs/CURRENT_STATUS.md:79` 和 `:80` 的「生产接线」列 `WIRED` → `VERIFIED` ——`CLAUDE.md` 第六节写着「真机留证后才改 `VERIFIED`」，这两行说的正是 memory_context 与它的 trace；
- `docs/CURRENT_STATUS.md:158`（切生产判据第 0 条）—— 把「当前 `PARTIAL`（缺真机证据）」改掉；
- `docs/CURRENT_STATUS.md:165`（当前状态那句）—— 条件 0 已满足，1、2 仍未满足；
- 文件顶部 `Last verified` 与 `Verified against`（`docs/CURRENT_STATUS.md:6-7`）—— 只有真的重新核过才动这两行。

**不改**：README、`CLAUDE.md`、`SYSTEM_OVERVIEW.md` 里没有状态结论可改（`CLAUDE.md` 第六节）。
但 `SYSTEM_OVERVIEW.md` 有一处**内容**错了，见第 8 节。

### 5-3 走分支和 PR

main 有保护，只能分支 + PR（根目录 `CLAUDE.md`）。PR 必须用仓库模板 `.github/pull_request_template.md`。

---

## 6. 失败分支：trace 里出现 skipped 时，reason 各是什么意思

skipped 那条长这样：`{"type":"memory_context","reason":"<原因>"}`，写入点在 `src/core/app.js:3029-3031`。

| reason | 什么意思 | 下一步 |
|---|---|---|
| `gated_off` | 三门里 `memory_context` 被显式关成 `false`（`app.js:959-961`） | **停在这里，不要顺手开门。** 开门是生产变更，不是排障动作 —— 见下面那段单独的说明。 |
| `disabled` | `CYBERBOSS_MEMORY_RETRIEVAL` 不是真值，检索那一段被跳过（`app.js:975-981`）。**注意这个 reason 不一定落在 skipped 里** —— 它也可能带着 `loaded:true` 出现在 blocks 里（location-v2 的 memory lines 照算），照样不算通过，见 4-3 | 这是 env，不是文件开关。要改 `settings\secrets\telegram.env` 并**重启 TG 进程**才生效。**这是生产变更，需要你明确决定后再做**，见 2-5。 |
| `manual_override` | 存在非空的 `context-memory-override.md`（`app.js:962-965`）；这种情况 `loaded` 会是 `true` 落在 blocks 里 | 把那个文件挪走（先备份），重发。**带这个 reason 的行不能当 G1 证据。** |
| `skip` | 这句话被判成闲聊、且没命中任何槽位（`memory-resolver.js:35-43` 或 `:53-61`） | 换句子，照 3-2。 |
| `state_only` | 句子里有「进度 / 提醒 / 现在」这类词，但没命中槽位，所以只用状态层不翻记忆（`memory-resolver.js:44-52`） | 换句子，把「提醒/进度」类的词去掉，加上 3-1 表里的槽位词。 |
| `targeted` **却落在 skipped 里** | 一条都没注进去。常见是对应的 `.md` 是空的，或者用词完全不重合（`app.js:1002-1008` 或 `:1010-1016` 返回空 lines）；**也可能是 targeted 计划压根没拿到可用的 retrieval slot。所以不能仅凭看到 `targeted` 这个词就断言"检索确实跑过了"。** | 这是最接近成功的一种失败。回 2-6 看文件内容，照 3-1 的加分规则重挑句子。 |
| `error` | 记忆解析抛异常了，fail-open 兜住了这一轮（`app.js:1031-1034`） | 看日志：`Select-String -Path "$env:CYBERLINK_ROOT\runtime\telegram\logs\cyberboss.err.log" -Pattern "memory context resolution failed"`（那句话出自 `app.js:1032`）。**这是个真 bug，值得单独记一笔。** |
| `empty` | `mode` 字段是空的（`app.js:3021` 取不到 mode 时的兜底） | 罕见。唯一会这样的是消息正文为空（`app.js:956-958`）。重发一条有字的。 |

### 6-A 拿到 `gated_off` 之后：开门这件事是**生产变更**，需要你先明确决定

不管走 520 面板（`docs/520_CONSOLE.md:294`）还是直接编辑 `context-gates.json` 把那个键改成 `true`，**这两条路是同一件事**：门一改，**下一轮真实对话立刻按新值走**（不用重启，`SYSTEM_OVERVIEW.md:204`）。也就是说，你改的不是一个测试开关，是从那一刻起系统给她注入什么内容。

所以它**不属于**上面那张表里的"下一步排障动作"，它是一次需要你点头的生产改动。做之前：

1. 把原文件备份一份（`Copy-Item "$env:CYBERLINK_ROOT\runtime\telegram\state\context-gates.json" "$env:USERPROFILE\Desktop\context-gates.bak.json"`），并把改之前的三门原值抄进证据文档；
2. 想清楚这个门当初是**谁、为什么**关的 —— 有可能是有意关的，不是配错了；
3. 明确决定：这一趟到底是"开门取证"，还是"记下门是关的、G1 保持 `PARTIAL`"。两种都是合法结论。

如果决定不开门：这一趟到此为止，按 `PARTIAL` 原样记着，把 `gated_off` 那一行 trace 当成"为什么拿不到证据"的说明存档。

另外两种「不是 skipped，但也拿不到证据」的情况：

- **整行里 blocks 和 skipped 都没有 `memory_context`** → 说明 `recordContextTrace` 没收到第四个参数。要么跑的是旧代码（回 2-2），要么这一行本来就不是对话轮 —— opening refresh 的两个调用点只传三个参数（`app.js:1852`、`app.js:2004`），它们的行 `"opening":true`，本来就不该有 memory_context。**认行先看 `"opening"` 是不是 `false`。**
- **压根没有新行写出来** → trace 文件没被写。最可能是 `CYBERBOSS_CONTINUITY_DIR` 没设，于是 `contextTraceFile` 是空字符串，`context-trace.js:14` 直接返回不写。查：`start-telegram.ps1:103` 应该设了；如果生产机的启动脚本和仓库镜像不一致 —— **真机才知道**，`WINDOWS_RUNTIME.md:63` 说过部署区脚本可能领先/落后于仓库。

---

## 7. 顺带可采的证据（同一个窗口里顺手拿）

建议顺序：**先做完 2-4 节拿到 G1 证据，再做这一节。** 这一节的东西失败了不影响 G1。

### 7-1 手动跑一次 Closeout，攒候选样本（给 #37 冷读）

**520 面板没有这个按钮。** 面板的活跃写端点里只有 `/api/review/retry`（`docs/520_CONSOLE.md:298`），而 `/api/janitor/run` 是冻结的、一律 403（`docs/520_CONSOLE.md:307`）。所以只能走命令行。

> # ⚠️ 只许跑 `closeout` 这一个子命令
> **绝对不要跑 `all`，也不要跑 `nightly`，也不要跑 `write`。**
>
> - `write` → `resolvePhase3Plan` 走 `directPlan("history")`（`src/continuity/nightly-mode.js:18`），`canon_writes_allowed: true`，**会往正史 `episodes.jsonl` 写**（`src/continuity/continuity-pipeline.js:273-276`）。准确说：**仅当某条候选已经有 `accepted` 判决、并且带发布授权时才写；没有这种候选就是零写入。** 但这个"零写入"是运气不是保障 —— 生产机上有没有攒着 accepted 候选，你事先并不知道。**所以 `write` 照旧禁用，不变。**
> - `all` / `nightly` → 走的不是固定计划，而是看环境变量 `CYBERBOSS_NIGHTLY_MODE`（`nightly-mode.js:26`）。默认是 `evidence`（只跑 janitor，不写正史）—— **但如果生产机把它设成了 `auto`，`nightly-mode.js:55-65` 会让 `history: true`、`canon_writes_allowed: true`，一条命令直接写正史。** 那个变量在生产机上是什么值，仓库看不到，**真机才知道**。所以不许赌。
>
> 候选与正式分离是全局禁区（`CLAUDE.md` 第三节第 6 条）。这条红线只要越一次就不可逆。

**要跑的命令**（`--date` 用昨天，格式 `YYYY-MM-DD`）：

```powershell
node "$env:CYBERLINK_ROOT\runtime\app\telegram\scripts\continuity\run-phase3.js" closeout --date=2026-07-28
```

**`closeout` 到底保证了什么**（别读成"这条命令是安全的、无副作用的"，它不是）：

它保证的只有一件事 —— **不调用 History writer、不写正史 canon**。三条依据，逐条可查：

1. `src/continuity/nightly-mode.js:15` → `directPlan("closeout")`；
2. `nightly-mode.js:68-79` → 该 plan 的 `history: false`、`canon_writes_allowed: false`；
3. `scripts/continuity/run-phase3.js:50` → 只有 `plan.history` 为真才调 `runHistoryWriter()`，而正史只由这个 writer 写。

**它不保证的**（这些都会真的发生，跑之前心里要有数）：

- **会真的调模型，会花钱**（`run-phase3.js:33-37`；plan 的 `model_calls_allowed: true`，`nightly-mode.js:77`）。这不是纯本地的干跑。
- **会往磁盘写候选文件** —— 落在下面那个 `episodes.candidates.jsonl` 里，是真实文件改动。
- **会写一份任务账本** `.jobs\closeout-<日期>.json`，记着这次跑过了。也就是说这次执行在系统里留了痕，520 面板的 Jobs 格子会看到它。

所以这条命令的定性是：**正史绝对安全，但它是一次真花钱、真落盘的执行，不是"看一眼"。** 想清楚再敲。

产出落在：

```
<CYBERLINK_ROOT>\memory\candidates\episodes.candidates.jsonl
```

（`src/continuity/continuity-pipeline.js:45` 的 `candidates` 路径 + `start-telegram.ps1:103` 的目录。）

**怎么算通过**：命令打印一段 JSON，`closeout.status` 是 `"success"` 且 `candidates` 数组非空（`continuity-pipeline.js:129`）。

**不算失败的失败**：`status` 是 `"no_output"` —— 那天没素材可写，这是成功状态，不该当错（`docs/520_CONSOLE.md:144`）。

**算失败**：`status` 是 `"deferred"`，`reason` 字段里写着原因（`run-phase3.js:39-40`）。

**还有一个坑**：

- **裸开一个 PowerShell 跑会直接报错**。这条命令要和 TG 进程用同一套环境变量才找得到目录，缺 `CYBERBOSS_CONTINUITY_DIR` 会抛 `CYBERBOSS_CONTINUITY_DIR is required for authoritative closeout`（`src/continuity/closeout-job.js:6` + `:41-45`）。怎么把 `telegram.env` 灌进当前 shell —— **真机才知道**；最省事的照 `start-telegram.ps1:50-75` 那段逐行 set 的写法照做一遍。

**建议就停在 closeout，不要顺手跑 `review`。** `review` 确实也不写正史（`nightly-mode.js:17` → `history: false`），但它会给每条候选落一个 decision（`continuity-pipeline.js:209`）；decision 一旦落了，之后任何人跑一次 `write` 就会照着它发布。攒冷读样本只需要候选。

（顺带一句，方便你理解这条链：祈使句拦截是在 **review** 那一步做的，不在 closeout —— `continuity-pipeline.js:198` 和 `:403`，命中就把候选打回 `deferred`，理由 `imperative_style`。所以只跑 closeout 的话，候选里会**包含**祈使句样本，这对冷读反而是好事：漏网的原样留着给你看。）

### 7-2 520 面板健康度截图

1. 浏览器打开 `http://127.0.0.1:520`（端口默认 520，`extensions/relationship-memory/memory-kit/dashboard.py:244`；只绑本机，不对外）。
2. 截 **Overview** 页：TG / runtime 健康、当前 state-dir、启用中的模块、最近错误（页面内容清单见 `docs/520_CONSOLE.md:65-73`）。
3. 截 **Context Trace** 页：它显示最近 30 行（`dashboard.py:3603`）。刚才那条 memory_context 应该出现在最上面 —— **这是 4-4 那行原始 trace 的第二份佐证，比原始 JSON 好读**。
4. 截 **Jobs & Health** 页里 Closeout 那一格（`docs/520_CONSOLE.md:121-144`）。如果做了 7-1，这里应该能看到刚跑的那次。

**面板打不开怎么办**：面板是独立计划任务拉起的，和 TG 进程互不依赖（`docs/520_CONSOLE.md:16`）。看它的日志：`runtime\telegram\logs\dashboard.err.log`（`WINDOWS_RUNTIME.md:105`）。面板挂了**不影响** G1 证据，别为了截图去重启它。

---

## 8. 两件必须知道的背景

### 8-1 有一份架构文档曾经是过期的（已修正）

> **这一条已经处理掉了。** 下面四处漂移已由 `fix/system-overview-g1-drift` 按当前代码行为对齐，保留这段只为记录当初是怎么发现的。读 `SYSTEM_OVERVIEW.md` 时不必再绕开它。

`docs/architecture/SYSTEM_OVERVIEW.md`（写这份手册时）还停在 G1 修复**之前**的描述，至少四处：

- `:36-38` —— 说 Telegram 在 memory_context 之前「提前 return，故断开」；
- `:52` —— 说「G1 `FAIL`」；
- `:60-62` —— 说 trace「只覆盖 reentry 与 current_state」、memory_context「从未作为 trace block 出现」；
- `:154` —— 说这段逻辑「在 Telegram 上不执行」。

**这四处和当前 main 的代码矛盾。** 代码里 Telegram 分支明确走了记忆解析（`src/core/app.js:1055-1071`），trace 也明确记了 memory_context（`src/core/app.js:3016-3032`）。`docs/CURRENT_STATUS.md:79-80`、`:109`、`:113` 是对的。

这属于「改了稳定结构但没同步文档」，按 `CLAUDE.md` 第六节第 3 条应该修 —— 已按当时说的那样，单独开 PR 修完。

### 8-2 「真机才知道」的清单（这份草案答不了的）

1. `deployment/current.json` 在这台机器上的确切路径（不入版本控制，`WINDOWS_RUNTIME.md:19`）；
2. `settings\secrets\telegram.env` 里 `CYBERBOSS_MEMORY_RETRIEVAL` 的实际值 —— **这项决定这一趟能不能成**；
3. 同一文件里 `CYBERBOSS_NIGHTLY_MODE` 的实际值 —— 决定 `all` 有多危险（所以直接禁用 `all`）；
4. `CYBERBOSS_CLAUDE_CONFIG_DIR` 设没设，即 transcript 落在哪；
5. 部署区 `runtime\startup\*.ps1` 和仓库镜像 `scripts/windows/runtime-startup/` 是否一致（`WINDOWS_RUNTIME.md:63` 明说可能不一致），本手册里所有从 `start-telegram.ps1` 推出来的路径都建立在「一致」这个假设上；
6. `memory\*.md` 里到底有什么内容 —— 决定第 3 节该发哪句话；
7. TG 进程当前实际跑的 release 与 `last_verified_sha` 是否对得上（所以 2-2 要用 grep 直接验代码，不能只信 descriptor）。
