const TELEGRAM_RETRY_BASE_MS = 1_000;
const TELEGRAM_RETRY_MAX_MS = 30_000;
const TELEGRAM_RETRY_MAX_ATTEMPTS = 5;

class TelegramRateLimitError extends Error {
  constructor(retryAfterMs) {
    super(`telegram rate limit, retry after ${retryAfterMs}ms`);
    this.name = "TelegramRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

async function fetchJsonWithRetry(url, options, timeoutMs, { allowEmptyJson = false } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < TELEGRAM_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetchJsonWithTimeout(url, options, timeoutMs, { allowEmptyJson });
    } catch (error) {
      lastError = error;
      if (attempt < TELEGRAM_RETRY_MAX_ATTEMPTS - 1) {
        let delay = Math.min(TELEGRAM_RETRY_BASE_MS * Math.pow(2, attempt), TELEGRAM_RETRY_MAX_MS);
        if (error instanceof TelegramRateLimitError && Number.isFinite(error.retryAfterMs)) {
          delay = Math.max(error.retryAfterMs, delay);
        }
        delay += Math.floor(Math.random() * 500);
        await sleep(delay);
      }
    }
  }
  throw lastError || new Error("telegram request failed");
}

async function fetchJsonWithTimeout(url, options, timeoutMs, { allowEmptyJson = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("telegram request timeout")), Math.max(1, Number(timeoutMs) || 0));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (response.status === 429) {
      let retryAfterSec = 5;
      try {
        const body = await response.json();
        if (Number.isFinite(body?.retry_after) && body.retry_after > 0) {
          retryAfterSec = body.retry_after;
        }
      } catch { /* ignore parse errors */ }
      throw new TelegramRateLimitError(Math.ceil(retryAfterSec) * 1000);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`telegram request failed: ${response.status}`);
    }
    if (!text.trim()) {
      return allowEmptyJson ? {} : {};
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

module.exports = {
  TELEGRAM_RETRY_BASE_MS,
  TELEGRAM_RETRY_MAX_MS,
  TELEGRAM_RETRY_MAX_ATTEMPTS,
  TelegramRateLimitError,
  fetchJsonWithRetry,
  fetchJsonWithTimeout,
  sleep,
};
