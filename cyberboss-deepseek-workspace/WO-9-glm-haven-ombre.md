# WO-9 · Haven-Ombre 对比 bot(执行者:GLM)

你是管道执行者。任务:在这台 Windows 机器上部署 Haven-Ombre(记忆网关),并写一个极简 Telegram 桥接进它,作为现有 AI 伴侣主线的**对比实验组**。只做基建,不写人设内容,不碰主线任何文件。

## 铁律(违反即返工)

1. 绝不读写这些目录:`cyberboss-deepseek-workspace\memory\`、`C:\Users\18717\.cyberboss\`、`cyberboss\`、`cyberboss-deepseek-test\`。
2. 绝不使用主线的 Telegram bot token(两个 poller 抢同一 token 会 409 互杀)。本工单用**新 token**,问用户要(她先在 @BotFather 建一个新 bot)。
3. 端口:Ombre 用默认 18001/18002;不许占用 520 和 8785。
4. 所有新东西住 `C:\Users\18717\Documents\cyberlink\haven-ombre-lab\` 下。
5. key 只进 `.env`,不进 yaml、不进代码、不进日志输出。

## 第一步:部署 Haven-Ombre

```bash
# 用 Git Bash(不要在 PowerShell 里直接 bash,可能误调 WSL)
git clone https://github.com/Yinglianchun/Haven-Ombre.git C:/Users/18717/Documents/cyberlink/haven-ombre-lab/Haven-Ombre
cd C:/Users/18717/Documents/cyberlink/haven-ombre-lab/Haven-Ombre
bash scripts/one_click.sh
```

菜单选择:**首次部署 → Windows → Python 直跑 → 部署全部**(需要 Gateway,不能只装 MCP)。交互式配置按下面填:

- **identity**:`ai_name` 等问用户要(实验体名字,别照抄示例的 Haven/Rain/xiaoyu)。
- **gateway.upstreams**:配两个 OpenAI-compatible 上游——
  - DeepSeek:`base_url: https://api.deepseek.com`,模型 `deepseek-chat`(key 问用户要;**对比实验默认用它**,和主线同模型才是对比记忆系统而不是对比模型)。
  - GLM 备用:`base_url: https://open.bigmodel.cn/api/paas/v4`,模型 `glm-5.2`(key 用户有)。
- **gateway.default_session_id**:`lab-main`。
- **embedding**:如果用户没有 SiliconFlow key,先试 bigmodel:`OMBRE_EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4`,`OMBRE_EMBEDDING_MODEL=embedding-3`;起不来就 `OMBRE_EMBEDDING_ENABLED=false` 先跑通(fuzzy 检索也能用),别卡在这。reranker 同理,起不来先 `enabled=false`,不要删配置键。
- **dream**:保持默认(`inject_enabled=false`)。
- Supabase / OAuth / diary:全部不配。

启动(脚本会生成 `start_local.ps1`),然后验收:

```powershell
curl.exe -sS http://127.0.0.1:18001/health
curl.exe -sS http://127.0.0.1:18002/health
```

两个都通才继续。Dashboard 在 `http://127.0.0.1:18001/dashboard`,首次打开设个密码,告诉用户。

## 第二步:写 TG 桥

新建 `C:\Users\18717\Documents\cyberlink\haven-ombre-lab\tg_bridge\tg_ombre_bridge.py`,只用 requests + 标准库:

- 配置从同目录 `.env` 读:`TG_BOT_TOKEN`(新 bot 的)、`OMBRE_GATEWAY_TOKEN`、`OMBRE_MODEL`(默认 deepseek-chat)、`ALLOWED_CHAT_IDS`(逗号分隔白名单,空=拒绝所有,防陌生人)。
- 主循环:`getUpdates` 长轮询(timeout=50),offset 持久化到 `tg_bridge/.offset`;收到白名单消息 → 发 `sendChatAction typing` → POST `http://127.0.0.1:18002/v1/chat/completions`,header 带 `Authorization: Bearer <token>` 和 `X-Ombre-Session-Id: tg-<chat_id>` → 回复发回 TG。
- 健壮性:回复超 4096 字分段发;网络/上游错误指数退避重试 3 次,最终失败回一句固定短句("我这边卡了一下,等我一会");任何异常不允许干掉主循环;日志写 `tg_bridge/bridge.log`(轮转,单文件 ≤5MB),日志里 token 打码。
- 附带 `启动桥.bat`(pythonw 隐藏窗口)和 `停止桥.bat`。**先不做开机自启**,对比实验满意了再说。

## 第三步:验收(逐项报告)

1. 两个 health 都 200。
2. TG 给新 bot 发"在吗",30 秒内有回复。
3. 记忆链路:发一条包含具体事实的消息(比如"我今天把阳台的多肉搬进屋里了"),等 2 分钟,再问"我刚才说我干了什么?"——应答对(短时上下文);然后问一个无关问题,确认它不把多肉硬塞进回答(注入不贴脸)。
4. Dashboard 桶列表能看到新写入的记忆。
5. `GET http://127.0.0.1:18002/api/debug/injections?session_id=tg-<chat_id>` 能看到注入记录(给用户看一眼截图/输出)。
6. 主线 TG bot 全程正常收发(证明零干扰)。

## 交付物清单

`haven-ombre-lab\`(仓库+数据)、`tg_bridge\`(桥+bat+README 三行用法)、connection_guide.txt 的位置、Dashboard 地址和密码提醒、验收 1-6 的逐项结果。遇到卡死的步骤,报告卡在哪、报错原文,不要自己绕过铁律。
