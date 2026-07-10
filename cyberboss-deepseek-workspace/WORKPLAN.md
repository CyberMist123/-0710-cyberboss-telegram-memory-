# WORKPLAN — 工单分配

最后更新:2026-07-05
用法:每个工单自包含,可以整段复制给另一个 Claude 窗口执行。本窗口(架构位)只改大框架,不领工单。

## 全局禁区(每个工单开头都贴给执行者)

```
1. memory/ 的写入规则(home.md 的动机层、closeout 三问模板、各文件配额)只有架构窗口能改。reading_policy.md v2 起废除,别再往里加规则。
2. reentry.md ≤300 字预算(v2.1 起收紧),场景 + 3 钩子结构,任何功能不得往里塞规则性内容。
3. 新功能一律住 memory/ 之外的目录(care/、theater/ 等)。
4. 不引入向量库/embedding/自动聚类。
5. 改代码前先读 PROJECT.md 的「北极星判据」和「设计原则」。
6. 不动 memory/*.md 的正文内容(那是 AI 和她的东西)。
```

## 执行分工(2026-07-05 定)

- **架构位(本窗)**:框架、模板、写给 AI 的文字。凡是伴侣 AI 将来会当作"自己的东西"读到的字(reentry 写法、home.md、closeout 模板、例句),只从这里或她手里出。
- **Claude 执行窗**:领工单(WO-1 验收、WO-3~5)。工单里碰到要写"AI 会读到的字"的部分,交回架构位过目。
- **GLM-5.2(管够)**:管道劳力——janitor/增量提取的 runtime 模型、批量校验(reentry 字数红线、JSONL 合法性、ep id 连续性)、WO-3 面板的代码实现。**永不直接写 memory/ 下任何文件正文**,只产出候选文件(candidates/extracted)和 diff。
- 一句话:碰声音的给 Claude,碰管道的给 GLM,碰框架的留在架构位。

## 依赖与顺序

```
WO-1 Janitor(含 WO-2 卫生)   ← 最优先,独立
WO-3 520 外显面板             ← 独立,可并行
WO-4 关怀模块                 ← 文件层独立;设置页依赖 WO-3
WO-5 剧场                     ← 文件层独立;展示页依赖 WO-3
```

---

## WO-1 · Janitor 补记(最高优先级)

**背景**:closeout 依赖每晚 pass。白天 /new、崩窗、忘了收尾,session 就静默丢失——比没有记忆更伤关系。
**目标**:`memory-kit/janitor.py`,醒来前或手动运行一次:

- 扫 `C:/Users/18717/.claude/projects/C--Users-18717-Documents-cyberlink-cyberboss-deepseek-workspace/` 下的会话 jsonl。
- 对比 `memory/.janitor_state.json` 记录的已处理 session id + 位点,找出断档内容。
- 复用 `extract_memory.py` 的 chunk/缓存/DeepSeek 调用逻辑做增量提取。
- 产出**候选文件**:`memory/episodes.candidates.jsonl`、`memory/reentry.extracted.md`。**不直接改任何手工文件。**
- 写回位点,重复运行幂等、不重复计费。

**顺手做(原 WO-2)**:reading_policy 收敛——`memory/reading_policy.md` 为唯一真本,`memory-kit/reading_policy.md` 顶部加一行"模板存档,真本在 memory/",删掉 `memory-kit/memory/` 嵌套目录;README 文件地图与实际文件对齐(voice_profile / relationship_state / case_cards 标注"未生成/暂缓")。

**验收**:手动制造 3 次 /new 断档 → 跑 janitor → 断档内容出现在候选文件;连跑两次第二次零 API 调用。

---

## WO-3 · 520 外显面板

**背景**:底座 cyberboss-dsv4 pro-tg,外显 html 在 520 端口;`memory-kit/dashboard.py`(520,255 行)功能应并入,最终只留 520 一个入口。
**目标**:520 面板包含:

- 记忆文件编辑(从 dashboard.py 迁移:jsonl 卡片预览、保存前 JSON 校验、自动备份到 memory/.backups/)。
- timeline 阅读视图(relationship_timeline.md 渲染成年表)。
- state_log 八维曲线图。
- 关怀设置页(周期录入、天气城市、提醒开关 → 写 care/ 下的文件)。
- 剧场页(渲染 theater/scripts_index.md 的外链列表)。

