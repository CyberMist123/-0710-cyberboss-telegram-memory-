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
REQUIRED = (
    "active_release_id", "telegram_entry", "config_dir", "state_dir", "log_dir",
    "pid_file", "watchdog_target", "rollback_release", "last_verified_sha",
)


def owner_paths(descriptor: dict) -> tuple[Path, Path]:
    owner_dir = Path(descriptor.get("watchdog_owner_dir") or HERE).resolve()
    return owner_dir / "watchdog.log", owner_dir / "watchdog.pid"


def log(message: str, log_file: Path) -> None:
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {message}\n"
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError:
        pass


def load_descriptor(file_path: Path) -> dict:
    raw = file_path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError("release descriptor must be UTF-8 without BOM")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("release descriptor is not valid UTF-8 JSON") from error
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
    log(f"launched active release {descriptor['active_release_id']} via {target}", log_file)


def watchdog_identity(row: dict, descriptor_path: Path) -> bool:
    """Only count a cyberboss watchdog that names this exact descriptor.

    A PID is never trusted by name alone: Windows can reuse it and other
    projects can legitimately run a Python watchdog with the same basename.
    """
    command = str((row or {}).get("CommandLine") or "")
    tokens = command.replace('"', ' ').split()
    descriptor = normalize(str(descriptor_path))
    script_tokens = [normalize(token) for token in tokens if token.lower().endswith("watchdog.py")]
    return any("cyberboss" in token for token in script_tokens) and descriptor in [normalize(token) for token in tokens]


def watchdog_rows() -> list[dict]:
    if os.name != "nt":
        return []
    script = "$p=Get-CimInstance Win32_Process -ErrorAction Stop|Where-Object {$_.CommandLine -match 'watchdog\\.py'};$p|Select-Object ProcessId,ExecutablePath,CommandLine|ConvertTo-Json -Compress"
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True, timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode != 0 or not result.stdout.strip(): return []
    value = json.loads(result.stdout)
    return value if isinstance(value, list) else [value]


def verify_watchdog_owner(pid_file: Path, descriptor_path: Path) -> None:
    existing = read_pid(pid_file)
    if existing and existing != os.getpid():
        row = process_row(existing)
        if row and watchdog_identity(row, descriptor_path):
            raise RuntimeError(f"watchdog already running with verified pid {existing}")
    # Do not rely on the owner-directory PID file: old and new releases used
    # different directories.  Scan process identity so two valid owners fail
    # closed instead of silently becoming dual watchdogs.
    for row in watchdog_rows():
        if int(row.get("ProcessId") or 0) != os.getpid() and watchdog_identity(row, descriptor_path):
            raise RuntimeError(f"watchdog already running with verified pid {row.get('ProcessId')}")
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()), encoding="utf-8")


def check_once(descriptor_path: Path, log_file: Path) -> bool:
    descriptor = load_descriptor(descriptor_path)
    alive, evidence = active_release_alive(descriptor)
    if alive:
        log(f"healthy active release {descriptor['active_release_id']}: {evidence}", log_file)
        return True
    log(f"active release {descriptor['active_release_id']} unavailable: {evidence}", log_file)
    launch_active_release(descriptor)
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--descriptor", type=Path, default=DEFAULT_DESCRIPTOR)
    parser.add_argument("--interval", type=float, default=60.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    descriptor_path = args.descriptor.resolve()
    descriptor = load_descriptor(descriptor_path)
    log_file, pid_file = owner_paths(descriptor)
    verify_watchdog_owner(pid_file, descriptor_path)
    try:
        while True:
            try:
                check_once(descriptor_path, log_file)
            except Exception as error:
                # The service remains alive after a broken descriptor or a
                # transient OS error.  Log only the error class/message (no
                # descriptor contents or stack) and suppress identical noise.
                marker = f"{type(error).__name__}: {error}"
                if marker != getattr(main, "last_error", None):
                    log(f"check failed (will retry): {marker}", log_file)
                    main.last_error = marker
                if args.once:
                    raise
            else:
                main.last_error = None
            if args.once:
                return 0
            time.sleep(max(1.0, args.interval))
    finally:
        if read_pid(pid_file) == os.getpid():
            try:
                pid_file.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
