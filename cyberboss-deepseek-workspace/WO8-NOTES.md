# WO-8 执行记录

## TG 卡死的真正原因(2026-07-05 10:11 UTC 之后)

不是 GLM 429、不是 sessions.json 目录被吃、不是 janitor 抢 key ——
是 **`api.telegram.org` 直连断了**。TG 进程还在跑(`.cyberboss-deepseek-test/logs/cyberboss.err.log` 457 行全是 `poll failed: fetch failed`;`telegram-poller.log` 从 10:11 起只剩 `sendTyping failed error=fetch failed`,一小时一次(那是 desire poller 到点想主动发但发不出)。

工单里那三条"已知线索"里,只有 GLM 429 是真的,但它只影响 janitor(提取管道),没影响聊天。sessions.json 只剩 GLM 三个 是微信线的 Codex runtime,和 TG 无关。

**要她做的事(不用改代码,只有一步):**
先确认系统代理开着 —— 国内直连 `api.telegram.org` 会 fetch failed。V2Ray / Clash / 别的什么都行,开完之后:

1. 双击 `重启TG.bat`(会自动把 keys.local.json 刷到 TG 的 .env、停旧进程、隐藏起新进程)
2. 想更稳一点:把代理地址填到 `520 面板 → 模型与 Key 页 → HTTPS_PROXY`,保存,再重启一次。这样即使系统代理没开,TG 也能定向走这个端口。

诊断脚本 `memory-kit\tg_doctor.py` 双击就能跑,报告 pid、DNS、能不能到 telegram / DeepSeek、err.log 尾部。

## 交付清单(全在工作区里,不动 memory/ 一个字节)

**TG 修通:**
- `重启TG.bat` — apply_keys → stop → start(隐藏)一条龙
- `memory-kit\tg_doctor.py` — 体检报告
- 代码零改动,聊天靠系统代理或 keys.local.json 里的 `https_proxy`

**自启三件套(全部隐藏窗口,onlogon):**
- `自启-注册.bat` / `自启-取消.bat` / `自启-状态.bat` / `自启-停止全部.bat`
- `launcher\tg-hidden.vbs` / `wechat-hidden.vbs` / `dashboard-hidden.vbs` / `watchdog-hidden.vbs`
- `launcher\watchdog.py` — 60s 一巡,pid 文件 + 端口双探(8785/520);死了拉,每条线每小时最多拉 4 次(防疯狂重启);日志 `launcher\watchdog.log`。

四条计划任务:`cyberboss-tg-line` / `cyberboss-wechat-line` / `cyberboss-memory-panel` / `cyberboss-watchdog`。WO-7 留下的 `cyberboss-memory-panel` 会被同名覆盖(不冲突)。

想接旧的 WO-7 `开机自启注册.bat` 也行 —— 那份只注册面板一条,新的 `自启-注册.bat` 是它的超集。

**key / 模型单一真源:**
- `memory-kit\keys.local.json` — 唯一真源(结构:`chat_provider/chat_model/chat_keys.{deepseek,glm,claude}/chat_endpoints/extract_*/telegram_bot_token/https_proxy`)
- `memory-kit\config_loader.py` — 三方都从这里读(`load_keys` / `chat_config` / `extract_config` / `telegram_config`)。旧字段 `MEM_PROVIDER/GLM_*/DS_*` 全保底,不打断 janitor 现有跑法。
- `memory-kit\apply_keys_to_env.py` — 单向 push:keys.local.json → `.cyberboss-deepseek-test\.env`。带 `# [managed by keys.local.json]` 标注,只碰它管的字段,其他行保留;有备份 `.env.bak`;chat 全空时拒绝写(不会把工作 .env 洗成空)。
- `dashboard.py` 加了 `/config` 页 + `/api/config` GET/POST。打开 `http://127.0.0.1:520/config` 就能填 key、切模型、改代理、保存。保存后自动跑 apply_keys,提示"重启 TG 生效"。

聊天 key 与提取 key **分开字段**:janitor GLM 429 不再波及聊天。

**人设:**
- `templates\weixin-instructions.md` 末尾追加了工单里那 4 行「记忆与连续性」块,原文一字未动。
- 运行态 `.cyberboss-deepseek-test\weixin-instructions.md` 也同步追加了 —— 因为 `src\index.js` 只在文件不存在时才复制模板,模板改了但实文件不重新生成。这样她那边下一个新会话就能读到。

## 全局禁区自检 ✅

1. `memory/` 写入规则、reading_policy、closeout 模板 —— 一个字节没动。
2. `reentry.md` 没塞任何东西,800 字预算原样。
3. 新功能全住 `memory/` 外(launcher/、根 bat、memory-kit/)。
4. 没引入向量库 / embedding / 自动聚类。
5. 改代码前读了 PROJECT.md 北极星判据 + 设计原则。
6. `memory/*.md` 正文没动。

工单专属禁区:
- `weixin-instructions.md` 已有内容 —— 只追加,不改。
- 面板 / apply_keys —— 只写 `keys.local.json` 与 TG `.env`,永不写 `memory/`。

## 还没做的(诚实)

- **消息端指令 `/model` / `/key`**:没接。原因:得改 `cyberboss-deepseek-test\src\` 里的 telegram inbound 派发链,这窗口没法验;换成从面板改 + `重启TG.bat`,得到同样结果("或安全重启该线"路径)。她想自己接,把面板 `/api/config` POST 直接调用即可,或者告诉我一声,我拿这条链再走一次。
- **看门狗拉 TG 时的代理感知**:看门狗只管进程死活。如果代理反复断,TG 会反复起来又空转 —— 得靠系统层保代理稳。这个不在 WO-8 范围里。

## 验收清单对照

| 工单要求 | 状态 |
|---|---|
| 重启电脑 → 三线自动活着、桌面无窗 | 计划任务 4 条 onlogon + wscript vbs 全隐藏,待她跑 `自启-注册.bat` 后重启验证 |
| TG 发消息有回 | 代理恢复 + `重启TG.bat` 即可;`tg_doctor.py` 有分层报告 |
| 面板切模型 → 消息端下一条生效 | `/api/config` 保存后自动 apply_keys;她再点 `重启TG.bat` 就吃到新模型 |
| `/model` 指令 → 面板显示同步 | 未做,原因见上;换成面板双向作为真源 |
| 手动杀进程 → 看门狗拉起 | `watchdog.py` 每 60s 一巡,拉起,日志留痕,限流 4 次/时 |
| janitor 429 时聊天不受影响 | chat_keys 和 extract_keys 已分离字段,互不影响 |
