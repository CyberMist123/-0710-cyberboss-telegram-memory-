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

# Apple Watch ↔ AI 双向接入施工清单

权威技术规格：[`docs/APPLE_WATCH_AI_BRIDGE_SPEC.md`](./APPLE_WATCH_AI_BRIDGE_SPEC.md)

## 目标

通过 Relay + watchOS/iPhone + MCP，实现：

- AI 读取 Apple Watch / HealthKit 最新健康快照；
- AI 向 Apple Watch 发送有辨识度的触觉节奏；
- AI 不直接连接设备；
- 用户拥有实时模式和震动能力的最终开关。

## 施工阶段

### Phase 1：Relay 与模拟设备

- [ ] 实现 `POST /upload`
- [ ] 实现 `GET /poll`
- [ ] 实现 snapshot freshness envelope
- [ ] 实现 MCP：`watch_health_open_session`
- [ ] 实现 MCP：`watch_get_latest_health`
- [ ] 实现 MCP：`watch_measure_now`
- [ ] 实现 MCP：`watch_buzz`
- [ ] 上传 token 与 MCP token 分离
- [ ] 命令 TTL、ID 去重和频率限制
- [ ] 测量与震动使用独立队列，避免互相覆盖

### Phase 2：watchOS

- [ ] HealthKit 权限与实时心率
- [ ] `HKWorkoutSession` 后台运行
- [ ] 每 2.5 秒轮询命令
- [ ] 触觉预设与自定义序列
- [ ] 自动停止、手动停止、遗留 workout 恢复/清理
- [ ] 锁屏和后台 smoke test

### Phase 3：iPhone companion

- [ ] 上传睡眠、步数、血氧、能量等数据
- [ ] 管理 Relay URL 与 Keychain token
- [ ] 管理静默时段、实时模式、震动总开关
- [ ] 展示连接状态和最近同步时间

### Phase 4：AI 接入与安全

- [ ] stale 数据必须明确显示时间差
- [ ] 无数据或离线时禁止推断实时身体状态
- [ ] 未 armed 时不得声称已震到
- [ ] 工具日志不记录健康详情、私密 note、token 或设备 ID
- [ ] 用户可限制 AI 允许发震动的场景
- [ ] 完成真实设备端到端测试

## 完成定义

全部行为、接口、代码参考、安全边界、平台限制和验收标准以权威技术规格为准。
