const fs = require('fs');
const path = require('path');

const SLOT_TO_CATEGORY = {
  identity: ['profile', 'facts'],
  relationship: ['relationships'],
  preference: ['preferences'],
  project: ['projects'],
  pattern: ['patterns'],
  pending_promise: ['pending_promises'],
};

function compressMemoryText(input = '') {
  let t = String(input || '').trim();
  if (!t) return '';
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/^[，。；、\-\s]+|[，。；、\-\s]+$/g, '');
  // keep core clause only
  t = t.replace(/^(请记住|记一下|记住|以后|后续|请|麻烦|就是|其实)/g, '');
  t = t.replace(/(谢谢|辛苦了|麻烦你了|好的|收到)[。！!]*$/g, '');
  t = t.replace(/[。！!？?]+/g, '；');
  const parts = t.split('；').map((x) => x.trim()).filter(Boolean);
  t = parts[0] || t;
  if (t.length > 42) t = t.slice(0, 42).replace(/[，、；\s]+$/g, '');
  return t;
}

function normalizeMemoryTier(value = '') {
  const tier = String(value || '').trim().toLowerCase();
  return tier === 'observation' ? 'observation' : 'stable';
}

function normalizeMemoryEntry(entry = {}) {
  return {
    ...entry,
    tier: normalizeMemoryTier(entry.tier),
  };
}

function isStableRetrievableMemory(item = {}) {
  return String(item.status || 'active') === 'active' && normalizeMemoryTier(item.tier) === 'stable';
}

function isLowValueMemoryText(text = '') {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^\[Quoted:/.test(t)) return true;
  if (/[?？]$/.test(t)) return true;
  if (/(顶到|夹射|吸你|肏|发情|高潮|欠操|想操|子宫口)/.test(t)) return true;
  if (/(哥哥没计划我可有计划|计划就是被哥哥|正在实施.*计划)/.test(t)) return true;
  if (/(今天|明天|刚刚|等会|一会|晚上|下午|早上).{0,18}(吃饭|睡觉|下班|回家|出门)/.test(t)) return true;
  if (/^(谁让我喜欢你呢|讨厌 给我嘛 给我嘛|就喜欢这种刺激的感觉|嗯 硬硬的 喜欢💕?)$/.test(t)) return true;
  if (/(你很喜欢.*吗|为什么不深|给我嘛|喜欢你呢|硬硬的)/.test(t)) return true;
  return false;
}

function shouldDowngradeToObservation(item = {}) {
  const text = String(item.text || item.value || '').trim();
  const category = String(item.category || '');
  const key = String(item.key || '');
  if (!text || isLowValueMemoryText(text)) return false;
  if (String(item.status || 'active') !== 'active') return false;
  if (/^(fact_|pref_|profile_|rel_address_|loop_)/.test(key)) return false;
  if (/(提醒我|别忘了|记得|叫我|喊我|称呼我|我是|我叫|生日|职业|不喜欢|讨厌|喜欢|不要|别用)/.test(text)) return false;
  if (category === 'projects' || category === 'patterns') return true;
  if (/(现在|刚刚|今天|明天|待会|等会)/.test(text)) return true;
  return false;
}

function shouldDeleteHistoricalMemory(item = {}) {
  const text = String(item.text || item.value || '').trim();
  const category = String(item.category || '');
  const key = String(item.key || '');
  if (isLowValueMemoryText(text)) return true;
  if (category === 'relationships' && /(客户|供应商|群发广告|基金调仓|回复客户|跟进客户|还没回复|做到\d+\/\d+|\d+\/\d+了)/.test(text)) return true;
  if (category === 'preferences' && /(调查问卷|skill|通知设置查了|醒了哥哥|点赞是为了让你看到)/.test(text)) return true;
  if ((category === 'preferences' || category === 'facts') && !key && text.length > 18) return true;
  if ((category === 'profile' || category === 'facts') && /(memory记|记到memor|不正经的那种转移|主动地给我发过telegram|挑衅我的智齿)/.test(text)) return true;
  return false;
}

function buildSevenDayMemoryTemplate() {
  return [
    '# 7-Day Memory',
    '',
    '## 记录规则',
    '- 这里只记录最近 7 天内会影响后续回应的关键事件摘要，不记录普通流水账。',
    '- 长期 memory 默认只从这里晋升；未标 KEY 的条目到期后可清理。',
    '- `summary` 用一句话概括事件。',
    '',
  ].join('\n');
}

