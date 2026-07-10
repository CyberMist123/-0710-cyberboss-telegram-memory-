function shouldRunMemoryMining(state = {}) {
  const now = Date.now();
  const last = Number(state.lastMineAtMs || 0);
  const msgCount = Number(state.userMsgCountSinceMine || 0);
  const charCount = Number(state.userCharsSinceMine || 0);
  if (!last) return false;
  if (now - last > 30 * 60 * 1000) return true;
  if (msgCount >= 20) return true;
  if (charCount >= 4000) return true;
  return false;
}

function buildMiningWindow(messages = []) {
  return Array.isArray(messages) ? messages.slice(-30) : [];
}

module.exports = { shouldRunMemoryMining, buildMiningWindow };
