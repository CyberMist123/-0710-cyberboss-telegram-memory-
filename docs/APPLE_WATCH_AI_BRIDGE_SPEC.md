```text
Status: supplemental
Authority: none
Scope: Apple Watch bridge 规格 / 提案（仓库无任何对应实现）
Last reviewed: 2026-07-27
Current authority: docs/CURRENT_STATUS.md
```

> This document may change independently. It is supporting material, not current project truth or an approved decision.
>
> 本文是提案，不要读作「已实现」。当前能力表见 `docs/CURRENT_STATUS.md`。

# Apple Watch ↔ AI 双向接入技术规格

> 目标：通过「中继服务 + Apple Watch 设备端 + MCP」让 AI 读取 Apple Watch 健康快照，并向手表发送可识别的触觉节奏；AI 不直接连接设备。

## 1. 总体架构

```text
读：Apple Watch / iPhone ── POST /upload ──▶ Relay ◀── MCP read tools ── AI
震：AI ── MCP watch_buzz ──▶ Relay ◀── GET /poll ── Apple Watch ──▶ Haptic
```

三个组件：

1. **Relay（Node.js）**：保存最新健康快照和一条待执行命令；提供设备 API 与 MCP 端点。
2. **watchOS / iPhone 设备端**：通过 HealthKit 读取数据、上传快照；实时模式下轮询命令并播放触觉。
3. **AI 端**：通过 MCP 读取健康数据或调用 `watch_buzz`。

安全边界：设备只主动上传和轮询，AI 永远拿不到设备直连入口。

---

## 2. Relay 数据模型

最小存储：

```js
{
  latest_snapshot: null,
  pending_command: null
}
```

建议常量：

```js
const LIVE_FRESH_SECONDS = 15;
const RECENT_SECONDS = 5 * 60;
const COMMAND_TTL_SECONDS = 90;
```

辅助函数：

```js
function getSnapshot() { return readStore().latest_snapshot || null; }
function setSnapshot(snapshot) {
  const state = readStore();
  state.latest_snapshot = snapshot;
  writeStore(state);
}
function getPending() { return readStore().pending_command || null; }
function setPending(command) {
  const state = readStore();
  state.pending_command = command;
  writeStore(state);
}
function clearPending() {
  const state = readStore();
  delete state.pending_command;
  writeStore(state);
}
```

所有设备接口必须校验 Bearer token：

```js
function bearerOk(req) {
  return req.headers.authorization === `Bearer ${process.env.WATCH_UPLOAD_TOKEN}`;
}
```

真实密钥、域名、IP、设备 ID 不得写入仓库。

---

## 3. 设备上传：`POST /upload`

设备上传结构：

```json
{
  "sampled_at": "2026-01-01T00:00:00Z",
  "live_mode": true,
  "device": "Apple Watch",
  "metrics": {
    "heart_rate": {
      "value": 73,
      "unit": "BPM",
      "sampled_at": "2026-01-01T00:00:00Z",
      "source_device": "Apple Watch"
    }
  }
}
```

按 metric 合并，新值覆盖同名旧值，未上传的其他指标保留：

```js
if (path === "/upload" && req.method === "POST") {
  if (!bearerOk(req)) return sendJson(res, 401, { error: "unauthorized" });

  const payload = JSON.parse(await readBody(req));
  const previous = getSnapshot();
  const metrics = {
    ...(previous?.metrics || {}),
    ...(payload.metrics || {})
  };

  const snapshot = {
    ...(previous || {}),
    ...payload,
    metrics,
    sampled_at:
      latestMetricDate(metrics) ||
      payload.sampled_at ||
      previous?.sampled_at ||
      isoNow(),
    uploaded_at: isoNow()
  };

  setSnapshot(snapshot);
  return sendJson(res, 200, {
    ok: true,
    uploaded_at: snapshot.uploaded_at
  });
}
```

需要限制请求体大小、校验 metric 类型、数值范围和 ISO 时间格式。

---

## 4. 健康数据新鲜度

铁律：任何读取结果都必须带 `age_seconds` 和 `freshness`。AI 不得把旧快照描述成实时测量。

```js
function ageSeconds(iso) {
  const timestamp = Date.parse(iso || "");
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
    : null;
}

function freshnessForAge(age) {
  if (age === null) return "unknown";
  if (age <= LIVE_FRESH_SECONDS) return "live";
  if (age <= RECENT_SECONDS) return "recent";
  return "stale";
}

function snapshotEnvelope(snapshot) {
  if (!snapshot) {
    return {
      connected: false,
      freshness: "no_data",
      message: "还没有上传过健康数据。"
    };
  }

  const age = ageSeconds(snapshot.sampled_at || snapshot.uploaded_at);
  const metrics = Object.fromEntries(
    Object.entries(snapshot.metrics || {}).map(([name, metric]) => {
      const metricAge = ageSeconds(metric?.sampled_at);
      return [name, {
        ...metric,
        age_seconds: metricAge,
        freshness: freshnessForAge(metricAge)
      }];
    })
  );

  return {
    ...snapshot,
    connected: age !== null && age <= RECENT_SECONDS,
    freshness: freshnessForAge(age),
    age_seconds: age,
    metrics
  };
}
```

