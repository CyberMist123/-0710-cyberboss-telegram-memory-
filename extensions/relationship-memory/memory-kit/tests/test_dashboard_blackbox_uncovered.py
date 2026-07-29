#!/usr/bin/env python3
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse


SOURCE_KIT = Path(__file__).resolve().parent.parent
SOURCE_FILES = (
    "dashboard.py",
    "dashboard_continuity.py",
    "continuity_layers.py",
    "janitor_config.py",
)
ACTIVE_POSTS = (
    "/api/runtime-prompt/save",
    "/api/runtime-prompt/restore",
    "/api/context-source/save",
    "/api/desire-schedule",
    "/api/context-layout/save",
    "/api/context-layout/snapshot",
    "/api/context-layout/restore",
    "/api/todo/save",
    "/api/context-gates",
    "/api/review/retry",
)
FROZEN_POSTS = (
    "/api/save",
    "/api/state_log",
    "/api/episode_candidate",
    "/api/janitor/run",
    "/api/care/config",
    "/api/care/cycle",
    "/api/config",
)
AUDIT_UNCOVERED_ENDPOINTS = {
    "/api/list",
    "/api/file",
    "/api/health",
    "/api/injection",
    "/api/memory_overview",
    "/api/episodes_index",
    "/api/rereadings_index",
    "/api/context-gates",
    "/api/reentry",
    "/api/timeline",
    "/api/rereadings",
    "/api/episodes",
    "/api/state_log",
    "/api/config",
    "/api/care/config",
    "/api/care/cycle",
    "/api/theater/scripts",
}
EXTRA_CONTRACT_ENDPOINTS = {
    "/api/runtime-prompt",
    "/config",
}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def snapshot_tree(root):
    result = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def reserve_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port, endpoint, method="GET", payload=None, headers=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"Content-Type": "application/json"}
    request_headers.update(headers or {})
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{endpoint}",
        data=data,
        method=method,
        headers=request_headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get("Content-Type", "")


def decode_json(raw):
    return json.loads(raw.decode("utf-8"))


def assert_content_type(content_type, expected):
    assert content_type.lower().startswith(expected), content_type


def stop_process(process):
    if process.poll() is not None:
        return process.communicate(timeout=3)
    process.terminate()
    try:
        return process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        return process.communicate(timeout=5)


def wait_until_ready(process, port):
    last_error = None
    for _ in range(160):
        if process.poll() is not None:
            stdout, stderr = process.communicate(timeout=3)
            raise AssertionError(
                "520 black-box process exited before readiness\n"
                f"stdout:\n{stdout}\n"
                f"stderr:\n{stderr}"
            )
        try:
            code, _, _ = request(port, "/api/list")
            if code == 200:
                return
        except Exception as error:
            last_error = error
        time.sleep(0.05)
    raise AssertionError(f"520 did not become ready: {last_error}")


