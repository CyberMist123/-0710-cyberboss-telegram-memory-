const { classifyMemoryIntent } = require("./memory-intent-classifier");

function resolveRequiredMemorySlots(classifierResult = {}) {
  const slots = Array.isArray(classifierResult.slots) ? classifierResult.slots : [];
  return Array.from(new Set(slots));
}

function isCasualChatMessage(text = "") {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  if (t.length <= 12 && /^(嗯|哦|好|好的|知道了|收到|哈哈+|嘿嘿+|晚安|早安|睡了|醒了|在吗|来了|去洗澡了|去睡觉了|我回来了|我去忙了|mua|晚点聊)$/i.test(t)) return true;
  if (t.length <= 24 && /^(在干嘛|干嘛呢|忙啥呢|忙吗|吃了吗|睡了吗|醒了吗|到家了吗|下班了吗)[？?！!]*$/i.test(t)) return true;
  if (/^[\s~～.,，。!?！？哈哈嘿嘿嗯啊哦]+$/.test(t)) return true;
  return false;
}

function shouldUseStateOnly(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/(今天|现在|此刻|刚刚|待会|等会|进度|做到哪|做到哪里|提醒|待办|安排|在干嘛|忙啥)/.test(t)) return true;
  if (/(做到|推进到|完成到|做到目前|做到现在).{0,8}\d{1,3}%/.test(t)) return true;
  if (/\d{1,3}%/.test(t) && /(做到|推进|完成|进展|进度)/.test(t)) return true;
  if (/(跟进|推进|完成|做到|处理|弄到).{0,8}\d{1,3}\s*\/\s*\d{1,3}/.test(t)) return true;
  if (/(\d{1,3}\s*\/\s*\d{1,3}).{0,8}(了|啦|呢|先|还)/.test(t) && /(跟进|推进|完成|做到|处理|广告|客户|资料)/.test(t)) return true;
  if (/(做到|推进|完成|先做|先推进|弄到).{0,8}(一半|一小块|一点|一部分|一点点|一点儿)/.test(t)) return true;
  return false;
}

function resolveMemoryRetrievalPlan(text = "") {
  const classifierResult = classifyMemoryIntent(text);
  const slots = resolveRequiredMemorySlots(classifierResult);
  const includePendingPromises = slots.includes("pending_promise");
  const retrievalSlots = slots.filter((slot) => slot !== "pending_promise");
  const casual = isCasualChatMessage(text);
  if (casual && !includePendingPromises && !retrievalSlots.length) {
    return {
      mode: "skip",
      classifierResult,
      slots,
      retrievalSlots: [],
      includePendingPromises: false,
    };
  }
  if (!includePendingPromises && !retrievalSlots.length && shouldUseStateOnly(text)) {
    return {
      mode: "state_only",
      classifierResult,
      slots,
      retrievalSlots: [],
      includePendingPromises: false,
    };
  }
  if (!includePendingPromises && !retrievalSlots.length) {
    return {
      mode: "skip",
      classifierResult,
      slots,
      retrievalSlots: [],
      includePendingPromises: false,
    };
  }
  return {
    mode: "targeted",
    classifierResult,
    slots,
    retrievalSlots,
    includePendingPromises,
  };
}

function buildMemoryConstraintPrefix(resolved = {}) {
  const items = Array.isArray(resolved.index) ? resolved.index : [];
  if (!items.length) return '';
  const hard = items.filter((x) => x && (x.priority === 'hard_fact' || x.priority === 'hard_preference'));
  const chosen = (hard.length ? hard : items).slice(0, 8);
  const lines = chosen.map((x) => `- ${String(x.text || "").trim()}`).filter(Boolean);
  if (!lines.length) return '';
  return [
    'MEMORY CONSTRAINTS (internal):',
    'Use these as stable constraints when replying. Do not mention memory system or files.',
    ...lines,
    '',
  ].join('\n');
}

module.exports = { resolveRequiredMemorySlots, resolveMemoryRetrievalPlan, buildMemoryConstraintPrefix };
