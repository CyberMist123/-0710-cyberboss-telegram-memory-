const { classifyMemoryIntent } = require('./memory-intent-classifier');
const { extractMemoryCandidatesFromText } = require('./memory-candidate-extractor');

const SEGMENT_SILENCE_MS = 20 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }
function id(prefix = "mem") { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`; }

function cleanCandidateText(text = "") {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(记住|请记住|记下|请记下|这是事实|这是偏好|以后都按这个|以后|后续|对了|还有)\s*[:：,，]?\s*/giu, "")
    .replace(/[。！!]+$/g, "")
    .trim();
}

function normalizeCandidate(c = {}) {
  const text = String(c.text || '').trim();
  const category = String(c.category || 'facts');
  const key = String(c.key || '').trim();
  const value = String(c.value ?? text).trim();
  return {
    id: id("mem"),
    category,
    key,
    value,
    priority: c.priority || 'soft_preference',
    tier: c.tier || 'stable',
    scope: 'user',
    source: 'wechat',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'active',
    text,
  };
}

function addDays(date, offset = 7) {
  const base = new Date(date);
  if (Number.isNaN(base.getTime())) return '';
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

function levelFromCategory(category = '') {
  switch (String(category || '').trim()) {
    case 'relationships':
      return { emotion: 'high', factual: 'medium' };
    case 'preferences':
      return { emotion: 'medium', factual: 'high' };
    case 'profile':
    case 'facts':
      return { emotion: 'low', factual: 'high' };
    case 'patterns':
    case 'projects':
      return { emotion: 'medium', factual: 'medium' };
    default:
      return { emotion: 'medium', factual: 'medium' };
  }
}

function shouldMarkKey(category = '', summary = '') {
  const text = String(summary || '').trim();
  const cat = String(category || '').trim();
  if (!text) return false;
  if (cat === 'relationships' || cat === 'preferences') return true;
  if (/(线程|连续性|偏爱|答应|承诺|边界|以后都按这个|不要再)/.test(text)) return true;
  return false;
}

function inferPromoteTo(category = '', summary = '') {
  const text = String(summary || '').trim();
  const cat = String(category || '').trim();
  if (cat === 'relationships' || /(线程|连续性|偏爱|关系)/.test(text)) return 'relationships';
  if (cat === 'preferences' || /(不要|别用|偏好|喜欢|讨厌|表达|微信|telegram)/.test(text)) return 'preferences';
  if (cat === 'patterns' || /(经常|总是|反复|习惯|容易)/.test(text)) return 'patterns';
  if (cat === 'profile' || cat === 'facts') return cat;
  if (cat === 'projects') return 'projects';
  return '';
}

function compactQuote(text = '') {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 36 ? `${t.slice(0, 36).replace(/[，、；\s]+$/g, '')}...` : t;
}

function normalizeTimestamp(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return new Date().toISOString();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function startOfDayIso(timestamp = '') {
  return normalizeTimestamp(timestamp).slice(0, 10);
}

function normalizeSegmentMessage(raw = {}) {
  const text = String(raw.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const role = String(raw.role || 'user').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';
  return {
    text,
    ts: normalizeTimestamp(raw.ts || raw.timestamp || ''),
    role,
  };
}

function buildCategoryHighlights(candidates = []) {
  const grouped = new Map();
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const item = normalizeCandidate(raw);
    if (!item.text) continue;
    const category = String(item.category || 'event').trim() || 'event';
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(item);
  }
  return Array.from(grouped.entries()).map(([category, items]) => {
    const texts = Array.from(new Set(items.map((item) => item.text))).slice(0, 2);
    return { category, texts };
  });
}

function stripTrailingParticle(text = '') {
  return String(text || '').trim().replace(/[诶欸哎呀啦嘛吧呢啊哦噢]+$/u, '').trim();
}

function normalizeSummaryPhrase(text = '') {
  let t = cleanCandidateText(text);
  t = t.replace(/^记住[:：]?\s*/u, '').trim();
  t = t.replace(/^请记住[:：]?\s*/u, '').trim();
  return t;
}

function summarizeWorkloadPhrase(text = '') {
  const t = normalizeSummaryPhrase(text);
  if (!t) return '';
  if (/(连不上|卡住|阻塞|返工|延期|改需求|出问题|恢复了)/.test(t)) return `项目进展有波动：${t}`;
  if (/(先别催我做大块任务|别一下子压大任务)/.test(t)) return '当前更适合小块推进';
  if (/(一点点推进工作|推进一小块|先只推进一小块)/.test(t)) return '工作宜小步推进';
  return t;
}

function summarizeClause(category = '', text = '') {
  const cat = String(category || '').trim();
  const t = normalizeSummaryPhrase(text);
  if (!t) return '';

  if (cat === 'relationships') {
    const addressMatch = t.match(/^叫我(.+)$/u);
    if (addressMatch) {
      return `偏好称呼为“${stripTrailingParticle(addressMatch[1])}”`;
    }
    if (/(关系|偏爱|连续性|在意)/.test(t)) {
      return `提到关系在意点：${t}`;
    }
    return `关系相关：${t}`;
  }

  if (cat === 'preferences') {
    if (/^(更喜欢|喜欢)/.test(t)) return `明确偏好：${t}`;
    if (/^(不喜欢|讨厌)/.test(t)) return `明确不喜欢：${t.replace(/^(不喜欢|讨厌)/u, '').trim() || t}`;
    if (/^(不要|别再|别用|别|禁用)/.test(t)) return `要求后续避免：${t.replace(/^(不要|别再|别用|别|禁用)/u, '').trim() || t}`;
    return `表达偏好更新：${t}`;
  }

  if (cat === 'profile' || cat === 'facts') {
    if (/眼睛疼|胃疼|痛经|不舒服|发烧|头疼|烦躁|崩溃|难受|过敏|姨妈前|脑袋懵|睡不好|没睡好/.test(t)) {
      return `身体状态：${t.replace(/^今天/u, '').trim()}`;
    }
    const eatMatch = t.match(/^我?吃(.{0,12})会(.+)$/u);
    if (eatMatch) return `身体反应：吃${eatMatch[1]}会${eatMatch[2]}`;
    const sensitiveMatch = t.match(/^我?对(.{0,12})(过敏|敏感)(.*)$/u);
    if (sensitiveMatch) return `身体情况：对${sensitiveMatch[1]}${sensitiveMatch[2]}${sensitiveMatch[3]}`;
    if (/^我(?:不能|容易|需要)/.test(t)) return `状态特点：${t.replace(/^我/u, '')}`;
    return `${cat === 'profile' ? '个人状态' : '客观事实'}：${t}`;
  }

  if (cat === 'patterns') {
    return `行为模式：${t}`;
  }

  if (cat === 'projects') {
    return `工作/项目状态：${summarizeWorkloadPhrase(t)}`;
  }

  if (cat === 'pending_promises') {
    return `提到待兑现事项：${t}`;
  }

  return `近况摘要：${summarizeWorkloadPhrase(t)}`;
}

function summarizeAssistantContribution(text = '') {
  const t = cleanCandidateText(text);
  if (!t) return '';
  if (/(我会|我来|我之后会|晚点我提醒|到时候提醒|我记住了|记下了)/.test(t)) {
    return `我回应会跟进：${t}`;
  }
  if (/(知道了|明白了|收到|好哦|好的|嗯嗯|行)/.test(t)) {
    return '我做了确认回应';
  }
  return '';
}

function buildNarrativeSummary(category = '', highlights = [], combinedText = '', messages = []) {
  const summaryParts = [];
  const preferredHighlights = Array.isArray(highlights)
    ? highlights.filter((item) => String(item.category || '').trim() === String(category || '').trim())
    : [];
  const sourceHighlights = preferredHighlights.length ? preferredHighlights : (Array.isArray(highlights) ? highlights : []);
  for (const item of sourceHighlights.slice(0, 2)) {
    for (const text of Array.isArray(item.texts) ? item.texts : []) {
      const summarized = summarizeClause(item.category || category, text);
      if (summarized && !summaryParts.includes(summarized)) {
        summaryParts.push(summarized);
      }
      if (summaryParts.length >= 2) break;
    }
    if (summaryParts.length >= 2) break;
  }
  if (!summaryParts.length) {
    const fallback = combinedText.length > 72 ? `${combinedText.slice(0, 72).replace(/[，、；\s]+$/g, '')}...` : combinedText;
    const summarized = summarizeClause(category, fallback);
    if (summarized) summaryParts.push(summarized);
  }
  const assistantMessages = (Array.isArray(messages) ? messages : []).filter((item) => item?.role === 'assistant');
  for (const message of assistantMessages.slice(0, 2)) {
    const assistantSummary = summarizeAssistantContribution(message.text);
    if (assistantSummary && !summaryParts.includes(assistantSummary)) {
      summaryParts.push(assistantSummary);
    }
    if (summaryParts.length >= 3) break;
  }
  if (summaryParts.length && !String(summaryParts[0]).startsWith('这段对话里')) {
    summaryParts[0] = `这段对话里${summaryParts[0]}`;
  }
  return summaryParts.join('；').trim();
}

function inferSegmentCategory(highlights = [], text = '') {
  if (highlights.length) return String(highlights[0].category || 'event');
  const t = String(text || '');
  if (/(答应|说好的|承诺|兑现|提醒)/.test(t)) return 'pending_promises';
  if (/(喜欢|不喜欢|讨厌|别用|不要|边界)/.test(t)) return 'preferences';
  if (/(眼睛疼|胃疼|痛经|不舒服|累|困|烦躁|头疼)/.test(t)) return 'profile';
  if (/(项目|开发|上线|页面|接口|客户|工作|进度)/.test(t)) return 'projects';
  return 'event';
}

function chooseQuotedTexts(messages = []) {
  const unique = [];
  for (const raw of messages) {
    const text = compactQuote(raw.text || '');
    if (!text) continue;
    if (unique.includes(text)) continue;
    unique.push(text);
    if (unique.length >= 3) break;
  }
  return unique;
}

function hasSignificantEvent({ category = '', summary = '', highlights = [], messages = [] } = {}) {
  const cat = String(category || '').trim();
  const text = String(summary || '').trim();
  const normalizedMessages = Array.isArray(messages) ? messages : [];
  if (!text) return false;
  const fullText = normalizedMessages.map((item) => String(item.text || '').trim()).filter(Boolean).join('；');
  if (cat === 'relationships' || cat === 'preferences' || cat === 'pending_promises') return true;
  if (/(记住|请记下|不要再|别用|边界|答应|承诺|以后都按这个|提醒我|别忘了|记得|叫我|称呼我)/.test(text)) return true;
  if (/(眼睛疼|胃疼|痛经|不舒服|发烧|头疼|烦躁|崩溃|难受|过敏|姨妈前|脑袋懵|睡不好|没睡好)/.test(text)) return true;
  if (/(关系|偏爱|连续性|在意|失约|兑现|说好的)/.test(text)) return true;
  if (/(项目目标|当前目标|里程碑|上线|卡住|阻塞|返工|延期|改需求|交付)/.test(text)) return true;
  if (/(开发|项目|页面|接口|进度|推进|客户)/.test(text) && /(只推进一小块|卡住|被打断|今天先别|改成小块|延后|出问题|连不上|恢复了)/.test(fullText)) return true;
  if (normalizedMessages.length >= 3 && highlights.length >= 2 && /(不舒服|边界|不要|答应|卡住|恢复|出问题)/.test(fullText)) return true;
  if (/^(刚到公司了|到公司了|到家了|下班了|起床了|准备睡了|路上有点热|在吃饭|去洗澡|忙工作)$/.test(text)) return false;
  return false;
}

function buildSegmentSummary(messages = [], candidates = []) {
  const normalizedMessages = (Array.isArray(messages) ? messages : [])
    .map((item) => normalizeSegmentMessage(item))
    .filter(Boolean);
  if (!normalizedMessages.length) return [];
  const userMessages = normalizedMessages.filter((item) => item.role !== 'assistant');
  if (!userMessages.length) return [];
  const combinedText = normalizedMessages.map((item) => item.text).join('；');
  const highlights = buildCategoryHighlights(candidates);
  const category = inferSegmentCategory(highlights, combinedText);
  const summary = buildNarrativeSummary(category, highlights, combinedText, normalizedMessages);
  if (!summary) return [];
  if (!hasSignificantEvent({ category, summary, highlights, messages: normalizedMessages })) return [];
  const levels = levelFromCategory(category);
  const key = shouldMarkKey(category, summary) ? 'yes' : 'no';
  const startTs = normalizedMessages[0].ts;
  return [{
    id: id('evt'),
    entry_date: startOfDayIso(startTs),
    type: category === 'relationships' ? 'relationship' : 'event',
    category,
    summary,
    quoted: '',
    keywords: Array.from(new Set(summary
      .split(/[，,；]/)
      .map((x) => x.trim())
      .filter(Boolean))).slice(0, 4),
    emotion: levels.emotion,
    factual: levels.factual,
    key,
    status: 'active',
    expires_at: addDays(startTs, 7),
    promote_to: key === 'yes' ? inferPromoteTo(category, summary) : '',
    suggested_category: inferPromoteTo(category, summary) || category,
    source: 'wechat_segment_summary',
  }];
}

function mergeWindowCandidates(candidates = []) {
  const byType = new Map();
  for (const raw of candidates) {
    const c = { ...raw };
    const category = String(c.category || "facts");
    const key = String(c.key || "").trim();
    const text = String(c.text || "").trim();
    if (!text) continue;
    const sig = key ? `${category}|${key}` : `${category}|${text}`;
    const prev = byType.get(sig);
    if (!prev) {
      byType.set(sig, c);
      continue;
    }
    const prevConf = Number(prev.confidence || 0);
    const currConf = Number(c.confidence || 0);
    const prevStable = String(prev.tier || '') === 'stable';
    const currStable = String(c.tier || '') === 'stable';
    if (currStable && !prevStable) {
      byType.set(sig, c);
      continue;
    }
    if (!currStable && prevStable) {
      continue;
    }
    if (currConf > prevConf) {
      byType.set(sig, c);
      continue;
    }
    if (currConf === prevConf && text.length < String(prev.text || "").length) {
      byType.set(sig, c);
    }
  }
  return Array.from(byType.values());
}

async function writeCandidatesWithConflictCheck(memoryService, embeddingService, candidates = []) {
  for (const raw of candidates) {
    const c = normalizeCandidate(raw);
    if (!c.text) continue;

    const dup = memoryService.findDuplicate(c);
    if (dup) continue;

    const conflict = memoryService.findConflict(c);
    if (conflict && (conflict.priority === 'hard_fact' || conflict.priority === 'hard_preference')) {
      memoryService.appendPending({ ...c, id: id("pending"), status: 'pending', conflictWith: conflict.id || '' });
      continue;
    }

    if (conflict) {
      memoryService.markSuperseded(conflict.id);
    }
    const saved = memoryService.appendMemory(c);
    const vector = embeddingService ? await embeddingService.embedText(c.text) : [];
    if (vector.length) memoryService.appendVector({ id: saved.id, category: saved.category, text: saved.text, vector });
  }
}

function summarizeSegmentMessages(messages = []) {
  const normalizedMessages = (Array.isArray(messages) ? messages : [])
    .map((item) => normalizeSegmentMessage(item))
    .filter(Boolean);
  if (!normalizedMessages.length) return [];
  const merged = [];
  const seen = new Set();
  for (const message of normalizedMessages) {
    if (message.role === 'assistant') continue;
    for (const candidate of extractMemoryCandidatesFromText(message.text)) {
      const sig = `${candidate.category}|${candidate.text}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      merged.push(candidate);
    }
  }
  return buildSegmentSummary(normalizedMessages, mergeWindowCandidates(merged));
}

