# R4 终审 · 只读代码审查结论：**FAIL**

| 项 | 值 |
| --- | --- |
| 审查对象 | `fix/r4-followups` @ `82e6667` |
| 审查日期 | 2026-07-26 |
| 审查环境 | macOS (darwin arm64) · Node v22.16.0 · Python 3.9.6 · 无 `powershell.exe` / `pwsh` |
| 审查性质 | 只读。本次提交只新增本文件，未改动任何被审代码 |
| 结论 | **FAIL** —— 不为"切生产"背书 |

## 结论

FAIL 不是否定加固设计。主链路的工程质量确实高：TOCTOU 单读纪律、原子 `rename` + 回读 + 回滚、全链路拒 BOM、精确身份匹配、旧可变部署 fail-closed 退役，这些都在代码里落实了，并且有实测通过的测试背书（见「确认扎实的部分」）。

FAIL 的理由是**当前状态下无法取得切生产所需的证据**：改动生产机的那批入口，在离线测试门上是零信号或反向信号；而锚定最弱的那个安装函数，恰好只能通过零信号的那个入口到达。在补齐 F1 之前，"测试全绿"这句话不能作为放行依据。

---

## F1｜测试门靠环境巧合才绿，且 fail-closed 断言恒真

**严重度：高（阻断放行）**

调 PowerShell 的 7 个测试文件里，只有 3 个有诚实的平台守卫：

| 文件 | 平台守卫 |
| --- | --- |
| `test/stable-telegram-launcher.test.js` | ✅ `{ skip: !IS_WINDOWS }` |
| `test/nightly-control-plane.test.js` | ✅ |
| `test/phase1-switch.test.js` | ✅ |
| `test/release-control-plane.test.js` | ❌ 无 |
| `test/orchestration-release-watchdog.test.js` | ❌ 无 |
| `test/status-script.test.js` | ❌ 无 |
| `test/release-manifest.test.js` | ❌ 无（但不实际 spawn，11/11 通过） |

`test/release-control-plane.test.js:79` 无条件直接 spawn：

```js
function runPowerShell(script, args) {
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, ...args], { encoding: "utf8" });
}
```

**本机实测**（`node --test`，逐文件）：

```
release-control-plane            11 tests /  7 pass / 4 fail
orchestration-release-watchdog   25 tests / 17 pass / 8 fail
status-script                     3 tests /  1 pass / 2 fail
release-manifest                 11 tests / 11 pass / 0 fail
                                 ─────────────────────────────
                                 50 tests / 36 pass / 14 fail
```

### F1.1 fail-closed 断言在 ENOENT 下恒真

`spawnSync` 找不到二进制时返回 `status === null`、`stdout/stderr === null`，**不抛异常**。于是：

```js
assert.notEqual(result.status, 0, `${retired} did not fail closed`);   // release-control-plane.test.js:115
assert.notEqual(telegramMode.status, 0, "...did not fail closed");     // :121
assert.notEqual(result.status, 0);                                     // orchestration-release-watchdog.test.js:248, 262
```

共 5 处。`null !== 0` 恒成立 —— **"脚本没跑"和"脚本正确退役"在这些断言下不可区分**。

这不是理论推断，本次实测就抓到了现场：测试 16 `legacy manifest writer is retired so it cannot overwrite the formal descriptor` 的 `assert.notEqual(result.status, 0)` 静静通过了，真正报错的是紧随其后的 `assert.match(...)`，`failureType: testCodeFailure / operator: 'match'`，因为 `stdout`/`stderr` 为 `null` 被插值成字符串 `undefined`。也就是说：**fail-closed 断言确实因为错误的原因绿了**，只是碰巧有一条后续断言接住了它。没有那条后续断言的地方（如 `:248`、`:262` 单独成立的 `notEqual`），就是纯粹的假绿。

### F1.2 测试从不暴露 `result.error`，ENOENT 诊断被吞掉

