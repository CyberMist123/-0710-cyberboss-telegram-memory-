#!/usr/bin/env python3
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


KIT = Path(__file__).resolve().parent.parent
TEMP = Path(tempfile.mkdtemp(prefix="dashboard-continuity-blackbox-"))
PROTECTED = TEMP / "protected"
CONTINUITY = PROTECTED / "continuity"
MEMORY = PROTECTED / "memory"
STATE = PROTECTED / "state"
RUNTIME = TEMP / "runtime"


def write_mixed_jsonl(relative, rows):
    path = CONTINUITY / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for index, row in enumerate(rows):
        lines.append(json.dumps(row, ensure_ascii=False))
        if index == 0:
            lines.append('{"broken":')
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def snapshot_tree(root):
    result = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def optional_file_state(path):
    if not path.is_file():
        return {"exists": False, "sha256": None}
    return {
        "exists": True,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def reserve_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(port, endpoint, method="GET", payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{endpoint}",
        data=data,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get("Content-Type", "")


def wait_until_ready(process, port):
    last_error = None
    for _ in range(120):
        if process.poll() is not None:
            stdout, stderr = process.communicate(timeout=3)
            raise AssertionError(
                "520 black-box process exited before readiness\n"
                f"stdout:\n{stdout}\n"
                f"stderr:\n{stderr}"
            )
        try:
            code, _, _ = request(port, "/api/continuity/layers?limit=1")
            if code == 200:
                return
        except Exception as error:
            last_error = error
        time.sleep(0.05)
    raise AssertionError(f"520 did not become ready: {last_error}")


def decode_json(raw):
    return json.loads(raw.decode("utf-8"))


def stop_process(process):
    if process.poll() is not None:
        return process.communicate(timeout=3)
    process.terminate()
    try:
        return process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        return process.communicate(timeout=5)


def prepare_fixture():
    MEMORY.mkdir(parents=True, exist_ok=True)
    STATE.mkdir(parents=True, exist_ok=True)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    (RUNTIME / "keys.local.json").write_text(
        json.dumps({"API_TOKEN": "blackbox-fixture-token"}),
        encoding="utf-8",
    )

    write_mixed_jsonl("trace/context_trace.jsonl", [
        {"trace_entry_id": "trace-1", "blocks": ["reentry"]},
    ])
    write_mixed_jsonl("gaps/gaps.jsonl", [
        {"gap_id": "gap-1", "source_ref": {"file": "day-a.jsonl", "window": "1-2"}},
        {"gap_id": "gap-2", "source_ref": {"file": "day-b.jsonl", "window": "3-4"}},
    ])
    write_mixed_jsonl("evidence/janitor.evidence.jsonl", [
        {
            "evidence_id": "evidence-1",
            "origin": "janitor",
            "author_role": "extractor",
            "semantic_authority": "none",
        },
        {
            "evidence_id": "evidence-2",
            "origin": "janitor",
            "author_role": "extractor",
            "semantic_authority": "none",
        },
    ])
    write_mixed_jsonl("candidates/episodes.candidates.jsonl", [
        {
            "candidate_id": "subject-1",
            "type": "episode",
            "author_role": "subject_ai",
            "semantic_authority": "high",
            "needs_subject_review": False,
        },
        {
            "candidate_id": "background-1",
            "type": "episode",
            "origin": "nightly_closeout",
            "author_role": "background_proxy",
            "semantic_authority": "medium",
        },
        {
            "candidate_id": "legacy-janitor-1",
            "type": "episode",
            "author": "janitor",
        },
        {
            "candidate_id": "unknown-legacy-1",
            "type": "episode",
            "author": "mystery",
        },
    ])
    write_mixed_jsonl("decisions/decisions.jsonl", [
        {
            "decision_id": "decision-1",
            "candidate_id": "background-1",
            "result": "deferred",
            "reason": "fixture",
        },
    ])
    write_mixed_jsonl("episodes.jsonl", [
        {
            "ep_id": "episode-1",
            "candidate_id": "subject-1",
            "decision_id": "decision-published",
        },
    ])


def main():
    prepare_fixture()
    before = snapshot_tree(PROTECTED)
    repository_pid = KIT / ".panel.pid"
    repository_pid_before = optional_file_state(repository_pid)
    port = reserve_port()
    env = os.environ.copy()
    env.update({
        "CYBERBOSS_DASHBOARD_HOST": "127.0.0.1",
        "CYBERBOSS_DASHBOARD_PORT": str(port),
        "CYBERBOSS_DASHBOARD_NO_BROWSER": "1",
        "CYBERBOSS_DASHBOARD_PID_FILE": str(RUNTIME / "dashboard.pid"),
        "CYBERBOSS_DASHBOARD_KEYS_FILE": str(RUNTIME / "keys.local.json"),
        "CYBERBOSS_CONTINUITY_DIR": str(CONTINUITY),
        "CYBERBOSS_MEMORY_DIR": str(MEMORY),
        "CYBERBOSS_STATE_DIR": str(STATE),
        "PYTHONUNBUFFERED": "1",
    })
    env.pop("CYBERBOSS_NIGHTLY_MODE", None)

    process = subprocess.Popen(
        [sys.executable, str(KIT / "dashboard_continuity.py")],
        cwd=str(KIT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    stdout = ""
    stderr = ""
    try:
        wait_until_ready(process, port)

        code, raw, content_type = request(port, "/")
        assert code == 200
        assert "text/html" in content_type
        page = raw.decode("utf-8")
        for label in (
            "技术断档",
            "证据材料",
            "主体 AI 候选",
            "后台代理候选",
            "冻结的旧候选",
            "Review 决策",
            "已发布 Canon",
        ):
            assert label in page
        assert '<div class="section-head">Candidates</div>' not in page
        assert "fetch('/api/continuity/layers?limit=30')" in page

        code, raw, _ = request(port, "/api/continuity/layers?limit=30")
        assert code == 200
        payload = decode_json(raw)
        assert payload["kind"] == "continuity_layers"
        assert payload["nightly_mode"] == "evidence"
        assert payload["write_mode"] == "read_only"
        assert Path(payload["continuity_dir"]).resolve() == CONTINUITY.resolve()

        layers = {item["key"]: item for item in payload["layers"]}
        assert layers["gaps"]["count"] == 2
        assert layers["evidence"]["count"] == 2
        assert [row["candidate_id"] for row in layers["subject_candidates"]["rows"]] == ["subject-1"]
        assert [row["candidate_id"] for row in layers["background_candidates"]["rows"]] == ["background-1"]
        assert {row["candidate_id"] for row in layers["blocked_candidates"]["rows"]} == {
            "legacy-janitor-1",
            "unknown-legacy-1",
        }
        assert layers["decisions"]["rows"][0]["result"] == "deferred"
        assert layers["canon"]["rows"][0]["ep_id"] == "episode-1"

        code, raw, _ = request(port, "/api/continuity/layers?limit=1")
        assert code == 200
        limited = {item["key"]: item for item in decode_json(raw)["layers"]}
        assert limited["gaps"]["count"] == 2
        assert len(limited["gaps"]["rows"]) == 1
        assert limited["blocked_candidates"]["count"] == 2
        assert len(limited["blocked_candidates"]["rows"]) == 1

        code, raw, _ = request(port, "/api/continuity/candidates?limit=200")
        assert code == 200
        legacy_candidates = decode_json(raw)
        assert legacy_candidates["kind"] == "candidates"
        assert len(legacy_candidates["rows"]) == 4

        code, raw, _ = request(port, "/api/save", method="POST", payload={})
        assert code == 403
        assert decode_json(raw)["error"] == "write_frozen"

        assert process.poll() is None, "520 process must remain alive after malformed JSON and frozen writes"
    finally:
        stdout, stderr = stop_process(process)

    after = snapshot_tree(PROTECTED)
    assert after == before, "external 520 smoke must leave the protected fixture tree byte-identical"
    assert optional_file_state(repository_pid) == repository_pid_before, (
        "black-box test must not create, delete, or rewrite the repository PID file"
    )

    print("520 black-box: external process, real HTTP, malformed JSON, legacy quarantine, frozen writes, full-tree hash -> ok")
    if stderr.strip():
        print("520 black-box stderr:", stderr.strip())


if __name__ == "__main__":
    main()