function flushCompletedSegment(memoryService, st = {}) {
  const messages = Array.isArray(st.segmentBuffer) ? st.segmentBuffer : [];
  if (!messages.length) return 0;
  const entries = summarizeSegmentMessages(messages);
  for (const entry of entries) {
    memoryService.appendPending(entry);
  }
  st.segmentBuffer = [];
  st.lastSegmentMessageAtMs = 0;
  return entries.length;
}

function cancelSegmentFlush(st = {}) {
  if (typeof st.cancelScheduledFlush === 'function') {
    st.cancelScheduledFlush();
    st.cancelScheduledFlush = null;
    return;
  }
  if (st.flushTimer) {
    clearTimeout(st.flushTimer);
    st.flushTimer = null;
  }
}

function scheduleSegmentFlush(memoryService, st = {}) {
  cancelSegmentFlush(st);
  const runner = () => {
    st.flushTimer = null;
    st.cancelScheduledFlush = null;
    flushCompletedSegment(memoryService, st);
  };
  if (typeof st.scheduleFlush === 'function') {
    st.cancelScheduledFlush = st.scheduleFlush(runner, SEGMENT_SILENCE_MS) || null;
    return;
  }
  st.flushTimer = setTimeout(runner, SEGMENT_SILENCE_MS);
  if (st.flushTimer && typeof st.flushTimer.unref === 'function') {
    st.flushTimer.unref();
  }
}

