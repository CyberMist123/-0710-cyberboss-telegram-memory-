# Timeline 移动端重构蓝图

这份文档约束 `timeline-for-agent` 的移动端适配方式。

目标不是把桌面 dashboard 压缩进窄屏，而是基于现有 timeline 数据，构建一套适合手机纵向阅读的移动端视图。

## 设计目标

移动端遵循以下原则：

- 交互以纵向滚动为主
- 页面结构参考 Journal 移动端的顶部 tab 组织方式
- 保留 Timeline 产品语义，不复制 Journal 的内容模型
- 共享同一套数据与主题 source of truth
- 不允许在桌面组件上叠加条件 CSS 形成“伪移动端”

## 移动端信息架构

移动端首页拆成三个 tab：

1. `时间轴`
2. `分析`
3. `事件`

### 时间轴

`时间轴` 是移动端主视图。

它必须满足：

- 纵向时间刻度
- 全天事件从上到下排列
- 页面纵向滚动
- 分类颜色沿用现有 category theme
- 事件块保留开始/结束时间与标题
- 支持重叠事件并排显示

它不应复用当前桌面 `vis-timeline` 的交互模型，因为桌面时间轴依赖：

- 横向时间轴
- 缩放等级
- wheel zoom
- `vis-timeline` 的桌面型布局

这些都不适合窄屏主视图。

### 分析

`分析` 页面纵向堆叠三个现有分析模块：

1. Distribution
2. Breakdown
3. Trend

移动端分析页规则：

- 三张卡片顺序固定，自上而下排布
- 不做桌面并排布局
- 复用现有图表数据 source
- 保持当前 category theme 管线

### 事件

`事件` 页面展示当前范围内的事件列表。

移动端事件页规则：

- 单列自然流布局
- 保留类别、子类、时长、日期信息
- 不再依赖桌面分析页中的事件块混排

## Source Of Truth

移动端必须复用现有三层 source of truth：

- 数据 source：`src/infra/timeline`
- 选择状态 source：`src/timeline/hooks`
- 主题 source：`src/infra/timeline/category-theme.js`

移动端不允许新增第二套：

- category color map
- range aggregation map
- timeline selection map

如果需要移动端专用展示数据，应该从现有 source 衍生，而不是重新定义数据语义。

## 事件逻辑边界

移动端适配只新增视图，不改事件逻辑。

这里的“事件逻辑”包括：

- timeline event 数据结构
- range aggregation 逻辑
- event block 构建逻辑
- 现有 category / subcategory 语义

移动端可以做的事：

- 改变展示布局
- 改变信息排序
- 为纵向时间轴新增布局计算

移动端不应该做的事：

- 改写事件聚合规则
- 改写事件筛选语义
- 为了移动端新增第二套事件数据结构

## PC 专属能力边界

以下能力只属于 PC 端：

- screenshot target
- timeline screenshot 流程
- MCP/自动化截图相关入口
- 面向桌面调试的 `vis-timeline` 交互

移动端视图不承接这些能力，也不要为了兼容它们而污染移动端结构。

## 现有结构问题

当前桌面结构集中在：

- `src/timeline/components/DashboardApp.jsx`
- `src/timeline/components/DashboardSections.jsx`
- `src/timeline/components/TimelinePanel.jsx`

当前主要问题：

- `DashboardApp` 同时承担页面编排、桌面布局与桌面交互入口
- `TimelinePanel` 完全绑定 `vis-timeline`
- `DashboardSections` 同时包含桌面图表、legend 和事件面板

这套结构不适合直接承接移动端。

## 目标目录结构

移动端实现时，目录应演进为：

```text
src/timeline/components/
  DashboardApp.jsx
  desktop/
    DesktopDashboardView.jsx
    DesktopTimelinePanel.jsx
    DesktopAnalyticsPanels.jsx
  mobile/
    MobileDashboardView.jsx
    MobileTabBar.jsx
    MobileTimelineView.jsx
    MobileAnalyticsView.jsx
    MobileEventsView.jsx
```

说明：

- 只有当移动端和桌面端都成为真实结构后，才引入 `desktop/` 和 `mobile/`
- 现有 `DashboardSections.jsx` 最终应被拆解，而不是继续扩展
- `TimelinePanel.jsx` 最终应收敛为桌面专用时间轴实现，移动端不要复用它

## Hook 结构建议

现有 hook：

- `useTimelineDashboardData`
- `useTimelineSelection`

移动端优先复用这两个 hook 的数据结果。

如果需要新增 hook，建议仅新增这类职责：

- `useTimelineViewMode`
  - 负责桌面 / 移动端视图判断
- `useMobileTimelineLayout`
  - 负责把当天事件转换为纵向时间轴布局数据

不要新增“移动端专用完整数据管线”。

## 实施顺序

建议按下面顺序重构：

1. 从 `DashboardApp` 中抽离桌面页面壳
2. 引入 `MobileDashboardView` 作为独立入口
3. 为移动端新增顶部 tab 结构
4. 新建纵向 `MobileTimelineView`
5. 将三个分析模块收编成 `MobileAnalyticsView`
6. 将事件列表收编成 `MobileEventsView`
7. 删除旧的条件样式和无效布局分支

## Review 标准

移动端改造的每一轮 diff 都必须满足：

- 没有新增补丁式条件分支
- 没有新增第二套颜色 source
- 没有让 `DashboardApp` 继续膨胀
- 至少明确地把一个桌面职责或一个移动端职责移到单独模块里

如果一次改动只是：

- 加一个 media query
- 加一个 `isMobile ? ... : ...` 分支
- 在桌面组件里硬塞移动端 DOM

那么这次改动不合格，需要重做。
