#!/usr/bin/env python3
"""Single-owner Telegram watchdog driven only by deployment/current.json."""
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DESCRIPTOR = next(
    (parent / "deployment" / "current.json" for parent in HERE.parents
     if (parent / "deployment" / "current.json").exists()),
    Path.cwd() / "deployment" / "current.json",
)
LOG_FILE = HERE / "watchdog.log"
PID_FILE = HERE / "watchdog.pid"
REQUIRED = (
    "active_release_id", "telegram_entry", "config_dir", "state_dir", "log_dir",
    "pid_file", "watchdog_target", "rollback_release", "last_verified_sha",
)


def log(message: str) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}\n"
    try:
        with LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError:
        pass


def load_descriptor(file_path: Path) -> dict:
    value = json.loads(file_path.read_text(encoding="utf-8"))
    missing = [field for field in REQUIRED if field not in value]
    if missing:
        raise ValueError(f"release descriptor missing: {', '.join(missing)}")
    for field in REQUIRED:
        if field == "rollback_release":
            continue
        if not isinstance(value[field], str) or not value[field].strip():
            raise ValueError(f"release descriptor field is empty: {field}")
    state_dir = Path(value["state_dir"]).resolve()
    pid_file = Path(value["pid_file"]).resolve()
    try:
        pid_file.relative_to(state_dir)
    except ValueError as error:
        raise ValueError("pid_file must belong to active release state_dir") from error
    return value


def read_pid(pid_file: Path) -> int:
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
        return pid if pid > 0 else 0
    except (OSError, ValueError):
        return 0


def process_row(pid: int) -> dict | None:
    if pid <= 0:
        return None
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return {"ProcessId": pid, "ExecutablePath": "", "CommandLine": ""}
        except OSError:
            return None
    escaped = str(pid)
    script = (
        f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={escaped}' -ErrorAction SilentlyContinue;"
        "if($p){$p|Select-Object ProcessId,ExecutablePath,CommandLine|ConvertTo-Json -Compress}"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=10,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return json.loads(result.stdout)


def normalize(value: str) -> str:
    return os.path.normcase(os.path.abspath(value)).replace("/", "\\")


def active_release_alive(descriptor: dict) -> tuple[bool, str]:
    pid = read_pid(Path(descriptor["pid_file"]))
    if not pid:
        return False, "pid file missing or invalid"
    row = process_row(pid)
    if not row:
        return False, f"pid {pid} is not alive"
    command = str(row.get("CommandLine") or "")
    executable = str(row.get("ExecutablePath") or "")
    if not executable or not Path(executable).is_absolute():
        return False, f"pid {pid} executable path is unavailable"
    expected = normalize(descriptor["telegram_entry"])
    normalized_command = os.path.normcase(command).replace("/", "\\")
    if expected not in normalized_command or " start" not in f" {normalized_command} ":
        return False, f"pid {pid} command does not match active release entry"
    return True, f"pid {pid} matches {expected}"


def launch_active_release(descriptor: dict) -> None:
    target = Path(descriptor["watchdog_target"]).resolve()
    if not target.exists():
        raise FileNotFoundError(f"watchdog target missing: {target}")
    environment = os.environ.copy()
    environment.update({
        "CYBERBOSS_CONFIG_DIR": descriptor["config_dir"],
        "CYBERBOSS_STATE_DIR": descriptor["state_dir"],
        "CYBERBOSS_LOG_DIR": descriptor["log_dir"],
    })
    if descriptor.get("workspace_dir"):
        environment["CYBERBOSS_WORKSPACE"] = descriptor["workspace_dir"]
    subprocess.Popen(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(target)],
        cwd=str(target.parent), env=environment,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    log(f"launched active release {descriptor['active_release_id']} via {target}")


def verify_watchdog_owner() -> None:
    existing = read_pid(PID_FILE)
    if existing and existing != os.getpid():
        row = process_row(existing)
        command = str((row or {}).get("CommandLine") or "").lower()
        if row and "watchdog.py" in command:
            raise RuntimeError(f"watchdog already running with verified pid {existing}")
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")


def check_once(descriptor_path: Path) -> bool:
    descriptor = load_descriptor(descriptor_path)
    alive, evidence = active_release_alive(descriptor)
    if alive:
        log(f"healthy active release {descriptor['active_release_id']}: {evidence}")
        return True
    log(f"active release {descriptor['active_release_id']} unavailable: {evidence}")
    launch_active_release(descriptor)
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--descriptor", type=Path, default=DEFAULT_DESCRIPTOR)
    parser.add_argument("--interval", type=float, default=60.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    verify_watchdog_owner()
    try:
        while True:
            try:
                check_once(args.descriptor.resolve())
            except Exception as error:
                log(f"check failed: {error}")
                if args.once:
                    raise
            if args.once:
                return 0
            time.sleep(max(1.0, args.interval))
    finally:
        if read_pid(PID_FILE) == os.getpid():
            try:
                PID_FILE.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
