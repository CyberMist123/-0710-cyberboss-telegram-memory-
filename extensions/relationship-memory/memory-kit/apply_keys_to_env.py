#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 keys.local.json 的聊天配置刷到 TG 线的 .env,让 claudecode runtime 拿到新 key/模型。

方向:keys.local.json → C:\\Users\\18717\\.cyberboss-deepseek-test\\.env
只改带 [managed by keys.local.json] 标记的行,其余行(用户手工注释、无关字段)保留原样。

面板保存 or /model 指令写完 keys.local.json 后,调用此脚本,再由看门狗/用户重启 TG。
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from config_loader import load_keys, chat_config, telegram_config  # noqa: E402

TG_STATE_DIR = Path(os.environ.get("CYBERBOSS_DEEPSEEK_STATE") or r"C:\Users\18717\.cyberboss-deepseek-test")
ENV_FILE = TG_STATE_DIR / ".env"

MANAGED_TAG = "# [managed by keys.local.json]"

MANAGED_KEYS = (
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CYBERBOSS_CLAUDE_MODEL",
    "CYBERBOSS_CLAUDE_PERMISSION_MODE",
    "CYBERBOSS_TELEGRAM_BOT_TOKEN",
    "CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS",
    "CYBERBOSS_TELEGRAM_PROXY_URL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
)


def build_managed_block(keys: dict) -> "list[str]":
    cc = chat_config(keys)
    tg = telegram_config(keys)
    lines = [f"{MANAGED_TAG} DO NOT edit these by hand; edit memory-kit/keys.local.json"]

    provider = cc["provider"]
    endpoint = cc["endpoint"]
    key = cc["key"]
    model = cc["model"] or ""
    haiku = cc["haiku_model"] or model

    if not key:
        lines.append(f"# WARNING: chat_keys.{provider} is empty in keys.local.json")

    # 只在有值时写这些字段;空值不写,避免把 .env 里手工填好的 chat 配置洗成空。
    if endpoint:
        lines.append(f"ANTHROPIC_BASE_URL={endpoint}")
    if key:
        lines.append(f"ANTHROPIC_AUTH_TOKEN={key}")
        lines.append(f"ANTHROPIC_API_KEY={key}")
    if model:
        lines.append(f"ANTHROPIC_MODEL={model}")
        lines.append(f"ANTHROPIC_DEFAULT_OPUS_MODEL={model}")
        lines.append(f"ANTHROPIC_DEFAULT_SONNET_MODEL={model}")
        lines.append(f"CYBERBOSS_CLAUDE_MODEL={model}")
    if haiku:
        lines.append(f"ANTHROPIC_DEFAULT_HAIKU_MODEL={haiku}")
        lines.append(f"CLAUDE_CODE_SUBAGENT_MODEL={haiku}")
    if tg["bot_token"]:
        lines.append(f"CYBERBOSS_TELEGRAM_BOT_TOKEN={tg['bot_token']}")
    if tg["allowed_user_ids"]:
        lines.append(f"CYBERBOSS_TELEGRAM_ALLOWED_USER_IDS={tg['allowed_user_ids']}")
    if tg["https_proxy"]:
        lines.append(f"HTTPS_PROXY={tg['https_proxy']}")
        lines.append(f"HTTP_PROXY={tg['https_proxy']}")
        # cyberboss 的 telegram poller 用 tunnel-agent,不吃 HTTPS_PROXY,只认这个专用变量
        lines.append(f"CYBERBOSS_TELEGRAM_PROXY_URL={tg['https_proxy']}")
    perm_mode = str(keys.get("claude_permission_mode") or "bypassPermissions").strip()
    if perm_mode:
        lines.append(f"CYBERBOSS_CLAUDE_PERMISSION_MODE={perm_mode}")
    lines.append(f"{MANAGED_TAG} end")
    return lines


def apply() -> None:
    if not ENV_FILE.exists():
        raise SystemExit(f"[apply_keys] {ENV_FILE} 不存在,不敢新建 —— 请先手工建立 .env 基线。")
    keys = load_keys()
    if not keys:
        raise SystemExit("[apply_keys] keys.local.json 读不到,拒绝写。")
    # 安全阀:chat 与 tg 都空时,不动这些字段;但如果 permission_mode 单独填了,允许只同步它。
    cc = chat_config(keys)
    chat_empty = not cc["key"] and not cc["endpoint"] and not keys.get("telegram_bot_token")
    perm_only = bool(str(keys.get("claude_permission_mode") or "").strip())
    if chat_empty and not perm_only:
        raise SystemExit(
            "[apply_keys] keys.local.json 里 chat_provider/chat_keys/telegram_bot_token 全空,"
            "拒绝把 .env 洗成空。先在 520 面板『模型与 Key』页填一次。"
        )
    if chat_empty and perm_only:
        print("[apply_keys] chat 配置全空,只同步 permission_mode,保留 .env 里已有 chat 字段。")

    original = ENV_FILE.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    # 部分模式:只管 CYBERBOSS_CLAUDE_PERMISSION_MODE,别的字段一律保留原样。
    partial_mode = chat_empty and perm_only
    managed_keys_to_strip = (
        {"CYBERBOSS_CLAUDE_PERMISSION_MODE"} if partial_mode else set(MANAGED_KEYS)
    )

    kept, in_block = [], False
    for line in original:
        stripped = line.strip()
        if stripped.startswith(MANAGED_TAG):
            in_block = not in_block
            continue
        if in_block:
            continue
        key_name = stripped.split("=", 1)[0].strip()
        if key_name in managed_keys_to_strip:
            continue
        kept.append(line)

    if partial_mode:
        perm_mode = str(keys.get("claude_permission_mode") or "bypassPermissions").strip()
        managed = [f"CYBERBOSS_CLAUDE_PERMISSION_MODE={perm_mode}"]
    else:
        managed = build_managed_block(keys)
    while kept and not kept[-1].strip():
        kept.pop()
    new_content = "\n".join(kept + [""] + managed) + "\n"

    backup = ENV_FILE.with_suffix(".env.bak")
    backup.write_text(ENV_FILE.read_text(encoding="utf-8-sig", errors="replace"), encoding="utf-8")
    ENV_FILE.write_text(new_content, encoding="utf-8")
    print(f"[apply_keys] wrote {ENV_FILE} (backup: {backup.name})")
    print(f"[apply_keys] chat={chat_config(keys)['provider']}/{chat_config(keys)['model']}")


if __name__ == "__main__":
    apply()
