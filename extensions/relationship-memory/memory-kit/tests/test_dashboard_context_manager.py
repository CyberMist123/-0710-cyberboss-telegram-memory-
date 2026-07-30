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
PROMPT = WORKSPACE / "templates" / "weixin-instructions.md"
for path in (STATE, MEMORY, CONTINUITY, TODO.parent, PROMPT.parent):
    path.mkdir(parents=True, exist_ok=True)
TODO.write_text("# TODO\n\n- [ ] first\n", encoding="utf-8")
PROMPT.write_text("# System / Persona\n\nStay present.\n", encoding="utf-8")

os.environ["CYBERBOSS_DASHBOARD_KEYS_FILE"] = str(TEMP / "keys.local.json")
os.environ["CYBERBOSS_STATE_DIR"] = str(STATE)
os.environ["CYBERBOSS_MEMORY_DIR"] = str(MEMORY)
os.environ["CYBERBOSS_CONTINUITY_DIR"] = str(CONTINUITY)
os.environ["CYBERBOSS_WORKSPACE_ROOT"] = str(WORKSPACE)
os.environ["CYBERBOSS_PROJECT_ROOT"] = str(WORKSPACE)
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

        code, sources = request(server.server_port, "/api/context-sources")
        assert code == 200
        assert [item["key"] for item in sources["sources"]] == ["prompt", "reentry", "current_state", "memory_context"]

        code, payload = request(
            server.server_port,
            "/api/context-source/save",
            "POST",
            {"key": "reentry", "content": "她刚刚说过，下一次先接住这条线。"},
        )
        assert code == 401

        code, payload = request(
            server.server_port,
            "/api/context-source/save",
            "POST",
            {"key": "reentry", "content": "她刚刚说过，下一次先接住这条线。", "source": "http-test"},
            dashboard.API_TOKEN,
        )
        assert code == 200 and payload["ok"]
        assert (MEMORY / "reentry.md").read_text(encoding="utf-8") == "她刚刚说过，下一次先接住这条线。"
        backups = list((STATE / "context-source-backups" / "reentry").glob("*.txt"))
        assert backups and backups[-1].read_text(encoding="utf-8") == ""
        audit_rows = [json.loads(line) for line in (STATE / "prompt-change-log.jsonl").read_text(encoding="utf-8").splitlines()]
        assert audit_rows[-1]["event"] == "context_source_saved"
        assert audit_rows[-1]["context_key"] == "reentry"

        code, payload = request(
            server.server_port,
            "/api/context-source/save",
            "POST",
            {
                "key": "reentry",
                "content": "不应覆盖已有内容。",
                "expected_sha256": dashboard.sha256_text(""),
                "source": "http-test-conflict",
            },
            dashboard.API_TOKEN,
        )
        assert code == 409 and payload["error"] == "context_source_conflict"
        assert (MEMORY / "reentry.md").read_text(encoding="utf-8") == "她刚刚说过，下一次先接住这条线。"

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
        assert 'data-view="injection"' not in dashboard.PAGE
        assert 'data-view="timeline">Timeline' in dashboard.PAGE
        assert 'id="context-sources"' in dashboard.PAGE
        assert "真实注入开关" in dashboard.PAGE
        assert "Current Context" in dashboard.PAGE
        assert "OLD_CONTINUITY_HTML" not in dashboard.PAGE
    finally:
        server.shutdown()
        server.server_close()


def test_early_return_drains_request_body():
    """提前返回的错误响应必须先把请求体读掉。

    否则关连接时 Windows 对接收缓冲里的未读数据回 RST，客户端拿到的是
    `ConnectionAbortedError / ConnectionResetError [WinError 10053/10054]`
    而**不是**那个状态码 —— 面板显示「连接被中止」，不是「token 校验失败」。

    用 200KB 请求体让这个回归**确定性**复现：小请求体塞得进 socket 缓冲，
    修复前也能碰巧通过（这正是本文件此前在 CI 上间歇把 main 弄红的原因 ——
    `test_http_and_ui_contract` 的第一个 POST 就是预期 401 的未授权请求）；
    200KB 在修复前实测三次三中失败。

    连接被中止时 `request()` 不会返回状态码，而是抛出 OSError 子类，
    测试直接以那个 traceback 失败 —— 与 CI 上看到的失败形状一致。
    """
    server = HTTPServer(("127.0.0.1", 0), dashboard.H)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        big = "x" * 200_000

        # 401 路径：14 个 _check_token() 提前返回点的代表
        code, _ = request(
            server.server_port, "/api/context-source/save", "POST",
            {"key": "reentry", "content": big},
        )
        assert code == 401, f"未授权 + 大请求体应干净返回 401，实际 {code}"

        # 403 路径：7 个冻结写端点，同样的提前返回形状
        frozen = sorted(dashboard.FROZEN_WRITE_ENDPOINTS)
        assert frozen, "FROZEN_WRITE_ENDPOINTS 不应为空"
        code, _ = request(
            server.server_port, frozen[0], "POST",
            {"payload": big}, dashboard.API_TOKEN,
        )
        assert code == 403, f"冻结端点 + 大请求体应干净返回 403，实际 {code}"

        # 排空不许把正常写路径搞坏：请求体只被读一次，仍然读得到内容
        code, payload = request(
            server.server_port, "/api/todo/save", "POST",
            {"content": "# drained\n", "source": "drain-test"}, dashboard.API_TOKEN,
        )
        assert code == 200 and payload["todo"]["last_saved_by"] == "drain-test"
        assert TODO.read_text(encoding="utf-8") == "# drained\n"
    finally:
        server.shutdown()
        server.server_close()


def main():
    test_normalization_and_snapshots()
    test_todo_backup_and_atomic_save()
    test_http_and_ui_contract()
    test_early_return_drains_request_body()
    print("520 context manager: fixed layers, persistent layout, snapshots, TODO backup, API and UI -> ok")


if __name__ == "__main__":
    main()
