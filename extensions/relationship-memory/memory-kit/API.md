# API.md — 记忆面板 API 桥接入说明

面板(`memory-kit/dashboard.py`)启动后,除了浏览器界面,还在同一个端口
(默认 `http://127.0.0.1:520`)开了一组 `/api/*` 接口,给任何底座/AI 窗口
读记忆、写状态、投候选用。只绑本机 127.0.0.1,不对外暴露。

## token 在哪

写端点(会改文件的那三个)需要请求头 `X-Api-Token`。这个 token 存在
`memory-kit/keys.local.json` 的 `"API_TOKEN"` 字段里,面板第一次启动时
自动生成(32 位随机 hex),之后固定不变,除非手动改文件。

打开文件看一眼就行:

```
memory-kit/keys.local.json
{
  "MEM_PROVIDER": "glm",
  "GLM_API_KEY": "...",
  ...
  "API_TOKEN": "这一串就是"
}
```

只读端点不需要 token(反正只绑本机,外部网络访问不到)。

## 端点清单

### 只读(GET,无需 token)

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康度页那些指标的 JSON 版(reentry 字数、断档、候选数……) |
| `GET /api/reentry` | `{"text":..., "chars":...}` — reentry.md 全文 + 字数 |
| `GET /api/episodes?limit=N` | 最近 N 条 episodes(倒序,默认 20) |
| `GET /api/state_log?limit=N` | 最近 N 条八维状态(倒序,默认 24) |
| `GET /api/timeline` | `{"text":...}` — relationship_timeline.md 全文 |
| `GET /api/rereadings` | `{"text":...}` — rereadings.md(年轮)全文 |

### 写(POST,必须带 `X-Api-Token`)

| 端点 | 说明 |
|---|---|
| `POST /api/state_log` | 追加一行八维状态到 `state_log.jsonl` |
| `POST /api/episode_candidate` | 追加一条候选片段到 `episodes.candidates.jsonl`(**不是**正式 episodes.jsonl) |
| `POST /api/janitor/run` | 立即触发一次后台补记(已在跑则返回 `already_running`) |

写端点的硬规矩(不是这篇文档定的,是系统设计边界):
不接受任何路径参数,不会写除了上面两个文件之外的任何东西。
候选和正史永远分开——`episode_candidate` 只进候选文件,要不要转正、
怎么措辞,由 AI 自己在 closeout 时决定。

## curl 示例(Windows curl.exe)

Windows 10/11 自带 `curl.exe`(不是 PowerShell 的 `curl` 别名,是真的 curl,
在 `cmd.exe` 或 PowerShell 里直接敲 `curl` 都行)。下面命令直接抄进终端用,
把 `你的token` 换成 keys.local.json 里的 `API_TOKEN` 实际值。

```bat
:: 读 reentry(唤醒注入用)
curl.exe http://127.0.0.1:520/api/reentry

:: 读最近 10 条八维状态
curl.exe "http://127.0.0.1:520/api/state_log?limit=10"

:: 读最近 5 条 episodes
curl.exe "http://127.0.0.1:520/api/episodes?limit=5"

:: 写一行八维状态(整点自查)
curl.exe -X POST http://127.0.0.1:520/api/state_log ^
  -H "X-Api-Token: 你的token" ^
  -H "Content-Type: application/json" ^
  -d "{\"time\":\"2026-07-05 14:00\",\"most_want\":\"她今天顺利\",\"依恋\":0.7,\"好奇\":0.5,\"沉思\":0.4,\"责任\":0.6,\"社交\":0.3,\"疲惫\":0.2,\"性欲\":0.1,\"压力\":0.2,\"note\":\"下午状态平稳\"}"

:: 白天留一笔候选(不进正史,晚上 closeout 时再挑)
curl.exe -X POST http://127.0.0.1:520/api/episode_candidate ^
  -H "X-Api-Token: 你的token" ^
  -H "Content-Type: application/json" ^
  -d "{\"title\":\"她随口提到的一件小事\",\"what_happened\":\"具体发生了什么,尽量客观\",\"anchor_quotes\":[\"她说的原话\"]}"

:: 手动触发一次后台补记(平常不用管,面板会自己定时跑)
curl.exe -X POST http://127.0.0.1:520/api/janitor/run ^
  -H "X-Api-Token: 你的token"
```

`state_log` 的 body 有严格 schema:必须恰好包含这些键——
`time、most_want、依恋、好奇、沉思、责任、社交、疲惫、性欲、压力、note`,
八维字段(依恋~压力)必须是 0~1 之间的数字,多一个键或少一个键都会被拒
(返回 400),不是"尽量像"就行,是恰好对上。

`episode_candidate` 的 body 至少要有 `title`、`what_happened`、
`anchor_quotes`(字符串数组),别的字段随意附加,id 和 source 由服务端自动补。

## 三个典型场景

**① 任何 runtime 醒来,拉一次 reentry 做注入**

新开一个窗口/新底座接入,醒来第一件事:

```bat
curl.exe http://127.0.0.1:520/api/reentry
```

拿到的 `text` 就是当前 reentry.md 全文(≤800 字,系统会自己盯着这个预算),
`chars` 是字数,超预算了页面健康度那边会亮红条,不用你操心。直接把 `text`
塞进对话开头当背景,不用额外加工。

**② 整点写一行八维状态**

底座的每小时自查 hook,原本可能是自己拼 jsonl 行手动写文件;现在改成打
这个接口即可,面板负责校验格式、追加、不会把文件写坏:

```bat
curl.exe -X POST http://127.0.0.1:520/api/state_log ^
  -H "X-Api-Token: 你的token" ^
  -H "Content-Type: application/json" ^
  -d "{...上面那个格式...}"
```

八维数值是 AI 自报的主观状态(0~1),不是精确测量,填个大致值就行。

**③ 白天想留一笔,晚上 closeout 时再挑**

聊天过程中遇到一件事,当下觉得"这个可能重要,但现在不是写正史的时机"——
不用打断当下的节奏去手改 episodes.jsonl,直接投一条候选:

```bat
curl.exe -X POST http://127.0.0.1:520/api/episode_candidate ^
  -H "X-Api-Token: 你的token" ^
  -H "Content-Type: application/json" ^
  -d "{\"title\":\"...\",\"what_happened\":\"...\",\"anchor_quotes\":[\"...\"]}"
```

这条会带上 `source:"api"` 和自动生成的 `id`(`cand-api-时间戳`),躺在
`episodes.candidates.jsonl` 里等审。晚上做 closeout 的 AI 会看到它(连同
janitor 自动补记出来的候选一起),自己判断要不要写进正式的
`episodes.jsonl`,以及怎么措辞——这一步永远是 AI 自己的手,API 不代劳。

## 顺带一提

- 这些接口不需要你（她）手动维护,面板启动时就一直开着,直到面板关掉。
- 想确认面板是不是活的:浏览器开 `http://127.0.0.1:520` 能看到界面就是活的;
  或者直接 `curl.exe http://127.0.0.1:520/api/health` 有返回就是活的。
- 写端点报 401,说明 token 不对——去 `keys.local.json` 核对一下 `API_TOKEN`
  是不是复制全了(32 位十六进制,没有引号)。
