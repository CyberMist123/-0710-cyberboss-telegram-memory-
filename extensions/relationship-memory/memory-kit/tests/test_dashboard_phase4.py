#!/usr/bin/env python3
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path


KIT = Path(__file__).resolve().parent.parent
REPO = KIT.parents[2]
TEMP = Path(tempfile.mkdtemp(prefix="dashboard-phase4-"))
CONTINUITY = TEMP / "continuity"
STATE = TEMP / "state"
os.environ["CYBERBOSS_DASHBOARD_KEYS_FILE"] = str(TEMP / "keys.local.json")
os.environ["CYBERBOSS_CONTINUITY_DIR"] = str(CONTINUITY)
os.environ["CYBERBOSS_STATE_DIR"] = str(STATE)
os.environ["CYBERBOSS_HOME"] = str(REPO)
sys.path.insert(0, str(KIT))
spec = importlib.util.spec_from_file_location("dashboard_phase4", KIT / "dashboard.py")
dashboard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dashboard)

ALLOWED_STATES = {"not_implemented", "available", "preview", "on", "failed"}


def write_jsonl(relative, rows):
    path = CONTINUITY / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


def request(port, endpoint, method="GET", body=None, token=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Api-Token"] = token
    last_error = None
    for _ in range(3):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{endpoint}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                raw = response.read().decode("utf-8")
                return response.status, json.loads(raw) if raw.startswith(("{", "[")) else raw
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8")
            return error.code, json.loads(raw) if raw.startswith(("{", "[")) else raw
        except (ConnectionResetError, TimeoutError, OSError) as error:
            last_error = error
            time.sleep(0.05)
    raise last_error


def test_http_contract():
    STATE.mkdir(parents=True, exist_ok=True)
    (STATE / "desire-state.json").write_text(json.dumps({
        "updatedAt": "2026-07-12T01:00:00+08:00",
        "drive": {
            "attachment": 0.81, "curiosity": 0.62, "reflection": 0.44, "duty": 0.73,
            "social": 0.31, "fatigue": 0.28, "libido": 0.19, "stress": 0.37,
        },
        "intent": {"want_action": "co_read"},
    }), encoding="utf-8")
    write_jsonl("../state/desire-history.jsonl", [{
        "time": "2026-07-12T01:00:00+08:00",
        "attachment": 0.81, "curiosity": 0.62, "reflection": 0.44, "duty": 0.73,
        "social": 0.31, "fatigue": 0.28, "libido": 0.19, "stress": 0.37,
    }])
    write_jsonl("trace/context_trace.jsonl", [{"trace_entry_id": "t1"}, {"trace_entry_id": "t2"}])
    write_jsonl("candidates/episodes.candidates.jsonl", [{"candidate_id": "c1"}])
    write_jsonl("decisions/decisions.jsonl", [{"candidate_id": "c1", "action": "deferred"}])
    server = HTTPServer(("127.0.0.1", 0), dashboard.H)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        code, modules = request(server.server_port, "/api/module-state")
        assert code == 200
        assert modules["write_mode"] == "controlled_context_write"
        assert "reentry" in modules["capabilities"]["controlled_context_write"]
        assert "canon" in modules["capabilities"]["frozen"]
        assert modules["modules"] and set(modules["modules"].values()) <= ALLOWED_STATES
        assert modules["modules"]["memory_lookup"] in ("available", "on")
        assert modules["modules"]["soft_retrieval"] == "not_implemented"

        code, schedule = request(server.server_port, "/api/desire-schedule")
        assert code == 200 and schedule["interval_minutes"] == 55
        code, _ = request(server.server_port, "/api/desire-schedule", "POST", {"timezone": "Australia/Sydney"})
        assert code == 401
        code, saved_schedule = request(
            server.server_port,
            "/api/desire-schedule",
            "POST",
            {
                "enabled": True,
                "interval_minutes": 55,
                "night_skip_enabled": True,
                "night_start": "23:00",
                "night_end": "06:00",
                "timezone": "Australia/Sydney",
                "expected_revision": schedule["revision"],
            },
            dashboard.API_TOKEN,
        )
        assert code == 200 and saved_schedule["schedule"]["interval_minutes"] == 55
        code, _ = request(
            server.server_port, "/api/desire-schedule", "POST",
            {"timezone": "Asia/Tokyo", "expected_revision": schedule["revision"]}, dashboard.API_TOKEN,
        )
        assert code == 409

        code, octant = request(server.server_port, "/api/state_rows?n=20")
        assert code == 200
        assert octant["history_source"] == "desire_history"
        assert octant["history_fallback"] is False
        assert octant["realtime"]["dimension_count"] == 8
        assert octant["realtime"]["missing_dimensions"] == []
        assert octant["realtime"]["dimensions"]["依恋"] == 0.81

        for endpoint, expected_kind in (
            ("/api/context-trace?limit=1", "trace"),
            ("/api/continuity/candidates", "candidates"),
            ("/api/continuity/decisions", "decisions"),
        ):
            code, payload = request(server.server_port, endpoint)
            assert code == 200 and payload["kind"] == expected_kind
            assert len(payload["rows"]) == 1

        for endpoint in dashboard.FROZEN_WRITE_ENDPOINTS:
            code, payload = request(server.server_port, endpoint, "POST", {})
            assert code == 403 and payload["error"] == "write_frozen"

        code, _ = request(server.server_port, "/config")
        assert code == 410

        calls = []
        original_retry = dashboard.run_review_retry
        dashboard.run_review_retry = lambda candidate_id: (calls.append(candidate_id) or ({"ok": True}, 200))
        try:
            code, _ = request(server.server_port, "/api/review/retry", "POST", {"candidate_id": "c1"})
            assert code == 401
            code, payload = request(
                server.server_port, "/api/review/retry", "POST", {"candidate_id": "c1"}, dashboard.API_TOKEN
            )
            assert code == 200 and payload["ok"] and calls == ["c1"]
        finally:
            dashboard.run_review_retry = original_retry
    finally:
        server.shutdown()
        server.server_close()


def test_ui_and_process_isolation():
    assert 'data-view="continuity"' in dashboard.PAGE
    assert 'id="octant-source"' in dashboard.PAGE
    assert "renderOctantSource" in dashboard.PAGE
    assert "run-janitor-btn" not in dashboard.PAGE
    assert "method: 'POST',\n      headers: { 'Content-Type': 'application/json', 'X-Api-Token': getApiToken()" not in dashboard.PAGE
    watchdog = (REPO / "extensions" / "relationship-memory" / "launcher" / "watchdog.py").read_text(encoding="utf-8")
    assert "dashboard" not in watchdog.lower()

    sentinel = subprocess.Popen(["node", "-e", "setInterval(() => {}, 1000)"])
    dashboard_fixture = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        dashboard_fixture.terminate()
        dashboard_fixture.wait(timeout=5)
        assert sentinel.poll() is None, "stopping an isolated dashboard fixture must not stop the TG sentinel"
    finally:
        if dashboard_fixture.poll() is None:
            dashboard_fixture.kill()
        sentinel.terminate()
        sentinel.wait(timeout=5)


def main():
    test_http_contract()
    test_ui_and_process_isolation()
    print("phase4 dashboard: module/read APIs, frozen writes, controlled retry, UI and process isolation -> ok")


if __name__ == "__main__":
    main()