function normalizeDateOnly(value = '') {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(dateOnly = '', offset = 7) {
  const normalized = normalizeDateOnly(dateOnly);
  const date = new Date(`${normalized}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + offset);
  return normalizeDateOnly(date.toISOString());
}

function normalizeLevel(value = '', fallback = 'medium') {
  const level = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(level) ? level : fallback;
}

function inferSevenDayCategory(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'event';
  if (raw === 'profile') return 'profile';
  if (raw === 'preferences') return 'preferences';
  if (raw === 'patterns') return 'patterns';
  if (raw === 'projects') return 'projects';
  if (raw === 'relationships') return 'relationships';
  if (raw === 'pending_promises' || raw === 'pending-promises') return 'pending_promises';
  if (raw === 'facts') return 'facts';
  return 'event';
}

function inferStablePriorityFromCategory(category = '') {
  switch (String(category || '').trim()) {
    case 'preferences':
      return 'hard_preference';
    case 'profile':
    case 'facts':
      return 'hard_fact';
    case 'relationships':
      return 'relationship';
    case 'patterns':
      return 'pattern';
    case 'projects':
      return 'project';
    case 'pending_promises':
      return 'pending_promise';
    default:
      return 'soft_preference';
  }
}

function normalizeSevenDayEntry(entry = {}) {
  const entryDate = normalizeDateOnly(entry.entry_date || entry.date || new Date().toISOString());
  const summary = String(entry.summary || entry.text || entry.value || '').trim();
  const keywords = Array.isArray(entry.keywords)
    ? entry.keywords.map((x) => String(x || '').trim()).filter(Boolean)
    : String(entry.keywords || '').split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  return {
    id: String(entry.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`).trim(),
    entry_date: entryDate,
    type: String(entry.type || inferSevenDayCategory(entry.category || '')).trim() || 'event',
    category: String(entry.category || inferSevenDayCategory(entry.type || '')).trim() || 'event',
    summary,
    keywords,
    emotion: normalizeLevel(entry.emotion, 'medium'),
    factual: normalizeLevel(entry.factual, 'medium'),
    key: String(entry.key || 'no').trim().toLowerCase() === 'yes' ? 'yes' : 'no',
    status: normalizeSevenDayStatus(entry.status || 'active'),
    expires_at: normalizeDateOnly(entry.expires_at || addDays(entryDate, 7)),
    promote_to: String(entry.promote_to || entry.promoted_to || '').trim(),
    suggested_category: String(entry.suggested_category || entry.category || '').trim(),
    source: String(entry.source || 'wechat').trim(),
  };
}

function normalizeSevenDayStatus(value = '') {
  const status = String(value || '').trim().toLowerCase();
  return ['active', 'promoted', 'rejected', 'expired'].includes(status) ? status : 'active';
}

function shouldSkipMarkdownSection(title = '') {
  const normalized = String(title || '').trim();
  if (!normalized) return false;
  return ['状态', '记录规则', '迁移规则', '条目模板', '注入与扫描规则'].includes(normalized);
}

function isDateExpired(dateOnly = '', today = '') {
  const left = normalizeDateOnly(dateOnly);
  const right = normalizeDateOnly(today || new Date().toISOString());
  if (!left || !right) return false;
  return left < right;
}

function sanitizeSevenDayPatch(patch = {}) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (key === 'entry_date' || key === 'expires_at') {
      out[key] = normalizeDateOnly(value);
      continue;
    }
    if (key === 'emotion' || key === 'factual') {
      out[key] = normalizeLevel(value);
      continue;
    }
    if (key === 'key') {
      out[key] = String(value || '').trim().toLowerCase() === 'yes' ? 'yes' : 'no';
      continue;
    }
    if (key === 'status') {
      out[key] = normalizeSevenDayStatus(value);
      continue;
    }
    if (key === 'keywords') {
      out[key] = Array.isArray(value)
        ? value.map((x) => String(x || '').trim()).filter(Boolean)
        : String(value || '').split(/[，,]/).map((x) => x.trim()).filter(Boolean);
      continue;
    }
    out[key] = String(value || '').trim();
  }
  return out;
}

