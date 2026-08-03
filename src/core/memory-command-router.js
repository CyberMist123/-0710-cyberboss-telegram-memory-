function parseMemoryCommand(text = '') {
  const t = String(text || '').trim();
  if (!t.startsWith('/memory')) return null;
  // Delegate to the same option-aware parser as the terminal path so Telegram
  // `/memory review --category X --limit N --json` (advertised in the help) are
  // honoured instead of dropped into positional args and ignored.
  return parseTerminalMemoryCommand(t.split(/\s+/).slice(1));
}

function parseTerminalMemoryCommand(args = []) {
  const parts = Array.isArray(args) ? args.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const positional = [];
  const options = {};
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part.startsWith("--")) {
      positional.push(part);
      continue;
    }
    const name = part.slice(2).trim().toLowerCase();
    if (!name) continue;
    if (name === "json") {
      options.json = true;
      continue;
    }
    const next = parts[i + 1];
    if (next && !next.startsWith("--")) {
      options[name] = next;
      i += 1;
      continue;
    }
    options[name] = true;
  }
  return {
    action: (positional[0] || 'help').toLowerCase(),
    args: positional.slice(1),
    options,
  };
}

module.exports = { parseMemoryCommand, parseTerminalMemoryCommand };