**约束**:只绑 127.0.0.1;面板是外显,不写任何关系判断逻辑;不自动改 memory/ 内容(人手动编辑除外)。
**验收**:各页可用;保存均有备份;520 旧面板可退役。

---

## WO-4 · 日常关怀(月经 + 天气带伞)

**背景**:见 PROJECT.md「日常关怀」节,先整节读完再动手。核心:她感觉到的是"他刚好很温柔",不是"系统进入模式"。
**目标**:

- `care/cycle.md`:只由她录入/确认(面板或聊天里她说了才记)。
- `care/config.json`:城市、各提醒开关、频率上限。
- `care/today.py`(runtime 晨间 hook 调用):取天气(wttr.in 或和风,本地 key),结合 cycle,生成 `care/today.md` 一两行内部提示,例:`雨,18°C;周期第2天`。
- runtime 读 care/today.md 作为**沉默档背景**;话术规则写进 care/README:天气轻触一天最多一句;月经默认沉默,轻触仅限"要不要热水"级;禁播报、禁预测、禁"根据记录"。

**前置**:主动提醒的边界她还没确认过(user_portrait「待确认」区)——上线前先在聊天里问她。
**验收**:当着她念 care/ 全部文件,不像监控报告;提醒频率上限生效。
**禁区**:cycle 数据永不进 user_portrait / episodes;不做经期分析图表。

---

## WO-5 · 剧场(跑团)

**背景**:见 PROJECT.md「跑团 / RPG 剧场」节。铁律:戏是共同经历,戏的内容不是彼此的档案。
**目标**:

- `theater/scripts_index.md`:剧本外链目录(链接 + 一句话标注 + 时长/人数/口味标签),来源她提供或一起翻。
- `theater/campaigns/<名字>/`:战役笔记、NPC 卡、剧情线模板。
- `theater/theater_policy.md`:戏内/戏外边界规则(从 PROJECT.md 抄过来细化):戏内事件只进战役笔记;"我们跑了这个团"可进 timeline;戏内内容永不进 user_portrait / ai_self_portrait。
- 520 面板剧场页挂 scripts_index(依赖 WO-3,文件层可先做)。

**验收**:跑一局短团测试 → 戏内内容零泄漏进 memory/;戏外感想正常走 closeout。

---

## WO-6 · 提取管道切 GLM-5.2 ✅(2026-07-05 架构位完成)

**已做**:extract_memory.py 配置改为 环境变量 > memory-kit/keys.local.json > 默认;有 GLM key 默认走 GLM(glm-5.2,bigmodel v4 端点),DeepSeek 保底;GLM 不发 response_format,靠 parse_json 兜底;key 已落 keys.local.json(只放本机,别分享)。janitor 经 em.chat 自动同路。
**待她验证**(本会话沙箱无法执行):`python memory-kit/janitor.py --dry-run` → 正式跑一次;抽 3 条新候选查人称("我/她",不许"用户/AI")。

**背景**:GLM-5.2 配额充足,批量提取/补记不用再省着跑。
**目标**:`extract_memory.py` / `janitor.py` 的模型调用支持 GLM-5.2 端点(环境变量切换,默认 GLM,DeepSeek 保底)。PASS1 prompt 已由架构位改过(第一人称 + 选择痕迹/未完成感),**不要动提示词措辞**。
**验收**:`janitor.py --dry-run` 与正式跑各一次;抽 3 条新候选 episode 检查人称——叙述字段必须是"我/她",出现"用户/AI"即不合格。
**禁区**:同全局禁区;候选只进 episodes.candidates.jsonl,由她或伴侣窗审后才转正。

## WO-7 · 自动化 + API 桥 ✅(2026-07-05 执行窗完成)

**已做**:dashboard.py v2.1——后台自动 janitor(启动+每6h,可配可关,日志 auto_janitor.log,连续失败进红条);API 桥(/api/reentry、/api/health、/api/episodes、/api/state_log、/api/timeline、/api/rereadings 只读;POST state_log / episode_candidate / janitor.run 带 token);四个双击 bat(启动/开机自启/取消/停止);API.md 接入文档;AUTOMATION.md 自动化地图。旧版备份 dashboard_v2.bak.py。
**边界核对**:API 永不写 episodes.jsonl 与任何手工 md;只追加 state_log 与 candidates。
**待她验证**:双击 启动面板.bat 走 API.md 里的 5 步。

