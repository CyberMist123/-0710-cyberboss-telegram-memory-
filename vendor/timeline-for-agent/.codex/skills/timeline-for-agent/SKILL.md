---
name: timeline-for-agent
description: 适用于修改或重构 timeline-for-agent 代码库，尤其是 dashboard UI、主题系统、移动端适配、时间轴视图、分析面板和项目结构时使用。约束仓库内的架构规则：禁止兜底补丁、禁止重复颜色管线、目录职责清晰、文件拆分有明确边界。
---

# Timeline For Agent

这份 skill 用于 `timeline-for-agent` 仓库内的实现与重构工作。

## 核心规则

优先做根因级重构，不做补丁式修复。

不要做这些事：
- 为了维持混乱结构而增加兼容层
- 在桌面端和移动端之间复制逻辑，却没有明确的职责切分
- 增加一次性的颜色覆盖、fallback 分支或特殊 CSS 补丁
- 让多套彼此竞争的数据到 UI 管线并存

如果行为不对，就修 source of truth。

## 重构标准

每次 UI 改动，在写代码前都要回答这三个问题：

1. What is the single source of truth?
2. Which layer owns the transformation?
3. Which file should be deleted or simplified after the change?

如果这三个问题答不清，就先停下来把设计简化。

## 单一真相规则

### 类目颜色系统

- 类目 `fill` 和 `ink` 必须只有一套 source of truth。
- 展示层可以消费 theme token，但不能重新定义语义颜色。
- 图表颜色、时间轴条目颜色、pill、label、legend 必须来自同一条 category theme 管线。
- 如果组件需要派生色，只能从共享 source 在一个 utility 里统一计算，不能在多个地方各自 inline 推导。

### 视图职责归属

- 数据整形属于 `src/infra/timeline`
- 视图状态选择属于 `src/timeline/hooks`
- 渲染属于 `src/timeline/components`
- 纯格式化/颜色 helper 属于 `src/timeline/lib`
- CSS 只表达展示，不承载业务逻辑或 category remap 逻辑

## 移动端适配规则

移动端不是压缩后的桌面 dashboard。

移动端改造时：
- 保持产品语义，但允许布局模型不同
- 优先纵向阅读和纵向滚动
- 不要把桌面端横向 timeline 交互强塞到窄屏里
- 当交互模型实质变化时，使用明确的移动端视图组件

当前预期的移动端方向：
- 顶部 tab 参考 Journal 移动端样式
- tab 为 `时间轴`、`分析`、`事件`
- `时间轴` 使用纵向日历式日视图
- `分析` 将三个分析面板纵向堆叠
- `事件` 在窄屏中自然变成单列流
- 只新增移动端视图，不改事件逻辑
- screenshot / MCP 截图相关能力只保留在 PC 端

如果结构模型已经不同，就不要靠往桌面布局上继续堆条件 CSS 来“硬适配”。

移动端实施前，先对齐：
- `docs/mobile-adaptation-blueprint.md`
- 目录边界、模块归属和实施顺序以这份蓝图为准

## 文件拆分规则

当一个文件开始同时承担多个关注点时，就应该拆分。

适合拆分的情况：
- 桌面端和移动端渲染的是不同的视图结构
- 图表渲染和 legend 渲染演化方向已经不同
- 一个组件同时混着 layout shell、data mapping 和 leaf rendering
- 一个 utility 同时混着格式化和语义主题推导

不要为了“包一层”而拆出很多小 wrapper。

理想结构：
- 一个文件只负责一个清晰职责
- 叶子组件尽量保持简单
- 组合发生在接近 route/page 的上层组件里

## 目录职责规则

使用下面这套职责划分：

- `src/infra/timeline`
  - timeline 数据的 canonical shaping
  - taxonomy / theme 的 source-of-truth utilities
  - dashboard 数据构建器

- `src/timeline/hooks`
  - selection state
  - 基于 infra 输出的 UI-facing derived slices
  - 如果多个组件复用，则放 responsive / view-mode state

- `src/timeline/components`
  - page shell
  - panel 组件
  - desktop / mobile 视图组件

- `src/timeline/lib`
  - 只放 pure helper function
  - 不放 React
  - 不允许和 DOM / CSS 有隐式耦合

- `src/timeline/css`
  - dashboard 全局样式
  - shared token
  - component class 样式

如果移动端适配规模继续增长，优先考虑：
- `src/timeline/components/mobile/*`
- `src/timeline/components/desktop/*`

只有桌面端和移动端都已经有真实结构时，才引入这两层目录，不要提前预建空架子。

## CSS 规则

- token 优先，override 作为最后手段
- 除非值是逐条数据动态变化，否则避免 inline style
- 不要在很多 selector 里重复写 `color-mix(...)`；语义决策要集中
- 如果多个 selector 需要相同视觉系统，就抽成 token 或共享 utility class
- 不要用 CSS 去补偿错误的数据语义

## 结构性改动的 review 标准

一个重构只有在满足这些条件时才算合格：
- 减少语义入口数量
- 让后续移动端工作更容易
- 删除或简化旧路径
- 让数据、状态和视图的职责更清晰

如果 diff 只是新增一条分支、一个 override 或一个特殊 case，那它就不是这个项目里合格的重构。
