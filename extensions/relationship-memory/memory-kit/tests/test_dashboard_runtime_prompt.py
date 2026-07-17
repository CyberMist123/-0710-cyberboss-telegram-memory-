#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path


KIT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT))
TEMP = Path(tempfile.mkdtemp(prefix="dashboard-runtime-prompt-"))
MEMORY = TEMP / "memory"
STATE = TEMP / "state"
PROJECT = TEMP / "project"
DASHBOARD_STATE = TEMP / "dashboard-state"
PROMPT = PROJECT / "templates" / "weixin-instructions.md"

for path in (MEMORY, STATE, PROMPT.parent, DASHBOARD_STATE):
    path.mkdir(parents=True, exist_ok=True)
PROMPT.write_text("# 测试人格\n\n旧版本。\n", encoding="utf-8")

os.environ.update({
    "CYBERBOSS_MEMORY_DIR": str(MEMORY),
    "CYBERBOSS_CONTINUITY_DIR": str(MEMORY),
    "CYBERBOSS_STATE_DIR": str(STATE),
    "CYBERBOSS_PROJECT_ROOT": str(PROJECT),
    "CYBERBOSS_DASHBOARD_STATE_DIR": str(DASHBOARD_STATE),
    "CYBERBOSS_DASHBOARD_KEYS_FILE": str(TEMP / "keys.local.json"),
    "CYBERBOSS_PROMPT_FILE": str(PROMPT),
    "CYBERBOSS_CLAUDE_MODEL": "test-model",
    "CYBERBOSS_RUNTIME": "test-runtime",
    "CYBERBOSS_INCLUDE_OPERATIONS_PROMPT": "0",
    "CYBERBOSS_MEMORY_RETRIEVAL": "0",
    "CYBERBOSS_MEMORY_BACKGROUND_WRITE": "0",
})

spec = importlib.util.spec_from_file_location("dashboard_runtime_prompt", KIT / "dashboard.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


def main():
    prompt = dashboard.get_runtime_prompt_payload()
    assert Path(prompt["path"]).resolve() == PROMPT.resolve()
    assert prompt["model"] == "test-model"
    assert prompt["runtime"] == "test-runtime"
    assert prompt["operations_enabled"] is False
    assert prompt["content"].startswith("# 测试人格")

    injection = dashboard.compute_injection_overview()
    runtime_entry = next(item for item in injection["runtime_chain"] if item["key"] == "runtime_instructions")
    operations_entry = next(item for item in injection["runtime_chain"] if item["key"] == "operations_template")
    assert Path(runtime_entry["path"]).resolve() == PROMPT.resolve()
    assert runtime_entry["active"] is True
    assert operations_entry["active"] is False
    assert injection["sections"]["operations_excerpt"] == ""

    updated = dashboard.save_runtime_prompt(
        "# 测试人格\n\n新版本。\n",
        expected_sha256=prompt["sha256"],
        source="test",
    )
    assert PROMPT.read_text(encoding="utf-8") == "# 测试人格\n\n新版本。\n"
    assert len(updated["backups"]) == 1
    backup_name = updated["backups"][0]["name"]

    restored = dashboard.restore_runtime_prompt(
        backup_name,
        expected_sha256=updated["sha256"],
        source="test",
    )
    assert PROMPT.read_text(encoding="utf-8") == "# 测试人格\n\n旧版本。\n"
    assert len(restored["backups"]) == 2

    try:
        dashboard.save_runtime_prompt("冲突", expected_sha256="wrong")
        raise AssertionError("stale prompt writes must fail")
    except RuntimeError:
        pass

    original = "同一晚她想起"
    corrupted = original.encode("utf-8").decode("gb18030")
    assert dashboard.repair_mojibake_text(corrupted) == original
    assert dashboard.repair_mojibake_text(original) == original

    audit_rows = [json.loads(line) for line in dashboard.PROMPT_AUDIT_FILE.read_text(encoding="utf-8").splitlines()]
    assert [row["event"] for row in audit_rows] == ["prompt_saved", "prompt_saved"]
    assert "runtime-prompt-editor" in dashboard.PAGE
    assert "/api/runtime-prompt/save" in dashboard.PAGE
    assert "describeContinuityEvent" in dashboard.PAGE
    assert "查看原始记录" in dashboard.PAGE
    print("520 runtime prompt: actual source, flags, safe save/restore, conflict guard and readable events -> ok")


if __name__ == "__main__":
    main()