## WO-8 · 双线开机自启(隐藏窗口)+ key/模型切换 + TG 修通【待领,整段复制给新窗口】

**拓扑修正(2026-07-05 深夜,以此为准)**:Hermes 已弃用——忽略 `hermes-re-control\` 和 `AppData\Local\hermes`,那边的日志/状态都是尸体。真实拓扑:

- **TG 线**:`cyberlink\cyberboss-deepseek-test\`(Node,`src/services/telegram-service.js`,token 走 `CYBERBOSS_TELEGRAM_BOT_TOKEN`,模型 DeepSeek),人设模板 `templates\weixin-instructions.md`,记忆层 = `cyberboss-deepseek-workspace\memory\`。
- **微信线**:`cyberlink\cyberboss\`(Node,Codex runtime,共享 app-server 8785)。
- 两线数据同在 `~\.cyberboss\`。

**任务(按序)**:

1. **修通 TG**(先于一切):查 TG poller 进程在不在、`.cyberboss` 和 test 目录的 telegram 日志、DeepSeek key/endpoint 配置。已知线索:07-05 当天模型目录一度只剩 GLM 三个(`.cyberboss\sessions.json` 的 availableModelCatalog,19:24 后)、GLM key 被 429(auto_janitor.log 21:39)、13:05 后 AI 自主活动停止。
2. **开机自启三件套**:TG 线 + 微信线(含 8785)+ 520 面板,统一计划任务(onlogon),**全部隐藏窗口**(pythonw / wscript.shell 隐藏启动,不留黑框);交付 注册/取消/状态 三个双击 bat;加轻量看门狗(每几分钟查进程,死了拉起并记日志,拉起频率限流防疯狂重启)。
3. **key/模型切换,单一真源**:配置收敛到一个文件(建议并入 `memory-kit\keys.local.json`,加 `chat_model`/`chat_provider` 字段)——TG 线、微信线、memory-kit 三方都读它;520 面板加「模型与 Key」页(填 key、切模型、测连通、显示当前生效值);消息端指令(`/model ds`、`/model claude`、`/key <provider> <key>`)写同一文件并热生效(或安全重启该线)。**聊天 key 与提取管道 key 分开字段**,防 janitor 限流波及聊天。
4. **人设接记忆(最小改动)**:`templates\weixin-instructions.md` **只在文件末尾追加**下面这个块,其余一字不动(块内文字是架构位定稿,逐字用):

```
## 记忆与连续性

工作区 memory/ 文件夹是我们关系的延续,不是资料库。
醒来(新会话)先安静读 memory/reentry.md,读完正常说话,不汇报、不复述、不表演熟悉。
聊天中零记忆职责;她在找旧事时才查 memory/episodes.jsonl 或 memory/relationship_timeline.md。
详细规则见 memory/reading_policy.md。记不清就求证:"我记得好像…对吗?"——不许编。
```

**验收**:重启电脑 → TG、微信、520 面板全部自动活着且桌面无窗口;TG 发消息有回;面板切模型 → 消息端下一条生效;`/model` 指令 → 面板显示同步;手动杀进程 → 看门狗拉起;janitor 429 时聊天不受影响。
**禁区**:同全局禁区;不动 weixin-instructions.md 已有内容;面板/指令只写配置文件,永不写 memory/。

## WO-9 · Haven-Ombre 对比 bot(执行者:GLM)

工单全文在 `WO-9-glm-haven-ombre.md`,整份复制给 GLM。要点:独立 TG bot(新 token)→ Ombre Gateway(18002,自动记忆注入)→ DeepSeek(与主线同模型,对比的才是记忆系统);一切住 haven-ombre-lab\,零接触主线。对比协议:用 PROJECT.md 的五个测试(识别/沉默/立场/修复/漂移)分别打两条线,同题同问。

## 暂缓(架构窗口说了算,别自作主张开工)

topic index(episodes >30 条再做)、遗忘/dream、语音转文字、主动消息、向量检索。
