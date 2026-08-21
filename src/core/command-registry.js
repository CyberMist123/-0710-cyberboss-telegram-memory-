const COMMAND_GROUPS = [
  {
    id: "lifecycle",
    label: "Lifecycle & Diagnostics",
    actions: [
      {
        action: "app.login",
        summary: "Start WeChat QR login and save the account",
        terminal: ["login"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.accounts",
        summary: "List locally saved accounts",
        terminal: ["accounts"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.start",
        summary: "Start the current channel/runtime main loop",
        terminal: ["start"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_start",
        summary: "Start the shared app-server and shared WeChat bridge",
        terminal: ["shared start"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_open",
        summary: "Attach to the shared thread currently bound in WeChat",
        terminal: ["shared open"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.shared_status",
        summary: "Show the shared app-server and bridge status",
        terminal: ["shared status"],
        weixin: [],
        status: "active",
      },
      {
        action: "app.doctor",
        summary: "Print current config, boundaries, and thread state",
        terminal: ["doctor"],
        weixin: [],
        status: "active",
      },
      {
        action: "memory.manage",
        summary: "Review pending memories, approve rewrites, search, and clean memory from terminal",
        terminal: ["memory review --limit 10", "memory suggest <pendingId>", "memory apply-suggestion <pendingId>", "memory pending --json"],
        weixin: ["/memory pending", "/memory approve <pendingId> [rewrite text]"],
        status: "active",
        // Front-end (Telegram menu + /help) hidden per Owner 2026-08-04: the old
        // /memory admin suite is no longer surfaced, but the handler is retained so
        // the pending-memory human-review path stays reachable by typing.
        hidden: true,
      },
      {
        action: "system.send",
        summary: "Write an invisible trigger message into the internal system queue",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "system.checkin_poller",
        summary: "Emit proactive check-in triggers at random intervals",
        terminal: [],
        weixin: [],
        status: "active",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace & Thread",
    actions: [
      {
        action: "workspace.bind",
        summary: "Bind the current chat to a workspace directory",
        terminal: [],
        weixin: ["/bind <path>"],
        status: "active",
      },
      {
        action: "workspace.status",
        summary: "Show the current workspace, thread, model, and context usage",
        terminal: [],
        weixin: ["/status"],
        status: "active",
      },
      {
        action: "thread.new",
        summary: "Switch to a fresh thread draft",
        terminal: [],
        weixin: ["/new"],
        status: "active",
      },
      {
        action: "thread.reread",
        summary: "Make the current thread reread the latest instructions",
        terminal: [],
        weixin: ["/reread"],
        status: "active",
      },
      {
        action: "thread.restart",
        summary: "Restart this chat's process so a model/effort change takes effect (keeps the conversation)",
        terminal: [],
        weixin: ["/restart"],
        status: "active",
      },
      {
        action: "thread.compact",
        summary: "Compact the current thread context",
        terminal: [],
        weixin: ["/compact"],
        status: "active",
        hidden: true,
      },
      {
        action: "thread.switch",
        summary: "Switch to a specific thread, or /switch back to return to the previous one",
        terminal: [],
        weixin: ["/switch <threadId>", "/switch back"],
        status: "active",
      },
      {
        action: "thread.stop",
        summary: "Stop the current run inside the thread",
        terminal: [],
        weixin: ["/stop"],
        status: "active",
      },
      {
        action: "system.checkin_range",
        summary: "Reset the proactive check-in range in minutes",
        terminal: [],
        weixin: ["/checkin <min>-<max>"],
        status: "active",
        hidden: true,
      },
      {
        action: "system.desire_probe",
        summary: "Fire one proactive desire self-check now (手动激发一次八维自查·主动态)",
        terminal: [],
        weixin: ["/probe"],
        status: "active",
      },
      {
        action: "channel.chunk_min",
        summary: "Adjust the minimum short-chunk merge size for WeChat replies",
        terminal: [],
        weixin: ["/chunk <number>"],
        status: "active",
        hidden: true,
      },
    ],
  },
  {
    id: "approval",
    label: "Approvals & Control",
    actions: [
      {
        action: "approval.accept_once",
        summary: "Allow the current approval request once",
        terminal: [],
        weixin: ["/yes"],
        status: "active",
      },
      {
        action: "approval.accept_workspace",
        summary: "Keep allowing matching command prefixes in the current workspace",
        terminal: [],
        weixin: ["/always"],
        status: "active",
      },
      {
        action: "approval.reject_once",
        summary: "Deny the current approval request",
        terminal: [],
        weixin: ["/no"],
        status: "active",
      },
      {
        action: "route1.soft_interrupt",
        summary: "Acknowledge immediately, then stop Route 1 workers at the current small-round boundary",
        terminal: [],
        weixin: ["/stop-tasks-and-answer-now"],
        status: "active",
        feature: "route1_dispatch",
      },
      {
        action: "route1.hard_interrupt",
        summary: "Acknowledge immediately and kill the active Route 1 worker process",
        terminal: [],
        weixin: ["/force-stop-now"],
        status: "active",
        feature: "route1_dispatch",
      },
      {
        action: "route1.continue",
        summary: "Resume halted Route 1 dispatch",
        terminal: [],
        weixin: ["/continue-tasks"],
        status: "active",
        feature: "route1_dispatch",
      },
    ],
  },
  {
    id: "capabilities",
    label: "Capabilities",
    actions: [
      {
        action: "model.inspect",
        summary: "Inspect the current model",
        terminal: [],
        weixin: ["/model"],
        status: "active",
      },
      {
        action: "model.select",
        summary: "Switch to a specific model",
        terminal: [],
        weixin: ["/model <id>"],
        status: "active",
      },
      {
        action: "runtime.effort",
        summary: "Inspect or switch the reasoning effort for this workspace",
        terminal: [],
        weixin: ["/effort", "/effort <level>"],
        status: "active",
      },
      {
        action: "channel.send_file",
        summary: "Send a local file back to the current chat as an attachment",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "reminder.create",
        summary: "Create a reminder and hand it to the scheduler",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "diary.append",
        summary: "Append a diary entry",
        terminal: [],
        weixin: [],
        status: "active",
      },
      {
        action: "app.star",
        summary: "Star the project on GitHub",
        terminal: [],
        weixin: ["/star"],
        status: "active",
        hidden: true,
      },
      {
        action: "app.help",
        summary: "Show currently available commands for this channel",
        terminal: ["help"],
        weixin: ["/help"],
        status: "active",
      },
      {
        action: "app.ai_profile",
        summary: "Read-only capability directory: MCP servers, tools, skills",
        terminal: [],
        weixin: ["/ai_profile"],
        status: "active",
        // Hidden per Owner 2026-08-04: routable by typing but kept out of the
        // Telegram menu and /help (AI-Profile is a diagnostic surface, not a
        // day-to-day command).
        hidden: true,
      },
    ],
  },
  {
    id: "autonomy",
    label: "Autonomy",
    actions: [
      {
        action: "activity.pause",
        summary: "Pause autonomous heartbeats outside window chat and user reminders",
        terminal: [],
        weixin: ["/pause_heartbeat"],
        status: "active",
      },
      {
        action: "activity.continue",
        summary: "Resume autonomous heartbeats and their queued proactive messages",
        terminal: [],
        weixin: ["/continue_heartbeat"],
        status: "active",
      },
    ],
  },
  {
    id: "sl",
    label: "存档 / 读档 (SL)",
    actions: [
      {
        action: "sl.save",
        summary: "把一段对话存成回档点（/sl_save 末句：「原话」；档名可省/可含空格，不写就自动取末句开头）",
        terminal: [],
        weixin: ["/sl_save 末句：「…」"],
        status: "active",
      },
      {
        action: "sl.load",
        summary: "读一个回档点，把那段注入当前对话（/sl_load <档名> [备注：这次为什么读]）",
        terminal: [],
        weixin: ["/sl_load <档名>"],
        status: "active",
      },
      {
        action: "sl.list",
        summary: "列出所有回档点（存档目录）",
        terminal: [],
        weixin: ["/sl_list"],
        status: "active",
      },
    ],
  },
];

function listCommandGroups() {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    // Not `filter(isActionEnabled)`: filter passes the index as the second
    // argument, which landed in the `env` parameter, so every feature-gated
    // action read its switch off a number and stayed hidden no matter what the
    // deployment set. Route 1's two interrupt commands were unreachable for
    // exactly this reason.
    actions: group.actions.filter((action) => isActionEnabled(action)).map((action) => ({ ...action })),
  }));
}

function buildTerminalHelpText() {
  const lines = [
    "Usage: cyberboss <command>",
    "",
    "Current terminal commands:",
    "  cyberboss start        start the WeChat bridge and runtime loop",
    "  cyberboss login        start WeChat QR login",
    "  cyberboss accounts     list locally saved accounts",
    "  cyberboss doctor       print current config and thread state",
    "  npm run shared:start   start the shared app-server and WeChat bridge",
    "  npm run shared:open    attach to the shared thread currently bound in WeChat",
    "  npm run shared:status  show shared bridge status",
  ];

  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => isActionEnabled(action) && action.status === "active" && action.terminal.length);
    if (!activeActions.length) {
      continue;
    }
    lines.push(`- ${group.label}`);
    for (const action of activeActions) {
      lines.push(`  ${formatTerminalExamples(action)}  ${action.summary}`);
    }
  }

  lines.push("");
  lines.push("Cyberboss capability operations are exposed to models as project tools, not terminal subcommands.");
  return lines.join("\n");
}

function buildWeixinHelpText() {
  const lines = ["💡 Available commands:"];
  for (const group of COMMAND_GROUPS) {
    const activeActions = group.actions.filter((action) => isActionEnabled(action) && action.status === "active" && !action.hidden && action.weixin.length);
    if (!activeActions.length) {
      continue;
    }
    lines.push("");
    lines.push(`${groupEmoji(group.id)} 【${group.label}】`);
    for (const action of activeActions) {
      lines.push(`  ${actionEmoji(action)} ${action.weixin.join(", ")} — ${action.summary}`);
    }
  }
  return lines.join("\n");
}

// Build the Telegram Bot API setMyCommands payload from the same COMMAND_GROUPS
// that generate /help — single source of truth. Telegram command names allow only
// lowercase a-z, 0-9 and underscore, 1-32 chars; any weixin form that does not
// reduce to a valid name (multi-word args, hyphens) is skipped so the whole
// setMyCommands call never fails on one bad entry. Deduped by command name.
function buildTelegramBotCommands() {
  const seen = new Set();
  const commands = [];
  for (const group of COMMAND_GROUPS) {
    for (const action of group.actions) {
      if (!isActionEnabled(action) || action.status !== "active" || action.hidden || !action.weixin.length) {
        continue;
      }
      for (const form of action.weixin) {
        const command = toTelegramCommandName(form);
        if (!command || seen.has(command)) {
          continue;
        }
        seen.add(command);
        commands.push({ command, description: toTelegramCommandDescription(action.summary) });
      }
    }
  }
  return commands;
}

function toTelegramCommandName(weixinForm) {
  const raw = typeof weixinForm === "string" ? weixinForm.trim() : "";
  if (!raw.startsWith("/")) {
    return "";
  }
  const firstToken = raw.slice(1).split(/[\s<]/)[0].toLowerCase();
  return /^[a-z0-9_]{1,32}$/.test(firstToken) ? firstToken : "";
}

function toTelegramCommandDescription(summary) {
  const text = typeof summary === "string" ? summary.trim() : "";
  if (!text) {
    return "";
  }
  return text.length > 256 ? `${text.slice(0, 253)}...` : text;
}

function groupEmoji(groupId) {
  switch (groupId) {
    case "lifecycle": return "🔄";
    case "workspace": return "📁";
    case "approval": return "🔐";
    case "capabilities": return "⚡️";
    case "autonomy": return "🤖";
    case "sl": return "💾";
    default: return "•";
  }
}

function actionEmoji(action) {
  switch (action.action) {
    case "workspace.bind": return "📍";
    case "workspace.status": return "📊";
    case "thread.new": return "🆕";
    case "thread.reread": return "🔄";
    case "thread.restart": return "♻️";
    case "thread.compact": return "🗜️";
    case "thread.switch": return "🔀";
    case "thread.stop": return "⏹️";
    case "system.checkin_range": return "⏰";
    case "approval.accept_once": return "✅";
    case "approval.accept_workspace": return "💡";
    case "approval.reject_once": return "❌";
    case "activity.pause": return "⏸️";
    case "activity.continue": return "▶️";
    case "route1.soft_interrupt": return "⏹️";
    case "route1.hard_interrupt": return "🛑";
    case "route1.continue": return "▶️";
    case "model.inspect":
    case "model.select": return "🤖";
    case "runtime.effort": return "🎚️";
    case "app.help": return "❓";
    case "app.star": return "⭐️";
    default: return "•";
  }
}

function isActionEnabled(action, env = process.env) {
  if (action?.feature !== "route1_dispatch") return true;
  return /^(?:1|true|yes|on)$/i.test(String(env.CYBERBOSS_ROUTE1_CHAT_DISPATCH_ENABLED || "").trim())
    && /^(?:1|true|yes|on)$/i.test(String(env.CYBERBOSS_CLAUDE_ROUTE1_TASK_SESSION_ENABLED || "").trim());
}

module.exports = {
  buildTerminalHelpText,
  buildWeixinHelpText,
  buildTelegramBotCommands,
  listCommandGroups,
};

function formatTerminalExamples(action) {
  const terminal = Array.isArray(action?.terminal) ? action.terminal : [];
  if (!terminal.length) {
    return "";
  }
  return terminal.map((commandText) => toTerminalCommandExample(commandText)).join(", ");
}

function toTerminalCommandExample(commandText) {
  const normalized = typeof commandText === "string" ? commandText.trim() : "";
  switch (normalized) {
    case "login":
    case "accounts":
    case "start":
    case "doctor":
    case "help":
      return `cyberboss ${normalized}`;
    case "shared start":
    case "shared open":
    case "shared status":
      return `npm run ${normalized.replace(" ", ":")}`;
    case "start --checkin":
      return "cyberboss start --checkin";
    default:
      return normalized;
  }
}