AI 展示规则：

- `live`：可以说“刚刚测到”。
- `recent`：说明这是近期同步数据。
- `stale`：必须明确说“这是 X 分钟/小时之前的数据”。
- `no_data` / `unknown`：不得推断当前身体状态。

---

## 5. 手表轮询：`GET /poll`

实时模式下，手表约每 2.5 秒轮询一次。读取后清除，保证一条命令只消费一次：

```js
if (path === "/poll" && req.method === "GET") {
  if (!bearerOk(req)) return sendJson(res, 401, { error: "unauthorized" });

  const command = getPending();
  if (!command) return sendJson(res, 200, { command: null });

  clearPending();
  return sendJson(res, 200, { command });
}
```

生产实现必须在 Relay 和设备端都执行 TTL 与 ID 去重，避免旧命令或重试造成重复震动。

---

## 6. Armed 判定

只有设备处于实时模式，且最近五分钟有新快照，才认为能收到震动：

```js
function watchArmed() {
  const snapshot = getSnapshot();
  if (!snapshot || snapshot.live_mode !== true) return false;

  const age = ageSeconds(snapshot.sampled_at || snapshot.uploaded_at);
  return age !== null && age <= RECENT_SECONDS;
}
```

`watch_buzz` 可以接受未 armed 状态下的请求，但返回结果必须明确说明设备当前收不到；未消费命令在 90 秒后作废。

---

## 7. 触觉节奏

Apple Watch 的 `WKHapticType` 强度不可编程，专属感通过节奏组合实现。

允许类型至少包括：

```js
const HAPTIC_FEELS = new Set([
  "notification",
  "click",
  "success",
  "failure",
  "start",
  "stop",
  "retry",
  "directionUp",
  "directionDown"
]);
```

预设：

```js
const HAPTIC_PATTERNS = {
  heartbeat: [
    { h: "notification", d: 0 },
    { h: "notification", d: 170 },
    { h: "notification", d: 640 },
    { h: "notification", d: 170 }
  ],
  knock: [
    { h: "success", d: 0 },
    { h: "success", d: 360 },
    { h: "success", d: 360 }
  ],
  rising: [
    { h: "click", d: 0 },
    { h: "click", d: 130 },
    { h: "directionUp", d: 150 },
    { h: "success", d: 180 }
  ],
  triple: [
    { h: "notification", d: 0 },
    { h: "notification", d: 240 },
    { h: "notification", d: 240 }
  ],
  longshort: [
    { h: "click", d: 0 },
    { h: "click", d: 180 },
    { h: "success", d: 420 }
  ],
  tap: [{ h: "notification", d: 0 }]
};
```

限制：

- 自定义序列最多 16 步；
- 简单模式最多 10 次；
- 间隔限制在 120–3000 ms；
- 第一拍 `delay_ms = 0`；
- 非法 feel 回退到 `notification`。

---

## 8. MCP 工具

Relay 暴露四个工具。

### `watch_health_open_session`

返回连接状态、新鲜度和最新快照概览。AI 开始处理健康数据时优先调用。

### `watch_get_latest_health`

返回所有最新指标，每项必须包含：

```text
value
unit
sampled_at
source_device
age_seconds
freshness
```

### `watch_measure_now`

请求一条比调用时间更新的心率样本。

```js
if (name === "watch_measure_now") {
  const requestedAt = isoNow();
  const latest = getSnapshot();

  if (!latest?.live_mode || ageSeconds(latest.sampled_at) > RECENT_SECONDS) {
    return toolText({
      ok: false,
      reason: "live_mode_inactive",
      message: "手表没开实时模式，测不到。让用户在手表上打开实时模式再试。"
    }, true);
  }

  setPending({
    id: crypto.randomUUID(),
    type: "measure_heart_rate_now",
    requested_at: requestedAt
  });

  const waitSeconds = Math.min(30, Math.max(1, Number(args?.wait_seconds) || 15));
  const deadline = Date.now() + waitSeconds * 1000;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const snapshot = getSnapshot();
    if (snapshot && Date.parse(snapshot.sampled_at || "") > Date.parse(requestedAt)) {
      return toolText({
        ok: true,
        measured_now: true,
        ...snapshotEnvelope(snapshot)
      });
    }
  }

  return toolText({
    ok: false,
    reason: "timeout",
    ...snapshotEnvelope(getSnapshot())
  }, true);
}
```

