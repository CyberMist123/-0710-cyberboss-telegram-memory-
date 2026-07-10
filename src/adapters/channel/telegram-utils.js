const https = require("https");

// Module-level proxy config. When null (default), Telegram requests go direct.
// Set via configureTelegramProxy() during startup from user config/env.
let _proxyConfig = null;
let _tunnelModule = null;

// Parse "http://host:port", "host:port", or "host" into { host, port }.
function parseProxyTarget(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  let host = raw;
  let port = 0;
  try {
    if (/^[a-z]+:\/\//i.test(raw)) {
      const u = new URL(raw);
      host = u.hostname;
      port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    } else {
      const [h, p] = raw.split(":");
      host = (h || "").trim();
      port = Number(p) || 80;
    }
  } catch {
    return null;
  }
  if (!host || !Number.isFinite(port) || port <= 0) {
    return null;
  }
  return { host, port };
}

// Configure (or clear) the Telegram proxy. Pass a falsy value to disable.
function configureTelegramProxy(value) {
  _proxyConfig = parseProxyTarget(value);
  if (_proxyConfig && !_tunnelModule) {
    try {
      _tunnelModule = require("tunnel-agent");
    } catch {
      _tunnelModule = null;
      _proxyConfig = null;
    }
  }
  return _proxyConfig;
}

function isProxyEnabled() {
  return !!(_proxyConfig && _tunnelModule);
}

async function doFetch(url, options, timeoutMs) {
  // Direct connection when no proxy is configured.
  if (!isProxyEnabled()) {
    return doFetchDirect(url, options, timeoutMs);
  }
  return doFetchWithProxy(url, options, timeoutMs);
}

async function doFetchDirect(url, options, timeoutMs) {
  const controller = new AbortController();
  const signal = options?.signal || controller.signal;
  const timeout = setTimeout(() => controller.abort(new Error("telegram request timeout")), Math.max(1, Number(timeoutMs) || 30000));
  try {
    const res = await fetch(typeof url === "string" ? url : url.toString(), {
      method: options?.method || "GET",
      headers: options?.headers || {},
      body: options?.body,
      signal: options?.signal || controller.signal,
    });
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      async json() { return JSON.parse(text); },
      async text() { return text; },
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function doFetchWithProxy(url, options, timeoutMs) {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  return new Promise((resolve, reject) => {
    const agent = _tunnelModule.httpsOverHttp({
      proxy: { host: _proxyConfig.host, port: _proxyConfig.port },
    });
    const req = https.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options?.method || "GET",
      headers: Object.assign({}, options?.headers || {}),
      agent,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          async json() { return JSON.parse(text); },
          async text() { return text; },
        });
      });
    });
    req.on("error", reject);
    const timeout = setTimeout(() => {
      req.destroy(new Error("telegram request timeout"));
    }, Math.max(1, Number(timeoutMs) || 30000));
    req.on("close", () => clearTimeout(timeout));
    const sig = options?.signal;
    if (sig) {
      if (sig.aborted) { req.destroy(sig.reason); return; }
      sig.addEventListener("abort", () => req.destroy(sig.reason), { once: true });
    }
    if (options?.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

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
    const response = await doFetch(url, { ...options, signal: controller.signal }, timeoutMs);
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
  configureTelegramProxy,
  isProxyEnabled,
  fetchJsonWithRetry,
  fetchJsonWithTimeout,
  sleep,
};
