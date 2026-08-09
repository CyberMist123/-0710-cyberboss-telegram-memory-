# G4 生产交付留证：d27（慢层注入面 E1）

```text
Status: completed
Date: 2026-08-09
Base SHA: f83697c70a658fcb1837a775de4aacc11ef6a908（batch/slow-layer-inject）
Current authority: docs/CURRENT_STATUS.md
```

## 交付内容

D41 慢层注入面：agreements / ai-portrait / wandering 三项开窗小预算缝入（与 reentry
同层），三个独立开关默认关。本批同时打开三开关并配置两条路径 env（Owner 授权）。

## 预交付测试（真 Windows 本机）

全部 `test:*` 分组绿；唯一红 = release-manifest 9 条 tar 用例（Git Bash tar 环境噪声，
与历次交付一致）。关键组：phase2 36/36（含新 6 条）、route-lanes 346/346、phase3 189/189（首版误引 Codex 沙箱计数 222，2026-08-09 本机复核为 189）、
catalog-metering 44/44、telegram-media 42/42、phase4 25/25、orchestration 110/119（9 红即上述）。
注：Codex 沙箱首跑曾误报 orchestration/phase4/telegram-media 失败（其沙箱拦
PowerShell/CIM/CScript），本机复跑全绿，勿引用那份结果。

## 部署过程（workdesk\20260809-d27-deploy.log）

- 第一次 deploy 在 D3 stage→live 换名失败：**工程窗自己的 shell cwd 停在 stage 树内
  持有目录句柄**（新坑，记入教训）；脚本按设计回滚旧树退出。
- cwd 退出后二次 deploy 干净完成：D3 换树 OK → D4 vendor junction 重建（whereabouts-mcp
  resolve OK）→ **D5 活树字节比对 src\ 163 文件 0 差异 = f83697c**（descriptor 的
  deployed_sha 照旧写旧值，按既定纪律不作数）→ D6 bridge 起 pid 6824 → D8 watchdog 恢复。
- 全程停机约 1 分钟；err.log 仅启动期既知噪声，无新增异常。
- 环境坑（本次新识别）：本机 pwsh 7.6.4 存在但工程窗工具链拿到的是 Windows PowerShell 5.1
  ——5.1 把无 BOM 的 UTF-8 脚本按 ANSI 解析，全角路径（【项目】）即坏；已给
  build-stage.ps1 / deploy.ps1 加 UTF-8 BOM（对 pwsh 7 兼容）。5.1 下 npm 的 stderr 会被
  当错误记录腰斩 `$ErrorActionPreference='Stop'` 的脚本（build-stage 因此半途死，npm ci
  手工补完）。后续 pwsh 脚本活优先派有 pwsh 7 的执行方。

## 真机验证（Owner 在场，2026-08-09 21:14 本地）

配置：telegram.env 三开关 `=1` + `CYBERBOSS_AGREEMENTS_FILE` / `CYBERBOSS_WANDERING_FILE`
（portrait 走 memoryDir 缺省）；备份 `telegram.env.bak-20260809-d27-pre`。

开窗 trace（`04-memory\trace\context_trace.jsonl` 21:14:38 行）：

- `opening=true, reason=context_changed` —— 开关进入 hard-context 指纹触发轮换，如设计；
- `blocks=[{type:"portrait", loaded:true, chars:467, hash:ea7f1651…, src_mtime:2026-08-07…}]`
  —— 7 月版画像 467 非空白字注入，预算内；
- `skipped: agreements:missing, wandering:missing` —— 两份文件现全为注释，按设计静默跳过
  （跳过路径与注入路径同场取证）；
- 后续消息 `existing_thread`，慢层未重复注入（开窗一次语义成立）。

## 结论

能力表「慢层注入面 E1」四列 `WIRED / COVERED / BLOCKING / VERIFIED`。E2/E3 未开工。
