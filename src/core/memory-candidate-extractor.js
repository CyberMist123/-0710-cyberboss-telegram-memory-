function normalizeText(v = "") {
  return String(v || "").trim();
}

function squeezeSpaces(value = "") {
  return normalizeText(value).replace(/\s+/g, " ");
}

function slugify(value = "") {
  return squeezeSpaces(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function buildKey(prefix, text) {
  return `${prefix}_${slugify(text) || "item"}`;
}

function splitClauses(text = "") {
  return squeezeSpaces(text)
    .split(/[。！？!?\n]/)
    .flatMap((part) => part.split(/[；;]/))
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function cleanCandidateText(text = "") {
  return squeezeSpaces(text)
    .replace(/^(记住|请记住|记下|请记下|这是事实|这是偏好|以后都按这个|以后|后续|对了|还有)\s*[:：,，]?\s*/gi, "")
    .replace(/[。！!]+$/g, "")
    .trim();
}

function isMeaningfulMemory(text = "") {
  const t = cleanCandidateText(text);
  if (!t) return false;
  if (t.length < 4) return false;
  if (/^(嗯|哦|好|好的|在吗|收到|晚安|早安|哈哈|ok|OK)[!！。\s]*$/.test(t)) return false;
  if (/^\[Quoted:/.test(t)) return false;
  if (/[?？]$/.test(t) && !/(记住|记下|提醒|别忘了|不要|别用|以后|下次|记得)/.test(t)) return false;
  if (/(今天|明天|刚刚|等会|一会|晚上|下午|早上).{0,14}(吃饭|睡觉|下班|回家|出门)/.test(t)) return false;
  if (/(辛苦|好累|累死|困死|烦死|崩溃|无语)[了啊呀吗吧呢]?$/.test(t)) return false;
  if (/(顶到|夹射|吸你|肏|发情|高潮|欠操|想操)/.test(t)) return false;
  if (/(记住|记下|别忘了|提醒我|记得|喜欢|不喜欢|讨厌|不要|别用|禁用|边界|叫我|喊我|称呼我|我是|我叫|生日|职业|身份|习惯|经常|总是|每次|后续|待办|未解决|项目目标|当前目标|里程碑)/.test(t)) {
    return true;
  }
  if (/(我吃.{0,10}会|我对.{0,10}(过敏|敏感)|我(?:不能|容易|需要)|下雨天我)/.test(t)) {
    return true;
  }
  return false;
}

function analyzeMemoryText(text = "") {
  const source = squeezeSpaces(text);
  if (!source) return { worthy: false, clauses: [], reasons: ["empty"] };
  const clauses = splitClauses(source).filter(isMeaningfulMemory);
  if (!clauses.length) return { worthy: false, clauses: [], reasons: ["no_meaningful_clause"] };
  const worthy = clauses.some((clause) => isStableMemorySignal(clause));
  return {
    worthy,
    clauses,
    reasons: worthy ? ["stable_signal"] : ["weak_signal_only"],
  };
}

function isStableMemorySignal(text = "") {
  const t = cleanCandidateText(text);
  if (/(记住|记下|别忘了|提醒我|记得|喜欢|不喜欢|讨厌|不要|别用|禁用|边界|叫我|喊我|称呼我|我是|我叫|生日|职业|身份|习惯|经常|总是|每次|后续|待办|未解决|项目目标|当前目标|里程碑)/.test(t)) {
    return true;
  }
  if (/(我吃.{0,10}会|我对.{0,10}(过敏|敏感)|我(?:不能|容易|需要)|下雨天我)/.test(t)) {
    return true;
  }
  return false;
}

function extractMemoryCandidatesFromText(text = "") {
  const analysis = analyzeMemoryText(text);
  if (!analysis.worthy) return [];

  const out = [];
  for (const clause of analysis.clauses) {
    extractPreferenceCandidates(clause, out);
    extractRelationshipCandidates(clause, out);
    extractProfileCandidates(clause, out);
    extractPatternCandidates(clause, out);
    extractProjectCandidates(clause, out);
    extractFactCandidates(clause, out, { explicit: /(记住|记下|这是事实|以后都按这个)/.test(text) });
  }
  return dedupeCandidates(out).slice(0, 8);
}

function extractPreferenceCandidates(text, out) {
  const t = cleanCandidateText(text);
  const extracted = [];

  pushMatches(extracted, t, [
    /((?:我)?更喜欢[^，,]*)/i,
    /((?:我)?喜欢[^，,]*)/i,
    /((?:我)?不喜欢[^，,]*)/i,
    /((?:我)?讨厌[^，,]*)/i,
    /((?:不要|别再|别用|别|禁用)[^，,]*)/i,
    /((?:微信这边|平时|以后|下次).{0,18}(?:收一点|直接一点|自然一点|别太[^，,]*|不要[^，,]*))/i,
  ]);

  for (const item of extracted) {
    const normalized = normalizePreferenceText(item);
    const summarized = summarizePreferenceMemory(normalized);
    if (!summarized) continue;
    pushCandidate(out, {
      category: "preferences",
      priority: "hard_preference",
      tier: "stable",
      text: summarized.text,
      value: summarized.value,
      key: summarized.key,
      confidence: 0.92,
    });
  }
}

function extractRelationshipCandidates(text, out) {
  const t = cleanCandidateText(text);
  const addressMatch = t.match(/(?:叫我|喊我|称呼我)([^\s，。,！!？?]+)/);
  if (addressMatch) {
    const expected = squeezeSpaces(addressMatch[1]);
    pushCandidate(out, {
      category: "relationships",
      priority: "relationship",
      tier: "stable",
      text: `叫我${expected}`,
      value: expected,
      key: `rel_address_${slugify(expected) || "preferred"}`,
      confidence: 0.95,
    });
  }

  const relationMatch = t.match(/((?:我们|你和我).{0,20}(?:关系|对象|伴侣|朋友)[^，,]*)/i);
  if (relationMatch) {
    const normalized = cleanCandidateText(relationMatch[1]);
    pushCandidate(out, {
      category: "relationships",
      priority: "relationship",
      tier: "observation",
      text: normalized,
      value: normalized,
      key: buildKey("rel", normalized),
      confidence: 0.86,
    });
  }
}

function extractProfileCandidates(text, out) {
  const t = cleanCandidateText(text);
  const patterns = [
    { re: /我叫([^\s，。,！!？?]+)/, key: "profile_name", render: (v) => `我叫${v}` },
    { re: /我的名字是([^\s，。,！!？?]+)/, key: "profile_name", render: (v) => `我的名字是${v}` },
    { re: /我是([^，。,！!？?]{1,18})/, key: "profile_identity", render: (v) => `我是${v}` },
    { re: /生日是?([^，。,！!？?]{1,18})/, key: "profile_birthday", render: (v) => `生日是${v}` },
    { re: /职业是?([^，。,！!？?]{1,18})/, key: "profile_job", render: (v) => `职业是${v}` },
  ];

  for (const pattern of patterns) {
    const match = t.match(pattern.re);
    if (!match) continue;
    const value = squeezeSpaces(match[1]);
    if (!value) continue;
    pushCandidate(out, {
      category: "profile",
      priority: "hard_fact",
      tier: "stable",
      text: pattern.render(value),
      value,
      key: pattern.key,
      confidence: 0.9,
    });
  }
}

function extractOpenLoopCandidates(text, out) {
  return out;
}

function extractPatternCandidates(text, out) {
  const t = cleanCandidateText(text);
  const match = t.match(/((?:总是|经常|反复|习惯|每次都)[^，,]*)/i);
  if (!match) return;
  const normalized = cleanCandidateText(match[1]);
  pushCandidate(out, {
    category: "patterns",
    priority: "pattern",
    tier: "observation",
    text: normalized,
    value: normalized,
    key: buildKey("pattern", normalized),
    confidence: 0.82,
  });
}

function extractProjectCandidates(text, out) {
  const t = cleanCandidateText(text);
  const patterns = [
    /(项目目标是[^，,]*)/i,
    /(当前目标是[^，,]*)/i,
    /(里程碑是[^，,]*)/i,
    /((?:在做|正在做|还要做).{0,18}(?:项目|开发|功能|页面|接口)[^，,]*)/i,
  ];
  const extracted = [];
  pushMatches(extracted, t, patterns);

  for (const item of extracted) {
    const normalized = cleanCandidateText(item);
    pushCandidate(out, {
      category: "projects",
      priority: "project",
      tier: /(?:项目目标是|当前目标是|里程碑是)/.test(normalized) ? "stable" : "observation",
      text: normalized,
      value: normalized,
      key: buildKey("project", normalized),
      confidence: 0.84,
    });
  }
}

function extractFactCandidates(text, out, { explicit = false } = {}) {
  const t = cleanCandidateText(text);
  const patterns = [
    /(我吃[^，,]{0,12}会[^，,]*)/i,
    /(我对[^，,]{0,12}(?:过敏|敏感)[^，,]*)/i,
    /(我(?:不能|容易|需要)[^，,]*)/i,
    /(下雨天我[^，,]*(?:不喜欢|会|容易)[^，,]*)/i,
  ];
  const extracted = [];
  pushMatches(extracted, t, patterns);

  for (const item of extracted) {
    const normalized = cleanCandidateText(item);
    const summarized = summarizeFactMemory(normalized, { explicit });
    if (!summarized) continue;
    pushCandidate(out, {
      category: "facts",
      priority: "hard_fact",
      tier: "stable",
      text: summarized.text,
      value: summarized.value,
      key: summarized.key,
      confidence: explicit ? 0.95 : 0.88,
    });
  }
}

function pushMatches(out, text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = cleanCandidateText(match[1] || match[0] || "");
    if (value) out.push(value);
  }
}

function pushCandidate(out, candidate = {}) {
  const text = cleanCandidateText(candidate.text || candidate.value || "");
  if (!text) return;
  out.push({
    category: String(candidate.category || "facts"),
    priority: String(candidate.priority || "soft_preference"),
    tier: String(candidate.tier || "stable"),
    key: String(candidate.key || buildKey(candidate.keyPrefix || "mem", text)),
    value: squeezeSpaces(candidate.value || text),
    text,
    confidence: Number(candidate.confidence || 0.8),
  });
}

function normalizePreferenceText(text = "") {
  return cleanCandidateText(text)
    .replace(/^我更喜欢/, "更喜欢")
    .replace(/^我喜欢/, "喜欢")
    .replace(/^我不喜欢/, "不喜欢")
    .replace(/^我讨厌/, "讨厌");
}

function summarizePreferenceMemory(text = "") {
  const t = cleanCandidateText(text);
  if (/直接一点|更容易理解/.test(t)) {
    return {
      key: "pref_style_direct",
      text: "偏好直接、易理解的表达",
      value: "偏好直接、易理解的表达",
    };
  }
  if (/别用.*比喻|奇奇怪怪的比喻/.test(t)) {
    return {
      key: "pref_no_weird_metaphor",
      text: "不喜欢奇怪比喻，偏好直接表达",
      value: "不喜欢奇怪比喻，偏好直接表达",
    };
  }
  if (/下雨/.test(t) && /(讨厌|不喜欢)/.test(t)) {
    return {
      key: "pref_dislike_rain",
      text: "不喜欢下雨",
      value: "不喜欢下雨",
    };
  }
  return null;
}

function normalizeOpenLoopText(text = "") {
  return cleanCandidateText(text)
    .replace(/^记得/, "提醒我")
    .replace(/^别忘了/, "提醒我");
}

function buildOpenLoopKey(text = "") {
  const t = cleanCandidateText(text);
  if (/免打扰/.test(t)) return "loop_disable_dnd";
  if (/银行卡/.test(t) && /身份证/.test(t)) return "loop_check_bank_card_and_id";
  return buildKey("loop", t);
}

function summarizeFactMemory(text = "", { explicit = false } = {}) {
  const t = cleanCandidateText(text);
  if (/吃太辣/.test(t) && /胃疼/.test(t)) {
    return {
      key: "fact_spicy_hurts_stomach",
      text: "吃太辣会胃疼",
      value: "吃太辣会胃疼",
    };
  }
  if (/下雨/.test(t) && /(不喜欢|讨厌)/.test(t)) {
    return {
      key: "fact_dislike_rain",
      text: "不喜欢下雨",
      value: "不喜欢下雨",
    };
  }
  if (explicit && /过敏|敏感|不能|容易|需要/.test(t)) {
    return {
      key: buildKey("fact", t),
      text: t,
      value: t,
    };
  }
  return null;
}

function dedupeCandidates(items = []) {
  const bySignature = new Map();
  for (const item of items) {
    if (!item?.text) continue;
    const signature = `${item.category}|${item.key || item.text}`;
    const prev = bySignature.get(signature);
    if (!prev) {
      bySignature.set(signature, item);
      continue;
    }
    if (Number(item.confidence || 0) > Number(prev.confidence || 0)) {
      bySignature.set(signature, item);
      continue;
    }
    if (Number(item.confidence || 0) === Number(prev.confidence || 0) && item.text.length < prev.text.length) {
      bySignature.set(signature, item);
    }
  }
  return Array.from(bySignature.values());
}

module.exports = {
  analyzeMemoryText,
  extractMemoryCandidatesFromText,
  isMeaningfulMemory,
};
