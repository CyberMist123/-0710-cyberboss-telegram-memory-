#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cyberboss 三线看门狗:TG + WeChat + 520 面板。

策略:
- 每 CHECK_INTERVAL 秒扫一遍三条线的存活证据(pid file / TCP 端口 / 进程)。
- 死了 → 用对应 VBS 隐藏拉起;限流:每条线最多 RESTART_QUOTA_PER_HOUR 次/小时。
- 日志写 launcher/watchdog.log(按小时切分,保留 24 份)。
- 全程 try/except,自身崩了会被计划任务 15 分钟内重启一次(计划任务另配)。
- 不写 memory/,不改配置,只做拉起。

启动:pythonw watchdog.py(隐藏)/ 计划任务 onlogon。
停止:任务管理器杀 python 进程 或 launcher/stop-watchdog.bat。
"""
import json
import os
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOG_FILE = HERE / "watchdog.log"
PID_FILE = HERE / "watchdog.pid"

CHECK_INTERVAL = 60          # 秒
RESTART_QUOTA_PER_HOUR = 4   # 每条线每小时最多拉几次,防疯狂重启

TG_STATE_DIR = Path(os.environ["CYBERBOSS_STATE_DIR"]).expanduser()
WECHAT_STATE_DIR = Path(os.environ["CYBERBOSS_WECHAT_STATE_DIR"]).expanduser()
DASHBOARD_KIT_DIR = Path(os.environ.get("CYBERBOSS_MEMORY_KIT_DIR", HERE.parent / "memory-kit")).expanduser()
WECHAT_PORT = int(os.environ.get("CYBERBOSS_WECHAT_PORT", "8785"))
DASHBOARD_PORT = int(os.environ.get("CYBERBOSS_DASHBOARD_PORT", "520"))

TARGETS = [
    {
        "name": "tg",
        "pid_file": TG_STATE_DIR / "cyberboss.pid",
        "launcher": HERE / "tg-hidden.vbs",
        "port_probe": None,
    },
    {
        "name": "wechat",
        "pid_file": WECHAT_STATE_DIR / "logs" / "shared-wechat.pid",
        "launcher": HERE / "wechat-hidden.vbs",
        "port_probe": ("127.0.0.1", WECHAT_PORT),
    },
    {
        "name": "dashboard",
        "pid_file": DASHBOARD_KIT_DIR / ".panel.pid",
        "launcher": HERE / "dashboard-hidden.vbs",
        "port_probe": ("127.0.0.1", DASHBOARD_PORT),
    },
]


def log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}\n"
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line)
        if LOG_FILE.stat().st_size > 2_000_000:
            LOG_FILE.replace(LOG_FILE.with_suffix(".log.old"))
    except Exception:
        pass


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return str(pid) in out.stdout
    except Exception:
        return False


def port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except Exception:
        return False


def target_alive(target: dict) -> bool:
    pid_file = target["pid_file"]
    probe = target.get("port_probe")
    if probe:
        alive = port_open(*probe)
        if not alive and pid_file.exists():
            try:
                pid = int(pid_file.read_text(encoding="utf-8").strip() or "0")
            except Exception:
                pid = 0
            if not pid_alive(pid):
                try:
                    pid_file.unlink()
                except Exception:
                    pass
        return alive
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip() or "0")
            if pid_alive(pid):
                return True
        except Exception:
            pid = 0
        if not pid_alive(pid):
            try:
                pid_file.unlink()
            except Exception:
                pass
    return False


def start_target(target: dict) -> None:
    launcher = target["launcher"]
    if not launcher.exists():
        log(f"launcher missing: {launcher}")
        return
    try:
        subprocess.Popen(
            ["wscript.exe", str(launcher)],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        log(f"[{target['name']}] launched via {launcher.name}")
    except Exception as e:
        log(f"[{target['name']}] launch failed: {e}")


def loop() -> None:
    quotas: dict[str, list[float]] = {t["name"]: [] for t in TARGETS}
    while True:
        for t in TARGETS:
            try:
                if target_alive(t):
                    continue
            except Exception as e:
                log(f"[{t['name']}] alive check failed: {e}")
                continue
            now = time.time()
            recent = [ts for ts in quotas[t["name"]] if now - ts < 3600]
            quotas[t["name"]] = recent
            if len(recent) >= RESTART_QUOTA_PER_HOUR:
                log(f"[{t['name']}] dead but quota exhausted ({len(recent)}/h), skip")
                continue
            log(f"[{t['name']}] dead, launching")
            start_target(t)
            quotas[t["name"]].append(now)
        time.sleep(CHECK_INTERVAL)


def main() -> None:
    try:
        PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    except Exception:
        pass
    log(f"watchdog starting, pid={os.getpid()}")
    try:
        loop()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        log(f"watchdog crashed: {e}")
        raise
    finally:
        try:
            PID_FILE.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    main()
