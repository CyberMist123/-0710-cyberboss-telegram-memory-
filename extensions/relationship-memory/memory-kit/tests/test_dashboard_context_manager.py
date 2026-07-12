#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
TEMP = Path(tempfile.mkdtemp(prefix="dashboard-context-"))
STATE = TEMP / "state"
MEMORY = TEMP / "memory"
CONTINUITY = TEMP / "continuity"
WORKSPACE = TEMP / "workspace"
TODO = WORKSPACE / "settings" / "CODING_TODO.md"
for path in (STATE, MEMORY, CONTINUITY, TODO.parent):
    path.mkdir(parents=True, exist_ok=True)
TODO.write_text("# TODO\n\n- [ ] first\n", encoding="utf-8")

os.environ["CYBERBOSS_DASHBOARD_KEYS_FILE"] = str(TEMP / "keys.local.json")
os.environ["CYBERBOSS_STATE_DIR"] = str(STATE)
os.environ["CYBERBOSS_MEMORY_DIR"] = str(MEMORY)
os.environ["CYBERBOSS_CONTINUITY_DIR"] = str(CONTINUITY)
os.environ["CYBERBOSS_WORKSPACE_ROOT"] = str(WORKSPACE)
os.environ["CYBERBOSS_TODO_FILE"] = str(TODO)

sys.path.insert(0, str(KIT))
spec = importlib.util.spec_from_file_location("dashboard_context", KIT / "dashboard.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)


def request(port, endpoint, method="GET", body=None, token=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Api-Token"] = token
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{endpoint}",
        data=data,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def test_normalization_and_snapshots():
    layout = dashboard.load_context_layout()
    assert layout["groups"][0]["id"] == "base"
    assert layout["groups"][-1]["id"] == "current"
    assert layout["groups"][0]["enabled"] is True
    assert layout["groups"][-1]["enabled"] is True

    mutated = json.loads(json.dumps(layout))
    middle = mutated["groups"][1:-1]
    mutated["groups"] = [mutated["groups"][0], *reversed(middle), mutated["groups"][-1]]
    mutated["groups"][1]["modules"].append({"id": "custom", "name": "Custom Module", "enabled": False})
    saved = dashboard.save_context_layout(mutated, "test")
    assert saved["layout"]["groups"][0]["id"] == "base"
    assert saved["layout"]["groups"][-1]["id"] == "current"
    assert saved["last_saved_by"] == "test"

    snap = dashboard.archive_context_snapshot("slot1")
    assert Path(snap["path"]).is_file()
    dashboard.save_context_layout(dashboard.DEFAULT_CONTEXT_LAYOUT, "reset")
    restored = dashboard.restore_context_snapshot("slot1", "restore-test")
    assert any(
        module["id"] == "custom"
        for group in restored["layout"]["groups"]
        for module in group["modules"]
    )


def test_todo_backup_and_atomic_save():
    before = TODO.read_text(encoding="utf-8")
    payload = dashboard.save_todo_content(before + "- [x] second\n", "test")
    assert payload["last_saved_by"] == "test"
    assert TODO.read_text(encoding="utf-8").endswith("- [x] second\n")
    backups = list(dashboard.TODO_BACKUP_DIR.glob("*.md"))
    assert backups and backups[-1].read_text(encoding="utf-8") == before
    assert not list(TODO.parent.glob("*.tmp"))


def test_http_and_ui_contract():
    server = HTTPServer(("127.0.0.1", 0), dashboard.H)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        code, overview = request(server.server_port, "/api/context-overview")
        assert code == 200
        assert overview["paths"]["todo"] == str(TODO)

        code, context = request(server.server_port, "/api/context-layout")
        assert code == 200
        assert context["layout"]["groups"][0]["id"] == "base"

        code, payload = request(
            server.server_port,
            "/api/context-layout/snapshot",
            "POST",
            {"slot": "slot2"},
        )
        assert code == 401

        code, payload = request(
            server.server_port,
            "/api/context-layout/snapshot",
            "POST",
            {"slot": "slot2"},
            dashboard.API_TOKEN,
        )
        assert code == 200 and payload["ok"]

        code, payload = request(
            server.server_port,
            "/api/todo/save",
            "POST",
            {"content": "# updated\n", "source": "http-test"},
            dashboard.API_TOKEN,
        )
        assert code == 200 and payload["todo"]["last_saved_by"] == "http-test"

        assert 'data-view="context"' in dashboard.PAGE
        assert 'data-view="files"' in dashboard.PAGE
        assert 'id="ctx-board"' in dashboard.PAGE
        assert "context-layout/snapshot" in dashboard.PAGE
        assert "真实注入开关" in dashboard.PAGE
        assert "Current Context" in dashboard.PAGE
        assert "OLD_CONTINUITY_HTML" not in dashboard.PAGE
    finally:
        server.shutdown()
        server.server_close()


def main():
    test_normalization_and_snapshots()
    test_todo_backup_and_atomic_save()
    test_http_and_ui_contract()
    print("520 context manager: fixed layers, persistent layout, snapshots, TODO backup, API and UI -> ok")


if __name__ == "__main__":
    main()
