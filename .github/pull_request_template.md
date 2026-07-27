<!--
这个模板的价值在于让「不用改文档」变成一次显式判断，而不是一次遗忘。
绝大多数小 PR 三问全是「否」—— 那就一个字都不用改。
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

## 三问

- **Does `docs/CURRENT_STATUS.md` need updating?** 是 / 否
  <!-- 是 → 只改对应的那一行。不要顺手改 README 或 CLAUDE.md。 -->
- **Does architecture documentation need updating?** 是 / 否
  <!-- 行为或结构变了才改（docs/architecture/），进度变了不改。 -->
- **Does this change production wiring?** 是 / 否
  <!-- 是 → CURRENT_STATUS 的「生产接线」列写 `未核`，等真机留证再改。 -->

## 测试

跑了哪些 `npm run test:*`，**在什么平台跑的**：

```text

```

- [ ] 新增的测试文件已进某个 `npm run test:*` 分组
- [ ] 该分组已接进 `.github/workflows/phase1-offline.yml`

<!-- 不进分组 = 无 CI 信号。本地跑绿只是你一个人知道。 -->

## 回滚方法

<!-- 这次改动怎么退回去。改了生产接线的 PR 必填。 -->
