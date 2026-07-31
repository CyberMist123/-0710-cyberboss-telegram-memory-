# Commands

```text
Status: active
Authority: stable architecture
Scope: 命令清单与设计原则
Current status: docs/CURRENT_STATUS.md
```


## Design Principles

`Cyberboss` does not hard-code one shared string format across terminal commands, Telegram commands, and different agent runtimes.

It defines stable internal actions first, then lets each channel expose its own entrypoints:

- core action: stable internal meaning
- terminal command: terminal entrypoint
- weixin command: Telegram entrypoint (historical key name)

This keeps the core naming stable when new runtimes or channels are added later.

The runtime can be `codex` or `claudecode`, but the documented command surface stays the same.

## Current Action Groups

### Lifecycle & Diagnostics

- `app.login`
- `app.accounts`
- `app.start`
- `app.shared_start`
- `app.shared_open`
- `app.shared_status`
- `app.doctor`

### Workspace & Thread

- `workspace.bind`
- `workspace.status`
- `thread.new`
- `thread.reread`
- `thread.compact`
- `thread.switch`
- `thread.stop`
- `system.checkin_range`
- `channel.chunk_min`

### Approvals & Control

- `approval.accept_once`
- `approval.accept_workspace`
- `approval.reject_once`
- `activity.pause`
- `activity.continue`

### Capabilities

- `model.inspect`
- `model.select`
- `runtime.effort`
- `channel.send_file`
- `timeline.write`
- `reminder.create`
- `diary.append`
- `app.star`
- `app.help`

## Current Terminal Commands

The intentionally small public set is:

- `npm run login`
- `npm run accounts`
- `npm run shared:start`
- `npm run shared:open`
- `npm run shared:status`
- `npm run doctor`
- `npm run help`

Historical naming note: `command-registry.js` 的键仍叫 `weixin`，属上游遗产；实际生效通道是 Telegram。

## Project Tools

Models no longer use local capability CLI commands for diary, reminders, timeline, screenshots, or file sending.

Those capabilities are exposed as project-native structured tools:

- `cyberboss_channel_send_file`
- `cyberboss_diary_append`
- `cyberboss_reminder_create`
- `cyberboss_system_send`
- `cyberboss_sleep_schedule_enable`
- `cyberboss_sleep_schedule_disable`
- `cyberboss_sleep_schedule_status`
- `cyberboss_timeline_write`
- `cyberboss_timeline_build`
- `cyberboss_timeline_serve`
- `cyberboss_timeline_dev`
- `cyberboss_timeline_screenshot`

Notes:
- These tools are bound to the Cyberboss project and routed through the repo's internal tool host.
- Claude Code loads them through workspace-local `.mcp.json` injected by Cyberboss and passed to Claude at startup with `--mcp-config`.
- Codex loads them through the runtime-side Cyberboss MCP bridge configured at spawn time.
- The public human terminal surface stays intentionally small: lifecycle commands plus shared bridge scripts.
- Night sleep scheduling is only valid after 19:00 Asia/Shanghai, and it automatically restores the stored check-in range at 06:30 Asia/Shanghai.

## Current Telegram Commands

- `/bind`
- `/status`
- `/new`
- `/reread`
- `/compact`
- `/stop`
- `/switch <threadId>`
- `/checkin <min>-<max>`
- `/chunk <number>`
- `/yes`
- `/always`
- `/no`
- `/model`
- `/model <id>`
- `/effort` / `/effort <low|medium|high|xhigh|max>`
- `/pause activity`
- `/continue activity`
- `/star`
- `/help`

Notes:

- `/status` covers thread, workspace, and context details
- there is no separate `/context` command; use `/status` and read the `📦 context` line
- `/effort` with no argument reports the level in force and where it came from: this chat's own choice, `CYBERBOSS_CLAUDE_EFFORT`, or the `medium` default. Setting a level relaunches the workspace's Claude child and resumes the same thread
- `/compact` asks the current thread to compact its context and reports start / finish back to Telegram
- `/pause activity` pauses Desire hourly ticks, scheduled check-ins, closeout/liveness scheduling, and delivery of proactive messages queued by those sources; window chat and user-set reminders stay active
- `/continue activity` resumes those ticks and delivers retained proactive messages using the existing queue order
- file sending is still available, but no longer exposed as a Telegram command
