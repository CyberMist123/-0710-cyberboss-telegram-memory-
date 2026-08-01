# Chat 端工具面与目录排布说明

```text
Status: supplemental
Authority: none
Scope: chat 主体 AI 的工具目录组织方式、三级取用规则与提示词排布原则（D27 的展开说明）
Last reviewed: 2026-07-31
Current authority: docs/DECISIONS.md（D13 / D25 / D27）+ docs/CURRENT_STATUS.md
```

> 本文是 D27 裁定的可读展开，供设计与实施翻阅；与 D27 冲突时以 DECISIONS.md 为准。
> 写作视角说明：文中"她"指 chat 主体 AI；"你"指 Owner。

## 一、总原则（D27）

1. **她的权限全集永远不减。** Toolset 限定的是初始装载面（节能态），不是能力天花板；完全体转化的钥匙在她自己手里——显式、留 Context Trace、不走审批。
2. **目录按意图分类，不按实现来源。** 她想用工具的瞬间脑子里是"我想干什么"，不是"这是不是 MCP"。memory/tool/mcp/skill 四类只是机制与计量口径，不面向她展示。
3. **层级服务发现，不给取用设卡。** 已知工具名允许 handle 直达 schema，绝不强迫一级→二级→三级三跳。
4. **数据的隐藏不靠目录。** "不用暴露但找得到"的信息（账本、Episodes、未来健康数据）走三档纪律的第三档：数据在抽屉里，抽屉把手（`memory_lookup` 等）在目录里。

## 二、三级结构

| 级 | 内容 | 取用方式 | 常驻性 |
|---|---|---|---|
| 一级 | 主题索引：每主题一行**触发式描述**（"什么时候来翻我"）+ 条目数 | 常驻（几百字符） | 常驻 |
| 二级 | 某主题内的工具清单：canonical 名 + 一句用途 + **risk 标注**（read/append/send/mutate/admin） | `cyberboss_catalog({theme})` | 按需 |
| 三级 | 单个工具的完整原始 `inputSchema` | `cyberboss_catalog({handle})`，**可跳级** | 按需 |

另有两个极小常驻核带完整 schema：`cyberboss_system_send`、`cyberboss_time`。

## 三、一级主题表（当前版）

```text
表达行动(6)   想跟你说话、发文件、发语音、发贴纸时来这——她伸出手的那一面
感知(6+)      你和世界的状态：天气、位置；将来健康、手机使用、可穿戴、日常活动 MCP 全进这
记忆(2+)      翻过去（Episodes/账本都从这个把手进）、留笔记
生活记录(2)   记日记、设提醒
时间线(8)     你们的时间线回看与整理
作息(1)       睡眠模式
工程派活(4+)  GitHub 操作；将来 Route 1 派工程车也在这
维护调试(3)   平时不碰
```

扩容规则：新 MCP **按主题入座**（接健康 MCP → 工具落"感知"，目录结构不变、一级只多计数）；某主题条目超过十几个时在**二级**里分小节，一级不动。

## 四、排布细节（她的舒适度考量）

- **别名不进目录**：`cyberboss_sleep_mode` 的 7 个 alias 等在目录里是纯噪音（canonicalize 是机器的事），只列 canonical，别名照常可调。
- **触发式描述**优于名词罗列：一级每行回答"什么时候需要我"，让她扫一眼就知道开哪个抽屉。
- **risk 标注放二级**：看到 `send/mutate` 就知道这个动作出得去、要多想一秒——这对分寸有真实帮助。
- **索引确定性**：一级表顺序与措辞保持稳定，利于缓存与习惯形成。
- 二级描述可以带一点她的语气，但以信息密度优先。

## 五、边界备忘（与本文并读）

- **chat lane 永不挂硬 toolset ceiling**（D27-1）；硬 fail-closed 调用闸只存在于 Route 1 worker 会话与 work profile 的记忆写权。
- **work profile 工程全权、唯记忆零写权**（D27-2）——身份边界，不是权限边界。
- 目录化省下的是 MCP 出牌字符面（常驻工具 schema 15,810 → 229 chars，T02 计量），**不声称**模型侧每轮 token 节省。

## 六、实施对应

- 已落地：T02 目录化 core（manifest / schema-on-demand / resources 收窄，#112）。
- 已落地（T02.5）：manifest 已加显式 `theme` 字段，四个分类目录工具已收敛为单入口 `cyberboss_catalog`，一级表按本文八主题稳定排布，别名已剔出目录展示。
- 相关票面修订：T04（work profile 边界措辞）、T05/T08（自助升格语义）、T07（Route 2 硬门=路由判断）。
