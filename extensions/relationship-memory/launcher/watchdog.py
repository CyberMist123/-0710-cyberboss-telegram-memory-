#!/usr/bin/env python3
"""Single-owner Telegram watchdog driven only by deployment/current.json."""
import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
WATCHDOG_SCRIPT = Path(__file__).resolve()
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
    script = (
        f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}' -ErrorAction SilentlyContinue;"
        "if($p){$p|Select-Object ProcessId,ExecutablePath,CommandLine|ConvertTo-Json -Compress}"
    )
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True, timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return json.loads(result.stdout)


def normalize(value: str) -> str:
    return os.path.normcase(os.path.abspath(value)).replace("/", "\\")


def windows_argv(command_line: str) -> list[str]:
    """Parse a Windows command line using CommandLineToArgvW when available.

    The fallback implements the documented backslash-before-quote rules so the
    same unit tests can run on non-Windows CI hosts.
    """
    if os.name == "nt":
        argc = ctypes.c_int()
        command_line_to_argv = ctypes.windll.shell32.CommandLineToArgvW
        command_line_to_argv.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
        command_line_to_argv.restype = ctypes.POINTER(ctypes.c_wchar_p)
        argv = command_line_to_argv(command_line, ctypes.byref(argc))
        if not argv:
            raise OSError("CommandLineToArgvW failed")
        try:
            return [argv[index] for index in range(argc.value)]
        finally:
            ctypes.windll.kernel32.LocalFree(ctypes.cast(argv, ctypes.c_void_p))
    result, current, index, quoted = [], [], 0, False
    while index < len(command_line):
        if command_line[index] in " \t" and not quoted:
            if current:
                result.append("".join(current)); current = []
            index += 1
            continue
        slashes = 0
        while index < len(command_line) and command_line[index] == "\\":
            slashes += 1; index += 1
        if index < len(command_line) and command_line[index] == '"':
            current.extend("\\" * (slashes // 2))
            if slashes % 2:
                current.append('"')
            elif quoted and index + 1 < len(command_line) and command_line[index + 1] == '"':
                current.append('"'); index += 1
            else:
                quoted = not quoted
            index += 1
            continue
        current.extend("\\" * slashes)
        if index < len(command_line):
            current.append(command_line[index]); index += 1
    if current:
        result.append("".join(current))
    return result


def is_python_process(row: dict) -> bool:
    executable = str((row or {}).get("ExecutablePath") or "")
    name = Path(executable.replace("\\", "/")).name.lower()
    return name in {"python.exe", "pythonw.exe", "py.exe"} or name.startswith("python")


def command_descriptor(tokens: list[str]) -> str | None:
    for index, token in enumerate(tokens):
        if token == "--descriptor" and index + 1 < len(tokens):
            return tokens[index + 1]
        if token.startswith("--descriptor="):
            return token.split("=", 1)[1]
    return None


def watchdog_identity(row: dict, descriptor_path: Path, script_path: Path = WATCHDOG_SCRIPT) -> bool:
    """Require an exact Python, script and descriptor token triple."""
    if not is_python_process(row):
        return False
    try:
        tokens = windows_argv(str((row or {}).get("CommandLine") or ""))
    except (OSError, ValueError):
        return False
    descriptor = command_descriptor(tokens)
    return (len(tokens) >= 2 and normalize(tokens[1]) == normalize(str(script_path.resolve()))
            and descriptor is not None and normalize(descriptor) == normalize(str(descriptor_path.resolve())))


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


def launch_active_release(descriptor: dict, log_file: Path) -> None:
    target = Path(descriptor["watchdog_target"]).resolve()
    if not target.exists():
        raise FileNotFoundError(f"watchdog target missing: {target}")
    environment = os.environ.copy()
    environment.update({"CYBERBOSS_CONFIG_DIR": descriptor["config_dir"], "CYBERBOSS_STATE_DIR": descriptor["state_dir"], "CYBERBOSS_LOG_DIR": descriptor["log_dir"]})
    if descriptor.get("workspace_dir"):
        environment["CYBERBOSS_WORKSPACE"] = descriptor["workspace_dir"]
    subprocess.Popen(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(target)], cwd=str(target.parent), env=environment, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    log(f"launched active release {descriptor['active_release_id']} via {target}", log_file)


def watchdog_rows() -> list[dict]:
    if os.name != "nt":
        return []
    script = "$p=Get-CimInstance Win32_Process -ErrorAction Stop;$p|Select-Object ProcessId,ExecutablePath,CommandLine|ConvertTo-Json -Compress"
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True, timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode != 0 or not result.stdout.strip():
        return []
    value = json.loads(result.stdout)
    return value if isinstance(value, list) else [value]


def verify_watchdog_owner(pid_file: Path, descriptor_path: Path, legacy_owners: list[tuple[Path, Path]] | None = None) -> None:
    identities = [(WATCHDOG_SCRIPT, descriptor_path), *(legacy_owners or [])]
    def matches(row: dict) -> bool:
        return any(watchdog_identity(row, desc, script) for script, desc in identities)
    existing = read_pid(pid_file)
    if existing and existing != os.getpid():
        row = process_row(existing)
        if row and matches(row):
            raise RuntimeError(f"watchdog already running with verified pid {existing}")
    for row in watchdog_rows():
        if int(row.get("ProcessId") or 0) != os.getpid() and matches(row):
            raise RuntimeError(f"watchdog already running with verified pid {row.get('ProcessId')}")
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(str(os.getpid()), encoding="utf-8")


def run_watchdog(descriptor_path: Path, interval: float, iterations: int | None = None, sleep=time.sleep, launcher=launch_active_release, health=active_release_alive, owner_verifier=verify_watchdog_owner, log_sink=log, legacy_owners=None) -> None:
    """One recoverable loop; injectable seams keep tests finite and process-free."""
    fallback_log = descriptor_path.parent / "watchdog.log"
    log_file, pid_file, owner_ready, last_error = fallback_log, None, False, None
    cycle = 0
    while iterations is None or cycle < iterations:
        cycle += 1
        try:
            descriptor = load_descriptor(descriptor_path)
            log_file, candidate_pid = owner_paths(descriptor)
            if not owner_ready or candidate_pid != pid_file:
                owner_verifier(candidate_pid, descriptor_path, legacy_owners)
                pid_file, owner_ready = candidate_pid, True
            alive, evidence = health(descriptor)
            if alive:
                if last_error is not None:
                    log_sink("watchdog recovered: descriptor and active release are healthy", log_file)
                log_sink(f"healthy active release {descriptor['active_release_id']}: {evidence}", log_file)
            else:
                log_sink(f"active release {descriptor['active_release_id']} unavailable: {evidence}", log_file)
                launcher(descriptor, log_file)
            last_error = None
        except Exception as error:
            marker = f"{type(error).__name__}: {error}"
            if marker != last_error:
                log_sink(f"check failed (will retry): {marker}", log_file)
            last_error = marker
        if iterations is None or cycle < iterations:
            sleep(max(1.0, interval))
    if pid_file and read_pid(pid_file) == os.getpid():
        try:
            pid_file.unlink()
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--descriptor", type=Path, default=DEFAULT_DESCRIPTOR)
    parser.add_argument("--interval", type=float, default=60.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--legacy-owner", action="append", default=[], metavar="SCRIPT|DESCRIPTOR")
    args = parser.parse_args()
    legacy = []
    for item in args.legacy_owner:
        script, separator, descriptor = item.partition("|")
        if not separator or not script or not descriptor:
            parser.error("--legacy-owner must be exact SCRIPT|DESCRIPTOR")
        legacy.append((Path(script).resolve(), Path(descriptor).resolve()))
    run_watchdog(args.descriptor.resolve(), args.interval, iterations=1 if args.once else None, legacy_owners=legacy)
    return 0


if __name__ == "__main__":
    sys.exit(main())
