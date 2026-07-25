#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
REPO = KIT.parents[2]
sys.path.insert(0, str(KIT))

os.environ.setdefault("CYBERBOSS_STATE_DIR", tempfile.mkdtemp(prefix="cyberboss-secret-test-"))
import apply_keys_to_env  # noqa: E402
import config_loader  # noqa: E402


def _walk_values(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key, item
            yield from _walk_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_values(item)


def test_example_files_have_shape_only():
    env_example = (REPO / ".env.example").read_text(encoding="utf-8-sig")
    assert "DEEPSEEK_API_KEY=" in env_example
    assert "DEEPSEEK_API_KEY=sk-" not in env_example
    profile = json.loads((REPO / "settings/secrets/model-profiles.example.json").read_text(encoding="utf-8-sig"))
    assert profile["profiles"]["deepseek"]["api_key_env"] == "DEEPSEEK_API_KEY"
    assert all(key != "api_key" for key, _ in _walk_values(profile))


def test_chat_config_prefers_process_env_for_deepseek():
    original = os.environ.get("DEEPSEEK_API_KEY")
    try:
        os.environ["DEEPSEEK_API_KEY"] = "opaque-runtime-value"
        cfg = config_loader.chat_config({"chat_provider": "deepseek", "chat_keys": {"deepseek": "file-value"}})
        assert cfg["key"] == "opaque-runtime-value"
        assert cfg["key_env"] == "DEEPSEEK_API_KEY"
    finally:
        if original is None:
            os.environ.pop("DEEPSEEK_API_KEY", None)
        else:
            os.environ["DEEPSEEK_API_KEY"] = original


def test_missing_or_placeholder_key_fails_closed_without_leakage():
    original = os.environ.get("DEEPSEEK_API_KEY")
    try:
        for value in (None, "<DEEPSEEK_API_KEY>"):
            if value is None:
                os.environ.pop("DEEPSEEK_API_KEY", None)
            else:
                os.environ["DEEPSEEK_API_KEY"] = value
            cfg = config_loader.chat_config({"chat_provider": "deepseek"})
            try:
                config_loader.require_chat_api_key(cfg)
            except RuntimeError as exc:
                message = str(exc)
                assert "DEEPSEEK_API_KEY" in message
                assert value is None or value not in message
            else:
                raise AssertionError("invalid key was accepted")
    finally:
        if original is None:
            os.environ.pop("DEEPSEEK_API_KEY", None)
        else:
            os.environ["DEEPSEEK_API_KEY"] = original


def test_apply_never_writes_or_logs_secret_values():
    original = os.environ.get("DEEPSEEK_API_KEY")
    try:
        os.environ["DEEPSEEK_API_KEY"] = "opaque-runtime-value"
        lines = apply_keys_to_env.build_managed_block({
            "chat_provider": "deepseek",
            "chat_model": "deepseek-v4-pro",
            "chat_keys": {"deepseek": "file-secret-must-not-win"},
            "telegram_bot_token": "telegram-secret-must-not-write",
        })
        output = "\n".join(lines)
        assert "opaque-runtime-value" not in output
        assert "file-secret-must-not-win" not in output
        assert "telegram-secret-must-not-write" not in output
        assert "ANTHROPIC_API_KEY=" not in output
        assert "ANTHROPIC_AUTH_TOKEN=" not in output
    finally:
        if original is None:
            os.environ.pop("DEEPSEEK_API_KEY", None)
        else:
            os.environ["DEEPSEEK_API_KEY"] = original


def test_save_rejects_secret_material_without_echoing_it():
    candidate = "opaque-file-secret"
    try:
        config_loader.save_keys({"chat_keys": {"deepseek": candidate}})
    except ValueError as exc:
        assert candidate not in str(exc)
    else:
        raise AssertionError("secret material was accepted for persistence")


def test_gitignore_covers_private_secret_files():
    for path in (".env", ".env.local", "settings/secrets/model-profiles.json", "extensions/relationship-memory/memory-kit/keys.local.json"):
        result = subprocess.run(["git", "check-ignore", "--no-index", path], cwd=REPO, capture_output=True, text=True)
        assert result.returncode == 0, path


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("deepseek env key handling -> ok")
