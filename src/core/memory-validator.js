function normalizeText(value) {
  return String(value || '').trim();
}

function validateDraftAgainstMemory(draft = '', resolved = {}) {
  const text = normalizeText(draft);
  const items = Array.isArray(resolved?.index) ? resolved.index : [];
  const conflicts = [];

  for (const item of items) {
    if (!item || item.status !== 'active') continue;
    const priority = String(item.priority || '');
    const hard = priority === 'hard_fact' || priority === 'hard_preference';
    if (!hard) continue;
    const key = normalizeText(item.key).toLowerCase();
    const expected = normalizeText(item.value ?? item.text).toLowerCase();
    const detected = detectMemoryConflict(text, item, { key, expected });
    if (detected) {
      conflicts.push(detected);
    }
  }

  return { ok: conflicts.length === 0, conflicts };
}

function rewriteDraftToMatchMemory(draft = '', resolved = {}) {
  const text = normalizeText(draft);
  if (!text) {
    return { ok: true, text, changed: false, conflicts: [] };
  }
  const validation = validateDraftAgainstMemory(text, resolved);
  if (validation.ok) {
    return { ok: true, text, changed: false, conflicts: [] };
  }

  let rewritten = text;
  let changed = false;
  for (const conflict of validation.conflicts) {
    const next = applyConflictRewrite(rewritten, conflict);
    if (next && next !== rewritten) {
      rewritten = next;
      changed = true;
    }
  }

  const finalValidation = validateDraftAgainstMemory(rewritten, resolved);
  return {
    ok: finalValidation.ok,
    text: rewritten,
    changed,
    conflicts: finalValidation.conflicts,
    originalConflicts: validation.conflicts,
  };
}

function detectMemoryConflict(draft = '', item = {}, context = {}) {
  const text = normalizeText(draft);
  const key = normalizeText(context.key).toLowerCase();
  const expected = normalizeText(context.expected).toLowerCase();
  if (!text || !expected) return null;

  const addressRule = extractAddressRule(item);
  if (addressRule) {
    const addressConflict = detectAddressRuleConflict(text, item, addressRule);
    if (addressConflict) {
      return addressConflict;
    }
  }

  if (key && text.toLowerCase().includes(key) && !text.toLowerCase().includes(expected)) {
    return {
      type: 'hard_mismatch',
      id: item.id || '',
      key,
      expected,
      priority: item.priority,
      item,
      strategy: 'fallback',
    };
  }
  return null;
}

function extractAddressRule(item = {}) {
  const candidates = [
    normalizeText(item.text),
    normalizeText(item.value),
  ].filter(Boolean);
  let expectedTerm = "";
  for (const source of candidates) {
    const match = source.match(/(?:叫我|喊我|称呼我)([^\s，。！？,!.?]+)/);
    if (match) {
      expectedTerm = normalizeText(match[1]);
      break;
    }
  }
  if (!expectedTerm && candidates.length) {
    expectedTerm = normalizeText(candidates[0]);
  }
  if (!expectedTerm) return null;
  return { expectedTerm };
}

function detectAddressRuleConflict(text = '', item = {}, rule = {}) {
  const expectedTerm = normalizeText(rule.expectedTerm);
  if (!expectedTerm) return null;
  const patterns = [
    /(以后我叫你)([^\s，。！？,!.?]+)/g,
    /(我叫你)([^\s，。！？,!.?]+)/g,
    /(喊你)([^\s，。！？,!.?]+)/g,
    /(称呼你)([^\s，。！？,!.?]+)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const actualTerm = normalizeText(match[2]);
      if (actualTerm && actualTerm !== expectedTerm) {
        return {
          type: 'address_mismatch',
          id: item.id || '',
          key: normalizeText(item.key).toLowerCase(),
          expected: expectedTerm.toLowerCase(),
          expectedTerm,
          actualTerm,
          priority: item.priority,
          item,
          strategy: 'replace_address_term',
          matchText: match[0],
          prefix: match[1],
        };
      }
    }
  }
  return null;
}

function applyConflictRewrite(draft = '', conflict = {}) {
  const text = normalizeText(draft);
  if (!text) return text;
  if (conflict.strategy === 'replace_address_term' && conflict.matchText && conflict.prefix && conflict.expectedTerm) {
    const replacement = `${conflict.prefix}${conflict.expectedTerm}`;
    return text.replace(conflict.matchText, replacement);
  }
  return text;
}

module.exports = { validateDraftAgainstMemory, rewriteDraftToMatchMemory };