注意：单槽 `pending_command` 会让测量请求和震动指令相互覆盖。正式实现应改为有界队列，或至少拆分 `pending_measurement` 与 `pending_haptic`。

### `watch_buzz`

支持三种参数模式：

1. `pattern`：预设节奏；
2. `sequence`：自定义序列；
3. `feel + count + gap_ms`：简单模式。

返回：

```json
{
  "ok": true,
  "armed": true,
  "taps": 4,
  "label": "pattern:heartbeat",
  "expires_in_seconds": 90,
  "message": "已发送 pattern:heartbeat，几秒内会震到。"
}
```

所有调用需审计，但不得记录健康原始值、私密 note 或认证 token。

---

## 9. watchOS 设备端

### 9.1 HealthKit 上传

实时心率由 `HKWorkoutSession` + `HKLiveWorkoutBuilder` 获取。在 `didCollectDataOf` 回调中读取最新 heart rate 并上传。

```swift
private func upload(value: Double?, sampledAt: Date, liveMode: Bool) {
    guard let url = URL(string: baseURL + "/upload") else { return }

    var metrics: [String: Any] = [:]
    if let value {
        metrics["heart_rate"] = [
            "value": Int(value.rounded()),
            "unit": "BPM",
            "sampled_at": ISO8601DateFormatter().string(from: sampledAt),
            "source_device": "Apple Watch"
        ]
    }

    let payload: [String: Any] = [
        "sampled_at": ISO8601DateFormatter().string(from: sampledAt),
        "live_mode": liveMode,
        "device": "Apple Watch",
        "metrics": metrics
    ]

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(uploadToken)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: request).resume()
}
```

血氧、睡眠、步数、能量等更完整数据可以由 iPhone companion app 读取 HealthKit，并按同一 metric 结构上传。

### 9.2 后台运行

普通 watchOS app 无法长期后台轮询。实时模式通过最轻量的 `.other` workout session 获得扩展后台运行权：

```swift
let configuration = HKWorkoutConfiguration()
configuration.activityType = .other
configuration.locationType = .unknown

let session = try HKWorkoutSession(
    healthStore: healthStore,
    configuration: configuration
)
session.startActivity(with: Date())
```

代价必须在 UI 明示：

- 增加耗电；
- 表盘显示绿色运动状态；
- 用户必须能随时关闭；
- 建议默认 45 分钟自动停止。

三重收尾：

1. `stop()` 中调用 `session.end()`；
2. 约 2.5 秒后检查并执行兜底清理；
3. app 启动时通过 `recoverActiveWorkoutSession` 恢复并关闭遗留 session。

### 9.3 轮询与播放触觉

```swift
import WatchKit

private func pollForCommands() {
    guard let url = URL(string: baseURL + "/poll") else { return }

    var request = URLRequest(url: url)
    request.setValue("Bearer \(uploadToken)", forHTTPHeaderField: "Authorization")

    URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
        guard
            let data,
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let command = object["command"] as? [String: Any],
            (command["type"] as? String) == "haptic",
            let sequence = command["sequence"] as? [[String: Any]]
        else { return }

        if let requestedAt = command["requested_at"] as? String,
           let timestamp = ISO8601DateFormatter().date(from: requestedAt),
           Date().timeIntervalSince(timestamp) > 90 {
            return
        }

        Task { @MainActor in
            self?.playHaptic(sequence: sequence)
        }
    }.resume()
}

private func playHaptic(sequence: [[String: Any]]) {
    let device = WKInterfaceDevice.current()
    var cumulative: Double = 0

    for step in sequence {
        cumulative += ((step["delay_ms"] as? NSNumber)?.doubleValue ?? 0) / 1000
        let type = Self.hapticType(
            from: step["haptic"] as? String ?? "notification"
        )
        DispatchQueue.main.asyncAfter(deadline: .now() + cumulative) {
            device.play(type)
        }
    }
}
```

设备端按 command ID 去重，并持久化最近消费 ID，避免重启后重复执行。

---

## 10. AI 端 MCP 配置

示例：

```json
{
  "mcpServers": {
    "watch-health": {
      "type": "http",
      "url": "<RELAY_BASE_URL>/mcp/<MCP_TOKEN>"
    }
  }
}
```

调用顺序：

1. `watch_health_open_session`
2. `watch_get_latest_health`
3. 需要实时心率时调用 `watch_measure_now`
4. 需要触觉时调用 `watch_buzz`