14 条失败的完整输出里，`ENOENT` 出现 **0** 次，`powershell` 出现 **0** 次。失败信息统一是：

```
Expected values to be strictly equal:
null !== 0
```

排查者看不到"二进制不存在"，只看到一个无解释的 `null`。

### F1.3 14 条失败并非同因，摘要归因需修正

必须分成三类，修法完全不同：

| 类别 | 条数 | 根因 | 修法 |
| --- | --- | --- | --- |
| (a) PowerShell 缺失 | 6 | `powershell.exe` 不存在 | 补 `{ skip: !IS_WINDOWS }` + 在 Windows 上真跑并留证 |
| (b) Python 版本 | 6 | 见 F5，与平台无关的真实缺陷 | 修 `watchdog.py`（**不是** skip 掉） |
| (c) Windows 路径字面量 | 2 | `status-script` 断言解析 `'node "D:\release\bin\cyberboss.js"'` | 测试本身是对的，`resolveProcessDirectory` 按构造就是 Windows-only |

> (c) 的具体表现：`resolveProcessDirectory('node "D:\\release\\bin\\cyberboss.js"')` 期望 `D:\release\bin`，POSIX 下实得 `.`。这是纯函数单元测试，**完全不 spawn 子进程**。如果用"非 Windows 一律 skip"来把门刷绿，这条合法失败也会被一起埋掉。

**结论：改动生产机的那几个 PS 入口，在离线门上零信号；其中 5 处 fail-closed 断言是反向信号（假绿）。**

---

## F2｜`installStartupArtifact` 的 manifest 无哈希锚定，且读两次

**严重度：中高（取决于 manifest 来源的可信度，而该可信度未在代码内强制）**

`scripts/orchestration/release-control-plane.js:70-81`：

```js
function installStartupArtifact({ source, target, manifestPath, releaseDir, verify = verifyManifest, repoDir }) {
  const result = verify({ manifestPath, releaseDir, repoDir: repoDir || null });   // 第 1 次读 manifest
  if (!result.ok) throw new Error(`manifest verification failed: ...`);
  const manifest = readManifest(manifestPath);                                    // 第 2 次读 manifest
  const sourceBytes = fs.readFileSync(source);                                    // 源单读 ✅
  const record = manifestCovers(manifest, releaseDir, source, sourceBytes);        // 用第 2 次的 manifest
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, sourceBytes);
  if (sha256(target) !== record.sha256) throw new Error("installed startup artifact hash does not match the manifest record");
}
```

### 与姊妹函数的不对称

`installDescriptor`（同文件 `:30-69`）有双锚定：

```js
equalHash(sha256Bytes(candidateBytes), expectedCandidateSha256, "candidate");   // :38
const manifestSha256 = sha256(manifestFile);
equalHash(manifestSha256, expectedManifestSha256, "manifest");                  // :39-40
```

`installStartupArtifact` 的入参列表里**根本不存在** `expectedManifestSha256` 字段。

### 具体后果

源文件是单读的（`:77-78`），"读后被换的源无法自我认证"这一点是成立的，且有测试实测通过 —— 这一条摘要说反了，此处修正。**可被换的是 manifest**：能在第 71 行与第 73 行之间替换 manifest 文件的人，同时决定了覆盖检查的基准（`record`）和事后校验的基准（第 80 行拿的是同一个 `record.sha256`），于是第 71 行的验证被整体绕过。

### 唯一生产调用方也没有传哈希

`scripts/windows/runtime-startup/install-runtime-startup-artifacts.ps1:27`：

```powershell
& node -e "...c.installStartupArtifact({source:...,target:...,manifestPath:process.argv[4],releaseDir:...,repoDir:...})" ... $ManifestPath $release $repo
```

`$ManifestPath` 直接来自算子入参，整条链路上不存在任何 expected-manifest-hash 通道。其安全性依赖"算子递交的 manifest 可信且在调用期间不可变"这一**巧合式信任**，而非代码内校验。

