const crypto = require("crypto");

const SHANGHAI_TZ = "Asia/Shanghai";

async function runHourlyDesirePoller(config = {}) {
  if (!config.desireDriven) {
    console.log("[desire] hourly poller disabled");
    return;
  }

  const { SessionStore } = require("../adapters/runtime/codex/session-store");
  const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });

  const { accountId, senderId, workspaceRoot } = resolveDesirePollerTargets({ config, sessionStore });
  if (!senderId || !workspaceRoot) {
    console.error("[desire] hourly poller: cannot resolve sender/workspace, aborting");
    return;
  }

  const now = Date.now();
  const waitMs = nextHourlyTickMs(now);
  console.log(`[desire] hourly poller starts, next tick in ${Math.round(waitMs / 60000)}m`);
  await sleep(waitMs);

  while (true) {
    const tickTime = Date.now();
    if (isDesireWindow(tickTime) && !queue.hasPendingForAccount(accountId)) {
      const id = crypto.randomUUID();
      queue.enqueue({
        id,
        accountId,
        senderId,
        workspaceRoot,
        text: buildDesireTriggerText(config),
        sourceType: "desire_checkin",
        createdAt: new Date().toISOString(),
      });
      console.log(`[desire] hourly checkin queued id=${id} at=${formatShanghai(tickTime)}`);
    }
    await sleep(60 * 60 * 1000);
  }
}

function resolveDesirePollerTargets({ config, sessionStore }) {
  const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
  if (config.channel === "telegram") {
    const accountId = normalizeText(config.accountId) || "telegram";
    const senderId = resolvePreferredSenderId({ config, accountId, sessionStore });
    const workspaceRoot = resolvePreferredWorkspaceRoot({ config, accountId, senderId, sessionStore });
    return { accountId, senderId, workspaceRoot };
  }

  const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
  const account = resolveSelectedAccount(config);
  const senderId = resolvePreferredSenderId({ config, accountId: account.accountId, sessionStore });
  const workspaceRoot = resolvePreferredWorkspaceRoot({ config, accountId: account.accountId, senderId, sessionStore });
  return { accountId: account.accountId, senderId, workspaceRoot };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildDesireTriggerText(config) {
  const userName = (process.env.CYBERBOSS_USER_NAME || "").trim() || "ta";
  return `${userName}又过了一小时。回顾这一小时，你内心有什么变化？此刻最想做的事是什么？各维度的感受和上小时比有什么变化？`;
}

function isDesireWindow(value) {
  const date = value instanceof Date ? value : new Date(value);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: SHANGHAI_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  return hour >= 6 && hour < 22;
}

function nextHourlyTickMs(now) {
  const OFFSET_MS = 8 * 60 * 60 * 1000;
  const localMs = now + OFFSET_MS;
  const nextLocalMs = Math.floor(localMs / 3_600_000) * 3_600_000 + 3_600_000;
  return Math.max(0, nextLocalMs - OFFSET_MS - now);
}

function formatShanghai(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SHANGHAI_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { runHourlyDesirePoller };