function parseSevenDayMemory(raw = '') {
  const lines = String(raw || '').split('\n');
  const entries = [];
  let currentDate = '';
  let current = null;
  for (const rawLine of lines) {
    const line = String(rawLine || '').replace(/\r/g, '');
    const heading = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (heading) {
      currentDate = heading[1];
      continue;
    }
    const idMatch = line.match(/^\s*-\s*id:\s*`([^`]+)`\s*$/);
    if (idMatch) {
      if (current) entries.push(normalizeSevenDayEntry({ ...current, entry_date: current.entry_date || currentDate }));
      current = { id: idMatch[1].trim(), entry_date: currentDate };
      continue;
    }
    const fieldMatch = line.match(/^\s*-\s*([a-zA-Z_]+):\s*(.*?)\s*$/);
    if (fieldMatch && current) {
      const key = fieldMatch[1].trim();
      const value = fieldMatch[2].trim().replace(/^`+|`+$/g, '');
      current[key] = value;
    }
  }
  if (current) entries.push(normalizeSevenDayEntry({ ...current, entry_date: current.entry_date || currentDate }));
  return entries.filter((entry) => entry.id && entry.summary);
}

function renderSevenDayMemory(entries = []) {
  const grouped = new Map();
  for (const entry of (Array.isArray(entries) ? entries : []).map((item) => normalizeSevenDayEntry(item))) {
    const date = entry.entry_date || normalizeDateOnly(new Date().toISOString());
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(entry);
  }
  const dates = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));
  const lines = [
    '# 7-Day Memory',
    '',
    '## 记录规则',
    '- 这里只记录最近 7 天内会影响后续回应的关键事件摘要，不记录普通流水账。',
    '- 长期 memory 默认只从这里晋升；未标 KEY 的条目到期后可清理。',
    '- \`summary\` 用一句话概括事件。',
    '',
  ];
  for (const date of dates) {
    lines.push(`## ${date}`);
    lines.push('');
    const items = grouped.get(date).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const entry of items) {
      lines.push(`- id: \`${entry.id}\``);
      lines.push(`- type: \`${entry.type}\``);
      lines.push(`- category: \`${entry.category}\``);
      lines.push(`- summary: ${entry.summary}`);
      lines.push(`- keywords: \`${(entry.keywords || []).join(', ')}\``);
      lines.push(`- emotion: \`${entry.emotion}\``);
      lines.push(`- factual: \`${entry.factual}\``);
      lines.push(`- key: \`${entry.key}\``);
      lines.push(`- status: \`${entry.status}\``);
      lines.push(`- expires_at: \`${entry.expires_at}\``);
      lines.push(`- promote_to: \`${entry.promote_to || ''}\``);
      lines.push(`- suggested_category: \`${entry.suggested_category || ''}\``);
      lines.push(`- source: \`${entry.source || 'wechat'}\``);
      lines.push('');
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

function appendSevenDayMemoryEntry(filePath = '', entry = {}) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const entries = parseSevenDayMemory(current);
  entries.push(normalizeSevenDayEntry(entry));
  fs.writeFileSync(filePath, renderSevenDayMemory(entries), 'utf8');
}

function resolveSevenDayPromotionCategory(entry = {}, options = {}) {
  const explicit = String(options?.category || '').trim();
  if (explicit) return explicit;
  const promoteTo = String(entry.promote_to || '').trim();
  if (promoteTo) return promoteTo;
  const suggested = String(entry.suggested_category || entry.category || '').trim();
  if (['relationships', 'preferences', 'patterns', 'profile', 'projects', 'facts', 'pending_promises'].includes(suggested)) {
    return suggested;
  }
  return '';
}