def prepare_fixture(temp_root):
    protected = temp_root / "protected"
    memory = protected / "memory"
    continuity = protected / "continuity"
    state = protected / "state"
    dashboard_state = protected / "dashboard-state"
    runtime = protected / "runtime"
    project = protected / "project"
    copied_root = temp_root / "copied-extension"
    copied_kit = copied_root / "memory-kit"
    care = copied_root / "care"
    theater = copied_root / "theater"

    for path in (memory, continuity, state, dashboard_state, runtime, project, copied_kit, care, theater):
        path.mkdir(parents=True, exist_ok=True)
    for name in SOURCE_FILES:
        shutil.copy2(SOURCE_KIT / name, copied_kit / name)

    (memory / "reentry.md").write_text("# Re-entry\nfixture reentry\n", encoding="utf-8")
    (memory / "relationship_timeline.md").write_text("# Timeline\nfixture timeline\n", encoding="utf-8")
    (memory / "rereadings.md").write_text(
        "# Rereadings\n2026-01-01 · ep0000 · first rereading\n2026-01-02 · ep1004 · last rereading\n",
        encoding="utf-8",
    )
    for name in ("user_portrait.md", "ai_self_portrait.md", "ai_self_notes.md"):
        (memory / name).write_text(f"# {name}\nfixture\n", encoding="utf-8")
    (memory / "ignored.txt").write_text("must not be listed", encoding="utf-8")
    (memory / "nested").mkdir()
    (memory / "nested" / "hidden.md").write_text("must not be listed", encoding="utf-8")

    episodes = [
        {
            "id": f"ep{index:04d}",
            "time": (datetime(2026, 1, 1) + timedelta(minutes=index)).strftime("%Y-%m-%d %H:%M:%S"),
            "title": f"episode {index}",
            "body": "fixture",
            "importance": (index % 5) + 1,
        }
        for index in range(1005)
    ]
    state_rows = [
        {
            "time": (datetime(2026, 1, 1) + timedelta(minutes=index)).strftime("%Y-%m-%d %H:%M:%S"),
            "value": index,
        }
        for index in range(1005)
    ]
    write_jsonl(memory / "episodes.jsonl", episodes)
    write_jsonl(memory / "state_log.jsonl", state_rows)
    write_jsonl(memory / "episodes.candidates.jsonl", [{"id": "candidate-1", "time": "2026-01-01"}])

    write_json(state / "desire-state.json", {"updated_at": "2026-01-01 00:00:00", "scores": {}})
    (state / "memory").mkdir()
    (state / "memory" / "7-day-memory.md").write_text("fixture short memory", encoding="utf-8")
    (state / "telegram-poller.log").write_text("", encoding="utf-8")

    prompt = project / "templates" / "weixin-instructions.md"
    prompt.parent.mkdir(parents=True)
    prompt.write_text("# Runtime Prompt\nfixture prompt\n", encoding="utf-8")
    for index in range(31):
        (dashboard_state / "prompt-backups").mkdir(parents=True, exist_ok=True)
        (dashboard_state / "prompt-backups" / f"backup-{index:02d}.md").write_text(
            f"backup {index}\n", encoding="utf-8"
        )

    write_json(
        runtime / "keys.local.json",
        {
            "API_TOKEN": "blackbox-fixture-token",
            "chat_provider": "fixture-chat",
            "chat_model": "fixture-model",
            "chat_haiku_model": "fixture-small",
            "chat_keys": {"fixture": "abcdefgh1234"},
            "chat_endpoints": {"fixture": "https://example.invalid"},
            "extract_provider": "fixture-extract",
            "extract_model": "fixture-extract-model",
            "extract_keys": {"fixture": "ijklmnop5678"},
            "extract_endpoints": {"fixture": "https://example.invalid"},
            "telegram_bot_token": "telegram-secret-9012",
            "telegram_allowed_user_ids": "123",
            "https_proxy": "",
        },
    )
    write_json(care / "config.json", {"city": "Sydney", "max_touch_per_day": 2})
    (care / "cycle.md").write_text("# Cycle\nfixture\n", encoding="utf-8")
    (theater / "scripts_index.md").write_text(
        "# Scripts\nfixture intro\n| 链接 | 备注 | 时长 | 人数 | 标签 |\n"
        "|---|---|---|---|---|\n"
        "| https://example.invalid/script | fixture | 5m | 2 | test |\n",
        encoding="utf-8",
    )

    return {
        "protected": protected,
        "memory": memory,
        "continuity": continuity,
        "state": state,
        "dashboard_state": dashboard_state,
        "runtime": runtime,
        "project": project,
        "copied_root": copied_root,
        "kit": copied_kit,
        "care": care,
        "theater": theater,
        "pid": temp_root / "process" / "dashboard.pid",
    }


def assert_object_endpoint(port, endpoint, expected_keys, expected_status=200):
    code, raw, content_type = request(port, endpoint)
    assert code == expected_status, (endpoint, code, raw.decode("utf-8", errors="replace"))
    assert_content_type(content_type, "application/json")
    payload = decode_json(raw)
    assert isinstance(payload, dict), (endpoint, type(payload))
    assert set(payload) == set(expected_keys), (endpoint, set(payload), set(expected_keys))
    return payload


