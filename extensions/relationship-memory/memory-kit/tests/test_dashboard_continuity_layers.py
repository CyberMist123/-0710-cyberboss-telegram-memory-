#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
import threading
import urllib.request
from http.server import HTTPServer
from pathlib import Path


KIT = Path(__file__).resolve().parent.parent
TEMP = Path(tempfile.mkdtemp(prefix="dashboard-continuity-layers-"))
CONTINUITY = TEMP / "continuity"
MEMORY = TEMP / "memory"
STATE = TEMP / "state"
MEMORY.mkdir(parents=True, exist_ok=True)
STATE.mkdir(parents=True, exist_ok=True)

os.environ["CYBERBOSS_DASHBOARD_KEYS_FILE"] = str(TEMP / "keys.local.json")
os.environ["CYBERBOSS_CONTINUITY_DIR"] = str(CONTINUITY)
os.environ["CYBERBOSS_MEMORY_DIR"] = str(MEMORY)
os.environ["CYBERBOSS_STATE_DIR"] = str(STATE)
os.environ["CYBERBOSS_NIGHTLY_MODE"] = "shadow"
sys.path.insert(0, str(KIT))


def write_jsonl(relative, rows):
    path = CONTINUITY / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    return path


def read_payload(port, endpoint):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{endpoint}", timeout=3) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def snapshot(paths):
    return {str(path): path.read_bytes() for path in paths}


def test_layered_continuity_view():
    paths = [
        write_jsonl("gaps/gaps.jsonl", [{"gap_id": "gap-1", "source_ref": {"file": "a", "window": "1-2"}}]),
        write_jsonl("evidence/janitor.evidence.jsonl", [{
            "evidence_id": "ev-1", "origin": "janitor", "author_role": "extractor", "semantic_authority": "none"
        }]),
        write_jsonl("candidates/episodes.candidates.jsonl", [
            {
                "candidate_id": "subject-1", "type": "episode", "author_role": "subject_ai",
                "semantic_authority": "high", "needs_subject_review": False,
            },
            {
                "candidate_id": "background-1", "type": "episode", "origin": "nightly_closeout",
                "author_role": "background_proxy", "semantic_authority": "medium",
            },
            {
                "candidate_id": "legacy-janitor-1", "type": "episode", "author": "janitor",
            },
        ]),
        write_jsonl("decisions/decisions.jsonl", [{
            "decision_id": "decision-1", "candidate_id": "background-1", "result": "deferred"
        }]),
        write_jsonl("episodes.jsonl", [{
            "ep_id": "ep-1", "candidate_id": "subject-1", "decision_id": "decision-published"
        }]),
    ]
    before = snapshot(paths)

    spec = importlib.util.spec_from_file_location("dashboard_continuity_test", KIT / "dashboard_continuity.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    assert 'id="continuity-feed"' in module.legacy.PAGE
    assert "上下文载入" in module.legacy.PAGE
    assert "记忆处理" in module.legacy.PAGE
    assert "断档与异常" in module.legacy.PAGE
    assert "filterContinuityFeed" in module.legacy.PAGE
    assert "fetch('/api/continuity/layers?limit=30')" in module.legacy.PAGE
    assert "row.result || row.action" in module.legacy.PAGE
    assert "continuity: loadContinuity" in module.legacy.PAGE

    server = HTTPServer(("127.0.0.1", 0), module.H)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        code, payload = read_payload(server.server_port, "/api/continuity/layers?limit=1")
        assert code == 200
        assert payload["kind"] == "continuity_layers"
        assert payload["nightly_mode"] == "shadow"
        assert payload["write_mode"] == "read_only"

        layers = {item["key"]: item for item in payload["layers"]}
        assert layers["gaps"]["label"] == "技术断档"
        assert layers["gaps"]["count"] == 1
        assert layers["evidence"]["count"] == 1
        assert [row["candidate_id"] for row in layers["subject_candidates"]["rows"]] == ["subject-1"]
        assert [row["candidate_id"] for row in layers["background_candidates"]["rows"]] == ["background-1"]
        assert [row["candidate_id"] for row in layers["blocked_candidates"]["rows"]] == ["legacy-janitor-1"]
        assert layers["decisions"]["rows"][0]["result"] == "deferred"
        assert layers["canon"]["rows"][0]["ep_id"] == "ep-1"

        # The old bounded endpoints remain available for compatibility.
        code, old_candidates = read_payload(server.server_port, "/api/continuity/candidates?limit=1")
        assert code == 200
        assert old_candidates["kind"] == "candidates"
        assert len(old_candidates["rows"]) == 1
    finally:
        server.shutdown()
        server.server_close()

    assert snapshot(paths) == before, "520 layered reads must not mutate continuity files"


def main():
    test_layered_continuity_view()
    print("520 continuity layers: Chinese separation, bounded API, retry field compatibility, read-only -> ok")


if __name__ == "__main__":
    main()