class MemoryService {
  constructor({ memoryDir = '', vectorFile = '' } = {}) {
    const normalizedMemoryDir = String(memoryDir || '').trim();
    if (!normalizedMemoryDir) {
      throw new Error("memoryDir is required");
    }
    this.memoryDir = normalizedMemoryDir;
    this.indexFile = path.join(this.memoryDir, 'index.jsonl');
    this.sevenDayFile = path.join(this.memoryDir, '7-day-memory.md');
    this.opsFile = path.join(this.memoryDir, 'ops.jsonl');
    this.vectorFile = vectorFile || path.join(this.memoryDir, 'vectors.jsonl');
    this.markdownEmbeddingFile = path.join(this.memoryDir, 'markdown-embeddings.json');
    this.categoryFiles = {
      facts: path.join(this.memoryDir, 'facts.md'),
      preferences: path.join(this.memoryDir, 'preferences.md'),
      patterns: path.join(this.memoryDir, 'patterns.md'),
      projects: path.join(this.memoryDir, 'projects.md'),
      pending_promises: path.join(this.memoryDir, 'pending-promises.md'),
      open_loops: path.join(this.memoryDir, 'open_loops.md'),
      relationships: path.join(this.memoryDir, 'relationships.md'),
      profile: path.join(this.memoryDir, 'profile.md'),
    };
  }

  hasStore(file) {
    return Boolean(file) && fs.existsSync(file);
  }

  ensureFiles() {
    fs.mkdirSync(this.memoryDir, { recursive: true });
    for (const file of Object.values(this.categoryFiles)) if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
    if (!fs.existsSync(this.sevenDayFile)) {
      fs.writeFileSync(this.sevenDayFile, buildSevenDayMemoryTemplate(), 'utf8');
    }
    this.cleanupSevenDayMemory();
  }

