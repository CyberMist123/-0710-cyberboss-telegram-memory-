# 记忆工具包 v2.1 — 从聊天史到关系连续性(轻量版)

给你的 cyberboss-deepseek 加一层关系记忆。一切在你本地跑,聊天记录不经过任何人。

v2.1 核心原则:**cyberboss 主人格,记忆做后台插件。** 记忆改变说话姿态,不替模型决定内容;八维交给 cyberboss 原生 desire runtime,不再由 AI 自己写。

## 文件与归属

```
memory/
  reentry.md                醒来第一包(≤300 字场景 + 3 条钩子)     ← AI 每晚在有变化时才动
  home.md                   这里怎么运转(第一次醒来读一次)         ← 架构位,低频改
  reading_policy.md         v2 已废除(内容并入 home.md)            ← 占位
  closeout_guide.md         每晚三问模板(默认"无",不强制写)     ← 架构位
  relationship_timeline.md  关系年表(故事层)                        ← AI 每晚最多 +1 条,挂 ep id
  user_portrait.md          她的画像(反复主题/证据判断/待确认)     ← AI 每晚最多改 3 条,带出处
  ai_self_portrait.md       AI 六问自画像                             ← 只有 AI 有笔;"无变化"合法
  ai_self_notes.md          AI 只写给未来自己的话                     ← 只追加
  episodes.jsonl            关系片段,证据层,逐条可溯源(有 id)     ← AI 每晚 +0~2 条
  rereadings.md             年轮:旧 ep 的新读法                      ← 只追加
  state_log.jsonl           历史存档,冻结不再追加(v2.1 起)         ← v1 遗留数据
  episodes.candidates.jsonl janitor 补记的候选片段(cand- 前缀)      ← 只有 janitor 写
  reentry.extracted.md      janitor/提取脚本的补记稿,参考件           ← 覆盖式,不注入
  .janitor_state.json       janitor 的已处理位点                       ← 只有 janitor 写
  .backups/                 面板保存时的自动备份
```

三级读法:
- **热路径**:醒来只读 reentry.md 一个文件。
- **温路径**:她拉线时才查 timeline / portrait / episodes。
- **冷路径**:home.md / closeout_guide.md,只在维护时读。

**八维 state_log**:v2.1 起由 cyberboss 原生 `desire-service.js` 管,数据在 `~/.cyberboss/desire-state.json`,自动 30 分钟 tick。AI 不再手写 memory/state_log.jsonl,旧文件保留为历史存档。

## 三步接线

**1. 引导(一次,聊天史 → 初始记忆)**

```
pip install requests
python extract_memory.py --input "<CLAUDE_TRANSCRIPT_DIR>" --dry-run
```

dry-run 只统计规模不花钱。合理就去掉 `--dry-run`;想先试水加 `--limit 20`。断了直接重跑,已完成的块有缓存不重复计费。

**1.5 断档补记(janitor,平时就用这个)**

```
python memory-kit/janitor.py --input "<CLAUDE_TRANSCRIPT_DIR>" --outdir "<MEMORY_DIR>" --dry-run
python memory-kit/janitor.py --input "<CLAUDE_TRANSCRIPT_DIR>" --outdir "<MEMORY_DIR>"
```

白天 /new、崩窗漏掉的 session 补进 `episodes.candidates.jsonl` 和 `reentry.extracted.md`,不直接改手工文件。位点在 `.janitor_state.json`,幂等。

**2. 提示词**

模板已带极简记忆块。改动后同步运行时副本:

```
python memory-kit/sync_memory_block.py     # 或双击 同步记忆块.bat
```

然后 `/reread` 或重启 TG。

**3. 面板**

```
python memory-kit/dashboard.py
```

打开 http://127.0.0.1:520 。八维页显示的是 memory/state_log.jsonl 里冻结的历史数据;实时状态请去看 `~/.cyberboss/desire-state.json`(cyberboss 自己的 UI 或后续面板集成)。

## 循环(不需要你维护)

- **醒来**:AI 只读 reentry.md,安静接回,不汇报
- **聊天中**:零记忆职责;她拉线才查 episodes / timeline
- **每小时**:cyberboss 自己 tick 八维,AI 不介入
- **每晚 closeout**:三个问题,"无"是常态,默认跳过
- **每两三周**:你跑一次增量提取,或做一次记忆卫生 pass

## 没做的(故意的)

向量库、embedding、自动聚类、聊天中检索。这个量级下,策展过的 markdown + 结构化时刻,比 RAG 更贴合"关系"而不是"检索"。等 episodes 过几百条再议。
