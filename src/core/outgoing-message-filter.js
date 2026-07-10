const BLOCK_PATTERNS = [
  /memory\s+system/i,
  /index\.jsonl|pending\.jsonl|ops\.jsonl/i,
  /facts\.md|preferences\.md|patterns\.md|projects\.md|pending-promises\.md|open_loops\.md|relationships\.md|profile\.md/i,
  /后台读取|后台写入|增量追加|冲突校验|检索过程|调试日志|中间草稿|内部判断链路/,
  /MEMORY CONSTRAINTS \(internal\)/i,
  /MEMORY CONSTRAINT FIX \(internal\)/i,
];

const REWRITE_RULES = [
  [/后台读取|后台写入|增量追加/g, '我会在这边记着'],
  [/冲突校验|检索过程|调试日志|中间草稿|内部判断链路/g, '我会再确认一下再回你'],
  [/index\.jsonl|pending\.jsonl|ops\.jsonl|facts\.md|preferences\.md|patterns\.md|projects\.md|pending-promises\.md|open_loops\.md|relationships\.md|profile\.md/gi, '相关记录'],
  [/MEMORY CONSTRAINTS \(internal\)|MEMORY CONSTRAINT FIX \(internal\)/gi, ''],
  [/\bmemory\s+system\b/gi, '记录方式'],
];

function isMemoryQuestion(userText = '') {
  const t = String(userText || '');
  return /memory|记忆|长期记忆|\/memory/.test(t);
}

function rewriteLine(line = '') {
  let out = String(line || '');
  for (const [re, rep] of REWRITE_RULES) {
    out = out.replace(re, rep);
  }
  return out.trim();
}

function shouldDropLine(line = '') {
  const t = String(line || '').trim();
  if (!t) return true;
  return BLOCK_PATTERNS.some((re) => re.test(t));
}

function filterOutgoingWechatText(text = '', userText = '') {
  if (String(process.env.CYBERBOSS_MEMORY_OUTGOING_FILTER || '0') !== '1') return String(text || '');
  const raw = String(text || '');
  if (!raw) return raw;
  if (isMemoryQuestion(userText)) return raw;

  const rewritten = raw
    .split('\n')
    .map((line) => rewriteLine(line))
    .filter((line) => !shouldDropLine(line));

  const cleaned = rewritten.join('\n').trim();
  if (cleaned) return cleaned;

  // do not swallow output; return a natural fallback sentence
  return '我在，刚刚那句我换个说法：你继续说，我认真接着。';
}

module.exports = { filterOutgoingWechatText };
