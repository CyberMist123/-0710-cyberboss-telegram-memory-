<!--
这个模板的价值在于让「不用改文档」变成一次显式判断，而不是一次遗忘。
绝大多数小 PR 全部勾 "No documentation impact" —— 那就一个字都不用改。
-->

## 这次改了什么

<!-- 一两句。为什么改，不是改了哪些行。 -->

## Affected areas

- [ ] Telegram / route lane
- [ ] Memory read
- [ ] Memory write
- [ ] 上下文预算 / 注入分档
- [ ] Windows runtime
- [ ] 520
- [ ] Desire
- [ ] CI only
- [ ] Docs only

## Documentation impact

- [ ] Current status changed
- [ ] An approved decision was added / changed / superseded
- [ ] Stable architecture changed
- [ ] Supplemental material / evidence changed
- [ ] Historical or handoff status changed
- [ ] No documentation impact

各项含义：

- **Current status** —— 当前能力、优先级、Gate 或生产结论是否变化（`docs/CURRENT_STATUS.md`）。
- **Decision** —— 是否作出、撤销或翻转了正式决定（`docs/DECISIONS.md`）。取代时把原条目标 `SUPERSEDED` 并新增一条，编号留空缺不重排。
- **Architecture** —— 稳定调用关系、writer、运行边界是否变化（`docs/architecture/`）。
- **Supplemental** —— 只是新增调研、实验、日志、外部材料或参考。
- **Historical** —— 某份旧文档是否需要标 `completed` / `superseded` / `historical`。

## Truth versus evidence

- **Does this PR change the current project conclusion?** Yes / No
- **Does this PR only add or refresh supporting evidence?** Yes / No
- **If evidence changed but the conclusion did not, which supplemental files changed?**
- **If the conclusion changed, which authority document was updated?**

> **补充材料发生变化，不要求自动修改 `docs/CURRENT_STATUS.md`。只有补充材料导致当前结论变化时，才修改权威文档。**
>
> 反过来也成立：改了当前结论却没动 `docs/CURRENT_STATUS.md`，这个 PR 不该合。

### Supplemental materials

| File | Status | What changed | Does it change current truth? |
|---|---|---|---|
|  |  |  |  |

`Status` 只允许零个值：

- `NEW` —— 新补充材料；
- `REFRESHED` —— 内容更新，结论Ꜫ变；
- `SUPERSEDED` —— 被新材料取代；
- `PROMOTED` —— 其结親被正式采纳进 `docs/CURRENT_STATUS.md` / `docs/DECISIONS.md` / `architecture/`。

## 测试
跑了哪些 `npm run test:*`，**在什么平台跑的**：

```text

```

- [ ] 新增的测试文件已进某个 `npm run test:*` 分组
- [ ] 该分组已接进 `.github/workflows/phase1-offline.yml`

<!-- 不进分组 = 无 CI 信号。本地跑绿只是你一个人知道。 -->

## 回滚方法

<!-- 这次改动怎么退回去。改了生产接线的 PR 必填。 -->
