# CLAUDE.md

给 AI 协作者的入口。**本文件只指路，不复制内容** —— 详情一律去 `README.md` 与 `docs/`。

Cyberboss Telegram Memory：Telegram 侧的关系记忆系统，生产机是一台 Windows。规模约 513 个跟踪文件、48k 行代码（`src` + `scripts` + `extensions`）、85 个测试文件 —— 不要试图通读，按下面的路径定位。

## 先读什么

`README.md` 第七节「文档地图」是权威索引，给出了五份权威文档及**优先级排序**：权威文档 > Handoff > 已验证源码与运行证据 > Liveness Notes > README 与其他说明。

最常用的三个入口：

- 架构（谁读、谁写、什么进上下文）→ `docs/CONTINUITY_ARCHITECTURE.md`
- 当前进度与验收 → `docs/IMPLEMENTATION_STATUS.md`
- **能不能切生产** → `docs/audit/R4_FINAL_CODE_REVIEW.md`

`docs/archive/` 下的内容已失效，**不要据此做判断**。

`README.md` 第八节「给执行模型」是实施纪律，动代码前必读。

## 当前状态：R4 终审 **FAIL**，不得切生产

`docs/audit/R4_FINAL_CODE_REVIEW.md`（2026-07-26）判 FAIL。**合并进 `main` 不等于批准部署**。五条发现，翻盘清单在报告末尾，按序号顺序做：

| | 问题 | 位置 |
|---|---|---|
| F1.4 | **CI 只跑 4/82 个测试文件**，release/cutover 那批一个都不在内 —— 门不存在。清单第 1 条，优先于所有代码修复 | `.github/workflows/phase1-offline.yml` |
| F1 | 4 个 PS 测试文件无平台守卫；5 处 `assert.notEqual(status, 0)` 在 ENOENT 下恒真（假绿） | `test/release-control-plane.test.js`、`test/orchestration-release-watchdog.test.js` |
| F2 | `installStartupArtifact` 无 manifest 哈希锚定且读两次；`verifyManifest` 的 git 校验只证存在性 | `scripts/orchestration/release-control-plane.js`、`src/orchestration/release-manifest.js` |
| F4 | 向上摸目录取最近匹配祖先，`$root` 决定被执行的 Python 文件与密钥路径 | `scripts/windows/runtime-startup/start-dashboard.ps1`、`start-telegram.ps1` |
| F5 | 硬依赖 Python ≥ 3.10 却无版本声明，3.9 上导入即失败 | `extensions/relationship-memory/launcher/watchdog.py` |

## 跑测试：先读这段，否则会误判

Node ≥ 22。**没有 `npm test`**，测试按 `npm run test:*` 分组（`test:phase1`、`test:orchestration`、`test:route-lanes` 等，完整列表见 `package.json`）。

三个会让你把红当绿、或把绿当过的陷阱：

1. **非 Windows 机器上**，调 `powershell.exe` 的测试会 `spawnSync` ENOENT，`status` 为 `null` 且不抛异常。于是 `assert.notEqual(status, 0)` 这类 fail-closed 断言**恒真** ——「脚本没跑」和「脚本正确退役」不可区分。这类测试在本机的绿灯**没有意义**。
2. **Python 需 ≥ 3.10**（见 F5）。3.9 上 `watchdog.py` 导入即 `TypeError`，相关测试全红，且失败信息不会告诉你是版本问题。
3. **CI 不是全量门**。`.github/workflows/phase1-offline.yml` 只跑 `npm run test:phase1`（4 个文件）。CI 绿 ≠ 你改的代码被验证过。改 `scripts/orchestration/`、`scripts/windows/`、`extensions/relationship-memory/launcher/` 时，必须自己指定测试文件跑，并说明在什么平台跑的。

现成但未接线：`npm run test:orchestration` 已覆盖 `release-control-plane` 与 `orchestration-release-watchdog`；`status-script`、`release-manifest`、`stable-telegram-launcher` 还需补进去。

## 硬性禁止

- **这是公开仓库。** 所有分支都不是私密空间。
- 永不提交：真实 token、会话、日志、私人 Episodes / Self-notes / Portrait、Desire live state、PID、缓存、lock。对应目录 `runtime/`、`memory/`、`settings/secrets/*.local.json` 均不在版本控制内，保持这样。
- `deployment/current.json` 与 `runtime/` 是**按机器不同**的，不要跨机同步。
- `README.md` 的「先看：还没实现 / 当前不要做」一节列出的暂缓项，即使「顺手就能做」也不得进 diff。
- `vendor/` 是上游拷贝，不要在里面改东西。

## 分支

`main` 是唯一主干；`fix/*` 单一问题，合并后即删；`audit/*` 只加报告、不改被审代码，作为留痕保留。

判断一个分支还有没有活儿：

```
git rev-list --left-right --count origin/main...<分支>
```

`ahead=0` 意味着它的每个提交都已在 `main` 里 —— 死分支，删掉，不要再往里做事。

## 目录速查

| 路径 | 内容 |
|---|---|
| `src/adapters/channel/telegram.js` | Telegram 通道适配器 |
| `src/core/app.js` | 启动编排（`describe()` 在此被调用打印横幅） |
| `src/orchestration/release-manifest.js` | manifest 生成与校验 |
| `scripts/orchestration/release-control-plane.js` | 发布控制平面：描述符与启动件安装 |
| `scripts/windows/runtime-startup/` | 生产机 PowerShell 入口 —— **改这里最危险**，见 F1/F2/F4 |
| `extensions/relationship-memory/` | 记忆内核与 520 面板；监督进程在 `extensions/relationship-memory/launcher/watchdog.py` |
| `test/` | 85 个测试文件 |
| `docs/` | 全部文档；`docs/audit/` 审查报告，`docs/archive/` 已失效 |