`watch_buzz` 示例：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "watch_buzz",
    "arguments": {
      "pattern": "heartbeat",
      "note": "想她了"
    }
  }
}
```

---

## 11. 硬限制

### 健康读取

- 数据只在设备 app / 实时模式运行时刷新；
- 远程无法直接启动 Apple Watch 传感器；
- `watch_measure_now` 只有在实时模式已开启时才可能成功；
- 任何健康信息都不能代替医疗诊断；
- 不得根据陈旧数据触发高风险判断。

### 震动

- Apple Watch 不能编程控制真正的触觉强度；
- 只能选择固定 `WKHapticType` 并组合节奏；
- 系统总强度由用户在“声音与触感”中控制；
- 后台执行依赖 workout session，会耗电并显示绿点。

---

## 12. 安全与隐私

- AI 不直连设备；
- 上传 token 与 MCP token 分离；
- token 仅放环境变量或 Keychain；
- Relay 强制 HTTPS；
- 支持 token 轮换与吊销；
- 默认只保存最新快照，不长期保存健康历史；
- 如需历史记录，必须单独设计保留期限、删除接口和访问审计；
- `watch_buzz` 应支持总开关、静默时段、频率限制与用户确认策略；
- 防止单个客户端在短时间内持续震动；
- 手表 UI 文案隐晦，几秒后自动消失；
- 日志不得包含健康详情、私密 note、token 或设备唯一标识。

建议频率限制：

```text
单次序列最多 16 拍
单分钟最多 3 次 watch_buzz
连续失败或异常调用触发冷却
用户可在设备端随时关闭 armed 状态
```

---

## 13. 运维注意事项

- 免费 Apple Developer 签名通常需要定期重装；长期使用需付费开发者账号；
- Xcode 卡在 watch debug symbols 时，可使用命令行构建和 `devicectl` 安装；
- 某些网络会屏蔽特定托管域名，Relay 应部署在自有、稳定、可控域名；
- 健康上传失败需本地显示连接状态，但不能无限缓存敏感健康数据；
- Relay 重启后不得重新投递过期命令；
- 服务器时间应使用 NTP，同步误差需要监控。

命令行安装示例：

```bash
xcodebuild \
  -project X.xcodeproj \
  -scheme "<WatchScheme>" \
  -destination 'generic/platform=watchOS' \
  -allowProvisioningUpdates \
  -derivedDataPath /tmp/wb \
  -configuration Debug \
  build

xcrun devicectl device install app \
  --device <WATCH_UDID> \
  "/tmp/wb/Build/Products/Debug-watchos/<WatchApp>.app"
```

---

## 14. 推荐施工阶段

### Phase 1：Relay + 模拟设备

- 实现 `/upload`、`/poll`、MCP；
- 用脚本模拟健康上传和命令消费；
- 完成 freshness、TTL、鉴权和速率限制测试。

### Phase 2：watchOS 心率 + 震动

- HealthKit 权限；
- workout session；
- 实时心率上传；
- 轮询和预设触觉；
- 停止与恢复遗留 session。

### Phase 3：iPhone companion

- 上传睡眠、步数、血氧、能量等；
- 管理 URL、token、静默时段；
- 显示连接状态和最近同步时间。

### Phase 4：AI 规则和产品化

- freshness 强制展示；
- 用户可配置 AI 允许调用震动的场景；
- 审计、频率限制、隐私设置；
- 真实设备 smoke test。

---

## 15. 验收标准

- [ ] 无数据时 MCP 返回 `connected=false`、`freshness=no_data`。
- [ ] 上传多个不同 metric 时可以合并，旧 metric 不会意外丢失。
- [ ] 每个 metric 独立计算 `age_seconds` 和 `freshness`。
- [ ] stale 数据在 AI 层永远不会被说成实时值。
- [ ] 未授权的 `/upload` 和 `/poll` 返回 401。
- [ ] `watch_buzz` 支持预设、自定义和简单模式。
- [ ] 非法触觉类型、次数和间隔被安全归一化。
- [ ] 未 armed 时返回明确状态，不声称已经震到。
- [ ] 命令超过 90 秒后绝不执行。
- [ ] 同一 command ID 最多执行一次。
- [ ] `watch_measure_now` 只接受请求时间之后的新样本。
- [ ] 测量与震动命令不会相互覆盖。
- [ ] workout session 可正常结束，app 重启后能清理遗留 session。
- [ ] 手表锁屏/后台时，在 session 有效期间仍能上传和轮询。
- [ ] MCP、设备上传和轮询使用彼此适当的认证边界。
- [ ] 日志和错误报告不泄露 token、健康原始数据或设备 ID。
- [ ] 用户关闭实时模式后，不再上传实时数据或执行远程触觉。

---

## 16. 可扩展性

同一 Relay/MCP 方法可以推广到：

- Wear OS：支持自定义振动波形和强度，可用 FCM 替代轮询；
- Garmin Connect IQ：可调用设备震动能力；
- Fitbit；
- 手机通知和本地震动；
- 可控 BLE 设备、智能灯、音箱或桌面机器人。

前提始终不变：仅连接用户自己控制的设备与服务，设备主动取指令，用户拥有最终开关。