### F2 与 F1 咬合

`install-runtime-startup-artifacts.ps1` 正是 F1 里零信号的那批入口之一。**锚定最弱的函数，只能通过离线零信号的入口到达** —— 这个组合是 FAIL 的核心。

### `verifyManifest` 的 git 校验只证存在性

`src/orchestration/release-manifest.js:323-331`：

```js
if (repoDir && manifest.commit) {
  for (const [field, sha] of [["commit.sha", manifest.commit.sha], ["commit.tree_sha", manifest.commit.tree_sha]]) {
    try { execFileSync("git", ["-C", repoDir, "cat-file", "-e", sha], { stdio: "ignore" }); }
    catch { errors.push(`${field}: does not exist in the external repository ${repoDir}`); }
  }
}
```

仅 `cat-file -e`。它**不**验证 `tree_sha` 是否确为 `commit.sha` 的 tree，也**不**比对 manifest 的文件清单与该 tree。真正的 tree 校验（`gitTrackedFiles` `:144` 用 `ls-tree -r`、`gitCommitTreeSha` `:149` 用 `rev-parse ^{tree}`）只存在于**生成**路径；对 `verifyManifest` 函数体的 grep 中 `ls-tree` / `rev-parse` 零命中。

结果：任何一对"在可信仓库里碰巧存在"的 SHA 都能通过验证，两者无需彼此相关。

---

## F4｜多处向上摸目录取"最近匹配祖先"

**严重度：分站点不同，见下**

### F4.1 `start-dashboard.ps1`（现役 520 面板）—— 中高

`scripts/windows/runtime-startup/start-dashboard.ps1:5-18`：

```powershell
if (-not $root) {
    $candidate = $scriptRoot
    while ($candidate) {
        if ((Test-Path (Join-Path $candidate "runtime")) -and (Test-Path (Join-Path $candidate "settings"))) {
            $root = $candidate; break
        }
        $parent = Split-Path -Parent $candidate
        if ($parent -eq $candidate) { break }
        $candidate = $parent
    }
}
```

取**最近**一个同时含 `runtime` 与 `settings` 的祖先。这个 `$root` 随后决定：

- `:25` `$dashboard = $root\runtime\web\memory-kit\dashboard_continuity.py` —— **随后在 `:79-85` 被执行**
- `:75` `$env:CYBERBOSS_DASHBOARD_KEYS_FILE = $root\settings\secrets\dashboard-keys.local.json` —— 面板密钥路径
- `:69-70` `CYBERBOSS_MEMORY_DIR` / `CYBERBOSS_CONTINUITY_DIR`

即：**一个比真实根更近、且恰好含有 `runtime/` 与 `settings/` 两个目录的诱饵祖先，就能让该脚本执行诱饵提供的 Python 文件，并把密钥路径指向诱饵目录。** 这条路径上没有任何哈希校验。

今天不出事只因为布局里没有更近的诱饵 —— 这是布局的巧合，不是代码的保证。

**缓解已存在但未强制**：`:4` 的 `$env:CYBERLINK_ROOT` 优先于回溯。设置它即可完全消除该回溯。

### F4.2 `start-telegram.ps1`（旧线）—— 中

同型回溯，找 `runtime` + `settings`。

### F4.3 `watchdog.py:15-19` —— 低（严重度需下调）

```python
DEFAULT_DESCRIPTOR = next(
    (parent / "deployment" / "current.json" for parent in HERE.parents
     if (parent / "deployment" / "current.json").exists()),
    Path.cwd() / "deployment" / "current.json",
)
```

摘要按同等严重度列出，但实际应下调：`watchdog_identity`（`:158-168`）要求进程 argv 里含**精确的 `--descriptor` token** 且与 `descriptor_path.resolve()` 归一化后相等，才认定所有者。因此生产路径必然显式传 `--descriptor`，`DEFAULT_DESCRIPTOR` 只影响手工运行。

