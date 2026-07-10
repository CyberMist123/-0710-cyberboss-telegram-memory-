# memory/（脱敏模板）

真实关系记忆、候选、janitor 位点与缓存未上传。这里仅保留文件契约，方便审查代码和架构。

真实数据应留在本地私密备份中，不进入普通 Git 仓库：
- `reentry.md`：热路径交接包
- `episodes.jsonl`：正式证据层
- `episodes.candidates.jsonl`：自动提取候选
- `relationship_timeline.md`：关系故事层
- `user_portrait.md` / `ai_self_portrait.md` / `ai_self_notes.md`
- `rereadings.md`：旧事新读
- `state_log.jsonl`：v1 冻结历史；v2.1 实时八维在 runtime state 的 `desire-state.json` / `desire-history.jsonl`