  _readJsonl(file) {
    this.ensureFiles();
    if (!this.hasStore(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }
  _writeJsonl(file, items) {
    this.ensureFiles();
    if (!this.hasStore(file)) return false;
    fs.writeFileSync(file, items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''), 'utf8');
    return true;
  }
  _appendJsonl(file, entry) {
    this.ensureFiles();
    if (!this.hasStore(file)) return false;
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    return true;
  }
  _appendOp(op) {
    if (!this.hasStore(this.opsFile)) return false;
    return this._appendJsonl(this.opsFile, { ts: new Date().toISOString(), ...op });
  }

  listFiles() { this.ensureFiles(); return fs.readdirSync(this.memoryDir); }
  readIndex({ status = 'active', categories = [], tiers = [], limit = 50 } = {}) {
    const wantedTiers = new Set((Array.isArray(tiers) ? tiers : []).map((x) => normalizeMemoryTier(x)).filter(Boolean));
    return this._readJsonl(this.indexFile)
      .map((x) => normalizeMemoryEntry(x))
      .filter((x) => (!status || x.status === status) && (!categories.length || categories.includes(x.category)) && (!wantedTiers.size || wantedTiers.has(normalizeMemoryTier(x.tier))))
      .slice(0, limit);
  }
  readPending({ limit = 50 } = {}) { return this.readSevenDayMemory({ status: 'active', limit }); }
  readMarkdown(category) { const f = this.categoryFiles[category]; return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; }
  readSevenDayMemory({ status = 'active', limit = 50, keyOnly = false } = {}) {
    this.ensureFiles();
    const entries = parseSevenDayMemory(fs.readFileSync(this.sevenDayFile, 'utf8'));
    return entries
      .filter((entry) => !status || String(entry.status || '').trim().toLowerCase() === status)
      .filter((entry) => !keyOnly || String(entry.key || '').trim().toLowerCase() === 'yes')
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        text: String(entry.summary || '').trim(),
        value: String(entry.summary || '').trim(),
      }));
  }
  readPendingPromises({ status = 'pending', limit = 20 } = {}) {
    const raw = this.readMarkdown('pending_promises');
    if (!raw) return [];
    const items = [];
    let current = null;
    for (const rawLine of raw.split('\n')) {
      const line = String(rawLine || '').replace(/\r/g, '');
      const taskMatch = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/);
      if (taskMatch) {
        if (current) items.push(current);
        current = {
          text: String(taskMatch[2] || '').trim(),
          status: taskMatch[1].toLowerCase() === 'x' ? 'done' : 'pending',
          promised: '',
          due: '',
          context: '',
        };
        continue;
      }
      const metaMatch = line.match(/^\s*-\s*([a-zA-Z_]+):\s*(.*?)\s*$/);
      if (metaMatch && current) {
        current[metaMatch[1].trim()] = String(metaMatch[2] || '').replace(/^`+|`+$/g, '').trim();
      }
    }
    if (current) items.push(current);
    return items
      .filter((item) => item.text && item.text !== '承诺内容' && item.text !== '暂无待兑现承诺。')
      .filter((item) => !status || String(item.status || '').trim().toLowerCase() === status)
      .slice(0, limit);
  }
  readMarkdownLines(category) {
    if (String(category || '').trim() === 'open_loops') return [];
    const text = this.readMarkdown(category);
    if (!text) return [];
    const out = [];
    let skipSection = false;
    for (const rawLine of text.split('\n')) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
      if (headingMatch) {
        skipSection = shouldSkipMarkdownSection(headingMatch[1]);
        continue;
      }
      if (skipSection) continue;
      const normalized = line.replace(/^[*-]\s+/, '').trim();
      if (!normalized) continue;
      out.push(normalized);
    }
    return out;
  }
  appendMarkdownLine(category = '', text = '') {
    const file = this.categoryFiles[String(category || '').trim()] || '';
    const line = String(text || '').trim();
    if (!file || !line) return false;
    const existing = this.readMarkdownLines(category);
    if (existing.includes(line)) return false;
    const current = this.readMarkdown(category);
    const next = `${current}${current && !current.endsWith('\n') ? '\n' : ''}- ${line}\n`;
    fs.writeFileSync(file, next, 'utf8');
    this._appendOp({ op: 'markdown_append', category, text: line });
    return true;
  }
  readMarkdownEmbeddingCache() {
    this.ensureFiles();
    if (!fs.existsSync(this.markdownEmbeddingFile)) {
      return { version: 1, categories: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.markdownEmbeddingFile, 'utf8'));
      const categories = parsed && typeof parsed === 'object' && parsed.categories && typeof parsed.categories === 'object'
        ? parsed.categories
        : {};
      return { version: 1, categories };
    } catch {
      return { version: 1, categories: {} };
    }
  }
  writeMarkdownEmbeddingCache(cache = {}) {
    this.ensureFiles();
    const payload = {
      version: 1,
      categories: cache && typeof cache === 'object' && cache.categories && typeof cache.categories === 'object'
        ? cache.categories
        : {},
    };
    fs.writeFileSync(this.markdownEmbeddingFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return true;
  }
  async syncMarkdownEmbeddings({ categories = [], markdownLines = {}, embeddingService = null } = {}) {
    this.ensureFiles();
    if (!embeddingService || typeof embeddingService.embedText !== 'function') return [];
    const selectedCategories = Array.from(new Set((Array.isArray(categories) ? categories : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)));
    if (!selectedCategories.length) return [];
    const cache = this.readMarkdownEmbeddingCache();
    const nextCategories = { ...(cache.categories || {}) };
    const result = [];
    let changed = false;
    for (const category of selectedCategories) {
      const lines = Array.isArray(markdownLines?.[category]) ? markdownLines[category] : this.readMarkdownLines(category);
      const uniqueLines = Array.from(new Set(lines.map((line) => String(line || '').trim()).filter(Boolean)));
      const existing = nextCategories[category] && typeof nextCategories[category] === 'object'
        ? { ...nextCategories[category] }
        : {};
      const categoryCache = {};
      for (const text of uniqueLines) {
        const cached = existing[text];
        if (cached && Array.isArray(cached.vector) && cached.vector.length) {
          categoryCache[text] = cached;
          result.push({ category, text, vector: cached.vector });
          continue;
        }
        const vector = await embeddingService.embedText(text);
        if (!Array.isArray(vector) || !vector.length) continue;
        categoryCache[text] = {
          vector,
          updatedAt: new Date().toISOString(),
        };
        result.push({ category, text, vector });
        changed = true;
      }
      const existingKeys = Object.keys(existing).sort();
      const nextKeys = Object.keys(categoryCache).sort();
      if (existingKeys.length !== nextKeys.length || existingKeys.some((key, index) => key !== nextKeys[index])) {
        changed = true;
      }
      nextCategories[category] = categoryCache;
    }
    if (changed) {
      this.writeMarkdownEmbeddingCache({ version: 1, categories: nextCategories });
      this._appendOp({ op: 'markdown_embedding_sync', categories: selectedCategories.join(','), count: result.length });
    }
    return result;
  }
  resolvePreResponseMemory({ slots = [], maxPerCategory = 5 } = {}) {
    const categories = Array.from(new Set(slots.flatMap((slot) => SLOT_TO_CATEGORY[slot] || [])));
    if (!categories.length) return { categories: [], markdown: {}, markdownLines: {}, limit: maxPerCategory };
    const markdown = {};
    const markdownLines = {};
    for (const c of categories) {
      markdown[c] = this.readMarkdown(c);
      markdownLines[c] = this.readMarkdownLines(c);
    }
    return { categories, markdown, markdownLines, limit: maxPerCategory };
  }

  saveFormalMemory(entry = {}, { markdownText = '' } = {}) {
    const category = String(entry.category || 'facts');
    const canonicalText = compressMemoryText(markdownText || entry.text || entry.value || '');
    if (!canonicalText) return null;
    const saved = this.appendMemory({
      ...entry,
      category,
      text: canonicalText,
      value: String(entry.value || canonicalText).trim() || canonicalText,
      tier: 'stable',
      status: 'active',
    });
    this.appendMarkdownLine(category, canonicalText);
    return saved;
  }

  appendMemory(entry = {}) {
    this.ensureFiles();
    const compressedText = compressMemoryText(entry.text || entry.value || '');
    if (!compressedText) return null;
    const e = {
      ...entry,
      text: compressedText,
      value: String(entry.value ?? compressedText).trim() || compressedText,
      status: entry.status || 'active',
      tier: normalizeMemoryTier(entry.tier || 'stable'),
    };
    const category = String(e.category || 'facts');
    if (this.hasStore(this.indexFile)) {
      fs.appendFileSync(this.indexFile, JSON.stringify(e) + '\n', 'utf8');
    }
    this._appendOp({ op: 'append', id: e.id || '', category, tier: e.tier });
    return e;
  }

  appendVector(entry = {}) {
    this.ensureFiles();
    if (!this.hasStore(this.vectorFile)) return null;
    if (!entry?.id || !Array.isArray(entry.vector) || !entry.vector.length) return null;
    const record = { id: String(entry.id), category: String(entry.category || ''), vector: entry.vector, text: String(entry.text || '').trim(), createdAt: new Date().toISOString() };
    this._appendJsonl(this.vectorFile, record);
    this._appendOp({ op: 'vector_append', id: record.id, category: record.category });
    return record;
  }

  readVectors({ ids = [] } = {}) {
    if (Array.isArray(ids) && ids.length === 0) return [];
    const wanted = new Set(Array.isArray(ids) ? ids.map((id) => String(id)).filter(Boolean) : []);
    return this._readJsonl(this.vectorFile).filter((x) => !wanted.size || wanted.has(String(x.id || '')));
  }

  searchMemory(query = '') {
    const q = String(query || '').toLowerCase();
    return this._readJsonl(this.indexFile).map((x) => normalizeMemoryEntry(x)).filter((x) => JSON.stringify(x).toLowerCase().includes(q)).slice(0, 20);
  }

  getMemory(reference = '') {
    const ref = String(reference || '').trim();
    if (!ref) return null;
    return this._readJsonl(this.indexFile).map((x) => normalizeMemoryEntry(x)).find((x) =>
      String(x.id || '') === ref || String(x.key || '') === ref
    ) || null;
  }

  markDeleted(id = '') {
    const items = this._readJsonl(this.indexFile);
    const now = new Date().toISOString();
    let changed = false;
    for (const x of items) if (x.id === id && x.status !== 'deleted') { x.status = 'deleted'; x.updatedAt = now; changed = true; }
    if (changed) this._writeJsonl(this.indexFile, items);
    this._appendOp({ op: 'delete', id });
    return changed;
  }

  markSuperseded(id = '') {
    const items = this._readJsonl(this.indexFile);
    const now = new Date().toISOString();
    let changed = false;
    for (const x of items) if (x.id === id && x.status === 'active') { x.status = 'superseded'; x.updatedAt = now; changed = true; }
    if (changed) this._writeJsonl(this.indexFile, items);
    this._appendOp({ op: 'supersede', id });
    return changed;
  }

  updateMemory(key = '', value = '') {
    const items = this._readJsonl(this.indexFile);
    const active = items.find((x) => x.status === 'active' && String(x.key || '') === String(key));
    if (!active) return null;
    this.markSuperseded(active.id);
    const now = new Date().toISOString();
    const entry = { ...active, id: `mem_${Date.now()}`, value, text: String(value), createdAt: now, updatedAt: now, status: 'active' };
    return this.appendMemory(entry);
  }

  updateMemoryReference(reference = '', value = '') {
    const active = this.getMemory(reference);
    if (!active || active.status !== 'active') return null;
    if (String(active.key || '').trim()) {
      return this.updateMemory(active.key, value);
    }
    this.markSuperseded(active.id);
    const now = new Date().toISOString();
    const entry = {
      ...active,
      id: `mem_${Date.now()}`,
      value,
      text: String(value),
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };
    return this.appendMemory(entry);
  }

  undoLastWrite() {
    const ops = this._readJsonl(this.opsFile);
    const last = [...ops].reverse().find((x) => x.op === 'append' && x.id);
    if (!last) return false;
    return this.markDeleted(last.id);
  }

  appendPending(candidate = {}) {
    this.ensureFiles();
    const entry = normalizeSevenDayEntry(candidate);
    if (!entry.summary) return null;
    const existing = this.readSevenDayMemory({ status: '', limit: 500 }).find((item) =>
      String(item.summary || '').trim() === entry.summary &&
      String(item.entry_date || '').trim() === entry.entry_date
    );
    if (existing) return existing;
    appendSevenDayMemoryEntry(this.sevenDayFile, entry);
    this._appendOp({ op: 'seven_day_append', id: entry.id || '', category: entry.category || '' });
    return entry;
  }
  approvePending(id = '', options = {}) {
    const approved = this.promoteSevenDayMemory(id, options);
    this._appendOp({ op: 'seven_day_promote', id });
    return approved;
  }
  rejectPending(id = '') {
    const changed = this.updateSevenDayMemory(id, { status: 'rejected' });
    this._appendOp({ op: 'seven_day_reject', id });
    return changed;
  }
  updateSevenDayMemory(id = '', patch = {}) {
    this.ensureFiles();
    const entries = parseSevenDayMemory(fs.readFileSync(this.sevenDayFile, 'utf8'));
    let changed = false;
    const next = entries.map((entry) => {
      if (String(entry.id || '').trim() !== String(id || '').trim()) return entry;
      changed = true;
      return {
        ...entry,
        ...sanitizeSevenDayPatch(patch),
      };
    });
    if (!changed) return false;
    fs.writeFileSync(this.sevenDayFile, renderSevenDayMemory(next), 'utf8');
    return true;
  }
  cleanupSevenDayMemory({ today = '' } = {}) {
    this.ensureFiles = this.ensureFiles.bind(this);
    const normalizedToday = normalizeDateOnly(today || new Date().toISOString());
    const current = fs.existsSync(this.sevenDayFile) ? fs.readFileSync(this.sevenDayFile, 'utf8') : '';
    const entries = parseSevenDayMemory(current);
    const kept = [];
    let removed = 0;
    for (const entry of entries) {
      const status = normalizeSevenDayStatus(entry.status || 'active');
      const expired = isDateExpired(entry.expires_at, normalizedToday);
      if (status !== 'active' || expired) {
        removed += 1;
        continue;
      }
      kept.push(entry);
    }
    if (removed > 0) {
      const backup = `${this.sevenDayFile}.bak-${Date.now()}`;
      if (fs.existsSync(this.sevenDayFile)) fs.copyFileSync(this.sevenDayFile, backup);
      fs.writeFileSync(this.sevenDayFile, renderSevenDayMemory(kept), 'utf8');
      this._appendOp({ op: 'seven_day_cleanup', removed, today: normalizedToday, backup });
    }
    return { removed };
  }
  promoteSevenDayMemory(id = '', options = {}) {
    this.ensureFiles();
    const entries = parseSevenDayMemory(fs.readFileSync(this.sevenDayFile, 'utf8'));
    const target = entries.find((entry) => String(entry.id || '').trim() === String(id || '').trim());
    if (!target) return null;
    const category = resolveSevenDayPromotionCategory(target, options);
    if (!category) return null;
    const overrideText = String(options?.text || '').trim();
    const saved = this.saveFormalMemory({
      id: `mem_${Date.now()}`,
      category,
      value: overrideText || target.summary || target.text || '',
      text: overrideText || target.summary || target.text || '',
      priority: options?.priority || inferStablePriorityFromCategory(category),
      tier: 'stable',
      scope: 'user',
      source: `seven_day_promote:${target.id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
    }, {
      markdownText: overrideText || target.summary || target.text || '',
    });
    if (!saved) return null;
    this.updateSevenDayMemory(id, {
      status: 'promoted',
      promoted_to: category,
      promote_to: category,
    });
    this.cleanupSevenDayMemory();
    return {
      ...target,
      promoted_to: category,
      text: overrideText || target.summary || target.text || '',
      value: overrideText || target.summary || target.text || '',
      category,
      status: 'active',
      tier: 'stable',
    };
  }

  backupBeforeRewrite(file) {
    const src = this.categoryFiles[file] || path.join(this.memoryDir, file);
    if (!fs.existsSync(src)) return null;
    const backup = `${src}.bak-${Date.now()}`;
    fs.copyFileSync(src, backup);
    this._appendOp({ op: 'backup', file: src, backup });
    return backup;
  }

  pruneCategory(category = '') {
    const f = this.categoryFiles[category];
    if (!f) return null;
    const backup = this.backupBeforeRewrite(category);
    const lines = fs.readFileSync(f, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
    const uniq = Array.from(new Set(lines));
    fs.writeFileSync(f, uniq.join('\n') + (uniq.length ? '\n' : ''), 'utf8');
    this._appendOp({ op: 'prune', category, before: lines.length, after: uniq.length });
    return { backup, before: lines.length, after: uniq.length };
  }

  findDuplicate(candidate = {}) {
    const category = String(candidate.category || "");
    const key = String(candidate.key || "");
    const text = String(candidate.text || "").trim();
    const rows = this._readJsonl(this.indexFile).map((x) => normalizeMemoryEntry(x)).filter((x) => x.status === "active");
    if (category && key) {
      const hit = rows.find((x) => String(x.category || "") === category && String(x.key || "") === key);
      if (hit) return hit;
    }
    if (text) {
      const hit = rows.find((x) => String(x.text || "").trim() === text);
      if (hit) return hit;
    }
    return null;
  }

  findConflict(candidate = {}) {
    const category = String(candidate.category || "");
    const key = String(candidate.key || "");
    const value = String(candidate.value ?? "").trim();
    if (!category || !key) return null;
    const rows = this._readJsonl(this.indexFile).map((x) => normalizeMemoryEntry(x)).filter((x) => x.status === "active");
    const hit = rows.find((x) => String(x.category || "") === category && String(x.key || "") === key);
    if (!hit) return null;
    const oldValue = String(hit.value ?? "").trim();
    if (oldValue && value && oldValue !== value) return hit;
    return null;
  }

  cleanupHistoricalMemories() {
    this.ensureFiles();
    if (!this.hasStore(this.indexFile)) {
      return { backups: [], deleted: 0, downgraded: 0, stabilized: 0 };
    }
    const backups = [this.backupBeforeRewrite('index.jsonl')].filter(Boolean);
    const items = this._readJsonl(this.indexFile).map((x) => normalizeMemoryEntry(x));
    let deleted = 0;
    let downgraded = 0;
    let stabilized = 0;
    for (const item of items) {
      if (String(item.status || 'active') !== 'active') continue;
      if (shouldDeleteHistoricalMemory(item)) {
        item.status = 'deleted';
        item.updatedAt = new Date().toISOString();
        deleted += 1;
        continue;
      }
      if (shouldDowngradeToObservation(item)) {
        if (item.tier !== 'observation') {
          item.tier = 'observation';
          item.updatedAt = new Date().toISOString();
          downgraded += 1;
        }
        continue;
      }
      if (item.tier !== 'stable') {
        item.tier = 'stable';
        item.updatedAt = new Date().toISOString();
        stabilized += 1;
      }
    }
    this._writeJsonl(this.indexFile, items);
    this._appendOp({ op: 'cleanup', deleted, downgraded, stabilized });
    return { backups, deleted, downgraded, stabilized };
  }
}

module.exports = { MemoryService, SLOT_TO_CATEGORY };