def exercise_uncovered_gets(port):
    seen = set()

    code, raw, content_type = request(port, "/api/list")
    seen.add("/api/list")
    assert code == 200
    assert_content_type(content_type, "application/json")
    listed = decode_json(raw)
    assert isinstance(listed, list)
    assert "reentry.md" in listed and "episodes.jsonl" in listed
    assert "ignored.txt" not in listed and "hidden.md" not in listed

    file_payload = assert_object_endpoint(port, "/api/file?f=reentry.md", {"name", "content"})
    seen.add("/api/file")
    assert file_payload["name"] == "reentry.md"
    assert "fixture reentry" in file_payload["content"]
    bounded_file = assert_object_endpoint(port, "/api/file?f=../reentry.md", {"name", "content"})
    assert bounded_file == file_payload
    missing_file = assert_object_endpoint(port, "/api/file?f=missing.md", {"err"}, expected_status=404)
    assert missing_file == {"err": "no such file"}

    health = assert_object_endpoint(
        port,
        "/api/health",
        {
            "now", "alerts", "reentry_chars", "reentry_budget", "episodes_total",
            "importance_dist", "octant_history_source", "octant_history_path",
            "octant_history_rows", "octant_history_fallback", "last_state_time",
            "hours_since_state", "gaps_7d", "desire_state", "memory_files",
            "runtime_memory", "bridge_status", "janitor_last_run", "backups_count",
            "candidates_n", "auto_janitor",
        },
    )
    seen.add("/api/health")
    assert health["episodes_total"] == 1005

    injection = assert_object_endpoint(
        port,
        "/api/injection",
        {
            "models", "chat_writer", "extract_writer", "runtime_state_dir",
            "runtime_memory_status", "runtime_background_write_enabled",
            "operations_enabled", "project_dir", "memory_block_sync", "runtime_chain",
            "source_files", "runtime_prompt", "sections",
        },
    )
    seen.add("/api/injection")
    assert injection["runtime_prompt"]["exists"] is True

    runtime_prompt = assert_object_endpoint(
        port,
        "/api/runtime-prompt",
        {
            "path", "exists", "updated_at", "chars", "lines", "sha256", "model",
            "runtime", "operations_enabled", "memory_retrieval_enabled",
            "background_write_enabled", "apply_note", "backups", "content",
        },
    )
    seen.add("/api/runtime-prompt")
    assert runtime_prompt["exists"] is True
    assert runtime_prompt["content"] == "# Runtime Prompt\nfixture prompt\n"
    assert len(runtime_prompt["backups"]) == 30

    memory_overview = assert_object_endpoint(
        port,
        "/api/memory_overview",
        {
            "models", "formal_entries", "auto_entries", "runtime_entries",
            "runtime_memory_status", "recent_file_updates", "formal_episode_days",
            "candidate_episode_days", "current", "timeline_meta",
            "formalization_status", "recent_candidates", "recent_formal_episodes",
        },
    )
    seen.add("/api/memory_overview")
    assert len(memory_overview["recent_candidates"]) <= 6
    assert len(memory_overview["recent_formal_episodes"]) <= 6

    episodes_index = assert_object_endpoint(
        port,
        "/api/episodes_index",
        {f"ep{index:04d}" for index in range(1005)},
    )
    seen.add("/api/episodes_index")
    assert episodes_index["ep0000"]["title"] == "episode 0"
    assert episodes_index["ep1004"]["title"] == "episode 1004"

    rereadings_index = assert_object_endpoint(
        port,
        "/api/rereadings_index",
        {"ep0000", "ep1004"},
    )
    seen.add("/api/rereadings_index")
    assert rereadings_index["ep0000"] == ["2026-01-01 · ep0000 · first rereading"]

    gates = assert_object_endpoint(
        port,
        "/api/context-gates",
        {"reentry", "current_state", "memory_context"},
    )
    seen.add("/api/context-gates")
    assert gates == {"reentry": True, "current_state": True, "memory_context": True}

    reentry = assert_object_endpoint(port, "/api/reentry", {"text", "chars"})
    seen.add("/api/reentry")
    assert reentry["chars"] > 0 and "fixture reentry" in reentry["text"]

    timeline = assert_object_endpoint(port, "/api/timeline", {"text"})
    seen.add("/api/timeline")
    assert "fixture timeline" in timeline["text"]

    rereadings = assert_object_endpoint(port, "/api/rereadings", {"text"})
    seen.add("/api/rereadings")
    assert "first rereading" in rereadings["text"]

    for endpoint, default_size in (("/api/episodes", 20), ("/api/state_log", 24)):
        seen.add(urlparse(endpoint).path)
        code, raw, content_type = request(port, endpoint + "?limit=1")
        assert code == 200
        assert_content_type(content_type, "application/json")
        one = decode_json(raw)
        assert isinstance(one, list) and len(one) == 1
        assert one[0]["time"] == "2026-01-01 16:44:00"

        code, raw, content_type = request(port, endpoint + "?limit=999999")
        assert code == 200
        assert_content_type(content_type, "application/json")
        assert len(decode_json(raw)) == 1000

        code, raw, content_type = request(port, endpoint + "?limit=invalid")
        assert code == 200
        assert_content_type(content_type, "application/json")
        assert len(decode_json(raw)) == default_size

        code, raw, content_type = request(port, endpoint + "?limit=0")
        assert code == 200
        assert_content_type(content_type, "application/json")
        assert len(decode_json(raw)) == default_size

    config = assert_object_endpoint(
        port,
        "/api/config",
        {
            "chat_provider", "chat_model", "chat_haiku_model", "chat_keys_masked",
            "chat_endpoints", "extract_provider", "extract_model", "extract_keys_masked",
            "extract_endpoints", "telegram_bot_token_masked", "telegram_allowed_user_ids",
            "https_proxy",
        },
    )
    seen.add("/api/config")
    assert config["chat_keys_masked"]["fixture"] == "…1234"
    assert config["extract_keys_masked"]["fixture"] == "…5678"
    assert config["telegram_bot_token_masked"] == "…9012"
    assert "abcdefgh1234" not in json.dumps(config, ensure_ascii=False)

    code, raw, content_type = request(port, "/config")
    seen.add("/config")
    assert code == 410
    assert_content_type(content_type, "text/plain")
    assert raw.decode("utf-8") == "Configuration writes are retired; the Phase 4 console is read-only."

    care_config = assert_object_endpoint(
        port,
        "/api/care/config",
        {
            "city", "weather_enabled", "cycle_silent_enabled",
            "cycle_light_touch_enabled", "max_touch_per_day", "https_proxy",
        },
    )
    seen.add("/api/care/config")
    assert care_config["city"] == "Sydney" and care_config["max_touch_per_day"] == 2

    # KNOWN_DEFECT: dashboard.py calls undefined read_cycle_text(); current behavior is a JSON 500.
    care_cycle = assert_object_endpoint(port, "/api/care/cycle", {"err"}, expected_status=500)
    seen.add("/api/care/cycle")
    assert care_cycle["err"] == "name 'read_cycle_text' is not defined"

    theater = assert_object_endpoint(port, "/api/theater/scripts", {"exists", "intro", "rows"})
    seen.add("/api/theater/scripts")
    assert theater["exists"] is True
    assert theater["intro"] == ["fixture intro"]
    assert len(theater["rows"]) == 1
    assert theater["rows"][0]["url"] == "https://example.invalid/script"

    expected = AUDIT_UNCOVERED_ENDPOINTS | EXTRA_CONTRACT_ENDPOINTS
    assert seen == expected, (seen, expected - seen, seen - expected)