仍应修，理由是兜底分支：祖先里找不到时落到 **`Path.cwd()`** —— 由当前工作目录决定单一所有者监督进程读哪个 descriptor。手工运行时 cwd 不受控。

### 对照组

`scripts/windows/runtime-startup/stable-telegram-launcher.candidate.ps1` 中 `while` 出现 **0** 次；它从 descriptor 的 `telegram_entry` 反推 release 根（`:62`），不探测文件系统。加固主链路已经做对了，问题在于没有推广到 F4.1/F4.2。

---

## F5｜（新增）`watchdog.py` 硬依赖 Python ≥ 3.10 且未声明

**严重度：高（可致单一所有者监督进程完全不启动）**

本次审查新发现，云端初稿未列。`extensions/relationship-memory/launcher/watchdog.py` 在**运行时求值的注解位置**使用 PEP 604 union：

```
:74   def process_row(pid: int) -> dict | None:
:149  def command_descriptor(tokens: list[str]) -> str | None:
:212  def verify_watchdog_owner(..., legacy_owners: list[tuple[Path, Path]] | None = None) -> None:
:228  def run_watchdog(..., iterations: int | None = None, ...) -> str | None:
```

文件中无 `from __future__ import annotations`。在 Python 3.9 上**导入即失败**：

```
$ python3 -V
Python 3.9.6
$ python3 extensions/relationship-memory/launcher/watchdog.py --help
Traceback (most recent call last):
  File ".../watchdog.py", line 74, in <module>
    def process_row(pid: int) -> dict | None:
TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'
```

这是 F1 分类 (b) 那 6 条失败的真正根因（实测 `PYTHON=python3 node --test` 计数不变，排除了"仅仅是 `python` vs `python3` 命名问题"）。

**生产风险**：全仓无任何 Python 版本声明（`python_requires` / `sys.version_info` 守卫，grep 零命中），而 `start-dashboard.ps1:26` 从 PATH 解析 `python.exe` 时不做版本检查。若目标机的 `python.exe` 是 3.9，watchdog 在导入阶段即死 —— 监督进程根本不起来。

**修法**（二选一，均为一行级）：加 `from __future__ import annotations`（四处全覆盖，恢复 3.9 兼容），或显式声明并在启动路径上加 `sys.version_info` 守卫使其 fail-closed 而非静默不启动。

---

## 确认扎实的部分

以下均为本机实测通过，不是纸面推断：

- **TOCTOU 单读纪律**（`installDescriptor`）：`:36` 单读 candidate，后续哈希锚定、BOM 检查、schema 校验、`rename`、回读比对全部作用于这同一份 bytes。
  - ✅ `manifest coverage judges the caller's bytes, so a source swapped after reading cannot self-certify`
- **原子 `rename` + 回读 + 回滚**：`:44` `flag: "wx"` 写临时文件 → `:47` 校验将被 rename 的 bytes → `:54` 同目录原子 rename → `:56-57` 回读比对 → `:59-64` 失败则恢复备份或删除新装。
  - ✅ `candidate install creates missing formal descriptor as exact UTF-8 bytes`
  - ✅ `candidate replacement retains an immutable backup and audit`
  - ✅ `hash mismatch, BOM, and validation failure do not damage old descriptor`
  - ✅ `manifest failure and descriptor schema/path failures retain the old descriptor`
  - ✅ `post-write validation failure restores the previous descriptor and removes a fresh install`
- **全链路拒 BOM**：`hasBom` 在 candidate（`:37`）、manifest（`:27`）、回读（`:57`）三处生效；`watchdog.py:44` 同样拒 BOM。
  - ✅ `descriptor rejects a UTF-8 BOM with a clear error`
