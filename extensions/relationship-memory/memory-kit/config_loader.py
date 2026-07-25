#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""memory-kit / dashboard / apply_keys_to_env 都从这里读 keys.local.json。

单一真源:memory-kit/keys.local.json。
- chat.*    → 聊天端(TG 线的 claudecode runtime 走的 DeepSeek/Claude/GLM)
- extract.* → 提取管道(extract_memory.py / janitor.py 用的模型)
- 上面两组 key 分开字段:聊天端不受 janitor 429 波及。

用法:
  from config_loader import load_keys, chat_config, extract_config, save_keys
  keys = load_keys()
  cc = chat_config(keys)  # {"provider": "deepseek", "model": "...", "key": "sk-...", "endpoint": "..."}
"""
import json
import os
from pathlib import Path

DEEPSEEK_ENV_KEY = "DEEPSEEK_API_KEY"
_PLACEHOLDER_MARKERS = ("<", ">", "changeme", "placeholder", "your_", "test", "dummy", "redacted")

KEYS_FILE = Path(
    os.environ.get("CYBERBOSS_DASHBOARD_KEYS_FILE")
    or os.environ.get("CYBERBOSS_KEYS_FILE")
    or (Path(__file__).resolve().parent / "keys.local.json")
)


def load_keys() -> dict:
    if not KEYS_FILE.exists():
        return {}
    try:
        return json.loads(KEYS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_keys(keys: dict) -> None:
    """只增/改键,内部注释键 _comment/_layout/_proxy_hint 强制保留,防被前端一键干掉。"""
    if _contains_secret_material(keys):
        raise ValueError("Refusing to persist secret material; set the required environment variable instead.")
    tmp = KEYS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(KEYS_FILE)


def chat_config(keys: dict) -> dict:
    provider = str(keys.get("chat_provider") or "deepseek").lower()
    key = _valid_secret(os.environ.get(DEEPSEEK_ENV_KEY, "")) if provider == "deepseek" else (keys.get("chat_keys") or {}).get(provider, "")
    endpoint = (keys.get("chat_endpoints") or {}).get(provider, "")
    model = keys.get("chat_model") or ""
    haiku = keys.get("chat_haiku_model") or ""
    return {
        "provider": provider,
        "model": model,
        "haiku_model": haiku,
        "key": key,
        "endpoint": endpoint,
        "key_env": DEEPSEEK_ENV_KEY if provider == "deepseek" else "",
    }


def require_chat_api_key(config: dict) -> str:
    key = _valid_secret(config.get("key", ""))
    if not key:
        env_name = config.get("key_env") or "the configured secret environment variable"
        raise RuntimeError(f"Missing or invalid API key; set {env_name} before starting.")
    return key


def _valid_secret(value: object) -> str:
    text = str(value or "").strip()
    lowered = text.lower()
    if not text or any(marker in lowered for marker in _PLACEHOLDER_MARKERS):
        return ""
    return text


def _contains_secret_material(value: object, field: str = "") -> bool:
    if isinstance(value, dict):
        if field.lower() in {"chat_keys", "extract_keys"}:
            return any(bool(str(item or "").strip()) for item in value.values())
        return any(_contains_secret_material(item, str(key)) for key, item in value.items())
    if isinstance(value, list):
        return any(_contains_secret_material(item, field) for item in value)
    secret_field = field.lower() in {"api_key", "api_token", "ds_api_key", "glm_api_key", "access_token", "auth_token", "password", "secret", "telegram_bot_token"}
    return secret_field and bool(str(value or "").strip())


def extract_config(keys: dict) -> dict:
    """提取管道优先读新字段 extract_*,回退到旧字段 MEM_PROVIDER/GLM_*/DS_*(不打断已有跑法)。"""
    provider = str(keys.get("extract_provider") or keys.get("MEM_PROVIDER") or "").lower()
    if not provider:
        provider = "glm" if (keys.get("GLM_API_KEY") or keys.get("extract_keys", {}).get("glm")) else "deepseek"
    key_new = (keys.get("extract_keys") or {}).get(provider, "")
    ep_new = (keys.get("extract_endpoints") or {}).get(provider, "")
    model = keys.get("extract_model") or ""
    if provider == "glm":
        return {
            "provider": "glm",
            "model": model or keys.get("GLM_MODEL") or "glm-5.2",
            "key": key_new or keys.get("GLM_API_KEY") or "",
            "endpoint": (ep_new or keys.get("GLM_BASE_URL") or "https://open.bigmodel.cn/api/paas/v4").rstrip("/"),
        }
    return {
        "provider": "deepseek",
        "model": model or keys.get("DS_MODEL") or "deepseek-chat",
        "key": key_new or keys.get("DS_API_KEY") or "",
        "endpoint": (ep_new or keys.get("DS_BASE_URL") or "https://api.deepseek.com").rstrip("/"),
    }


def telegram_config(keys: dict) -> dict:
    return {
        "bot_token": keys.get("telegram_bot_token") or "",
        "allowed_user_ids": keys.get("telegram_allowed_user_ids") or "",
        "https_proxy": keys.get("https_proxy") or "",
    }


if __name__ == "__main__":
    import sys
    k = load_keys()
    print(json.dumps({
        "chat": chat_config(k),
        "extract": extract_config(k),
        "telegram": telegram_config(k),
    }, ensure_ascii=False, indent=2))
