#!/usr/bin/env python3
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


KIT = Path(__file__).resolve().parent.parent
REPO = KIT.parents[2]
VBS_LAUNCHER = REPO / "extensions" / "relationship-memory" / "launcher" / "dashboard-hidden.vbs"
PS_LAUNCHER = REPO / "scripts" / "windows" / "continuity-startup.ps1"


def reserve_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def snapshot_tree(root):
    rows = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        rows[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return rows


def write_jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def request_json(port, endpoint):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{endpoint}", timeout=3) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def request_text(port, endpoint):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{endpoint}", timeout=3) as response:
        return response.status, response.read().decode("utf-8")


def read_pid(pid_file):
    try:
        raw = pid_file.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(raw) if raw.isdigit() and int(raw) > 0 else None


def wait_for_dashboard(port, pid_file):
    last_error = None
    for _ in range(160):
        try:
            pid = read_pid(pid_file)
            if pid:
                code, payload = request_json(port, "/api/continuity/layers?limit=10")
                if code == 200:
                    return pid, payload
        except Exception as error:
            last_error = error
        time.sleep(0.05)
    raise AssertionError(f"launcher did not produce a ready layered 520: {last_error}")


def process_command_line(pid):
    command = (
        f"$row = Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\"; "
        "if ($null -eq $row) { exit 3 }; [Console]::Write($row.CommandLine)"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def terminate_process(pid, pid_file):
    subprocess.run(
        ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
    )
    for _ in range(80):
        probe = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", f"if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        if probe.returncode == 0:
            break
        time.sleep(0.05)
    else:
        raise AssertionError(f"dashboard process {pid} did not stop")
    try:
        pid_file.unlink()
    except FileNotFoundError:
        pass


def cleanup_case(pid, pid_file):
    resolved_pid = pid or read_pid(pid_file)
    if resolved_pid:
        terminate_process(resolved_pid, pid_file)


def prepare_case(name):
    root = Path(tempfile.mkdtemp(prefix=f"dashboard-startup-{name}-"))
    protected = root / "protected"
    workspace = protected / "workspace"
    continuity = workspace / "continuity"
    memory = workspace / "memory"
    state = protected / "state"
    config = protected / "config"
    runtime = root / "runtime"
    for path in (continuity, memory, state, config, runtime):
        path.mkdir(parents=True, exist_ok=True)

    write_jsonl(
        continuity / "candidates" / "episodes.candidates.jsonl",
        [{"candidate_id": f"{name}-legacy-janitor", "type": "episode", "author": "janitor"}],
    )
    write_jsonl(
        continuity / "gaps" / "gaps.jsonl",
        [{"gap_id": f"{name}-gap", "source_ref": {"file": "fixture.jsonl", "window": "1-1"}}],
    )
    keys = runtime / "keys.local.json"
    keys.write_text(json.dumps({"API_TOKEN": f"{name}-fixture-token"}), encoding="utf-8")
    return {
        "root": root,
        "protected": protected,
        "workspace": workspace,
        "continuity": continuity,
        "memory": memory,
        "state": state,
        "config": config,
        "runtime": runtime,
        "keys": keys,
        "pid": runtime / "dashboard.pid",
    }


def base_env(case, port):
    env = os.environ.copy()
    env.update({
        "CYBERBOSS_DASHBOARD_HOST": "127.0.0.1",
        "CYBERBOSS_DASHBOARD_PORT": str(port),
        "CYBERBOSS_DASHBOARD_NO_BROWSER": "1",
        "CYBERBOSS_DASHBOARD_PID_FILE": str(case["pid"]),
        "CYBERBOSS_DASHBOARD_KEYS_FILE": str(case["keys"]),
        "CYBERBOSS_DASHBOARD_PYTHON": sys.executable,
        "CYBERBOSS_MEMORY_KIT_DIR": str(KIT),
        "CYBERBOSS_HOME": str(REPO),
        "CYBERBOSS_STATE_DIR": str(case["state"]),
        "CYBERBOSS_CONFIG_DIR": str(case["config"]),
        "CYBERBOSS_CONTINUITY_DIR": str(case["continuity"]),
        "CYBERBOSS_MEMORY_DIR": str(case["memory"]),
        "CYBERBOSS_NIGHTLY_MODE": "evidence",
        "PYTHONUNBUFFERED": "1",
    })
    return env


def assert_layered_server(port, payload, expected_candidate):
    assert payload["kind"] == "continuity_layers"
    assert payload["nightly_mode"] == "evidence"
    assert payload["write_mode"] == "controlled_context_write"
    assert "reentry" in payload["capabilities"]["controlled_context_write"]
    assert "canon" in payload["capabilities"]["frozen"]
    layers = {layer["key"]: layer for layer in payload["layers"]}
    assert layers["gaps"]["count"] == 1
    assert [row["candidate_id"] for row in layers["blocked_candidates"]["rows"]] == [expected_candidate]

    code, page = request_text(port, "/")
    assert code == 200
    assert 'id="continuity-feed"' in page
    for label in ("上下文载入", "记忆处理", "断档与异常", "配置变更"):
        assert label in page
    for legacy_label in ("技术断档", "证据材料", "主体 AI 候选", "后台代理候选", "冻结的旧候选"):
        assert f'<div class="section-head">{legacy_label}</div>' not in page
    assert '<div class="section-head">Candidates</div>' not in page


def run_vbs_case():
    case = prepare_case("vbs")
    before = snapshot_tree(case["protected"])
    port = reserve_port()
    pid = None
    try:
        result = subprocess.run(
            ["cscript.exe", "//nologo", str(VBS_LAUNCHER)],
            cwd=str(VBS_LAUNCHER.parent),
            env=base_env(case, port),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        pid, payload = wait_for_dashboard(port, case["pid"])
        assert "dashboard_continuity.py" in process_command_line(pid)
        assert_layered_server(port, payload, "vbs-legacy-janitor")
    finally:
        cleanup_case(pid, case["pid"])
    assert snapshot_tree(case["protected"]) == before


def run_powershell_case():
    case = prepare_case("powershell")
    descriptor = case["runtime"] / "current.json"
    descriptor.write_text(json.dumps({
        "telegram_entry": str(REPO / "bin" / "cyberboss.js"),
        "state_dir": str(case["state"]),
        "config_dir": str(case["config"]),
        "workspace_dir": str(case["workspace"]),
        "dashboard_root": str(REPO),
    }), encoding="utf-8")
    before = snapshot_tree(case["protected"])
    port = reserve_port()
    pid = None
    try:
        result = subprocess.run(
            [
                "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", str(PS_LAUNCHER), "-Mode", "Dashboard", "-DescriptorPath", str(descriptor),
            ],
            cwd=str(REPO),
            env=base_env(case, port),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        pid, payload = wait_for_dashboard(port, case["pid"])
        assert "dashboard_continuity.py" in process_command_line(pid)
        assert_layered_server(port, payload, "powershell-legacy-janitor")
    finally:
        cleanup_case(pid, case["pid"])
    assert snapshot_tree(case["protected"]) == before


def main():
    if os.name != "nt":
        print("520 startup-entry black-box skipped: Windows only")
        return
    repository_pid = KIT / ".panel.pid"
    repository_pid_before = repository_pid.read_bytes() if repository_pid.is_file() else None
    run_vbs_case()
    run_powershell_case()
    repository_pid_after = repository_pid.read_bytes() if repository_pid.is_file() else None
    assert repository_pid_after == repository_pid_before
    print("520 startup entries: VBS + scheduled PowerShell launch layered read-only dashboard -> ok")


if __name__ == "__main__":
    main()