- **精确身份匹配**：`watchdog_identity` 要求 Python / 脚本 / descriptor 三元组精确匹配，不做子串匹配。
- **严格路径校验**：`release-manifest.test.js` 11/11 全通过；PID 路径越界、父目录缺失、目录冒充文件、跨 release 目录引用等均被拒。
- **startup 源的越界防护**：`manifestCovers:20` 对 `path.relative` 结果检查 `../` 与绝对路径。

---

## 翻盘 PASS 清单

按依赖顺序，全部完成方可重新申请放行：

1. **【F1｜必须】** 给 4 个无守卫的 PS 测试文件补 `{ skip: !IS_WINDOWS }`，对齐 `stable-telegram-launcher.test.js` 的既有写法。**注意**：不要用"非 Windows 一律 skip"一刀切 —— F1 分类 (b)(c) 那 8 条不是平台问题，skip 掉等于埋掉真实缺陷。
2. **【F1｜必须】** 在真 Windows 机器上跑那 6 条 PowerShell 测试并留证（完整 `node --test` 输出 + 机器/PowerShell 版本），归档进 `docs/audit/`。这是切生产的核心证据，目前完全缺失。
3. **【F1｜必须】** 收紧 5 处 fail-closed 断言。最小改法：断言前先确认进程真的跑过 —— 检查 `result.error` 为空且 `result.status !== null`，再断言 `notEqual(status, 0)`。同时把 `result.error` 纳入失败信息，别再让 ENOENT 静默成 `null !== 0`。
4. **【F5｜必须】** 修 `watchdog.py` 的 Python 版本依赖（加 `from __future__ import annotations`），并在启动路径上补版本守卫使其 fail-closed。
5. **【F2｜必须】** 给 `installStartupArtifact` 补 manifest 锚定：新增 `expectedManifestSha256` 参数，单读 manifest bytes 后先 `equalHash` 再用于 `verify` 和 `manifestCovers`（消除双读），并把该参数一路打通到 `install-runtime-startup-artifacts.ps1`。
6. **【F2｜建议】** 在 `verifyManifest` 里把 git 校验从存在性提升为关系校验：`rev-parse ${commit.sha}^{tree}` 与 `manifest.commit.tree_sha` 比对；生成路径已有现成辅助函数 `gitCommitTreeSha` 可复用。
7. **【F4.1/F4.2｜必须】** 消除 `start-dashboard.ps1` / `start-telegram.ps1` 的祖先回溯。最省的做法：在安装期把 `CYBERLINK_ROOT` 固化进启动项（回溯逻辑已让位于它），或改为像 `stable-telegram-launcher.candidate.ps1` 那样从 descriptor 反推根目录。
8. **【F4.3｜建议】** 去掉 `watchdog.py` 的 `Path.cwd()` 兜底，改为无显式 `--descriptor` 时 fail-closed。

---

## 与云端 R4 初稿的差异（修正记录）

本报告在本机独立复核，以下三处与初稿摘要不一致，以本报告实测为准：

| 项 | 初稿 | 本报告实测 |
| --- | --- | --- |
| 失败计数 | 58 tests / 51 pass / 6 fail / 1 skip | 所审 4 文件 50 tests / 36 pass / 14 fail / 0 skip（口径不同，初稿未记录所跑文件集） |
| 失败归因 | 14 条（或 6 条）全部因 `powershell.exe` 不存在 | 三类同存：PowerShell 缺失 6 条、Python ≥3.10 未声明 6 条（F5，初稿未列）、Windows 路径字面量 2 条 |
| F2 源文件读取 | 描述为"读两次" | 源是**单读**且有测试背书；双读的是 **manifest**，这才是可被换的对象 |
| F4.3 watchdog | 与 F4.1 同等严重度 | 下调至低：`watchdog_identity` 要求精确 `--descriptor` token，生产路径必然显式传参 |

初稿的 `verifyManifest` 只做 `cat-file -e` 这一判断经复核**成立**（`ls-tree` / `rev-parse ^{tree}` 只在生成路径），此处无修正。