async function runMemoryPostResponsePipeline({ memoryService, embeddingService, normalized, bgState }) {
  if (!memoryService || !normalized) return;
  if (String(process.env.CYBERBOSS_MEMORY_BACKGROUND_WRITE || "0") !== "1") return;

  const text = String(normalized.text || '');
  const role = String(normalized.role || 'user').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';
  const intent = classifyMemoryIntent(text);
  const st = bgState || {};
  const receivedAtMs = Date.parse(String(normalized.receivedAt || '')) || Date.now();
  st.segmentBuffer = Array.isArray(st.segmentBuffer) ? st.segmentBuffer : [];

  if (st.segmentBuffer.length && Number(st.lastSegmentMessageAtMs || 0) > 0 && receivedAtMs - Number(st.lastSegmentMessageAtMs || 0) >= SEGMENT_SILENCE_MS) {
    flushCompletedSegment(memoryService, st);
  }
  if (text.trim()) {
    st.segmentBuffer.push({ text, ts: new Date(receivedAtMs).toISOString(), role });
    st.lastSegmentMessageAtMs = receivedAtMs;
    scheduleSegmentFlush(memoryService, st);
  }

  if (role === 'user' && intent.strongSignal) {
    st.pendingStrongSignal = true;
    return;
  }

  // A) 强信号优先等一轮回复后再总结，避免只记单边原话
  if (role === 'assistant' && st.pendingStrongSignal) {
    const entries = summarizeSegmentMessages(st.segmentBuffer);
    for (const entry of entries) {
      memoryService.appendPending(entry);
    }
    st.segmentBuffer = [];
    st.lastSegmentMessageAtMs = 0;
    st.pendingStrongSignal = false;
    cancelSegmentFlush(st);
    return;
  }
}

module.exports = {
  runMemoryPostResponsePipeline,
  writeCandidatesWithConflictCheck,
  summarizeSegmentMessages,
  flushCompletedSegment,
  scheduleSegmentFlush,
  SEGMENT_SILENCE_MS,
};