def exercise_post_guards(port):
    assert len(ACTIVE_POSTS) == 10
    for endpoint in ACTIVE_POSTS:
        code, raw, content_type = request(port, endpoint, method="POST", payload={})
        assert code == 401, (endpoint, code, raw.decode("utf-8", errors="replace"))
        assert_content_type(content_type, "application/json")
        payload = decode_json(raw)
        assert set(payload) == {"ok", "err"}
        assert payload["ok"] is False
        assert payload["err"] == "token 校验失败"

    assert len(FROZEN_POSTS) == 7
    for endpoint in FROZEN_POSTS:
        code, raw, content_type = request(port, endpoint, method="POST", payload={})
        assert code == 403, (endpoint, code, raw.decode("utf-8", errors="replace"))
        assert_content_type(content_type, "application/json")
        assert decode_json(raw) == {
            "ok": False,
            "error": "write_frozen",
            "path": endpoint,
        }


def run_entrypoint(entrypoint, fixture):
    port = reserve_port()
    env = os.environ.copy()
    env.update({
        "CYBERBOSS_DASHBOARD_HOST": "127.0.0.1",
        "CYBERBOSS_DASHBOARD_PORT": str(port),
        "CYBERBOSS_DASHBOARD_NO_BROWSER": "1",
        "CYBERBOSS_DASHBOARD_PID_FILE": str(fixture["pid"]),
        "CYBERBOSS_DASHBOARD_KEYS_FILE": str(fixture["runtime"] / "keys.local.json"),
        "CYBERBOSS_DASHBOARD_STATE_DIR": str(fixture["dashboard_state"]),
        "CYBERBOSS_CONTINUITY_DIR": str(fixture["continuity"]),
        "CYBERBOSS_MEMORY_DIR": str(fixture["memory"]),
        "CYBERBOSS_STATE_DIR": str(fixture["state"]),
        "CYBERBOSS_PROJECT_ROOT": str(fixture["project"]),
        "CYBERBOSS_WORKSPACE_ROOT": str(fixture["project"]),
        "CYBERBOSS_HOME": str(fixture["project"]),
        "PYTHONUNBUFFERED": "1",
    })

    process = subprocess.Popen(
        [sys.executable, str(fixture["kit"] / entrypoint)],
        cwd=str(fixture["kit"]),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout = ""
    stderr = ""
    try:
        wait_until_ready(process, port)
        exercise_uncovered_gets(port)
        exercise_post_guards(port)
        assert process.poll() is None, f"{entrypoint} must survive all probes"
    finally:
        stdout, stderr = stop_process(process)
    if process.returncode not in (0, 1):
        raise AssertionError(
            f"unexpected {entrypoint} return code {process.returncode}\n"
            f"stdout:\n{stdout}\nstderr:\n{stderr}"
        )
    return stderr.strip()


def main():
    assert len(AUDIT_UNCOVERED_ENDPOINTS) == 17
    assert len(EXTRA_CONTRACT_ENDPOINTS) == 2
    temp_root = Path(tempfile.mkdtemp(prefix="dashboard-uncovered-blackbox-"))
    try:
        fixture = prepare_fixture(temp_root)
        protected_before = snapshot_tree(fixture["protected"])
        read_only_before = {
            "care": snapshot_tree(fixture["care"]),
            "theater": snapshot_tree(fixture["theater"]),
        }
        results = {}
        for entrypoint in ("dashboard_continuity.py", "dashboard.py"):
            results[entrypoint] = run_entrypoint(entrypoint, fixture)
            assert snapshot_tree(fixture["protected"]) == protected_before
            assert snapshot_tree(fixture["care"]) == read_only_before["care"]
            assert snapshot_tree(fixture["theater"]) == read_only_before["theater"]

        print(
            "520 uncovered black-box: 17 audited GET contracts + 2 extra contracts + "
            "10 active POST auth + 7 exact frozen writes, production and fallback -> ok"
        )
        for entrypoint, stderr in results.items():
            if stderr:
                print(f"{entrypoint} stderr: {stderr}")
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)


if __name__ == "__main__":
    main()
