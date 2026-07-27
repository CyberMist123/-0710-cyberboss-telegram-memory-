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

# [Feature][Apple Watch] AI 双向接入：健康数据读取 + 触觉震动

## 背景

需要把 Apple Watch 作为 cyberboss 的可选设备通道，让 AI：

1. 读取用户主动上传的最新 HealthKit 健康快照；
2. 在用户明确开启实时模式时，向手表发送可识别的触觉节奏；
3. 始终通过中继服务通信，不让 AI 直接连接设备。

完整技术规格：[`docs/APPLE_WATCH_AI_BRIDGE_SPEC.md`](./APPLE_WATCH_AI_BRIDGE_SPEC.md)

施工清单：[`docs/APPLE_WATCH_AI_BRIDGE_ISSUE_CHECKLIST.md`](./APPLE_WATCH_AI_BRIDGE_ISSUE_CHECKLIST.md)

## 架构

```text
读：Apple Watch / iPhone ── POST /upload ──▶ Relay ◀── MCP read tools ── AI
震：AI ── MCP watch_buzz ──▶ Relay ◀── GET /poll ── Apple Watch ──▶ Haptic
```

## 核心范围

### Relay

- 保存最新健康快照；
- 接收设备 `POST /upload`；
- 向设备提供 `GET /poll`；
- 暴露 MCP 工具；
- 每项数据计算 `age_seconds` 与 `freshness`；
- 命令执行 TTL、ID 去重、频率限制；
- 健康上传 token 与 MCP token 分离。

### MCP 工具

- `watch_health_open_session`
- `watch_get_latest_health`
- `watch_measure_now`
- `watch_buzz`

### watchOS

- HealthKit 实时心率上传；
- 使用 `HKWorkoutSession` 获得有限后台运行能力；
- 约每 2.5 秒轮询命令；
- 按预设或自定义序列播放 `WKHapticType`；
- 支持自动结束和遗留 workout session 清理。

### iPhone companion

- 上传睡眠、步数、血氧、能量等更完整 HealthKit 数据；
- 管理 Relay 地址、Keychain token、静默时段和总开关。

## 必须遵守的产品边界

- AI 永远不能直连 Apple Watch；
- 数据由设备主动上传，命令由设备主动轮询；
- `stale` 数据必须明确说明时间差，不能说成当前实测；
- 未开启实时模式时，`watch_measure_now` 应明确失败；
- 未 armed 时，`watch_buzz` 不得声称已经震到；
- Apple Watch 触觉强度不可编程，专属感只能通过节奏实现；
- 后台轮询依赖 workout session，会耗电并显示绿色运动状态；
- 用户必须拥有震动总开关、实时模式开关和静默时段；
- 日志不得保存 token、设备唯一标识、私密 note 或健康原始详情。

## 需要避免的实现缺陷

当前参考设计中的单个 `pending_command` 槽会让实时测量请求与震动指令互相覆盖。正式实现必须使用独立队列或至少拆成：

```text
pending_measurement
pending_haptic
```

同时需要：

- 有界队列；
- 90 秒 TTL；
- command ID 去重；
- Relay 重启后不重放过期命令；
- 单分钟震动频率限制；
- 服务器和设备时钟偏差处理。

## 推荐施工顺序

1. Relay + 模拟设备；
2. watchOS 心率上传与触觉；
3. iPhone companion；
4. AI 规则、安全设置和真实设备 smoke test。

## 验收标准

- [ ] 无数据时返回 `connected=false` 与 `freshness=no_data`。
- [ ] 多 metric 上传可正确合并。
- [ ] 每个 metric 独立计算 freshness。
- [ ] stale 数据永远不会被 AI 描述成实时值。
- [ ] 未授权的 `/upload`、`/poll` 和 MCP 请求被拒绝。
- [ ] `watch_buzz` 支持预设、自定义和简单模式。
- [ ] 未 armed 时返回明确状态。
- [ ] 超过 90 秒的命令绝不执行。
- [ ] 同一 command ID 最多执行一次。
- [ ] `watch_measure_now` 只接受请求之后产生的新样本。
- [ ] 测量与震动命令不会互相覆盖。
- [ ] workout session 能正常结束，并能清理遗留 session。
- [ ] 手表锁屏/后台时，在 session 有效期间仍可上传和轮询。
- [ ] 用户关闭实时模式后，不再上传实时数据或执行远程触觉。
- [ ] 日志不泄露健康详情、token 或设备 ID。

## 优先级

**P1 功能主线。** 建议先完成 Relay 和模拟设备，安全边界与 freshness 测试通过后，再开始真实 Apple Watch 端施工。
