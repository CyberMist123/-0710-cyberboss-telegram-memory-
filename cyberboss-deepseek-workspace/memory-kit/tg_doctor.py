#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TG 线体检:能不能到 api.telegram.org、能不能到 DeepSeek Anthropic 端点、当前 pid 活否。

用法:双击 memory-kit\\tg_doctor.py 或 python tg_doctor.py
不做修复,只报告。
"""
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

try:
    import urllib.request
except Exception:
    urllib = None

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from config_loader import load_keys, chat_config, telegram_config  # noqa: E402

TG_STATE = Path(r"C:\Users\18717\.cyberboss-deepseek-test")


def check_dns(host: str) -> str:
    try:
        addr = socket.gethostbyname(host)
        return f"OK  {host} → {addr}"
    except Exception as e:
        return f"FAIL {host}: {e}"


def check_http(url: str, proxy: str = "") -> str:
    try:
        req = urllib.request.Request(url)
        handler = urllib.request.ProxyHandler({"https": proxy, "http": proxy}) if proxy else urllib.request.ProxyHandler({})
        opener = urllib.request.build_opener(handler)
        with opener.open(req, timeout=8) as resp:
            return f"OK  {url} → HTTP {resp.status}"
    except Exception as e:
        return f"FAIL {url}: {e}"


def check_pid() -> str:
    pid_file = TG_STATE / "cyberboss.pid"
    if not pid_file.exists():
        return "FAIL pid 文件不存在(TG 未启动或异常退出)"
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip() or "0")
    except Exception as e:
        return f"FAIL pid 文件损坏: {e}"
    if pid <= 0:
        return "FAIL pid=0"
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=6,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return (f"OK  pid={pid} 活着" if str(pid) in out.stdout else f"FAIL pid={pid} 不在 tasklist 里(已挂)")
    except Exception as e:
        return f"WARN pid={pid} 无法确认: {e}"


def tail_log() -> str:
    log = TG_STATE / "logs" / "cyberboss.err.log"
    if not log.exists():
        return "  (无 err.log)"
    try:
        text = log.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join("    " + l for l in text[-8:])
    except Exception as e:
        return f"  (读日志失败: {e})"


def main() -> None:
    keys = load_keys()
    tg = telegram_config(keys)
    cc = chat_config(keys)
    proxy = tg["https_proxy"]

    print("=== TG 线体检 ===\n")
    print(f"[配置] chat_provider={cc['provider']} model={cc['model']}")
    print(f"[配置] chat_endpoint={cc['endpoint']}")
    print(f"[配置] https_proxy={'(未配)' if not proxy else proxy}")
    print()
    print("[进程]", check_pid())
    print()
    print("[DNS]")
    for host in ("api.telegram.org", "api.deepseek.com", "open.bigmodel.cn"):
        print("  ", check_dns(host))
    print()
    print(f"[HTTPS]  (proxy={'on' if proxy else 'off'})")
    print("  ", check_http("https://api.telegram.org", proxy))
    print("  ", check_http(cc["endpoint"] + "/" if cc.get("endpoint") else "https://api.deepseek.com", proxy))
    print()
    print("[err.log 尾部 8 行]")
    print(tail_log())
    print()
    if not proxy:
        print("提示:如果 api.telegram.org 直连 FAIL,把系统代理端口填到")
        print("     memory-kit/keys.local.json 的 https_proxy(如 http://127.0.0.1:7890),")
        print("     然后跑 重启TG.bat。")


if __name__ == "__main__":
    main()
