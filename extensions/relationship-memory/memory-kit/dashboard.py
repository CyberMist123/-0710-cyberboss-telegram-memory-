#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""记忆面板 v3 — 查看/编辑 memory/ 下的所有画像与记忆文件 + 自动补记 + 本地 API 桥 + 关怀/剧场页。

用法:  python dashboard.py
然后开  http://127.0.0.1:0520

零依赖(只用标准库)。保存前自动备份旧版到 memory/.backups/(care/ 文件备份到 care/.backups/)。
只绑定本机 127.0.0.1,不对外。

六个视图(顶部 tab):
  1 健康度 — 落地页。系统有没有悄悄坏掉(静默失忆 / 未审候选 / reentry 超字);
             v2.1 起有「自动补记」卡片(后台定时跑 janitor.py)。
  2 时间线 — relationship_timeline.md 的可读年表,ep id 可点开展开成卡片。
  3 八维   — state_log.jsonl:v3 新增 canvas 手绘八维曲线(内联,无外部 CDN,
             图例可点选隐藏维度,断档处断线),下面保留朴素表格 + sparkline。
  4 关怀   — v3 新增:读写 care/config.json(城市/开关/频率上限,默认全关)+
             cycle 录入表单(追加写 care/cycle.md,只由她录入)。不做任何分析图表。
  5 剧场   — v3 新增:渲染 theater/scripts_index.md 的剧本外链列表,纯展示只读。
  6 文件   — 原有编辑器,默认只读,点"编辑"解锁,保存前 diff 确认。

v2.1 起有:
  - 启动时 + 每 AUTO_JANITOR_HOURS 小时后台跑一次 `python janitor.py`(daemon 线程,
    全程 try/except,崩了不影响面板本体)。
  - /api/* JSON 接口桥(给任意底座接入):只读端点无需 token(只绑本机);
    写端点(state_log 追加 / episode 候选追加 / 触发 janitor / care 配置与 cycle 录入)
    需要 X-Api-Token。
  - 启动时把 pid 写到 memory-kit/.panel.pid,配合根目录的 停止面板.bat 使用。

面板是纯外显工具:不写任何关系判断逻辑,不自动改 memory/ 内容(人手动编辑除外),
不新建文件(备份/候选/位点/care 表单落盘除外)。janitor 幂等且只写候选文件,自动跑是安全的;
API 桥永不让外部直接写 episodes.jsonl 正式文件——候选与正式分离是全局禁区。
关怀页边界:cycle 只由她录入,数据永不进 user_portrait / episodes,不做经期分析图表。
"""
import atexit
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
try:
    from zoneinfo import ZoneInfo, available_timezones
except ImportError:  # pragma: no cover
    ZoneInfo = None
    available_timezones = lambda: set()
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

from janitor_config import resolve_auto_janitor_hours_from_keys

KIT_DIR = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("CYBERBOSS_MEMORY_DIR") or (KIT_DIR.parent / "memory"))
BACKUPS = ROOT / ".backups"
WORKSPACE_ROOT = KIT_DIR.parent
CYBERLINK_ROOT = WORKSPACE_ROOT.parent


def _resolve_dashboard_workspace_root():
    for key in ("CYBERBOSS_WORKSPACE_ROOT", "CYBERBOSS_WORKSPACE"):
        value = os.environ.get(key, "").strip()
        if value:
            return Path(value)
    for parent in KIT_DIR.parents:
        if (parent / "settings" / "manifest.json").exists():
            return parent
    return CYBERLINK_ROOT


DASHBOARD_WORKSPACE_ROOT = _resolve_dashboard_workspace_root()
DASHBOARD_STATE_DIR = Path(
    os.environ.get("CYBERBOSS_DASHBOARD_STATE_DIR")
    or os.environ.get("CYBERBOSS_STATE_DIR")
    or (KIT_DIR / ".dashboard-state")
)


def _resolve_todo_file():
    explicit = os.environ.get("CYBERBOSS_TODO_FILE", "").strip()
    if explicit:
        return Path(explicit)
    candidates = (
        DASHBOARD_WORKSPACE_ROOT / "settings" / "CODING_TODO.md",
        DASHBOARD_WORKSPACE_ROOT / "CODING_TODO.md",
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


TODO_FILE = _resolve_todo_file()
TODO_META_FILE = DASHBOARD_STATE_DIR / "dashboard-todo-meta.json"
TODO_BACKUP_DIR = DASHBOARD_STATE_DIR / "todo-backups"
CONTEXT_LAYOUT_FILE = DASHBOARD_STATE_DIR / "context-layout.json"
CONTEXT_SNAPSHOT_DIR = DASHBOARD_STATE_DIR / "context-layout-snapshots"
CONTEXT_META_FILE = DASHBOARD_STATE_DIR / "context-layout-meta.json"
PROMPT_BACKUP_DIR = DASHBOARD_STATE_DIR / "prompt-backups"
PROMPT_AUDIT_FILE = DASHBOARD_STATE_DIR / "prompt-change-log.jsonl"
CONTEXT_SOURCE_BACKUP_DIR = DASHBOARD_STATE_DIR / "context-source-backups"
DESIRE_SCHEDULE_FILE = DASHBOARD_STATE_DIR / "desire-schedule.json"
DESIRE_SCHEDULE_BACKUP_DIR = DASHBOARD_STATE_DIR / "desire-schedule-backups"
DESIRE_SCHEDULE_AUDIT_FILE = DASHBOARD_STATE_DIR / "desire-schedule-audit.jsonl"
DESIRE_TELEMETRY_FILE = DASHBOARD_STATE_DIR / "desire-usage.jsonl"
DESIRE_PLAN_FILE = DASHBOARD_STATE_DIR / "desire-checkin-plan.json"

DESIRE_SCHEDULE_DEFAULTS = {
    "version": 1,
    "enabled": True,
    "interval_minutes": 55,
    "night_skip_enabled": True,
    "night_start": "22:00",
    "night_end": "06:00",
    "timezone": "Australia/Sydney",
}

DESIRE_TIMEZONE_COMMON_NAMES = {
    "Asia/Shanghai": "(UTC+08:00) 北京，重庆，香港特别行政区，乌鲁木齐",
    "Asia/Tokyo": "(UTC+09:00) 大阪，札幌，东京",
    "Australia/Sydney": "(UTC+10:00) 堪培拉，墨尔本，悉尼",
    "Australia/Melbourne": "(UTC+10:00) 墨尔本，悉尼",
    "Australia/Brisbane": "(UTC+10:00) 布里斯班",
    "Pacific/Auckland": "(UTC+12:00) 奥克兰，惠灵顿",
    "Asia/Singapore": "(UTC+08:00) 新加坡",
    "Asia/Seoul": "(UTC+09:00) 首尔",
    "Asia/Kolkata": "(UTC+05:30) 钦奈，加尔各答，孟买，新德里",
    "Europe/London": "(UTC+00:00) 都柏林，爱丁堡，里斯本，伦敦",
    "Europe/Paris": "(UTC+01:00) 布鲁塞尔，哥本哈根，马德里，巴黎",
    "Europe/Berlin": "(UTC+01:00) 阿姆斯特丹，柏林，罗马",
    "America/New_York": "(UTC-05:00) 东部时间（美国和加拿大）",
    "America/Chicago": "(UTC-06:00) 中部时间（美国和加拿大）",
    "America/Denver": "(UTC-07:00) 山地时间（美国和加拿大）",
    "America/Los_Angeles": "(UTC-08:00) 太平洋时间（美国和加拿大）",
    "America/Toronto": "(UTC-05:00) 多伦多",
    "America/Vancouver": "(UTC-08:00) 温哥华",
    "America/Sao_Paulo": "(UTC-03:00) 巴西利亚",
    "Pacific/Honolulu": "(UTC-10:00) 檀香山",
}

def _timezone_options():
    try:
        zones = set(available_timezones()) if ZoneInfo is not None else set()
    except Exception:
        zones = set()
    def with_current_offset(iana, label):
        try:
            offset = datetime.now(timezone.utc).astimezone(ZoneInfo(iana)).strftime("%z")
            shown = f"UTC{offset[:3]}:{offset[3:]}" if len(offset) == 5 else "UTC"
            return re.sub(r"\(UTC[^)]*\)", f"({shown})", label, count=1)
        except Exception:
            return label
    options = [{"iana": iana, "label": with_current_offset(iana, label)} for iana, label in DESIRE_TIMEZONE_COMMON_NAMES.items() if not zones or iana in zones]
    known = {item["iana"] for item in options}
    options.extend({"iana": iana, "label": f"IANA 时区 · {iana}"} for iana in sorted(zones - known))
    return options

DEFAULT_CONTEXT_LAYOUT = {
    "version": 1,
    "groups": [
        {
            "id": "base",
            "title": "Base",
            "subtitle": "稳定层",
            "fixed": "first",
            "enabled": True,
            "modules": [
                {"id": "identity", "name": "人物卡 / AI Identity", "enabled": True},
                {"id": "relationship", "name": "关系 / 情感注入", "enabled": True},
                {"id": "tools_rules", "name": "Tool / AI 自主活动规则", "enabled": True},
            ],
        },
        {
            "id": "reentry",
            "title": "Re-entry",
            "subtitle": "慢变化层",
            "enabled": True,
            "runtime_gate": "reentry",
            "modules": [
                {"id": "boundary", "name": "Boundary", "enabled": True},
                {"id": "history", "name": "History / Timeline 摘要", "enabled": True},
                {"id": "ai_portrait", "name": "AI Portrait", "enabled": True},
                {"id": "user_portrait", "name": "User Portrait", "enabled": True},
            ],
        },
        {
            "id": "live_state",
            "title": "Live State",
            "subtitle": "鲜活状态层",
            "enabled": True,
            "runtime_gate": "current_state",
            "modules": [
                {"id": "state_note", "name": "最近状态摘要 / 小纸条", "enabled": True},
                {"id": "desire", "name": "八维 / Desire", "enabled": True},
                {"id": "commitments", "name": "承诺 / Commitments", "enabled": True},
                {"id": "focus", "name": "Todo / Current Focus", "enabled": True},
                {"id": "health", "name": "Health / 手机 Monitor", "enabled": True},
                {"id": "location", "name": "Location / Weather", "enabled": True},
                {"id": "rp", "name": "RP 预设 / Overlays", "enabled": True},
            ],
        },
        {
            "id": "cache",
            "title": "Cache / Continuity",
            "subtitle": "会话连续层",
            "enabled": True,
            "modules": [
                {"id": "previous_summary", "name": "上一会话摘要", "enabled": True},
                {"id": "recent_turns", "name": "上一会话原文 / 最近 N 轮", "enabled": True},
            ],
        },
        {
            "id": "retrieval",
            "title": "Retrieval & Tools",
            "subtitle": "按需检索层",
            "enabled": True,
            "runtime_gate": "memory_context",
            "modules": [
                {"id": "memory_lookup", "name": "记忆检索 / 特殊记忆浮现", "enabled": True},
                {"id": "tools", "name": "Tool / MCP 调用", "enabled": True},
                {"id": "cc", "name": "CC / Codex 项目管理结果", "enabled": True},
            ],
        },
        {
            "id": "current",
            "title": "Current Context",
            "subtitle": "当轮上下文",
            "fixed": "last",
            "enabled": True,
            "modules": [
                {"id": "conversation", "name": "当前会话", "enabled": True},
                {"id": "work_summary", "name": "当前轮公开工作摘要", "enabled": True},
                {"id": "cot", "name": "可选公开推理摘要（不含私有 CoT）", "enabled": False},
            ],
        },
    ],
}

HOST = os.environ.get("CYBERBOSS_DASHBOARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("CYBERBOSS_DASHBOARD_PORT", "520"))
CONTINUITY_DIR = Path(os.environ.get("CYBERBOSS_CONTINUITY_DIR") or (WORKSPACE_ROOT / "continuity"))
CYBERBOSS_HOME_TEXT = os.environ.get("CYBERBOSS_HOME", "").strip()
CYBERBOSS_HOME = Path(CYBERBOSS_HOME_TEXT) if CYBERBOSS_HOME_TEXT else None
NODE_COMMAND = os.environ.get("CYBERBOSS_NODE_COMMAND", "node")

# 注入侧真正生效的预算，也是本文件里**唯一**的 reentry 预算来源。
# 必须与 `src/core/reentry-loader.js` 的 REENTRY_CHAR_BUDGET 一致，所以这里**不**
# 接受环境变量覆盖：面板上调一个数字改不了 loader 的判断，只会造出「面板说过了、
# 注入侧说没过」的假放行（issue #76 目标 4）。
#
# 原先此处另有一个 `REENTRY_BUDGET = int(os.environ.get("CYBERBOSS_REENTRY_BUDGET", "300"))`
# 专供健康页告警。该环境变量在全仓没有第二处引用，node 侧也没有对应物 —— 一旦被设成
# 500，健康页要到 501 才报红，而 loader 在 301 就已经降级，正是上面要防的那种假放行。
# 已删除，健康页与 effective 判定共用本常量。
REENTRY_INJECTION_BUDGET = 300

PID_FILE = KIT_DIR / ".panel.pid"


def safe_print(*args, **kwargs):
    """pythonw 下没有控制台,sys.stdout 可能是 None 或写入即抛异常。
    这里把所有输出包一层:能打印就打印,不能就静默丢弃,绝不让 print 崩掉主程序。
    """
    try:
        print(*args, **kwargs)
    except Exception:
        pass


def write_pid_file():
    """把 os.getpid() 写到 memory-kit/.panel.pid,配合 停止面板.bat 使用。"""
    try:
        PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    except Exception:
        pass


def remove_pid_file():
    """尽力删除 pid 文件(atexit 注册,退出时清理;删不掉也不报错)。"""
    try:
        if PID_FILE.exists():
            PID_FILE.unlink()
    except Exception:
        pass

# ---------- keys.local.json:读配置 + 补写 API_TOKEN(只增键,不丢键) ----------

KEYS_FILE = Path(os.environ.get("CYBERBOSS_DASHBOARD_KEYS_FILE") or (KIT_DIR / "keys.local.json"))


def load_keys():
    if KEYS_FILE.exists():
        try:
            return json.loads(KEYS_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def ensure_api_token():
    """确保 keys.local.json 里有 API_TOKEN;没有就生成并写回,保留原有全部键值。"""
    keys = load_keys()
    if keys.get("API_TOKEN"):
        return keys["API_TOKEN"], keys
    keys["API_TOKEN"] = secrets.token_hex(16)
    try:
        KEYS_FILE.write_text(
            json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception:
        pass  # 写不进去也不阻塞面板,token 仍在内存里可用
    return keys["API_TOKEN"], keys


API_TOKEN, _KEYS = ensure_api_token()
AUTO_JANITOR_HOURS = resolve_auto_janitor_hours_from_keys(_KEYS)
# AUTO_JANITOR_HOURS:自动补记间隔小时数。0 = 关闭自动定时(手动「立即补记」仍可用)。
# 阶段 1 默认关闭;只有明确配置后才会运行 janitor。
AUTO_JANITOR_HOURS = 0


# ---------- 自动 janitor 状态(内存,进程重启即丢,健康度页会显示) ----------

JANITOR_STATE = {
    "running": False,
    "last_run_at": None,       # "%Y-%m-%d %H:%M:%S"
    "last_returncode": None,
    "last_tail": "",           # stdout 末尾几行
    "last_error": None,        # 线程/subprocess 层面的异常(不是 janitor 内部错误)
    "next_run_at": None,       # 下次自动运行的预计时间
    "consecutive_failures": 0,  # 连续失败次数(健康度顶部红条用)
}
_janitor_lock = threading.Lock()

AUTO_JANITOR_LOG = KIT_DIR / "auto_janitor.log"

FROZEN_WRITE_ENDPOINTS = {
    "/api/save",
    "/api/state_log",
    "/api/episode_candidate",
    "/api/janitor/run",
    "/api/care/config",
    "/api/care/cycle",
    "/api/config",
}


def continuity_paths():
    return {
        "trace": CONTINUITY_DIR / "trace" / "context_trace.jsonl",
        "candidates": CONTINUITY_DIR / "candidates" / "episodes.candidates.jsonl",
        "decisions": CONTINUITY_DIR / "decisions" / "decisions.jsonl",
        "episodes": CONTINUITY_DIR / "episodes.jsonl",
        "reentry": CONTINUITY_DIR / "reentry.md",
        "self_notes": CONTINUITY_DIR / "ai_self_notes.md",
        "jobs": CONTINUITY_DIR / ".jobs",
        "writer_state": CONTINUITY_DIR / ".jobs" / "history-writer-state.json",
        "recall_log": CONTINUITY_DIR / "recall_log.jsonl",
    }


def compute_module_state():
    paths = continuity_paths()
    configured = bool(str(CONTINUITY_DIR))
    candidates = read_jsonl(paths["candidates"])
    decisions = read_jsonl(paths["decisions"])
    jobs = list(paths["jobs"].glob("closeout-*.json")) if paths["jobs"].is_dir() else []

    def available_or(state):
        return state if configured else "not_implemented"

    return {
        "hard_context": available_or("on" if paths["trace"].exists() else "available"),
        "context_trace": available_or("on" if paths["trace"].exists() else "available"),
        "reentry": available_or("on" if paths["reentry"].exists() else "available"),
        "closeout": available_or("on" if jobs else "available"),
        "janitor": available_or("preview" if candidates else "available"),
        "auto_review": available_or("on" if decisions else ("preview" if candidates else "available")),
        "history_writer": available_or("on" if paths["writer_state"].exists() else ("preview" if decisions else "available")),
        "dashboard": "on",
        "memory_lookup": available_or("on" if paths["recall_log"].exists() else "available"),
        "soft_retrieval": "not_implemented",
    }


def get_continuity_rows(kind, limit=50):
    paths = continuity_paths()
    if kind not in ("trace", "candidates", "decisions"):
        raise ValueError("invalid continuity row kind")
    rows = read_jsonl(paths[kind])
    return normalize_display_value(rows[-max(1, min(int(limit), 200)):])


def run_review_retry(candidate_id):
    candidate_id = str(candidate_id or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", candidate_id):
        return {"ok": False, "error": "invalid_candidate_id"}, 400
    if CYBERBOSS_HOME is None:
        return {"ok": False, "error": "review_service_unavailable"}, 503
    script = CYBERBOSS_HOME / "scripts" / "continuity" / "run-phase3.js"
    if not CYBERBOSS_HOME.is_dir() or not script.is_file():
        return {"ok": False, "error": "review_service_unavailable"}, 503
    try:
        proc = subprocess.run(
            [NODE_COMMAND, str(script), "review", f"--candidate-id={candidate_id}"],
            cwd=str(CYBERBOSS_HOME), capture_output=True, text=True, timeout=120,
        )
    except Exception:
        return {"ok": False, "error": "review_service_failed"}, 503
    if proc.returncode != 0:
        return {"ok": False, "error": "review_service_failed", "exit_code": proc.returncode}, 503
    return {"ok": True, "candidate_id": candidate_id, "status": "review_requested"}, 200
AUTO_JANITOR_LOG_MAX_BYTES = 500 * 1024  # 500KB,超过就从中点截半(只保留后半段)


def _append_janitor_log(entry_text):
    """只追加;文件超过 500KB 就截半(保留后一半,丢弃较旧的前一半)。全程不抛异常。"""
    try:
        with open(AUTO_JANITOR_LOG, "a", encoding="utf-8") as f:
            f.write(entry_text)
            if not entry_text.endswith("\n"):
                f.write("\n")
    except Exception:
        return
    try:
        if AUTO_JANITOR_LOG.exists() and AUTO_JANITOR_LOG.stat().st_size > AUTO_JANITOR_LOG_MAX_BYTES:
            raw = AUTO_JANITOR_LOG.read_text(encoding="utf-8", errors="replace")
            half = raw[len(raw) // 2:]
            # 从下一个换行处开始,避免截断到一行中间
            nl = half.find("\n")
            if nl != -1:
                half = half[nl + 1:]
            AUTO_JANITOR_LOG.write_text(half, encoding="utf-8")
    except Exception:
        pass


# ---------- 自动 janitor:后台线程,daemon,全包 try/except ----------

def _run_janitor_once():
    """跑一次 `python janitor.py`,结果存进 JANITOR_STATE。绝不抛出到调用者。"""
    with _janitor_lock:
        if JANITOR_STATE["running"]:
            return False  # 已在跑,调用方(定时器/手动触发)自行处理
        JANITOR_STATE["running"] = True
    try:
        try:
            transcript_dir = os.environ.get("CYBERBOSS_CLAUDE_TRANSCRIPT_DIR", "").strip()
            memory_dir = os.environ.get("CYBERBOSS_MEMORY_DIR", "").strip()
            if not transcript_dir or not memory_dir:
                raise RuntimeError("CYBERBOSS_CLAUDE_TRANSCRIPT_DIR and CYBERBOSS_MEMORY_DIR are required.")
            proc = subprocess.run(
                [sys.executable, "janitor.py", "--input", transcript_dir, "--outdir", memory_dir],
                cwd=str(KIT_DIR),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=1800,
            )
            out = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
            lines = [l for l in out.splitlines() if l.strip()]
            JANITOR_STATE["last_returncode"] = proc.returncode
            JANITOR_STATE["last_tail"] = "\n".join(lines[-10:])
            JANITOR_STATE["last_error"] = None if proc.returncode == 0 else \
                f"janitor.py 退出码 {proc.returncode}"
        except Exception as e:
            JANITOR_STATE["last_returncode"] = None
            JANITOR_STATE["last_tail"] = ""
            JANITOR_STATE["last_error"] = f"启动/运行 janitor.py 失败:{e}"
        JANITOR_STATE["last_run_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        if JANITOR_STATE["last_error"]:
            JANITOR_STATE["consecutive_failures"] += 1
        else:
            JANITOR_STATE["consecutive_failures"] = 0

        log_entry = (
            f"[{JANITOR_STATE['last_run_at']}] rc={JANITOR_STATE['last_returncode']} "
            f"err={JANITOR_STATE['last_error']}\n"
            f"{JANITOR_STATE['last_tail']}\n"
            f"{'-' * 40}\n"
        )
        _append_janitor_log(log_entry)
    except Exception as e:
        # 双保险:再外面兜一层,任何情况都不让异常跑出这个函数
        try:
            JANITOR_STATE["last_error"] = f"janitor runner 内部异常:{e}"
            JANITOR_STATE["consecutive_failures"] += 1
        except Exception:
            pass
    finally:
        with _janitor_lock:
            JANITOR_STATE["running"] = False
    return True


def _auto_janitor_loop():
    """后台守护线程:启动 60 秒后先跑一次,之后每 AUTO_JANITOR_HOURS 小时跑一次。
    AUTO_JANITOR_HOURS <= 0 表示关闭自动补记(仅保留手动「立即补记」按钮/API)。
    """
    try:
        if AUTO_JANITOR_HOURS <= 0:
            JANITOR_STATE["next_run_at"] = None
            return  # 自动定时关闭
        first_run_at = datetime.now() + timedelta(seconds=60)
        JANITOR_STATE["next_run_at"] = first_run_at.strftime("%Y-%m-%d %H:%M:%S")
        time.sleep(60)
        _run_janitor_once()
        while True:
            next_dt = datetime.now() + timedelta(hours=AUTO_JANITOR_HOURS)
            JANITOR_STATE["next_run_at"] = next_dt.strftime("%Y-%m-%d %H:%M:%S")
            time.sleep(max(60, AUTO_JANITOR_HOURS * 3600))
            _run_janitor_once()
    except Exception:
        # 后台线程整体崩溃也不能带倒主面板;状态卡片会因为 next_run_at 停更而看出异常
        pass


def start_auto_janitor_thread():
    t = threading.Thread(target=_auto_janitor_loop, name="auto-janitor", daemon=True)
    t.start()


LABELS = {
    "reentry.md": "醒来第一包",
    "reading_policy.md": "读取政策",
    "relationship_timeline.md": "关系年表",
    "user_portrait.md": "她的画像",
    "ai_self_portrait.md": "AI 自画像(六问)",
    "ai_self_notes.md": "AI 私人笔记",
    "home.md": "这个家怎么运转",
    "rereadings.md": "年轮",
    "episodes.jsonl": "关系片段(证据层)",
    "state_log.jsonl": "八维状态史",
    "episodes.candidates.jsonl": "候选层(待 AI closeout 吸收)",
}

# 编辑前需要二次确认的文件:这是它的声音,手改会盖掉。
GUARD_CONFIRM = {
    "ai_self_portrait.md": "这是它的自画像,手改会盖掉它的声音。确定?",
    "ai_self_notes.md": "这是它的私人笔记,手改会盖掉它的声音。确定?",
}

EP_ID_RE = re.compile(r"ep\d+")


# ---------- 基础文件工具 ----------

def list_files():
    if not ROOT.exists():
        return []
    return sorted(
        [f.name for f in ROOT.iterdir() if f.is_file() and f.suffix in (".md", ".jsonl")]
    )


def safe_path(name):
    name = Path(unquote(name)).name  # 去掉任何路径成分
    if name in list_files():
        return ROOT / name
    return None


def read_text(path):
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def sha256_text(content):
    return hashlib.sha256(str(content or "").encode("utf-8")).hexdigest()


def _valid_schedule_timezone(value):
    text = str(value or "").strip()
    if not text or ZoneInfo is None:
        return False
    try:
        ZoneInfo(text)
        return True
    except Exception:
        return False


def _valid_schedule_clock(value):
    return bool(re.match(r"^(?:[01]\d|2[0-3]):[0-5]\d$", str(value or "").strip()))


def _schedule_revision(payload):
    return sha256_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _schedule_now_payload(config):
    now_utc = datetime.now(timezone.utc)
    tz = ZoneInfo(config["timezone"])
    local = now_utc.astimezone(tz)
    offset = local.strftime("%z")
    offset_display = f"UTC{offset[:3]}:{offset[3:]}" if len(offset) == 5 else "UTC"
    return {
        "utc_now": now_utc.isoformat().replace("+00:00", "Z"),
        "local_now": local.isoformat(),
        "offset": offset_display,
        "is_night_skip": desire_schedule_is_night(local, config),
    }


def desire_schedule_is_night(local_dt, config):
    if not config.get("night_skip_enabled") or config.get("night_start") == config.get("night_end"):
        return False
    current = local_dt.hour * 60 + local_dt.minute
    start = int(config["night_start"][:2]) * 60 + int(config["night_start"][3:])
    end = int(config["night_end"][:2]) * 60 + int(config["night_end"][3:])
    return (current >= start or current < end) if start > end else (start <= current < end)


def load_desire_schedule_config():
    config = dict(DESIRE_SCHEDULE_DEFAULTS)
    raw = read_json_file(DESIRE_SCHEDULE_FILE, default={})
    if isinstance(raw, dict):
        for key in config:
            if key in raw:
                config[key] = raw[key]
    if not _valid_schedule_timezone(config.get("timezone")):
        config["timezone"] = DESIRE_SCHEDULE_DEFAULTS["timezone"]
    if config.get("interval_minutes") != 55:
        config["interval_minutes"] = 55
    for key in ("night_start", "night_end"):
        if not _valid_schedule_clock(config.get(key)):
            config[key] = DESIRE_SCHEDULE_DEFAULTS[key]
    config["enabled"] = config.get("enabled") is not False
    config["night_skip_enabled"] = config.get("night_skip_enabled") is not False
    config["revision"] = _schedule_revision(config)
    config["path"] = str(DESIRE_SCHEDULE_FILE)
    config["timezone_options"] = _timezone_options()
    try:
        runtime_env = resolve_runtime_env(resolve_runtime_state_dir())
    except Exception:
        runtime_env = os.environ
    config["master_enabled"] = str(runtime_env.get("CYBERBOSS_DESIRE_DRIVEN", "0")).strip().lower() in {"1", "true", "yes", "on"}
    config["now"] = _schedule_now_payload(config)
    telemetry = read_jsonl(DESIRE_TELEMETRY_FILE)
    config["last_call"] = telemetry[-1] if telemetry else None
    plan = read_json_file(DESIRE_PLAN_FILE, default={})
    config["next_planned_at"] = plan.get("nextPlannedAt") if isinstance(plan, dict) else None
    return config


def validate_desire_schedule_body(obj):
    if not isinstance(obj, dict):
        return False, "body 必须是 JSON 对象"
    if "timezone" in obj and not _valid_schedule_timezone(obj.get("timezone")):
        return False, "timezone 必须是有效 IANA 时区"
    for key in ("night_start", "night_end"):
        if key in obj and not _valid_schedule_clock(obj.get(key)):
            return False, f"{key} 必须是 HH:mm"
    if "interval_minutes" in obj and obj.get("interval_minutes") != 55:
        return False, "interval_minutes 当前固定为 55"
    for key in ("enabled", "night_skip_enabled"):
        if key in obj and not isinstance(obj[key], bool):
            return False, f"{key} 必须是 true/false"
    allowed = set(DESIRE_SCHEDULE_DEFAULTS)
    if any(key not in allowed for key in obj):
        return False, "包含不允许的字段"
    if obj.get("night_start") == obj.get("night_end") and "night_start" in obj and "night_end" in obj:
        # Equal endpoints are valid but explicitly mean no active interval.
        pass
    return True, None


def save_desire_schedule_config(obj, expected_revision="", source="520"):
    current = load_desire_schedule_config()
    current_revision = current["revision"]
    if expected_revision and expected_revision != current_revision:
        raise RuntimeError("调度配置已被其他进程修改，请刷新后重试。")
    body = {key: value for key, value in obj.items() if key not in {"expected_revision", "source"}}
    ok, error = validate_desire_schedule_body(body)
    if not ok:
        raise ValueError(error)
    next_config = dict(DESIRE_SCHEDULE_DEFAULTS)
    for key in next_config:
        next_config[key] = body.get(key, current.get(key, next_config[key]))
    next_config["revision"] = _schedule_revision(next_config)
    DESIRE_SCHEDULE_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    if DESIRE_SCHEDULE_FILE.exists():
        backup = DESIRE_SCHEDULE_BACKUP_DIR / f"{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}-{current_revision[:10]}.json"
        write_text_atomic(backup, read_text(DESIRE_SCHEDULE_FILE))
    write_text_atomic(DESIRE_SCHEDULE_FILE, json.dumps(next_config, ensure_ascii=False, indent=2) + "\n")
    DESIRE_SCHEDULE_AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with DESIRE_SCHEDULE_AUDIT_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "event": "desire_schedule_saved",
            "source": str(source or "520")[:80],
            "before_revision": current_revision,
            "after_revision": next_config["revision"],
            "timezone": next_config["timezone"],
        }, ensure_ascii=False) + "\n")
    return load_desire_schedule_config()


def repair_mojibake_text(value):
    """Repair the common UTF-8-as-GBK corruption for display only."""
    text = str(value or "")
    markers = "鍚鐨鏄浠绗鎴濂璇杩锛銆鈥"
    before = sum(text.count(char) for char in markers)
    if before < 1:
        return text
    try:
        repaired = text.encode("gb18030").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text
    after = sum(repaired.count(char) for char in markers)
    return repaired if after < before else text


def normalize_display_value(value):
    if isinstance(value, str):
        return repair_mojibake_text(value)
    if isinstance(value, list):
        return [normalize_display_value(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_display_value(item) for key, item in value.items()}
    return value


def write_text_atomic(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def copy_json(value):
    return json.loads(json.dumps(value, ensure_ascii=False))


def read_json_file(path, default=None):
    path = Path(path)
    if not path.exists():
        return {} if default is None else copy_json(default)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {} if default is None else copy_json(default)
    return value


def iso_mtime(path):
    path = Path(path)
    if not path.exists():
        return None
    try:
        return datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _safe_id(value, fallback):
    text = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "").strip()).strip("_")
    return text[:64] or fallback


def normalize_context_layout(payload):
    raw_groups = payload.get("groups") if isinstance(payload, dict) else None
    defaults = {group["id"]: group for group in DEFAULT_CONTEXT_LAYOUT["groups"]}
    incoming = {}
    if isinstance(raw_groups, list):
        for raw_group in raw_groups:
            if not isinstance(raw_group, dict):
                continue
            group_id = str(raw_group.get("id") or "").strip()
            if group_id in defaults and group_id not in incoming:
                incoming[group_id] = raw_group

    order = [
        str(item.get("id") or "").strip()
        for item in (raw_groups or [])
        if isinstance(item, dict)
    ]
    middle_ids = [item for item in order if item in defaults and item not in {"base", "current"}]
    middle_ids += [
        group_id for group_id in defaults
        if group_id not in {"base", "current"} and group_id not in middle_ids
    ]

    groups = []
    for group_id in ["base", *middle_ids, "current"]:
        default_group = defaults[group_id]
        raw_group = incoming.get(group_id, {})
        fixed = default_group.get("fixed")
        raw_modules = raw_group.get("modules")
        if not isinstance(raw_modules, list):
            raw_modules = default_group.get("modules", [])
        modules = []
        seen = set()
        for index, raw_module in enumerate(raw_modules[:40]):
            if not isinstance(raw_module, dict):
                continue
            module_id = _safe_id(raw_module.get("id"), f"module_{index + 1}")
            if module_id in seen:
                module_id = f"{module_id}_{index + 1}"
            seen.add(module_id)
            name = str(raw_module.get("name") or "").strip()[:160]
            if not name:
                continue
            modules.append({
                "id": module_id,
                "name": name,
                "enabled": raw_module.get("enabled") is not False,
            })
        group = {
            "id": group_id,
            "title": default_group["title"],
            "subtitle": str(raw_group.get("subtitle") or default_group.get("subtitle") or "")[:80],
            "enabled": True if fixed else raw_group.get("enabled") is not False,
            "modules": modules,
        }
        if fixed:
            group["fixed"] = fixed
        if default_group.get("runtime_gate"):
            group["runtime_gate"] = default_group["runtime_gate"]
        groups.append(group)
    return {"version": 1, "groups": groups}


def _context_meta():
    value = read_json_file(CONTEXT_META_FILE, default={})
    return value if isinstance(value, dict) else {}


def _write_context_meta(**updates):
    meta = _context_meta()
    meta.update(updates)
    write_text_atomic(CONTEXT_META_FILE, json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    return meta


def context_snapshot_slots():
    return ("default", "last_auto", "slot1", "slot2", "slot3")


def context_snapshot_path(slot):
    slot = str(slot or "").strip().lower()
    if slot not in context_snapshot_slots():
        raise ValueError("invalid context snapshot slot")
    return CONTEXT_SNAPSHOT_DIR / f"{slot}.json"


def load_context_layout():
    if not CONTEXT_LAYOUT_FILE.exists():
        return normalize_context_layout(DEFAULT_CONTEXT_LAYOUT)
    value = read_json_file(CONTEXT_LAYOUT_FILE, default=DEFAULT_CONTEXT_LAYOUT)
    return normalize_context_layout(value if isinstance(value, dict) else DEFAULT_CONTEXT_LAYOUT)


def _write_context_snapshot(slot, layout):
    CONTEXT_SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = context_snapshot_path(slot)
    write_text_atomic(path, json.dumps(normalize_context_layout(layout), ensure_ascii=False, indent=2) + "\n")
    return path


def context_snapshot_entries():
    entries = []
    for slot in context_snapshot_slots():
        path = context_snapshot_path(slot)
        entries.append({
            "slot": slot,
            "exists": slot == "default" or path.exists(),
            "updated_at": None if slot == "default" else iso_mtime(path),
        })
    return entries


def context_layout_payload():
    meta = _context_meta()
    return {
        "layout": load_context_layout(),
        "path": str(CONTEXT_LAYOUT_FILE),
        "updated_at": iso_mtime(CONTEXT_LAYOUT_FILE),
        "last_saved_at": meta.get("last_saved_at"),
        "last_saved_by": meta.get("last_saved_by"),
        "snapshots": context_snapshot_entries(),
    }


def save_context_layout(payload, saved_by="520 context"):
    current = load_context_layout()
    if CONTEXT_LAYOUT_FILE.exists():
        _write_context_snapshot("last_auto", current)
    normalized = normalize_context_layout(payload if isinstance(payload, dict) else {})
    write_text_atomic(CONTEXT_LAYOUT_FILE, json.dumps(normalized, ensure_ascii=False, indent=2) + "\n")
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    _write_context_meta(last_saved_at=now, last_saved_by=str(saved_by or "520 context")[:120])
    return context_layout_payload()


def archive_context_snapshot(slot):
    slot = str(slot or "").strip().lower()
    if slot not in {"slot1", "slot2", "slot3"}:
        raise ValueError("only slot1/slot2/slot3 can be archived")
    path = _write_context_snapshot(slot, load_context_layout())
    return {"slot": slot, "path": str(path), "updated_at": iso_mtime(path)}


def restore_context_snapshot(slot, saved_by="520 restore"):
    slot = str(slot or "").strip().lower()
    if slot == "default":
        layout = copy_json(DEFAULT_CONTEXT_LAYOUT)
    else:
        path = context_snapshot_path(slot)
        if not path.exists():
            raise FileNotFoundError(f"context snapshot missing: {slot}")
        layout = read_json_file(path, default=DEFAULT_CONTEXT_LAYOUT)
    return save_context_layout(layout, saved_by=saved_by)


def _todo_meta():
    value = read_json_file(TODO_META_FILE, default={})
    return value if isinstance(value, dict) else {}


def todo_payload():
    meta = _todo_meta()
    return {
        "path": str(TODO_FILE),
        "content": read_text(TODO_FILE),
        "updated_at": iso_mtime(TODO_FILE),
        "last_saved_at": meta.get("last_saved_at"),
        "last_saved_by": meta.get("last_saved_by"),
    }


def save_todo_content(content, saved_by="520 context"):
    TODO_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    if TODO_FILE.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup = TODO_BACKUP_DIR / f"{TODO_FILE.stem}.{stamp}{TODO_FILE.suffix or '.md'}"
        write_text_atomic(backup, read_text(TODO_FILE))
    write_text_atomic(TODO_FILE, str(content or ""))
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    write_text_atomic(
        TODO_META_FILE,
        json.dumps({
            "last_saved_at": now,
            "last_saved_by": str(saved_by or "520 context")[:120],
        }, ensure_ascii=False, indent=2) + "\n",
    )
    return todo_payload()


def run_git_text(repo_path, args):
    repo_path = Path(repo_path)
    if not repo_path.is_dir():
        return ""
    git_command = "git.exe" if os.name == "nt" else "git"
    try:
        proc = subprocess.run(
            [git_command, "-C", str(repo_path), *args],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def compute_context_overview():
    repo_text = (
        os.environ.get("CYBERBOSS_CONTINUITY_WORKTREE", "").strip()
        or os.environ.get("CYBERBOSS_HOME", "").strip()
    )
    repo_path = Path(repo_text) if repo_text else DASHBOARD_WORKSPACE_ROOT
    return {
        "workspace_root": str(DASHBOARD_WORKSPACE_ROOT),
        "repo": {
            "path": str(repo_path),
            "branch": run_git_text(repo_path, ["branch", "--show-current"]),
            "commit": run_git_text(repo_path, ["rev-parse", "HEAD"]),
            "dirty": bool(run_git_text(repo_path, ["status", "--short"])),
        },
        "paths": {
            "memory": str(ROOT),
            "continuity": str(CONTINUITY_DIR),
            "state": str(DASHBOARD_STATE_DIR),
            "todo": str(TODO_FILE),
            "context_layout": str(CONTEXT_LAYOUT_FILE),
        },
        "gates": load_context_gates(),
        "modules": compute_module_state(),
    }


def read_jsonl(path):
    """逐行解析 jsonl,跳过坏行,不抛异常。"""
    rows = []
    if not path.exists():
        return rows
    for i, line in enumerate(read_text(path).split("\n")):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows


def count_chars(text):
    """字数统计:去掉空白与常见 markdown 标记字符后计非空白字符数。"""
    if not text:
        return 0
    stripped = re.sub(r"\s+", "", text)
    return len(stripped)


def parse_time(s):
    """宽松解析 'YYYY-MM-DD HH:MM' 或 'YYYY-MM-DD' 之类。失败返回 None。"""
    if not s:
        return None
    s = s.strip()
    try:
        iso_text = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(iso_text)
        if dt.tzinfo is not None:
            return dt.astimezone().replace(tzinfo=None)
        return dt
    except Exception:
        pass
    # 只取形如 2026-07-04 13:00 或 2026-07-04 的前缀,时间范围类("08:45-09:36")取起点
    m = re.match(r"(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?", s)
    if not m:
        return None
    date_part = m.group(1)
    time_part = m.group(2) or "00:00"
    try:
        return datetime.strptime(date_part + " " + time_part, "%Y-%m-%d %H:%M")
    except Exception:
        return None


def normalize_utc_iso(value):
    """Return an explicit UTC timestamp for API consumers; never apply a fixed offset."""
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except Exception:
        return None


DESIRE_WINDOW_START_HOUR = 6
DESIRE_WINDOW_END_HOUR = 22
DESIRE_HISTORY_DIM_TO_LABEL = {
    "attachment": "依恋",
    "curiosity": "好奇",
    "reflection": "沉思",
    "duty": "责任",
    "social": "社交",
    "fatigue": "疲惫",
    "libido": "性欲",
    "stress": "压力",
}


def compute_active_window_gap_hours(start_dt, end_dt=None):
    if not start_dt:
        return None
    end_dt = end_dt or datetime.now()
    if end_dt <= start_dt:
        return 0.0
    total_seconds = 0.0
    day_cursor = datetime(start_dt.year, start_dt.month, start_dt.day)
    end_day = datetime(end_dt.year, end_dt.month, end_dt.day)
    while day_cursor <= end_day:
        window_start = day_cursor + timedelta(hours=DESIRE_WINDOW_START_HOUR)
        window_end = day_cursor + timedelta(hours=DESIRE_WINDOW_END_HOUR)
        seg_start = max(start_dt, window_start)
        seg_end = min(end_dt, window_end)
        if seg_end > seg_start:
            total_seconds += (seg_end - seg_start).total_seconds()
        day_cursor += timedelta(days=1)
    return round(total_seconds / 3600.0, 1)


# ---------- 健康度计算 ----------

def resolve_desire_state_file():
    explicit = os.environ.get("CYBERBOSS_DESIRE_STATE")
    if explicit:
        return Path(explicit)
    state_dir = os.environ.get("CYBERBOSS_STATE_DIR")
    if state_dir:
        return Path(state_dir) / "desire-state.json"
    raise RuntimeError("CYBERBOSS_STATE_DIR or CYBERBOSS_DESIRE_STATE is required.")


def get_file_status(path, preview_chars=0):
    info = {
        "exists": path.exists(),
        "path": str(path),
        "updated_at": None,
        "hours_since_update": None,
        "preview": "",
    }
    if not info["exists"]:
        return info
    stat = path.stat()
    updated = datetime.fromtimestamp(stat.st_mtime)
    info["updated_at"] = updated.strftime("%Y-%m-%d %H:%M:%S")
    info["hours_since_update"] = round((datetime.now() - updated).total_seconds() / 3600.0, 1)
    if preview_chars > 0:
        info["preview"] = read_text(path).strip()[:preview_chars]
    return info


def load_desire_state():
    desire_state_file = resolve_desire_state_file()
    info = {
        "exists": desire_state_file.exists(),
        "path": str(desire_state_file),
        "data": None,
        "updated_at": None,
        "hours_since_update": None,
    }
    if not info["exists"]:
        return info
    try:
        data = json.loads(read_text(desire_state_file))
    except Exception as e:
        info["error"] = str(e)
        return info
    info["data"] = data
    info["dimensions"] = extract_desire_dimensions(data)
    info["dimension_count"] = len(info["dimensions"])
    info["missing_dimensions"] = [
        label for label in DESIRE_HISTORY_DIM_TO_LABEL.values()
        if label not in info["dimensions"]
    ]
    if isinstance(data, dict):
        for key in ("updatedAt", "lastUpdated", "lastUpdate", "updated_at", "last_updated", "last_update", "timestamp", "time", "ts"):
            value = data.get(key)
            if value is None:
                continue
            value = str(value)
            dt = parse_time(value)
            if dt:
                info["updated_at"] = normalize_utc_iso(value) or value
                info["hours_since_update"] = round((datetime.now() - dt).total_seconds() / 3600.0, 1)
            else:
                info["updated_at"] = value
            break
    return info


def extract_desire_dimensions(data):
    if not isinstance(data, dict):
        return {}
    result = {}
    drives = data.get("drives")
    if isinstance(drives, list):
        for drive in drives:
            if not isinstance(drive, dict):
                continue
            key = str(drive.get("key") or "").strip()
            label = DESIRE_HISTORY_DIM_TO_LABEL.get(key) or str(drive.get("label") or "").strip()
            score = normalize_octant_score(drive.get("score"))
            if label in DESIRE_HISTORY_DIM_TO_LABEL.values() and score is not None:
                result[label] = score
    for container_key in ("drive", "scores"):
        container = data.get(container_key)
        if not isinstance(container, dict):
            continue
        for key, label in DESIRE_HISTORY_DIM_TO_LABEL.items():
            score = normalize_octant_score(container.get(key))
            if score is not None:
                result[label] = score
    for key, label in DESIRE_HISTORY_DIM_TO_LABEL.items():
        score = normalize_octant_score(data.get(key))
        if score is not None:
            result[label] = score
    return result


def resolve_desire_history_file():
    return resolve_runtime_state_dir() / "desire-history.jsonl"


CONTEXT_GATE_KEYS = ("reentry", "current_state", "memory_context")


def load_context_gates():
    """读 CYBERBOSS_STATE_DIR/context-gates.json;缺文件/缺键 = 默认开。"""
    gates = {key: True for key in CONTEXT_GATE_KEYS}
    try:
        gate_file = resolve_runtime_state_dir() / "context-gates.json"
        if gate_file.exists():
            parsed = json.loads(read_text(gate_file))
            for key in CONTEXT_GATE_KEYS:
                if isinstance(parsed, dict) and key in parsed:
                    gates[key] = parsed[key] is not False
            if isinstance(parsed, dict) and parsed.get("updated_at"):
                gates["updated_at"] = str(parsed["updated_at"])
    except Exception:
        pass
    return gates


def normalize_octant_score(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    try:
        return round(float(str(value).strip()), 2)
    except Exception:
        return None


def normalize_desire_history_row(row):
    if not isinstance(row, dict):
        return None
    raw_time = row.get("time") or row.get("updated_at") or row.get("updatedAt")
    dt = parse_time(str(raw_time or ""))
    if not dt:
        return None
    out = {
        "time": normalize_utc_iso(raw_time) or str(raw_time),
        "most_want": str(row.get("most_want") or "").strip(),
        "note": str(row.get("note") or row.get("source") or "runtime desire-history").strip(),
    }
    for key, label in DESIRE_HISTORY_DIM_TO_LABEL.items():
        score = row.get(key)
        if score is None and isinstance(row.get("drive"), dict):
            score = row["drive"].get(key)
        if score is None and isinstance(row.get("scores"), dict):
            score = row["scores"].get(key)
        if score is None:
            drives = row.get("drives")
            if isinstance(drives, list):
                for drive in drives:
                    if str((drive or {}).get("key") or "").strip() == key:
                        score = drive.get("score")
                        break
        out[label] = normalize_octant_score(score)
    return out


def annotate_octant_gaps(rows):
    parsed = []
    for raw in rows or []:
        row = dict(raw)
        dt = parse_time(row.get("time", ""))
        parsed.append((dt, row))
    parsed.sort(key=lambda x: (x[0] is None, x[0]))
    for i, (dt, row) in enumerate(parsed):
        row["_gap"] = False
        row["_gap_hours"] = None
        if i > 0 and dt is not None and parsed[i - 1][0] is not None:
            delta_h = (dt - parsed[i - 1][0]).total_seconds() / 3600.0
            if delta_h > 2:
                row["_gap"] = True
                row["_gap_hours"] = round(delta_h, 1)
    return [row for _, row in parsed]


def load_octant_history_rows(limit=None):
    desire_history_file = resolve_desire_history_file()
    desire_rows = [normalize_desire_history_row(row) for row in read_jsonl(desire_history_file)]
    desire_rows = [row for row in desire_rows if row]
    if desire_rows:
        # 连续历史存在但行数还很少时（刚接线），把冻结 state_log 中更早的行
        # 作为只读历史前缀拼进来，避免八维页只剩 1 条数据。只读，不写文件。
        merged = list(desire_rows)
        earliest = min(
            (parse_time(r.get("time", "")) for r in desire_rows if parse_time(r.get("time", ""))),
            default=None,
        )
        legacy_used = 0
        if earliest is not None:
            for raw in read_jsonl(ROOT / "state_log.jsonl"):
                if not isinstance(raw, dict):
                    continue
                dt = parse_time(str(raw.get("time") or ""))
                if dt is not None and dt < earliest:
                    row = dict(raw)
                    row.setdefault("note", "state_log(frozen)")
                    merged.append(row)
                    legacy_used += 1
        rows = annotate_octant_gaps(merged)
        if limit:
            rows = rows[-limit:]
        return {
            "rows": rows,
            "source": "desire_history+state_log" if legacy_used else "desire_history",
            "path": str(desire_history_file),
            "row_count": len(desire_rows),
            "legacy_prefix_count": legacy_used,
            "fallback": False,
        }
    rows = annotate_octant_gaps(read_jsonl(ROOT / "state_log.jsonl"))
    if limit:
        rows = rows[-limit:]
    return {
        "rows": rows,
        "source": "state_log",
        "path": str(ROOT / "state_log.jsonl"),
        "row_count": len(rows),
        "fallback": True,
    }


def read_env_file(path):
    data = {}
    if not path.exists():
        return data
    for raw in read_text(path).splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        data[key] = value
    return data


def is_truthy_env(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def resolve_runtime_env(state_dir=None):
    state_dir = state_dir or resolve_runtime_state_dir()
    merged = {}
    manifest = read_json_file(DASHBOARD_WORKSPACE_ROOT / "settings" / "manifest.json", default={})
    telegram = manifest.get("telegram") if isinstance(manifest, dict) else {}
    configured_env = (telegram or {}).get("env_file") if isinstance(telegram, dict) else None
    if configured_env:
        merged.update(read_env_file(Path(configured_env)))
    merged.update(read_env_file(state_dir / ".env"))
    merged.update(resolve_runtime_launch_env(state_dir))
    for key, value in os.environ.items():
        if key.startswith("CYBERBOSS_"):
            merged[key] = value
    return merged


def resolve_runtime_launch_env(state_dir=None):
    state_dir = state_dir or resolve_runtime_state_dir()
    return read_env_file(state_dir / "logs" / "launch-env.txt")


def is_runtime_background_write_enabled(state_dir=None):
    state_dir = state_dir or resolve_runtime_state_dir()
    env = resolve_runtime_env(state_dir)
    launch_env = resolve_runtime_launch_env(state_dir)
    return (
        is_truthy_env(env.get("CYBERBOSS_MEMORY_BACKGROUND_WRITE"))
        or is_truthy_env(launch_env.get("CYBERBOSS_MEMORY_BACKGROUND_WRITE"))
    )


def resolve_runtime_memory_dir(state_dir=None):
    state_dir = state_dir or resolve_runtime_state_dir()
    return state_dir / "memory"


def compute_runtime_memory_status():
    state_dir = resolve_runtime_state_dir()
    memory_dir = resolve_runtime_memory_dir(state_dir)
    seven_day = get_file_status(memory_dir / "7-day-memory.md", preview_chars=420)
    pending = get_file_status(memory_dir / "pending-promises.md", preview_chars=240)
    relationships = get_file_status(memory_dir / "relationships.md", preview_chars=240)
    profile = get_file_status(memory_dir / "profile.md", preview_chars=240)
    return {
        "state_dir": str(state_dir),
        "memory_dir": str(memory_dir),
        "env_path": str(state_dir / ".env"),
        "background_write_enabled": is_runtime_background_write_enabled(state_dir),
        "seven_day": seven_day,
        "pending_promises": pending,
        "relationships": relationships,
        "profile": profile,
    }


def compute_telegram_bridge_status():
    state_dir = resolve_runtime_state_dir()
    log_path = state_dir / "telegram-poller.log"
    info = {
        "exists": log_path.exists(),
        "path": str(log_path),
        "latest_gap": None,
        "latest_long_gap": None,
        "recent_gaps": [],
        "recent_long_gaps": [],
        "runtime_exit_at": None,
    }
    if not log_path.exists():
        return info
    timed = []
    for raw in read_text(log_path).splitlines()[-4000:]:
        m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$", raw)
        if not m:
            continue
        dt = parse_time(m.group(1))
        if not dt:
            continue
        timed.append((dt, m.group(1), m.group(2)))
    if not timed:
        return info
    cutoff = datetime.now() - timedelta(days=2)
    gaps = []
    failure_started_dt = None
    failure_started_raw = ""
    failure_reason = ""
    for dt, raw_ts, message in timed:
        if dt < cutoff:
            continue
        lower = message.lower()
        is_failure = (
            "poll failed" in lower
            or "sendtyping failed" in lower
            or "sendtext failed" in lower
            or "runtime process exited unexpectedly" in lower
        )
        is_recovery = (
            "getupdates count=" in lower
            or "state=enabled" in lower
        )
        if is_failure and not failure_started_dt:
            failure_started_dt = dt
            failure_started_raw = raw_ts
            failure_reason = message.strip()
            continue
        if is_failure:
            failure_reason = message.strip()
            continue
        if failure_started_dt and is_recovery:
            delta_min = (dt - failure_started_dt).total_seconds() / 60.0
            gaps.append({
                "from": failure_started_raw,
                "to": raw_ts,
                "minutes": round(delta_min, 1),
                "reason": failure_reason,
            })
            failure_started_dt = None
            failure_started_raw = ""
            failure_reason = ""
    info["recent_gaps"] = gaps[-5:]
    long_gaps = [gap for gap in gaps if gap.get("minutes", 0) >= 120]
    info["recent_long_gaps"] = long_gaps[-5:]
    info["latest_gap"] = gaps[-1] if gaps else None
    info["latest_long_gap"] = long_gaps[-1] if long_gaps else None
    for _, raw_ts, message in reversed(timed):
        if "Runtime process exited unexpectedly" in message:
            info["runtime_exit_at"] = raw_ts
            break
    return info


def compute_health():
    now = datetime.now()

    # reentry 字数
    reentry_path = ROOT / "reentry.md"
    reentry_text = read_text(reentry_path)
    reentry_chars = count_chars(reentry_text)

    # 八维历史最后写入时间 + 断档段落(最近 7 天)
    octant_history = load_octant_history_rows()
    state_rows = octant_history["rows"]
    last_state_time = None
    last_state_dt = None
    if state_rows:
        last_state_time = state_rows[-1].get("time", "")
        last_state_dt = parse_time(last_state_time)
    hours_since_state = None
    if last_state_dt:
        hours_since_state = compute_active_window_gap_hours(last_state_dt, now)

    # 断档段落:相邻两行间隔 > 2 小时,且落在最近 7 天内
    gaps = []
    cutoff = now - timedelta(days=7)
    parsed_times = []
    for row in state_rows:
        dt = parse_time(row.get("time", ""))
        if dt:
            parsed_times.append((dt, row.get("time", "")))
    for i in range(1, len(parsed_times)):
        prev_dt, prev_raw = parsed_times[i - 1]
        cur_dt, cur_raw = parsed_times[i]
        delta_h = (cur_dt - prev_dt).total_seconds() / 3600.0
        if delta_h > 2 and cur_dt >= cutoff:
            gaps.append({
                "from": prev_raw, "to": cur_raw,
                "hours": round(delta_h, 1),
            })

    desire_state = load_desire_state()
    runtime_memory = compute_runtime_memory_status()
    bridge_status = compute_telegram_bridge_status()
    formal_reentry = get_file_status(ROOT / "reentry.md")
    formal_episodes = get_file_status(ROOT / "episodes.jsonl")
    auto_reentry = get_file_status(ROOT / "reentry.extracted.md", preview_chars=500)
    auto_candidates = get_file_status(ROOT / "episodes.candidates.jsonl")

    # episodes 总数 + importance 分布
    episodes = read_jsonl(ROOT / "episodes.jsonl")
    importance_dist = {str(i): 0 for i in range(1, 6)}
    for e in episodes:
        imp = e.get("importance")
        key = str(imp) if str(imp) in importance_dist else None
        if key:
            importance_dist[key] += 1

    # 待审候选
    candidates = read_jsonl(ROOT / "episodes.candidates.jsonl")
    candidates_n = len(candidates)

    # janitor 上次运行
    janitor_last_run = None
    janitor_path = ROOT / ".janitor_state.json"
    if janitor_path.exists():
        try:
            j = json.loads(read_text(janitor_path))
            janitor_last_run = j.get("last_run")
        except Exception:
            janitor_last_run = None

    # .backups 份数
    backups_count = 0
    if BACKUPS.exists():
        backups_count = len([f for f in BACKUPS.iterdir() if f.is_file()])

    # 顶部横条异常判定
    alerts = []
    if not desire_state.get("exists"):
        alerts.append({
            "level": "amber",
            "text": "未找到 desire-state.json，实时八维心跳未接通",
        })
    elif desire_state.get("error"):
        alerts.append({
            "level": "red",
            "text": f"desire-state.json 读取失败: {desire_state['error']}",
        })
    elif desire_state.get("updated_at") and parse_time(desire_state["updated_at"]):
        desire_gap_h = compute_active_window_gap_hours(parse_time(desire_state["updated_at"]), now)
        if desire_gap_h is not None and desire_gap_h > 2:
            alerts.append({
                "level": "amber",
                "text": f"desire-state.json 已错过约 {desire_gap_h:.1f} 小时的八维心跳",
            })
    elif desire_state.get("hours_since_update") is not None and desire_state["hours_since_update"] > 24:
        alerts.append({
            "level": "amber",
            "text": f"desire-state.json 距今 {desire_state['hours_since_update']:.1f} 小时未更新",
        })

    if candidates_n > 0:
        alerts.append({"level": "amber", "text": f"episodes.candidates.jsonl 有 {candidates_n} 条待 AI closeout 吸收"})

    if not runtime_memory["background_write_enabled"]:
        alerts.append({
            "level": "amber",
            "text": "runtime 7-day memory 背景写入未开启；~/.cyberboss.../memory/7-day-memory.md 不会自动更新",
        })
    elif runtime_memory["seven_day"].get("hours_since_update") is not None and runtime_memory["seven_day"]["hours_since_update"] > 24:
        alerts.append({
            "level": "amber",
            "text": f"7-day-memory.md 距今 {runtime_memory['seven_day']['hours_since_update']:.1f} 小时未更新",
        })

    formal_dt = parse_time(formal_episodes.get("updated_at") or "")
    auto_dt = parse_time(auto_candidates.get("updated_at") or "")
    if formal_dt and auto_dt and auto_dt - formal_dt > timedelta(hours=12):
        lag_h = round((auto_dt - formal_dt).total_seconds() / 3600.0, 1)
        alerts.append({
            "level": "amber",
            "text": f"自动候选层比正式 episodes 新 {lag_h} 小时，说明 closeout 尚未把候选吸收到正史",
        })

    latest_gap = bridge_status.get("latest_long_gap")
    if latest_gap:
        alerts.append({
            "level": "amber",
            "text": f"Telegram/runtime 最近一次长断联约 {round(latest_gap['minutes'] / 60.0, 1)} 小时（{latest_gap['from']} → {latest_gap['to']}）",
        })

    if reentry_chars > REENTRY_INJECTION_BUDGET:
        # 文案原先硬写「800 字预算」，而实际判据是注入侧的 300。
        # 面板上唯一最重要的那个数字不许和判据不一致（issue #76 目标 4）。
        alerts.append({
            "level": "red",
            "text": f"reentry.md 字数 {reentry_chars} 超过 {REENTRY_INJECTION_BUDGET} 字预算，"
                    f"注入侧会降级为上一份预算内正文或整块跳过",
        })

    if JANITOR_STATE.get("consecutive_failures", 0) >= 2:
        alerts.append({
            "level": "red",
            "text": f"自动补记连续失败 {JANITOR_STATE['consecutive_failures']} 次 — "
                    f"{JANITOR_STATE.get('last_error') or '(无详细信息)'}",
        })

    return {
        "now": now.strftime("%Y-%m-%d %H:%M:%S"),
        "alerts": alerts,
        "reentry_chars": reentry_chars,
        "reentry_budget": REENTRY_INJECTION_BUDGET,
        "episodes_total": len(episodes),
        "importance_dist": importance_dist,
        "octant_history_source": octant_history["source"],
        "octant_history_path": octant_history["path"],
        "octant_history_rows": octant_history["row_count"],
        "octant_history_fallback": octant_history["fallback"],
        "last_state_time": last_state_time,
        "hours_since_state": round(hours_since_state, 1) if hours_since_state is not None else None,
        "gaps_7d": gaps,
        "desire_state": desire_state,
        "memory_files": {
            "formal_reentry": formal_reentry,
            "formal_episodes": formal_episodes,
            "auto_reentry": auto_reentry,
            "auto_candidates": auto_candidates,
        },
        "runtime_memory": runtime_memory,
        "bridge_status": bridge_status,
        "janitor_last_run": janitor_last_run,
        "backups_count": backups_count,
        "candidates_n": candidates_n,
        "auto_janitor": {
            "running": JANITOR_STATE["running"],
            "last_run_at": JANITOR_STATE["last_run_at"],
            "last_returncode": JANITOR_STATE["last_returncode"],
            "last_tail": JANITOR_STATE["last_tail"],
            "last_error": JANITOR_STATE["last_error"],
            "next_run_at": JANITOR_STATE["next_run_at"],
            "interval_hours": AUTO_JANITOR_HOURS,
            "consecutive_failures": JANITOR_STATE.get("consecutive_failures", 0),
        },
    }


# ---------- 时间线 / episodes / rereadings ----------

def compute_episodes_index():
    episodes = read_jsonl(ROOT / "episodes.jsonl")
    by_id = {}
    for e in episodes:
        eid = e.get("id")
        if eid:
            by_id[eid] = e
    return by_id


def compute_rereadings_index():
    """rereadings.md 格式自由(年轮:日期 · ep id · 一句读法),尽量宽松地按行抓 ep id。"""
    text = read_text(ROOT / "rereadings.md")
    # 先去掉 <!-- ... --> 多行注释块(可能跨行),再逐行处理
    text = re.sub(r"<!--[\s\S]*?-->", "", text)
    by_id = {}
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        ids = EP_ID_RE.findall(line)
        for eid in ids:
            by_id.setdefault(eid, []).append(line)
    return by_id


def resolve_runtime_state_dir():
    explicit = os.environ.get("CYBERBOSS_STATE_DIR")
    if explicit:
        return Path(explicit)
    raise RuntimeError("CYBERBOSS_STATE_DIR is required.")


def resolve_cyberboss_project_dir():
    explicit = os.environ.get("CYBERBOSS_PROJECT_ROOT")
    if explicit:
        return Path(explicit)
    raise RuntimeError("CYBERBOSS_PROJECT_ROOT is required.")


def strip_md_comments(text):
    return re.sub(r"<!--[\s\S]*?-->", "", text or "")


def extract_h2_block(text, heading):
    cleaned = text or ""
    pattern = re.compile(
        r"(^##\s+" + re.escape(heading) + r"\s*$)(.*?)(?=^##\s+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(cleaned)
    if not m:
        return ""
    return (m.group(1) + m.group(2)).strip()


def collect_visible_lines(text, limit=6):
    lines = []
    for raw in strip_md_comments(text).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        lines.append(line)
    return lines[-limit:]


def preview_block(text, limit_chars=1200, limit_lines=16):
    lines = []
    total = 0
    for raw in strip_md_comments(text).splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        lines.append(line)
        total += len(line)
        if len(lines) >= limit_lines or total >= limit_chars:
            break
    out = "\n".join(lines).strip()
    if len(out) > limit_chars:
        out = out[:limit_chars].rstrip() + "..."
    return out


def count_jsonl_by_day(path):
    counts = {}
    for row in read_jsonl(path):
        raw = str(row.get("time", "")).strip()
        m = re.match(r"(\d{4}-\d{2}-\d{2})", raw)
        if not m:
            continue
        day = m.group(1)
        counts[day] = counts.get(day, 0) + 1
    return [{"day": day, "count": counts[day]} for day in sorted(counts.keys(), reverse=True)]


def summarize_recent_file_updates(entries, limit=7):
    grouped = {}
    for entry in entries:
        updated_at = entry.get("updated_at")
        if not updated_at:
            continue
        day = updated_at[:10]
        grouped.setdefault(day, []).append(entry.get("label") or entry.get("name") or entry.get("key"))
    out = []
    for day in sorted(grouped.keys(), reverse=True)[:limit]:
        labels = sorted({item for item in grouped[day] if item})
        out.append({"day": day, "items": labels})
    return out


def get_model_overview():
    keys = load_keys()
    try:
        runtime_env = resolve_runtime_env()
    except Exception:
        runtime_env = {}
    return {
        "chat_provider": keys.get("chat_provider") or runtime_env.get("CYBERBOSS_RUNTIME") or "",
        "chat_model": keys.get("chat_model") or runtime_env.get("CYBERBOSS_CLAUDE_MODEL") or "",
        "extract_provider": keys.get("extract_provider") or keys.get("MEM_PROVIDER") or "",
        "extract_model": keys.get("extract_model") or keys.get("GLM_MODEL") or keys.get("DS_MODEL") or "",
    }


def model_label(provider, model, fallback):
    provider = (provider or "").strip()
    model = (model or "").strip()
    if provider or model:
        return " / ".join([p for p in (provider, model) if p])
    return fallback


def resolve_runtime_prompt_path(state_dir=None, project_dir=None):
    state_dir = state_dir or resolve_runtime_state_dir()
    project_dir = project_dir or resolve_cyberboss_project_dir()
    runtime_env = resolve_runtime_env(state_dir)
    configured = str(runtime_env.get("CYBERBOSS_PROMPT_FILE") or "").strip()
    return Path(configured) if configured else (project_dir / "templates" / "weixin-instructions.md")


def list_prompt_backups(limit=30):
    if not PROMPT_BACKUP_DIR.is_dir():
        return []
    rows = []
    for path in sorted(PROMPT_BACKUP_DIR.glob("*.md"), key=lambda item: item.stat().st_mtime, reverse=True)[:limit]:
        content = read_text(path)
        rows.append({
            "name": path.name,
            "updated_at": iso_mtime(path),
            "chars": len(content),
            "sha256": sha256_text(content),
        })
    return rows


def get_runtime_prompt_payload(include_content=True):
    state_dir = resolve_runtime_state_dir()
    project_dir = resolve_cyberboss_project_dir()
    runtime_env = resolve_runtime_env(state_dir)
    path = resolve_runtime_prompt_path(state_dir, project_dir)
    content = read_text(path)
    payload = {
        "path": str(path),
        "exists": path.is_file(),
        "updated_at": iso_mtime(path),
        "chars": len(content),
        "lines": len(content.splitlines()),
        "sha256": sha256_text(content),
        "model": runtime_env.get("CYBERBOSS_CLAUDE_MODEL") or "",
        "runtime": runtime_env.get("CYBERBOSS_RUNTIME") or "",
        "operations_enabled": is_truthy_env(runtime_env.get("CYBERBOSS_INCLUDE_OPERATIONS_PROMPT")),
        "memory_retrieval_enabled": is_truthy_env(runtime_env.get("CYBERBOSS_MEMORY_RETRIEVAL")),
        "background_write_enabled": is_truthy_env(runtime_env.get("CYBERBOSS_MEMORY_BACKGROUND_WRITE")),
        "apply_note": "保存后，Telegram 会在下一条消息自动换干净线程并载入新版本。",
        "backups": list_prompt_backups(),
    }
    if include_content:
        payload["content"] = content
    return payload


def append_prompt_audit(event):
    PROMPT_AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with PROMPT_AUDIT_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def save_runtime_prompt(content, expected_sha256="", source="520"):
    text = str(content or "")
    if not text.strip() or len(text) > 100000 or "\x00" in text:
        raise ValueError("提示词不能为空，且必须小于 100000 字符。")
    path = resolve_runtime_prompt_path()
    current = read_text(path)
    current_sha = sha256_text(current)
    if expected_sha256 and expected_sha256 != current_sha:
        raise RuntimeError("提示词已被其他进程修改，请刷新后重试。")
    if text == current:
        return get_runtime_prompt_payload()
    PROMPT_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = PROMPT_BACKUP_DIR / f"{stamp}-{current_sha[:10]}.md"
    write_text_atomic(backup, current)
    write_text_atomic(path, text)
    append_prompt_audit({
        "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
        "event": "prompt_saved",
        "source": str(source or "520"),
        "path": str(path),
        "before_sha256": current_sha,
        "after_sha256": sha256_text(text),
        "backup": backup.name,
    })
    return get_runtime_prompt_payload()


def restore_runtime_prompt(backup_name, expected_sha256="", source="520"):
    safe_name = Path(str(backup_name or "")).name
    if not safe_name or safe_name != str(backup_name or "") or not safe_name.endswith(".md"):
        raise ValueError("无效的备份版本。")
    backup = PROMPT_BACKUP_DIR / safe_name
    if not backup.is_file():
        raise FileNotFoundError("备份版本不存在。")
    return save_runtime_prompt(read_text(backup), expected_sha256=expected_sha256, source=f"{source}:restore:{safe_name}")


def _context_source_paths():
    state_dir = resolve_runtime_state_dir()
    return {
        "reentry": ROOT / "reentry.md",
        "current_state": state_dir / "context-current-state.md",
        "memory_context": state_dir / "context-memory-override.md",
    }


def _summarize_current_state_for_context():
    payload = load_desire_state()
    data = payload.get("data") if isinstance(payload, dict) else {}
    if not isinstance(data, dict):
        return ""
    intent = data.get("intent") if isinstance(data.get("intent"), dict) else {}
    parts = []
    drive = str(intent.get("drive_key") or "").strip()
    action = str(intent.get("want_action") or intent.get("action") or "").strip()
    reason = str(intent.get("reason") or "").strip()
    if drive:
        parts.append(f"姿态:{drive}")
    if action and action != "none":
        parts.append(f"倾向:{action}")
    if reason:
        parts.append(f"缘由:{reason}")
    if parts:
        return "；".join(parts)[:100]
    most_want = re.sub(r"\s+", " ", str(data.get("most_want") or "")).strip()[:70]
    drives = data.get("drives") if isinstance(data.get("drives"), list) else []
    scored = [row for row in drives if isinstance(row, dict) and row.get("label") and isinstance(row.get("score"), (int, float))]
    scored.sort(key=lambda row: float(row.get("score") or 0), reverse=True)
    drive_text = " ".join(f"{row['label']}{row['score']}{'↑' if row.get('change') == 'up' else ('↓' if row.get('change') == 'down' else '')}" for row in scored[:2])
    return "；".join(item for item in (f"此刻:{most_want}" if most_want else "", drive_text) if item)[:100]


def _read_reentry_last_known_good():
    """只读 loader 落的 last-known-good 副本（issue #76 目标 2）。

    唯一 writer 是 TG 运行时的 `src/core/reentry-loader.js`；面板只读，绝不写它。
    这里只做展示口径对齐，权威判断仍在 node 侧 —— 副本正文的期限钩子过滤不在这里
    重做，所以极端情况下面板显示的降级正文可能比实际注入的多一两行钩子。
    """
    try:
        payload = json.loads((ROOT / ".jobs" / "reentry-last-known-good.json").read_text(encoding="utf-8"))
    except Exception:
        return ""
    if not isinstance(payload, dict):
        return ""
    body = payload.get("body")
    return body if isinstance(body, str) else ""


def get_context_sources_payload():
    gates = load_context_gates()
    prompt = get_runtime_prompt_payload(include_content=True)
    paths = _context_source_paths()
    reentry_text = read_text(paths["reentry"])
    current_override = read_text(paths["current_state"])
    memory_override = read_text(paths["memory_context"])
    # 门开着不等于正文进得去：超预算时 loader 降级用 last-known-good，没有副本就整块
    # 跳过。面板必须照实分开显示 configured 与 effective（issue #76 目标 4），
    # 否则 954 字那种「门开着、注入为零」会继续被显示成正常。
    reentry_gate = bool(gates.get("reentry", True))
    reentry_chars = len(re.sub(r"\s+", "", reentry_text))
    reentry_over_budget = reentry_chars > REENTRY_INJECTION_BUDGET
    reentry_fallback = _read_reentry_last_known_good() if (reentry_gate and reentry_over_budget) else ""
    if not reentry_gate:
        reentry_effective, reentry_effective_content, reentry_degraded = "none", "", "gated_off"
    elif not reentry_over_budget:
        reentry_effective, reentry_effective_content, reentry_degraded = "current", reentry_text, ""
    elif reentry_fallback.strip():
        reentry_effective, reentry_effective_content, reentry_degraded = "fallback", reentry_fallback, "over_budget"
    else:
        reentry_effective, reentry_effective_content, reentry_degraded = "none", "", "over_budget"
    sources = [
        {
            "key": "prompt", "label": "System / Persona", "gate": None,
            "content": prompt.get("content") or "", "effective_content": prompt.get("content") or "",
            "mode": "固定文件", "budget": 100000, "sha256": prompt.get("sha256") or "",
            "updated_at": prompt.get("updated_at"), "model": prompt.get("model") or "",
            "description": "稳定身份、关系边界与回答方式。保存后，下一条消息会自动换干净线程载入。",
        },
        {
            "key": "reentry", "label": "Re-entry", "gate": reentry_gate,
            "content": reentry_text, "effective_content": reentry_effective_content,
            "configured": "on" if reentry_gate else "off",
            "effective": reentry_effective, "degraded_reason": reentry_degraded,
            "chars": reentry_chars,
            "mode": "手写交接", "budget": REENTRY_INJECTION_BUDGET, "sha256": sha256_text(reentry_text),
            "updated_at": iso_mtime(paths["reentry"]),
            "description": "新线程的醒来第一包。关闭或保存后，下一条消息会自动换干净线程。",
        },
        {
            "key": "current_state", "label": "Live State", "gate": gates.get("current_state", True),
            "content": current_override, "effective_content": current_override.strip() or _summarize_current_state_for_context(),
            "mode": "手动覆盖" if current_override.strip() else "八维自动摘要",
            "budget": 100, "sha256": sha256_text(current_override), "updated_at": iso_mtime(paths["current_state"]),
            "description": "留空时自动读取八维摘要；填写后使用这里的文字。保存后下一条消息重建上下文。",
        },
        {
            "key": "memory_context", "label": "Memory Context", "gate": gates.get("memory_context", True),
            "content": memory_override, "effective_content": memory_override.strip(),
            "mode": "手动覆盖" if memory_override.strip() else "按话题自动检索",
            "budget": 4000, "sha256": sha256_text(memory_override), "updated_at": iso_mtime(paths["memory_context"]),
            "description": "留空时按本轮话题检索；填写后只使用这里的非空行。下一轮即时生效。",
        },
    ]
    return {"sources": sources, "gates": gates, "thread_rebuild_policy": "hard_context_change_on_next_turn"}


def save_context_source(key, content, expected_sha256="", source="520"):
    key = str(key or "").strip()
    text = str(content or "")
    if "\x00" in text:
        raise ValueError("内容不能包含空字符。")
    if key == "prompt":
        save_runtime_prompt(text, expected_sha256=expected_sha256, source=source)
        return get_context_sources_payload()
    paths = _context_source_paths()
    if key not in paths:
        raise ValueError("不支持的上下文来源。")
    limits = {"reentry": REENTRY_INJECTION_BUDGET, "current_state": 100, "memory_context": 4000}
    chars = len(re.sub(r"\s+", "", text))
    if chars > limits[key]:
        raise ValueError(f"内容超过 {limits[key]} 个非空白字符预算。")
    path = paths[key]
    current = read_text(path)
    current_sha = sha256_text(current)
    if expected_sha256 and expected_sha256 != current_sha:
        raise RuntimeError("内容已被其他进程修改，请刷新后重试。")
    if text == current:
        return get_context_sources_payload()
    backup_dir = CONTEXT_SOURCE_BACKUP_DIR / key
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = backup_dir / f"{stamp}-{current_sha[:10]}.txt"
    write_text_atomic(backup, current)
    write_text_atomic(path, text)
    append_prompt_audit({
        "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
        "event": "context_source_saved", "context_key": key,
        "source": str(source or "520"), "before_sha256": current_sha,
        "after_sha256": sha256_text(text), "backup": str(backup.relative_to(DASHBOARD_STATE_DIR)),
    })
    return get_context_sources_payload()


def build_entry(path, *, key, label, writer, cadence, purpose, layer,
                preview_chars=0, recent_lines_limit=0, kind="md"):
    info = get_file_status(path, preview_chars=preview_chars)
    entry = {
        "key": key,
        "name": path.name,
        "label": label,
        "path": str(path),
        "exists": info["exists"],
        "updated_at": info["updated_at"],
        "hours_since_update": info["hours_since_update"],
        "preview": info["preview"],
        "writer": writer,
        "cadence": cadence,
        "purpose": purpose,
        "layer": layer,
        "kind": kind,
    }
    if recent_lines_limit > 0:
        entry["recent_lines"] = collect_visible_lines(read_text(path), limit=recent_lines_limit)
    if kind == "jsonl":
        rows = read_jsonl(path)
        entry["rows"] = len(rows)
        day_counts = count_jsonl_by_day(path)
        entry["latest_day"] = day_counts[0]["day"] if day_counts else None
        entry["day_counts"] = day_counts[:7]
    return entry


def compute_injection_overview():
    state_dir = resolve_runtime_state_dir()
    project_dir = resolve_cyberboss_project_dir()
    models = get_model_overview()
    runtime_env = resolve_runtime_env(state_dir)
    runtime_memory_status = compute_runtime_memory_status()
    runtime_instructions = resolve_runtime_prompt_path(state_dir, project_dir)
    template_instructions = project_dir / "templates" / "weixin-instructions.md"
    operations_template = project_dir / "templates" / "weixin-operations.md"
    runtime_memory_dir = resolve_runtime_memory_dir(state_dir)
    runtime_seven_day = runtime_memory_dir / "7-day-memory.md"
    runtime_pending_promises = runtime_memory_dir / "pending-promises.md"
    workspace_state_relay = ROOT / "state.md"
    workspace_pending_promises = ROOT / "pending-promises.md"
    reentry_path = ROOT / "reentry.md"
    sync_script = KIT_DIR / "sync_memory_block.py"

    runtime_text = read_text(runtime_instructions)
    template_text = read_text(template_instructions)
    operations_text = read_text(operations_template)
    seven_day_text = read_text(runtime_seven_day)
    runtime_pending_text = read_text(runtime_pending_promises)
    state_text = read_text(workspace_state_relay)
    pending_text = read_text(workspace_pending_promises)
    reentry_text = read_text(reentry_path)
    operations_enabled = is_truthy_env(runtime_env.get("CYBERBOSS_INCLUDE_OPERATIONS_PROMPT"))

    runtime_memory_block = extract_h2_block(runtime_text, "记忆与连续性")
    template_memory_block = extract_h2_block(template_text, "记忆与连续性")
    memory_block_sync = None
    if runtime_memory_block or template_memory_block:
        memory_block_sync = runtime_memory_block.strip() == template_memory_block.strip()

    chat_writer = model_label(models["chat_provider"], models["chat_model"], "AI 主模型")
    extract_writer = model_label(models["extract_provider"], models["extract_model"], "提取小模型")

    runtime_chain = [
        build_entry(
            runtime_instructions,
            key="runtime_instructions",
            label="运行时 weixin-instructions.md",
            writer="模板初生 + 你手改 + sync_memory_block 局部同步",
            cadence="按模板修改 / /reread / 重新同步时变化",
            purpose="当前线程真正吃进去的人格卡与记忆规则",
            layer="runtime",
            preview_chars=420,
        ),
        build_entry(
            operations_template,
            key="operations_template",
            label="weixin-operations.md",
            writer="Cyberboss 项目模板",
            cadence="项目规则更新时变化",
            purpose="发送、提醒、频道边界、工具执行等 operations 规则",
            layer="runtime",
            preview_chars=420,
        ),
        build_entry(
            runtime_seven_day,
            key="runtime_seven_day",
            label="runtime memory/7-day-memory.md",
            writer="Cyberboss runtime 背景写入",
            cadence="每段对话后（仅在 background write 开启时）",
            purpose="当前 runtime 暂存记忆池；这里才是“背景写入有没有开起来”的直接证据",
            layer="runtime",
            preview_chars=420,
        ),
        build_entry(
            runtime_pending_promises,
            key="runtime_pending_promises",
            label="runtime memory/pending-promises.md",
            writer="Cyberboss runtime / 待兑现承诺",
            cadence="按需",
            purpose="runtime 侧承诺与待跟进事项；不是 workspace 里的 relay 空文件",
            layer="runtime",
            preview_chars=320,
        ),
        build_entry(
            workspace_state_relay,
            key="workspace_state_relay",
            label="workspace memory/state.md",
            writer="外部 baton / runtime 状态中继",
            cadence="按需",
            purpose="可选 relay 文件；当前很多时候并未启用",
            layer="runtime",
            preview_chars=320,
        ),
        build_entry(
            workspace_pending_promises,
            key="workspace_pending_promises",
            label="workspace memory/pending-promises.md",
            writer="AI / 系统待兑现承诺",
            cadence="按需",
            purpose="可选 relay 文件；不是 runtime 真实 pending store",
            layer="runtime",
            preview_chars=320,
        ),
        build_entry(
            reentry_path,
            key="reentry",
            label="memory/reentry.md",
            writer=f"{chat_writer}（每晚 closeout）",
            cadence="有变化时才动",
            purpose="醒来热路径；runtime 指令要求先读这一口",
            layer="runtime",
            preview_chars=420,
            recent_lines_limit=6,
        ),
    ]
    active_by_key = {
        "runtime_instructions": True,
        "operations_template": operations_enabled,
        "runtime_seven_day": is_truthy_env(runtime_env.get("CYBERBOSS_MEMORY_BACKGROUND_WRITE")),
        "runtime_pending_promises": is_truthy_env(runtime_env.get("CYBERBOSS_LEGACY_PROMISE_RELAY")),
        "workspace_state_relay": is_truthy_env(runtime_env.get("CYBERBOSS_LEGACY_STATE_RELAY")),
        "workspace_pending_promises": is_truthy_env(runtime_env.get("CYBERBOSS_LEGACY_PROMISE_RELAY")),
        "reentry": True,
    }
    for entry in runtime_chain:
        entry["active"] = bool(active_by_key.get(entry.get("key"), False))

    source_files = [
        build_entry(
            template_instructions,
            key="template_instructions",
            label="templates/weixin-instructions.md",
            writer="你 / 架构位模板源",
            cadence="你改模板时变化",
            purpose="运行时 persona 的源头；sync_memory_block 从这里抠记忆块",
            layer="source",
            preview_chars=420,
        ),
        build_entry(
            sync_script,
            key="sync_memory_block",
            label="memory-kit/sync_memory_block.py",
            writer="工具脚本",
            cadence="你改同步逻辑时变化",
            purpose="把模板里的“记忆与连续性”段同步进运行时 persona",
            layer="source",
            preview_chars=420,
        ),
    ]

    return {
        "models": models,
        "chat_writer": chat_writer,
        "extract_writer": extract_writer,
        "runtime_state_dir": str(state_dir),
        "runtime_memory_status": runtime_memory_status,
        "runtime_background_write_enabled": is_runtime_background_write_enabled(state_dir),
        "operations_enabled": operations_enabled,
        "project_dir": str(project_dir),
        "memory_block_sync": memory_block_sync,
        "runtime_chain": runtime_chain,
        "source_files": source_files,
        "runtime_prompt": get_runtime_prompt_payload(include_content=True),
        "sections": {
            "role_card": extract_h2_block(runtime_text, "人格与关系"),
            "memory_continuity": runtime_memory_block,
            "thinking_style": extract_h2_block(runtime_text, "思考方式"),
            "operations_excerpt": preview_block(operations_text, limit_chars=1800, limit_lines=24) if operations_enabled else "",
            "runtime_seven_day": preview_block(seven_day_text, limit_chars=1600, limit_lines=20),
            "runtime_pending_promises": preview_block(runtime_pending_text, limit_chars=1200, limit_lines=16),
            "state_relay": preview_block(state_text, limit_chars=1200, limit_lines=16),
            "pending_promises": preview_block(pending_text, limit_chars=1200, limit_lines=16),
            "reentry": reentry_text.strip(),
        },
    }


def compute_memory_overview():
    models = get_model_overview()
    chat_writer = model_label(models["chat_provider"], models["chat_model"], "AI 主模型")
    extract_writer = model_label(models["extract_provider"], models["extract_model"], "提取小模型")
    runtime_state_dir = resolve_runtime_state_dir()
    runtime_memory_status = compute_runtime_memory_status()

    formal_entries = [
        build_entry(ROOT / "reentry.md", key="reentry", label="reentry.md", writer=f"{chat_writer}（每晚 closeout）",
                    cadence="有变化时才动", purpose="醒来第一包 / 当前热路径", layer="formal",
                    preview_chars=380, recent_lines_limit=6),
        build_entry(ROOT / "relationship_timeline.md", key="timeline", label="relationship_timeline.md",
                    writer=f"{chat_writer}（每晚 closeout）", cadence="每晚最多 +1 条",
                    purpose="正式关系年表，不是实时对话流", layer="formal", recent_lines_limit=6),
        build_entry(ROOT / "user_portrait.md", key="user_portrait", label="user_portrait.md",
                    writer=f"{chat_writer}（每晚 closeout）", cadence="每晚最多改 3 条",
                    purpose="她反复在意什么，不是实时状态条", layer="formal", recent_lines_limit=6),
        build_entry(ROOT / "ai_self_portrait.md", key="ai_self_portrait", label="ai_self_portrait.md",
                    writer="AI 自己", cadence="只有立场真的变化才动",
                    purpose="AI 六问自画像", layer="formal", recent_lines_limit=6),
        build_entry(ROOT / "ai_self_notes.md", key="ai_self_notes", label="ai_self_notes.md",
                    writer="AI 自己", cadence="按需追加", purpose="写给未来自己的私 notes", layer="formal",
                    recent_lines_limit=6),
        build_entry(ROOT / "episodes.jsonl", key="episodes", label="episodes.jsonl",
                    writer=f"{chat_writer}（每晚 closeout）", cadence="每晚 0~2 条",
                    purpose="正式证据层片段", layer="formal", kind="jsonl"),
        build_entry(ROOT / "rereadings.md", key="rereadings", label="rereadings.md",
                    writer="AI 自己", cadence="旧事重读时追加",
                    purpose="年轮，不是每天都会动", layer="formal", recent_lines_limit=6),
    ]

    auto_entries = [
        build_entry(ROOT / "episodes.candidates.jsonl", key="episodes_candidates", label="episodes.candidates.jsonl",
                    writer=f"{extract_writer} / janitor", cadence="白天断档 / 留痕时追加",
                    purpose="自动候选层，待 AI/人审，不直接进正史", layer="auto", kind="jsonl"),
        build_entry(ROOT / "reentry.extracted.md", key="reentry_extracted", label="reentry.extracted.md",
                    writer=f"{extract_writer} / janitor", cadence="断档补记时覆盖",
                    purpose="自动补记稿，只供参考，不直接注入", layer="auto", preview_chars=380, recent_lines_limit=6),
    ]

    runtime_entries = [
        build_entry(resolve_desire_state_file(), key="desire_state", label="desire-state.json",
                    writer="Cyberboss runtime", cadence="实时 tick",
                    purpose="当前实时八维，不属于 formal memory", layer="runtime", preview_chars=380),
        build_entry(resolve_desire_history_file(), key="desire_history", label="desire-history.jsonl",
                    writer="Cyberboss runtime", cadence="每次 desire_state 落盘时追加",
                    purpose="八维连续历史；八维页优先读这里，不再依赖冻结 state_log", layer="runtime", kind="jsonl"),
        build_entry(runtime_state_dir / "weixin-instructions.md", key="runtime_instructions", label="weixin-instructions.md",
                    writer="运行时 persona", cadence="/reread / 同步 / 手改时变化",
                    purpose="当前线程实际吃进去的人格与注入规则", layer="runtime", preview_chars=380),
        build_entry(resolve_runtime_memory_dir(runtime_state_dir) / "7-day-memory.md", key="runtime_seven_day",
                    label="runtime memory/7-day-memory.md", writer="Cyberboss runtime 背景写入",
                    cadence="每段对话后（仅在 background write 开启时）",
                    purpose="runtime 侧短期记忆池；会先在这里积压，再决定是否转稳定层", layer="runtime",
                    preview_chars=380),
        build_entry(resolve_runtime_memory_dir(runtime_state_dir) / "pending-promises.md", key="runtime_pending_promises",
                    label="runtime memory/pending-promises.md", writer="Cyberboss runtime",
                    cadence="按需", purpose="runtime 侧待兑现承诺，不等于 workspace relay", layer="runtime",
                    preview_chars=300),
        build_entry(resolve_runtime_memory_dir(runtime_state_dir) / "relationships.md", key="runtime_relationships",
                    label="runtime memory/relationships.md", writer="Cyberboss runtime",
                    cadence="转稳定层后", purpose="runtime 结构化 relationships 存储", layer="runtime",
                    preview_chars=300),
        build_entry(resolve_runtime_memory_dir(runtime_state_dir) / "profile.md", key="runtime_profile",
                    label="runtime memory/profile.md", writer="Cyberboss runtime",
                    cadence="转稳定层后", purpose="runtime 结构化 profile 存储", layer="runtime",
                    preview_chars=300),
        build_entry(ROOT / "state_log.jsonl", key="state_log", label="state_log.jsonl",
                    writer="历史归档", cadence="v2.1 后冻结",
                    purpose="旧八维历史档案，只看断档，不代表当前值", layer="runtime", kind="jsonl"),
    ]

    touched_entries = formal_entries + auto_entries + runtime_entries
    timeline_entry = next((item for item in formal_entries if item["key"] == "timeline"), None)
    auto_latest = next((item for item in auto_entries if item["key"] == "episodes_candidates"), None)
    formal_latest = next((item for item in formal_entries if item["key"] == "episodes"), None)
    overview = {
        "models": models,
        "formal_entries": formal_entries,
        "auto_entries": auto_entries,
        "runtime_entries": runtime_entries,
        "runtime_memory_status": runtime_memory_status,
        "recent_file_updates": summarize_recent_file_updates(touched_entries, limit=7),
        "formal_episode_days": count_jsonl_by_day(ROOT / "episodes.jsonl")[:7],
        "candidate_episode_days": count_jsonl_by_day(ROOT / "episodes.candidates.jsonl")[:7],
        "current": {
            "reentry": preview_block(read_text(ROOT / "reentry.md"), limit_chars=1600, limit_lines=18),
            "timeline_lines": collect_visible_lines(read_text(ROOT / "relationship_timeline.md"), limit=8),
            "user_portrait_lines": collect_visible_lines(read_text(ROOT / "user_portrait.md"), limit=8),
            "ai_self_portrait_lines": collect_visible_lines(read_text(ROOT / "ai_self_portrait.md"), limit=8),
            "ai_self_notes_lines": collect_visible_lines(read_text(ROOT / "ai_self_notes.md"), limit=8),
            "rereadings_lines": collect_visible_lines(read_text(ROOT / "rereadings.md"), limit=8),
        },
        "timeline_meta": {
            "updated_at": timeline_entry.get("updated_at") if timeline_entry else None,
            "hours_since_update": timeline_entry.get("hours_since_update") if timeline_entry else None,
            "latest_formal_episode_day": next(
                (item["day"] for item in count_jsonl_by_day(ROOT / "episodes.jsonl")),
                None,
            ),
        },
        "formalization_status": {
            "mode": "AI closeout",
            "background_write_enabled": runtime_memory_status["background_write_enabled"],
            "runtime_seven_day_updated_at": runtime_memory_status["seven_day"].get("updated_at"),
            "runtime_seven_day_hours_since_update": runtime_memory_status["seven_day"].get("hours_since_update"),
            "candidate_count": len(read_jsonl(ROOT / "episodes.candidates.jsonl")),
            "formal_updated_at": formal_latest.get("updated_at") if formal_latest else None,
            "auto_updated_at": auto_latest.get("updated_at") if auto_latest else None,
        },
        "recent_candidates": [
            {
                "time": str(item.get("time", "")),
                "title": str(item.get("title", "")),
                "importance": item.get("importance"),
                "id": str(item.get("id", "")),
            }
            for item in list(reversed(read_jsonl(ROOT / "episodes.candidates.jsonl")))[:6]
        ],
        "recent_formal_episodes": [
            {
                "time": str(item.get("time") or item.get("ts") or ""),
                "title": str(item.get("title") or ""),
                "body": str(item.get("body") or item.get("what_happened") or ""),
                "importance": item.get("importance"),
                "id": str(item.get("id") or item.get("ep_id") or ""),
                "author_role": str(item.get("author_role") or ""),
            }
            for item in list(reversed(read_jsonl(ROOT / "episodes.jsonl")))[:6]
        ],
    }
    return overview


# ---------- API 桥:辅助函数(只读端点 + 写端点的 schema 校验) ----------
# 全局禁区提醒:API 永不直接写 memory/ 下任何 .md 和 episodes.jsonl 正式文件;
# 只允许 state_log.jsonl 追加、episodes.candidates.jsonl 追加。

STATE_LOG_REQUIRED_KEYS = {
    "time", "most_want", "依恋", "好奇", "沉思", "责任",
    "社交", "疲惫", "性欲", "压力", "note",
}
STATE_LOG_OCTANT_KEYS = ("依恋", "好奇", "沉思", "责任", "社交", "疲惫", "性欲", "压力")


def _parse_limit(raw, default=20):
    """把 querystring 里的 limit 参数转成安全的正整数;非法值/超大值都回退到合理范围。"""
    try:
        n = int(raw)
    except Exception:
        return default
    if n <= 0:
        return default
    return min(n, 1000)


def get_reentry_payload():
    text = read_text(ROOT / "reentry.md")
    return {"text": text, "chars": count_chars(text)}


def get_text_payload(filename):
    text = read_text(ROOT / filename)
    return {"text": text}


def get_episodes_limited(limit):
    episodes = read_jsonl(ROOT / "episodes.jsonl")
    return list(reversed(episodes))[:limit]


def get_state_log_limited(limit):
    rows = read_jsonl(ROOT / "state_log.jsonl")
    return list(reversed(rows))[:limit]


def validate_state_log_body(obj):
    """校验 POST /api/state_log 的 body。返回 (ok, err_message)。
    要求:恰好包含指定的键集合(time/most_want/八维/note),八维为 0~1 数字。
    """
    if not isinstance(obj, dict):
        return False, "body 必须是 JSON 对象"
    keys = set(obj.keys())
    if keys != STATE_LOG_REQUIRED_KEYS:
        missing = STATE_LOG_REQUIRED_KEYS - keys
        extra = keys - STATE_LOG_REQUIRED_KEYS
        parts = []
        if missing:
            parts.append("缺少键:" + ",".join(sorted(missing)))
        if extra:
            parts.append("多余键:" + ",".join(sorted(extra)))
        return False, "body 键必须恰好等于规定集合;" + "; ".join(parts)
    for k in STATE_LOG_OCTANT_KEYS:
        v = obj.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return False, f"{k} 必须是 0~1 的数字"
        if v < 0 or v > 1:
            return False, f"{k} 必须在 0~1 之间"
    if not isinstance(obj.get("time"), str) or not obj.get("time"):
        return False, "time 必须是非空字符串"
    if not isinstance(obj.get("most_want"), str):
        return False, "most_want 必须是字符串"
    if not isinstance(obj.get("note"), str):
        return False, "note 必须是字符串"
    return True, None


def append_state_log(obj):
    path = ROOT / "state_log.jsonl"
    line = json.dumps(obj, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def validate_episode_candidate_body(obj):
    """校验 POST /api/episode_candidate 的 body。至少含 title/what_happened/anchor_quotes。"""
    if not isinstance(obj, dict):
        return False, "body 必须是 JSON 对象"
    if not isinstance(obj.get("title"), str) or not obj.get("title"):
        return False, "title 必须是非空字符串"
    if not isinstance(obj.get("what_happened"), str) or not obj.get("what_happened"):
        return False, "what_happened 必须是非空字符串"
    aq = obj.get("anchor_quotes")
    if not isinstance(aq, list) or not aq:
        return False, "anchor_quotes 必须是非空数组"
    if not all(isinstance(q, str) for q in aq):
        return False, "anchor_quotes 数组元素必须都是字符串"
    return True, None


def append_episode_candidate(obj):
    """自动补 id(cand-api-时间戳)、source:'api';追加到 episodes.candidates.jsonl。
    绝不写 episodes.jsonl 正式文件。
    """
    path = ROOT / "episodes.candidates.jsonl"
    stamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    record = dict(obj)
    record["id"] = f"cand-api-{stamp}"
    record["source"] = "api"
    line = json.dumps(record, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")
    return record["id"]


# ---------- 关怀 / 剧场(v3):care/ 与 theater/ 的外显读写 ----------
# 边界:面板只是表单与展示,不写任何关系判断逻辑,不做经期分析/预测;
# cycle 只由她录入,数据永不写进 memory/(user_portrait / episodes 等)。
# care/ 的写入都先备份到 care/.backups/,和 memory/.backups 同一习惯。

CARE_DIR = KIT_DIR.parent / "care"
CARE_BACKUPS = CARE_DIR / ".backups"
THEATER_DIR = KIT_DIR.parent / "theater"

CARE_CONFIG_DEFAULTS = {
    "city": "",
    "weather_enabled": False,
    "cycle_silent_enabled": False,
    "cycle_light_touch_enabled": False,
    "max_touch_per_day": 1,
    "https_proxy": "",
}

CYCLE_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

CYCLE_TEMPLATE = """# cycle — 她的周期记录

<!-- 规则:只由她录入/确认——面板「关怀」页的表单,或聊天里她亲口说了才记,别的来源一律不算。
这份数据永不进 user_portrait / episodes / memory/ 下任何文件;不做分析、不做预测、不画图表。
today.py 只读「记录」里最近一条「开始」来算今天是第几天,其余内容它不看。
写错了直接改这份文件就行(面板保存前会备份到 care/.backups/)。 -->

## 记录

<!-- 一行一条,格式:- YYYY-MM-DD 开始|结束(备注可选,用 — 隔开) -->
"""


def load_care_config():
    """读 care/config.json,和默认值合并;文件缺失/坏 JSON 都回落默认(全关)。"""
    cfg = dict(CARE_CONFIG_DEFAULTS)
    path = CARE_DIR / "config.json"
    if path.exists():
        try:
            data = json.loads(read_text(path))
            if isinstance(data, dict):
                for k in CARE_CONFIG_DEFAULTS:
                    if k in data:
                        cfg[k] = data[k]
        except Exception:
            pass
    return cfg


def _backup_care_file(path):
    """保存前把旧版备份到 care/.backups/。备份失败不阻塞保存(但尽力而为)。"""
    try:
        if path.exists():
            CARE_BACKUPS.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            bak = CARE_BACKUPS / (path.name + "." + stamp + ".bak")
            bak.write_text(read_text(path), encoding="utf-8")
    except Exception:
        pass


def validate_care_config_body(obj):
    """校验 POST /api/care/config 的 body。只认识 CARE_CONFIG_DEFAULTS 里的键。"""
    if not isinstance(obj, dict):
        return False, "body 必须是 JSON 对象"
    if "city" in obj and not isinstance(obj["city"], str):
        return False, "city 必须是字符串"
    for k in ("weather_enabled", "cycle_silent_enabled", "cycle_light_touch_enabled"):
        if k in obj and not isinstance(obj[k], bool):
            return False, f"{k} 必须是 true/false"
    if "max_touch_per_day" in obj:
        v = obj["max_touch_per_day"]
        if isinstance(v, bool) or not isinstance(v, int) or v < 0 or v > 10:
            return False, "max_touch_per_day 必须是 0~10 的整数"
    if "https_proxy" in obj and not isinstance(obj["https_proxy"], str):
        return False, "https_proxy 必须是字符串"
    return True, None


def save_care_config(obj):
    """白名单合并写回 care/config.json(先备份旧版);返回合并后的配置。"""
    CARE_DIR.mkdir(parents=True, exist_ok=True)
    cfg = load_care_config()
    for k in CARE_CONFIG_DEFAULTS:
        if k in obj:
            cfg[k] = obj[k]
    path = CARE_DIR / "config.json"
    _backup_care_file(path)
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return cfg


def validate_cycle_entry(obj):
    """校验 POST /api/care/cycle 的 body:date(YYYY-MM-DD)+ kind(开始|结束)+ note(可选)。"""
    if not isinstance(obj, dict):
        return False, "body 必须是 JSON 对象"
    d = obj.get("date")
    if not isinstance(d, str) or not CYCLE_DATE_RE.match(d.strip()):
        return False, "date 必须是 YYYY-MM-DD"
    try:
        datetime.strptime(d.strip(), "%Y-%m-%d")
    except Exception:
        return False, "date 不是合法日期"
    if obj.get("kind") not in ("开始", "结束"):
        return False, "kind 必须是「开始」或「结束」"
    note = obj.get("note", "")
    if not isinstance(note, str) or len(note) > 100:
        return False, "note 必须是 ≤100 字的字符串"
    if "\n" in note or "\r" in note:
        return False, "note 不能换行"
    return True, None


def append_cycle_entry(obj):
    """把一条记录追加到 care/cycle.md 末尾(「## 记录」区)。只追加,不改旧行;
    文件不存在就先落模板;追加前备份。返回写入的那一行。"""
    CARE_DIR.mkdir(parents=True, exist_ok=True)
    path = CARE_DIR / "cycle.md"
    if not path.exists():
        path.write_text(CYCLE_TEMPLATE, encoding="utf-8")
    _backup_care_file(path)
    note = (obj.get("note") or "").strip()
    line = f"- {obj['date'].strip()} {obj['kind']}"
    if note:
        line += f" — {note}"
    old = read_text(path)
    sep = "" if (not old or old.endswith("\n")) else "\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(sep + line + "\n")
    return line


def parse_scripts_index():
    """把 theater/scripts_index.md 解析成 {intro:[段落], rows:[…]}。
    宽松解析:markdown 表格行按 | 拆列;链接列里抓第一个 http(s) URL 放进 row["url"]。
    纯展示:不校验链接、不排序、不推荐。"""
    path = THEATER_DIR / "scripts_index.md"
    text = read_text(path)
    intro, rows = [], []
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if cells and all(c and set(c) <= set(":-") for c in cells):
                continue  # 表头分隔行 |---|---|
            if cells and cells[0] == "链接":
                continue  # 表头行
            m = re.search(r"https?://\S+", cells[0] if cells else "")
            rows.append({
                "link": cells[0] if len(cells) > 0 else "",
                "url": m.group(0) if m else "",
                "note": cells[1] if len(cells) > 1 else "",
                "duration": cells[2] if len(cells) > 2 else "",
                "players": cells[3] if len(cells) > 3 else "",
                "tags": cells[4] if len(cells) > 4 else "",
            })
        else:
            intro.append(line)
    return {"exists": path.exists(), "intro": intro, "rows": rows}


# ---------- HTML / JS / CSS 页面(占位符替换,不用 f-string,避开花括号转义问题) ----------

CONFIG_PAGE = r"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>模型与 Key</title>
<style>
body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;max-width:820px;margin:24px auto;padding:0 20px;color:#222}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:20px 0 8px;color:#555;border-bottom:1px solid #eee;padding-bottom:4px}
.hint{color:#777;font-size:13px;margin:0 0 16px}
.row{display:grid;grid-template-columns:150px 1fr;gap:10px;align-items:center;margin:8px 0}
label{color:#555;font-size:14px}input,select{padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:14px;font-family:inherit;width:100%;box-sizing:border-box}
.mask{color:#999;font-family:monospace}
button{padding:8px 16px;background:#2a6;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:14px}
button.secondary{background:#666}
.msg{padding:10px;margin-top:12px;border-radius:4px;font-size:13px;white-space:pre-wrap}
.ok{background:#e6f7e6;color:#274}.err{background:#fee;color:#822}
a{color:#369}
</style></head><body>
<h1>模型与 Key <a href="/" style="font-size:13px;margin-left:12px">← 回面板</a></h1>
<p class="hint">唯一真源 = <code>memory-kit/keys.local.json</code>。保存后会自动刷到 TG 线的 <code>.env</code>;重启 TG 才生效(桌面 <code>重启TG.bat</code>)。key 只显示末 4 位;要改就填新值,想留原样就别动。</p>

<h2>聊天端(TG 线走的模型)</h2>
<div class="row"><label>Provider</label>
  <select id="cp"><option value="deepseek">deepseek</option><option value="glm">glm</option><option value="claude">claude</option></select></div>
<div class="row"><label>Model</label><input id="cm" placeholder="如 deepseek-v4-pro[1m]"></div>
<div class="row"><label>Haiku 子代理</label><input id="ch" placeholder="如 deepseek-v4-flash"></div>
<div class="row"><label>Key: deepseek</label><input id="ck_ds" placeholder="sk-…"></div>
<div class="row"><label>Key: glm</label><input id="ck_glm" placeholder="…"></div>
<div class="row"><label>Key: claude</label><input id="ck_claude" placeholder="sk-ant-…"></div>

<h2>提取管道(janitor / extract_memory)</h2>
<div class="row"><label>Provider</label>
  <select id="ep"><option value="glm">glm</option><option value="deepseek">deepseek</option></select></div>
<div class="row"><label>Model</label><input id="em" placeholder="如 glm-5.2"></div>
<div class="row"><label>Key: glm</label><input id="ek_glm" placeholder="…"></div>
<div class="row"><label>Key: deepseek</label><input id="ek_ds" placeholder="sk-…"></div>

<h2>Telegram & 网络</h2>
<div class="row"><label>Bot token</label><input id="tg_tk" placeholder="8621…"></div>
<div class="row"><label>Allowed user ids</label><input id="tg_uid"></div>
<div class="row"><label>HTTPS_PROXY</label><input id="proxy" placeholder="http://127.0.0.1:7890 (国内直连 telegram 会 fetch failed)"></div>

<div style="margin-top:20px"><button onclick="save()">保存 + 刷 .env</button>
  <button class="secondary" onclick="load()">重新加载</button>
  <span id="masks" class="mask" style="margin-left:16px;font-size:12px"></span></div>
<div id="msg"></div>

<script>
const TOKEN = %API_TOKEN%;
function $(id){return document.getElementById(id)}
let formDirty = false;
function markDirty(){ formDirty = true }
async function load(){
  try{
    const r = await fetch('/api/config'); const d = await r.json();
    $('cp').value = d.chat_provider || 'deepseek';
    $('cm').value = d.chat_model || ''; $('ch').value = d.chat_haiku_model || '';
    $('ep').value = d.extract_provider || 'glm';
    $('em').value = d.extract_model || '';
    $('tg_uid').value = d.telegram_allowed_user_ids || '';
    $('proxy').value = d.https_proxy || '';
    const cm = d.chat_keys_masked || {}, em = d.extract_keys_masked || {};
    $('ck_ds').placeholder = cm.deepseek || 'sk-…'; $('ck_glm').placeholder = cm.glm || '…'; $('ck_claude').placeholder = cm.claude || 'sk-ant-…';
    $('ek_glm').placeholder = em.glm || '…'; $('ek_ds').placeholder = em.deepseek || 'sk-…';
    $('tg_tk').placeholder = d.telegram_bot_token_masked || '8621…';
    $('masks').textContent = '当前 chat: '+(d.chat_provider||'?')+' / '+(d.chat_model||'?');
    formDirty = false;
  }catch(e){show('err','读取失败: '+e)}
}
function show(cls,text){const m=$('msg');m.className='msg '+cls;m.textContent=text}
async function save(){
  const body = {
    chat_provider:$('cp').value, chat_model:$('cm').value, chat_haiku_model:$('ch').value,
    chat_keys:{deepseek:$('ck_ds').value,glm:$('ck_glm').value,claude:$('ck_claude').value},
    extract_provider:$('ep').value, extract_model:$('em').value,
    extract_keys:{glm:$('ek_glm').value,deepseek:$('ek_ds').value},
    telegram_bot_token:$('tg_tk').value, telegram_allowed_user_ids:$('tg_uid').value,
    https_proxy:$('proxy').value
  };
  try{
    const r = await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':TOKEN},body:JSON.stringify(body)});
    const d = await r.json();
    if(d.ok){show('ok','已存 keys.local.json 并刷到 .env。重启 TG 生效:桌面双击 重启TG.bat\n\n'+(d.apply||''));load()}
    else{show('err','失败: '+(d.err||JSON.stringify(d)))}
  }catch(e){show('err','请求失败: '+e)}
}
document.querySelectorAll('input,select').forEach(el => { el.addEventListener('input', markDirty); el.addEventListener('change', markDirty); });
load();
setInterval(() => { if (!formDirty && !document.hidden) load(); }, 20000);
window.addEventListener('focus', () => { if (!formDirty) load(); });
</script></body></html>"""


PAGE = r"""<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>记忆面板</title>
<style>
  :root {
    --bg: #0f1014;
    --bg-2: #14151a;
    --surface: #1a1c24;
    --surface-2: #1e2029;
    --surface-3: #232631;
    --line: #2a2d38;
    --line-soft: #232630;
    --text: #d8d9de;
    --text-dim: #9aa0b0;
    --text-faint: #6b7080;
    --accent: #7a86c2;
    --accent-2: #5a6ad0;
    --accent-deep: #3c4568;
    --gold: #c9b458;
    --green: #4a9d6a;
    --amber: #c9a03c;
    --red: #c94040;
    --radius: 10px;
    --radius-sm: 6px;
    --shadow: 0 1px 2px rgba(0,0,0,.25), 0 6px 18px rgba(0,0,0,.28);
    --shadow-soft: 0 1px 3px rgba(0,0,0,.3);
    --ease: cubic-bezier(.4,0,.2,1);
  }
  * { box-sizing: border-box; }
  ::selection { background: rgba(122,134,194,.35); }
  body { margin:0; font-family: "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif;
         background: radial-gradient(1200px 600px at 78% -10%, #1b1e2b 0%, var(--bg) 60%) fixed, var(--bg);
         color: var(--text); height:100vh; overflow:hidden;
         -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  #app { display:flex; flex-direction:column; height:100vh; }

  /* 滚动条 */
  * { scrollbar-width: thin; scrollbar-color: #33384a transparent; }
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-thumb { background:#2f3444; border-radius:8px; border:2px solid transparent; background-clip:padding-box; }
  ::-webkit-scrollbar-thumb:hover { background:#3c4256; background-clip:padding-box; }
  ::-webkit-scrollbar-track { background:transparent; }

  /* 顶部 tab 栏 */
  #tabs { display:flex; align-items:center; gap:4px; padding:10px 18px;
          background: rgba(20,21,26,.72); backdrop-filter: blur(10px);
          border-bottom:1px solid var(--line); flex-shrink:0;
          box-shadow: 0 1px 0 rgba(255,255,255,.02); }
  #tabs .brand { display:flex; align-items:center; gap:8px; padding-right:12px; margin-right:4px;
                 border-right:1px solid var(--line); white-space:nowrap; }
  #tabs .brand-mark { width:25px; height:25px; display:grid; place-items:center; border-radius:8px;
                      color:#f4f5fb; font-size:11px; font-weight:800; background:linear-gradient(145deg,#59689e,#343d62); }
  #tabs .brand-copy strong { display:block; color:#f0f1f5; font-size:12px; line-height:1.1; }
  #tabs .brand-copy small { display:block; margin-top:3px; color:var(--text-faint); font-size:9px; letter-spacing:.07em; }
  #tabs .tab { padding:7px 16px; cursor:pointer; border-radius:8px; font-size:13.5px;
               color: var(--text-dim); font-weight:500; letter-spacing:.02em;
               transition: background .18s var(--ease), color .18s var(--ease), transform .12s var(--ease); }
  #tabs .tab:hover { background: var(--surface-3); color: var(--text); }
  #tabs .tab:active { transform: translateY(1px); }
  #tabs .tab.on { background: linear-gradient(180deg,#454f78,#3a4266);
                  color:#fff; box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 2px 8px rgba(60,69,104,.4); }
  #tabs .tab.secondary { color:#777d8d; padding-left:11px; padding-right:11px; }
  #tabs .nav-divider { width:1px; height:22px; margin:0 4px; background:var(--line); flex:0 0 auto; }
  #tabs .spacer { flex:1; }
  #tabs .hint { font-size:11.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }

  #views { flex:1; min-height:0; overflow:hidden; position:relative; }
  .view { position:absolute; inset:0; overflow-y:auto; padding:20px 24px; display:none; }
  .view.on { display:block; animation: fadeIn .28s var(--ease); }
  @keyframes fadeIn { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform:none; } }
  @media (prefers-reduced-motion: reduce) {
    .view.on { animation:none; }
    * { transition:none !important; }
  }

  /* ---- 健康度视图 ---- */
  #alertbar { margin-bottom:16px; display:flex; flex-direction:column; gap:8px; }
  .alert { padding:11px 15px; border-radius:8px; font-size:13px; line-height:1.5;
           display:flex; align-items:flex-start; gap:9px; border:1px solid transparent; }
  .alert::before { content:""; flex:0 0 auto; width:8px; height:8px; border-radius:50%; margin-top:5px; }
  .alert.red { background: linear-gradient(180deg,#3a1c22,#331a20); border-color:#8a3040; color:#ffb4bd; }
  .alert.red::before { background:#ff6b7a; box-shadow:0 0 8px rgba(255,107,122,.6); }
  .alert.amber { background: linear-gradient(180deg,#3a301c,#332b19); border-color:#8a6a30; color:#ffd98a; }
  .alert.amber::before { background:#ffcf6b; box-shadow:0 0 8px rgba(255,207,107,.5); }
  .alert.ok { background: linear-gradient(180deg,#1c3a24,#193320); border-color:#308a4a; color:#9be3ab; }
  .alert.ok::before { background:#57d183; box-shadow:0 0 8px rgba(87,209,131,.5); }

  .cardgrid { display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
              gap:16px; }
  .hcard { background: linear-gradient(180deg, var(--surface-2), #1b1d26);
           border:1px solid var(--line); border-radius: var(--radius); padding:16px 18px;
           box-shadow: var(--shadow-soft);
           transition: transform .18s var(--ease), border-color .18s var(--ease), box-shadow .18s var(--ease); }
  .hcard:hover { transform: translateY(-2px); border-color:#3a4056; box-shadow: var(--shadow); }
  .hcard h3 { margin:0 0 10px; font-size:12.5px; color: var(--text-dim); font-weight:500;
              letter-spacing:.02em; }
  .hcard .big { font-size:28px; color:#fff; font-weight:600; letter-spacing:-.01em;
                font-variant-numeric: tabular-nums; }
  .hcard .sub { font-size:12px; color: var(--text-faint); margin-top:5px; line-height:1.5; }

  /* ---- 核心工作台 ---- */
  .core-hero { padding:20px; margin-bottom:15px; border:1px solid #343a52; border-radius:14px;
               background:radial-gradient(620px 230px at 86% -25%,rgba(122,134,194,.23),transparent 65%),
                          linear-gradient(145deg,#202433,#181b25 72%); box-shadow:var(--shadow); }
  .core-hero-top { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; }
  .core-eyebrow { color:#aeb8e8; font-size:10px; letter-spacing:.13em; text-transform:uppercase; }
  .core-title { margin:6px 0 5px; color:#f5f6fa; font-size:23px; font-weight:650; }
  .core-copy { color:var(--text-dim); font-size:12.5px; line-height:1.7; }
  .core-state { flex:0 0 auto; padding:8px 12px; border-radius:999px; font-size:12px; border:1px solid #75612f;
                color:#ffd98a; background:#302712; }
  .core-state.ok { color:#a8e7b7; border-color:#3b754b; background:#183322; }
  .core-state.bad { color:#ffb4bd; border-color:#8a3040; background:#351b21; }
  .core-status-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-top:17px; }
  .core-status { min-height:92px; padding:12px 13px; border:1px solid var(--line-soft); border-radius:10px; background:rgba(22,24,32,.7); }
  .core-status .label { color:var(--text-faint); font-size:10.5px; }
  .core-status strong { display:block; margin-top:7px; color:#f0f1f5; font-size:14px; line-height:1.35; }
  .core-status small { display:block; margin-top:5px; color:var(--text-faint); font-size:10.5px; line-height:1.45; }
  .core-status.warn strong { color:#ffd98a; }
  .core-status.bad strong { color:#ffb4bd; }
  .quick-nav { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; margin-bottom:16px; }
  .quick-link { text-align:left; padding:12px 13px; border:1px solid var(--line); border-radius:10px; background:var(--surface-2);
                color:var(--text); box-shadow:none; }
  .quick-link:hover { border-color:#596691; background:#232735; filter:none; }
  .quick-link strong,.quick-link small { display:block; }
  .quick-link strong { font-size:12.5px; }
  .quick-link small { margin-top:4px; color:var(--text-faint); font-size:10.5px; line-height:1.45; }
  details.advanced-details { border:1px solid var(--line); border-radius:11px; background:rgba(24,26,34,.7); overflow:hidden; }
  details.advanced-details > summary { cursor:pointer; list-style:none; padding:13px 15px; color:var(--text-dim); font-size:12px; }
  details.advanced-details > summary::-webkit-details-marker { display:none; }
  details.advanced-details > summary::before { content:"＋"; display:inline-block; width:20px; color:#8793c8; }
  details.advanced-details[open] > summary::before { content:"−"; }
  details.advanced-details > .details-body { padding:2px 15px 15px; }

  .memory-map { display:grid; grid-template-columns:repeat(5,minmax(130px,1fr)); gap:9px; }
  .memory-stage { position:relative; min-height:122px; padding:13px; border:1px solid var(--line); border-radius:10px; background:var(--surface-2); }
  .memory-stage:not(:last-child)::after { content:"→"; position:absolute; right:-15px; top:44px; z-index:2; color:#65709f; font-size:17px; }
  .memory-stage .num { color:#7f8bc3; font:600 10px Consolas,monospace; }
  .memory-stage strong { display:block; margin-top:6px; color:#f0f1f5; font-size:13px; }
  .memory-stage p { margin:5px 0 0; color:var(--text-faint); font-size:10.5px; line-height:1.55; }
  .read-policy { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:9px; margin-top:10px; }
  .policy-card { padding:11px 12px; border:1px solid var(--line-soft); border-radius:9px; background:#191b23; }
  .policy-card strong { color:#e9ebf1; font-size:11.5px; }
  .policy-card span { display:block; margin-top:5px; color:var(--text-faint); font-size:10.5px; line-height:1.5; }
  .policy-pill { display:inline-flex !important; width:auto; margin:0 0 6px !important; padding:2px 7px; border-radius:999px;
                 color:#a8e7b7 !important; border:1px solid #356344; background:#172c1e; font-size:9.5px !important; }

  .barwrap { background:#0c0d12; border-radius:7px; height:14px; overflow:hidden; margin-top:10px;
             box-shadow: inset 0 1px 2px rgba(0,0,0,.5); }
  .barfill { height:100%; background: linear-gradient(90deg,#3f8e5e,#57c07f);
             border-radius:7px; transition: width .5s var(--ease); }
  .barfill.warn { background: linear-gradient(90deg,#b8922f,#e0bd52); }
  .barfill.danger { background: linear-gradient(90deg,#b53838,#e05a5a); }

  .impbars { display:flex; align-items:flex-end; gap:8px; height:70px; margin-top:8px; }
  .impbar-col { display:flex; flex-direction:column; align-items:center; gap:4px; flex:1; }
  .impbar { width:100%; background: linear-gradient(180deg,#6b79e0,#4d5cc0);
            border-radius:4px 4px 0 0; min-height:2px; transition: height .4s var(--ease); }
  .impbar-label { font-size:10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }

  .gaplist { margin-top:8px; font-size:12px; color: var(--gold); }
  .gaplist div { padding:4px 0; border-bottom:1px solid var(--line-soft); }
  .gaplist div:last-child { border-bottom:0; }

  /* ---- 注入 / 记忆概览 ---- */
  .section-head { font-size:12.5px; color: var(--text-dim); margin:18px 0 10px; letter-spacing:.02em; }
  .view-stack { display:flex; flex-direction:column; gap:18px; }
  .mini-pre, .mono-block {
      background:#101116; border:1px solid #2a2d38; border-radius:8px; padding:12px;
      font-family:"JetBrains Mono", Consolas, monospace; font-size:12px; line-height:1.7;
      color:#c7c9d4; white-space:pre-wrap; overflow:auto; }
  .mini-pre { max-height:180px; margin:10px 0 0; color:#9aa0b0; }
  .line-list { margin-top:10px; display:flex; flex-direction:column; gap:6px; }
  .line-list div { font-size:12px; color:#c7c9d4; line-height:1.6; padding-bottom:6px; border-bottom:1px solid var(--line-soft); }
  .line-list div:last-child { border-bottom:0; padding-bottom:0; }
  .meta-row { font-size:12px; color: var(--text-dim); margin-top:6px; line-height:1.6; }
  .path-row { font-size:11px; color: var(--text-faint); margin-top:8px; line-height:1.5; word-break:break-all; }
  .status-pill { display:inline-block; font-size:11px; padding:2px 8px; border-radius:999px; margin-top:8px;
                 border:1px solid var(--line); color: var(--text-dim); }
  .status-pill.ok { color:#9be3ab; border-color:#2f6a42; background:#163020; }
  .status-pill.warn { color:#ffd98a; border-color:#735923; background:#302712; }
  .meta-table { width:100%; border-collapse:collapse; font-size:12px; }
  .meta-table th { text-align:left; color: var(--text-faint); font-weight:500; padding:8px 10px; border-bottom:1px solid var(--line); }
  .meta-table td { padding:8px 10px; border-bottom:1px solid var(--line-soft); color: var(--text); vertical-align:top; }
  .meta-table tr:last-child td { border-bottom:0; }

  /* ---- 时间线视图 ---- */
  #timeline-meta { margin-bottom:14px; }
  #timeline-latest { margin-bottom:14px; }
  #timeline-body h2 { font-size:15px; color:#aeb8e8; margin:22px 0 6px; }
  #timeline-body h2:first-child { margin-top:0; }
  #timeline-body p { font-size:13.5px; line-height:1.9; color:#d8d9de; margin:4px 0 14px; }
  .epid { color:#7a86c2; cursor:pointer; text-decoration:underline dotted; }
  .epid:hover { color:#aeb8e8; }
  .epcard { background: linear-gradient(180deg,#1f2230,#1b1e2a); border:1px solid #3c4568;
            border-left:3px solid var(--accent); border-radius:8px;
            padding:13px 16px; margin:8px 0 18px; font-size:12.5px; box-shadow: var(--shadow-soft);
            animation: fadeIn .22s var(--ease); }
  .epcard .eptitle { color:#aeb8e8; font-size:13.5px; margin-bottom:4px; }
  .epcard .eptime { color:#6b7080; font-size:11px; margin-bottom:8px; }
  .epcard .epwhat { color:#d8d9de; margin-bottom:8px; line-height:1.7; }
  .epcard blockquote { border-left:3px solid #c9b458; margin:6px 0; padding:2px 10px;
                        color:#c9b458; font-size:12.5px; }
  .epcard .epimp { color:#9aa0b0; font-size:11.5px; margin-top:6px; }
  .epcard .epreread { margin-top:10px; padding-top:8px; border-top:1px dashed #3a3d4a; }
  .epcard .epreread .tag { color:#6b7080; font-size:11px; }
  .epcard .epreread div.line { color:#9ab4c9; font-size:12px; margin-top:3px; }
  .epcard .epclose { float:right; cursor:pointer; color:#6b7080; }
  .epcard .epclose:hover { color:#d8d9de; }

  /* ---- 八维视图 ---- */
  #octant-notice { background:#232120; border:1px solid #4a4234; color:#c9b98a;
                   padding:10px 14px; border-radius:8px; font-size:12.5px; margin-bottom:14px; }
  #octant-live { background:#1b1d24; border:1px solid #2a2d38; border-radius:8px; padding:12px 14px;
                 margin-bottom:14px; color:#c7c9d4; }
  #octant-live h3 { margin:0 0 8px; font-size:13px; color:#fff; }
  #octant-live .meta { font-size:12px; color:#9aa0b0; margin-bottom:8px; }
  #octant-live .most { font-size:13px; color:#e7e9ef; margin-bottom:10px; line-height:1.6; }
  #octant-live .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; }
  #octant-live .item { background:#20232d; border:1px solid #2b2f3b; border-radius:6px; padding:8px 10px; }
  #octant-live .item strong { display:block; font-size:12px; color:#fff; margin-bottom:4px; }
  #octant-live .item .score { font-size:18px; color:#c9b458; margin-bottom:4px; }
  #octant-live .item .cause { font-size:11px; color:#8f96a8; line-height:1.5; }
  #octant-source { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:8px; margin-bottom:14px; }
  #octant-source .source-card { background:#171923; border:1px solid #2d3140; border-radius:8px; padding:10px 12px; }
  #octant-source .source-card strong { display:block; color:#f2f3f7; font-size:12px; margin-bottom:4px; }
  #octant-source .source-card span { color:#8f96a8; font-size:11px; line-height:1.5; word-break:break-all; }
  .octant-bar { height:5px; background:#11131a; border-radius:999px; overflow:hidden; margin-top:5px; }
  .octant-bar > i { display:block; height:100%; border-radius:999px; }
  #curve-box { background: linear-gradient(180deg, var(--surface-2), #1b1d26);
               border:1px solid var(--line); border-radius:10px;
               padding:14px 16px; margin-bottom:14px; box-shadow: var(--shadow-soft); }
  #curve-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:12px; margin-bottom:8px; }
  #curve-legend .lg { cursor:pointer; user-select:none; color:#9aa0b0;
                      display:flex; align-items:center; gap:5px; }
  #curve-legend .lg.off { opacity:.35; text-decoration:line-through; }
  #curve-legend .sw { width:10px; height:10px; border-radius:2px; display:inline-block; }
  #octant-canvas { width:100%; display:block; }

  /* ---- 关怀 / 剧场视图(v3) ---- */
  .notice { background:#232120; border:1px solid #4a4234; color:#c9b98a;
            padding:10px 14px; border-radius:8px; font-size:12.5px; margin-bottom:14px; }
  .form-row { display:grid; grid-template-columns:140px 1fr; gap:10px; align-items:center; margin:8px 0; }
  .form-row label { color:#9aa0b0; font-size:13px; }
  .form-row input[type=text], .form-row input[type=date], .form-row input[type=number],
  .form-row select {
      background:#0c0d12; color:var(--text); border:1px solid var(--line); border-radius:6px;
      padding:8px 11px; font-size:13px; font-family:inherit; width:100%; box-sizing:border-box;
      transition: border-color .15s var(--ease), box-shadow .15s var(--ease); }
  .form-row input[type=text]:focus, .form-row input[type=date]:focus,
  .form-row input[type=number]:focus, .form-row select:focus {
      outline:none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(122,134,194,.18); }
  .form-row input[type=checkbox] { justify-self:start; width:16px; height:16px; accent-color:#7a86c2; }
  .form-status { font-size:12px; color:#8a9; margin-left:10px; }
  #cycle-view { background:#101116; border:1px solid #2a2d38; border-radius:8px; padding:12px;
                font-family:Consolas,monospace; font-size:12px; line-height:1.7; color:#9aa0b0;
                white-space:pre-wrap; max-height:320px; overflow-y:auto; margin:0; }
  .th-intro { font-size:13px; color:#9aa0b0; line-height:1.8; margin:4px 0 12px; }
  .th-card { background: var(--surface-2); border:1px solid var(--line); border-radius:10px;
             padding:13px 16px; margin-bottom:10px; box-shadow: var(--shadow-soft);
             transition: transform .16s var(--ease), border-color .16s var(--ease); }
  .th-card:hover { transform: translateY(-1px); border-color:#3a4056; }
  .th-card a { color:#7ab3e0; font-size:14px; word-break:break-all; }
  .th-card .th-note { color:#d8d9de; font-size:13px; margin:6px 0; line-height:1.7; }
  .th-card .th-meta { color:#6b7080; font-size:12px; }
  .th-card.sample { opacity:.55; }
  table.octant { border-collapse:collapse; width:100%; font-size:11.5px; }
  table.octant th { text-align:left; color:#6b7080; font-weight:normal; padding:5px 6px;
                     border-bottom:1px solid #2a2d38; position:sticky; top:0; background:#14151a; }
  table.octant td { padding:5px 6px; border-bottom:1px solid #202230; color:#c7c9d4; white-space:nowrap; }
  table.octant tr.gap td { background:#2a1d20; }
  table.octant tr.live td { background:#182334; }
  table.octant .gaptag { color:#d98a8a; font-size:10px; }
  table.octant .livetag { color:#8fb4ff; font-size:10px; }
  .spark-row { display:flex; gap:10px; margin:10px 0 18px; flex-wrap:wrap; }
  .spark-item { background:#1e2029; border:1px solid #2a2d38; border-radius:6px; padding:6px 10px; }
  .spark-item .lbl { font-size:11px; color:#6b7080; }

  /* ---- 文件视图 ---- */
  #files-layout { display:flex; height:100%; margin:-18px -22px; }
  #side { width:230px; min-width:230px; background: var(--surface); padding:14px 0;
          overflow-y:auto; border-right:1px solid var(--line); }
  #side h1 { font-size:12px; margin:0 16px 12px; color: var(--text-faint); font-weight:600;
             text-transform:uppercase; letter-spacing:.08em; }
  .f { padding:9px 15px; cursor:pointer; font-size:13px; border-left:3px solid transparent;
       transition: background .14s var(--ease); }
  .f:hover { background: var(--surface-3); }
  .f.on { background: linear-gradient(90deg,#262a38,#20232f); border-left-color: var(--accent); color:#fff; }
  .f small { display:block; color: var(--text-faint); font-size:11px; margin-top:2px; }
  #main { flex:1; display:flex; flex-direction:column; padding:14px; min-width:0; }
  #bar { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  #fname { font-size:15px; color:#fff; }
  #status { font-size:12px; color:#8a9; }
  #rolabel { font-size:11.5px; color:#c9a03c; }
  button { background: linear-gradient(180deg,#454f78,#3a4266); color:#fff; border:0;
           padding:8px 18px; border-radius: var(--radius-sm); cursor:pointer; font-size:13px;
           font-weight:500; font-family:inherit;
           box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 1px 2px rgba(0,0,0,.3);
           transition: filter .15s var(--ease), transform .1s var(--ease); }
  button:hover { filter: brightness(1.18); }
  button:active { transform: translateY(1px); }
  button:disabled { opacity:.5; cursor:not-allowed; filter:none; }
  button.ghost { background:transparent; border:1px solid var(--accent-deep); box-shadow:none; }
  button.ghost:hover { background: var(--surface-3); filter:none; border-color: var(--accent); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:4px; }
  #cards { overflow-y:auto; max-height:45%; margin-bottom:10px; display:none; }
  .card { background: var(--surface-2); border:1px solid var(--line); border-radius:8px;
          padding:11px 13px; margin-bottom:8px; font-size:12.5px; box-shadow: var(--shadow-soft);
          transition: border-color .15s var(--ease); }
  .card:hover { border-color:#39405480; }
  .card b { color:#aeb8e8; }
  .card .t { color:#6b7080; font-size:11px; }
  .card .q { color:#c9b458; margin-top:4px; }
  .kv { color:#9aa0b0; }
  textarea { flex:1; width:100%; background:#0c0d12; color: var(--text);
             border:1px solid var(--line); border-radius:8px; padding:14px;
             font-family: "JetBrains Mono", Consolas, monospace; font-size:13px; line-height:1.75;
             resize:none; outline:none; transition: border-color .15s var(--ease), box-shadow .15s var(--ease); }
  textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(122,134,194,.16); }
  textarea[readonly] { color:#9aa0b0; background:#15161b; }
  #editbtn, #savebtn, #cancelbtn { display:none !important; }
  .continuity-row { background:var(--surface-2); border:1px solid var(--line); border-radius:8px;
                    padding:10px 12px; margin-bottom:8px; font-size:12px; overflow-wrap:anywhere; }
  .continuity-row .event-title { font-weight:700; color:var(--text); margin-bottom:5px; }
  .continuity-row .event-meta { color:var(--muted); margin-bottom:7px; }
  .continuity-row .event-body { white-space:pre-wrap; line-height:1.65; }
  .continuity-row details { margin-top:8px; color:var(--muted); }
  .continuity-row details pre { margin-top:6px; max-height:260px; overflow:auto; white-space:pre-wrap; }
  .module-state { display:inline-block; margin:3px 6px 3px 0; padding:5px 8px;
                  border:1px solid var(--line); border-radius:6px; font-size:12px; }
  .module-state.on { border-color:#4f7658; color:#9be3ab; }
  .module-state.failed { border-color:#7a3f48; color:#ffb4bd; }

  /* diff 弹层 */
  #modal-mask { position:fixed; inset:0; background:rgba(0,0,0,0.6); display:none;
                align-items:center; justify-content:center; z-index:50; backdrop-filter: blur(3px); }
  #modal-mask.on { display:flex; animation: fadeIn .18s var(--ease); }
  #modal-box { background: var(--surface); border:1px solid var(--accent-deep); border-radius:12px;
               width:min(720px, 90vw); max-height:80vh; display:flex; flex-direction:column;
               box-shadow: 0 20px 60px rgba(0,0,0,.55); }
  #modal-box h3 { margin:0; padding:14px 18px; border-bottom:1px solid #2a2d38; font-size:14px; color:#fff; }
  #modal-diff { padding:12px 18px; overflow-y:auto; font-family:Consolas,monospace; font-size:12px; line-height:1.6; }
  #modal-diff .add { background:#1c3a24; color:#9be3ab; display:block; white-space:pre-wrap; }
  #modal-diff .del { background:#3a1c22; color:#ffb4bd; display:block; white-space:pre-wrap; text-decoration:line-through; }
  #modal-diff .same { color:#5c6070; display:block; white-space:pre-wrap; }
  #modal-actions { padding:12px 18px; border-top:1px solid #2a2d38; display:flex; gap:10px; justify-content:flex-end; }

  /* ---- 上下文编排 ---- */
  .ctx-shell { display:flex; flex-direction:column; gap:16px; }
  .ctx-hero {
      position:relative; overflow:hidden; padding:20px 22px; border:1px solid #343a52;
      border-radius:14px; background:
        radial-gradient(620px 220px at 84% -20%, rgba(122,134,194,.25), transparent 66%),
        linear-gradient(145deg, #202433, #181b25 72%);
      box-shadow:var(--shadow);
  }
  .ctx-hero::after {
      content:""; position:absolute; inset:auto -36px -72px auto; width:180px; height:180px;
      border:1px solid rgba(174,184,232,.14); border-radius:50%; pointer-events:none;
  }
  .ctx-kicker { color:#aeb8e8; font-size:11px; letter-spacing:.14em; text-transform:uppercase; }
  .ctx-title { margin:6px 0 5px; font-size:22px; color:#f3f4f8; font-weight:650; }
  .ctx-lead { max-width:760px; color:var(--text-dim); font-size:12.5px; line-height:1.75; }
  .ctx-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:16px; position:relative; z-index:1; }
  .ctx-toolbar select {
      min-width:185px; background:#11131a; color:var(--text); border:1px solid var(--line);
      border-radius:7px; padding:8px 10px;
  }
  .ctx-toolbar .spacer { flex:1 1 18px; }
  .ctx-meta { color:var(--text-faint); font-size:11.5px; min-height:18px; }
  .ctx-section {
      border:1px solid var(--line); border-radius:13px; background:rgba(26,28,36,.82);
      box-shadow:var(--shadow-soft); overflow:hidden;
  }
  .ctx-section-head {
      display:flex; align-items:flex-start; justify-content:space-between; gap:16px;
      padding:15px 17px 12px; border-bottom:1px solid var(--line-soft);
      background:linear-gradient(180deg,rgba(35,38,49,.72),rgba(30,32,41,.25));
  }
  .ctx-section-title { margin:0; color:#edf0f7; font-size:14px; }
  .ctx-section-copy { margin-top:4px; color:var(--text-faint); font-size:11.5px; line-height:1.6; }
  .ctx-section-body { padding:15px 17px 17px; }
  .ctx-runtime-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; }
  .ctx-runtime-card {
      min-height:92px; padding:12px 13px; border:1px solid var(--line-soft); border-radius:10px;
      background:linear-gradient(180deg,#20232d,#1b1e27);
  }
  .ctx-runtime-card .label { color:var(--text-faint); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; }
  .ctx-runtime-card .value { margin-top:7px; color:#e7e9ef; font-size:13px; line-height:1.55; word-break:break-all; }
  .ctx-runtime-card .detail { margin-top:5px; color:var(--text-faint); font-size:10.5px; line-height:1.5; }
  .ctx-gates { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; }
  .ctx-gate {
      display:flex; align-items:center; justify-content:space-between; gap:12px;
      padding:12px 13px; border:1px solid var(--line-soft); border-radius:10px; background:#1c1f28;
  }
  .ctx-gate strong { display:block; color:#e8eaf1; font-size:12.5px; }
  .ctx-gate small { display:block; color:var(--text-faint); font-size:10.5px; margin-top:3px; line-height:1.45; }
  .ctx-switch { position:relative; width:38px; height:22px; flex:0 0 auto; }
  .ctx-switch input { opacity:0; width:0; height:0; }
  .ctx-switch span {
      position:absolute; inset:0; cursor:pointer; border-radius:999px; background:#353946;
      transition:.18s var(--ease); border:1px solid #454a59;
  }
  .ctx-switch span::before {
      content:""; position:absolute; width:16px; height:16px; left:2px; top:2px; border-radius:50%;
      background:#a5a9b4; transition:.18s var(--ease); box-shadow:0 1px 3px rgba(0,0,0,.35);
  }
  .ctx-switch input:checked + span { background:#46568f; border-color:#6f80bf; }
  .ctx-switch input:checked + span::before { transform:translateX(16px); background:#f2f4ff; }
  .ctx-board { display:flex; flex-direction:column; gap:9px; }
  .ctx-layer {
      display:grid; grid-template-columns:42px minmax(150px,220px) 1fr auto; gap:12px; align-items:start;
      padding:12px; border:1px solid var(--line-soft); border-radius:11px;
      background:linear-gradient(100deg,#1d2029,#1b1d25); transition:.15s var(--ease);
  }
  .ctx-layer:hover { border-color:#3a4054; transform:translateY(-1px); }
  .ctx-layer.dragging { opacity:.46; transform:scale(.995); }
  .ctx-layer.drop-target { border-color:#6e7cba; box-shadow:inset 0 0 0 1px #6e7cba; }
  .ctx-layer.fixed { background:linear-gradient(100deg,#222637,#1b1e27); border-color:#354064; }
  .ctx-order {
      width:34px; height:34px; display:grid; place-items:center; border-radius:9px;
      background:#11131a; color:#8793c8; font:600 12px Consolas,monospace; border:1px solid #2c3140;
      cursor:grab; user-select:none;
  }
  .ctx-layer.fixed .ctx-order { cursor:default; color:#687295; }
  .ctx-layer-name { color:#f0f1f5; font-size:13px; font-weight:650; }
  .ctx-layer-sub { color:var(--text-faint); font-size:10.5px; margin-top:3px; }
  .ctx-layer-badge {
      display:inline-flex; align-items:center; margin-top:7px; padding:2px 7px; border-radius:999px;
      font-size:10px; color:#aeb8e8; border:1px solid #3b4567; background:#20263a;
  }
  .ctx-layer-badge.draft { color:#b5a982; border-color:#51492f; background:#2b271b; }
  .ctx-items { display:flex; flex-direction:column; gap:6px; }
  .ctx-item {
      display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:8px;
      padding:6px 7px; border:1px solid transparent; border-radius:7px; background:#171921;
  }
  .ctx-item:focus-within { border-color:#414967; background:#191c26; }
  .ctx-item input[type="text"] {
      min-width:0; width:100%; padding:4px 6px; color:var(--text); background:transparent;
      border:0; border-bottom:1px solid transparent; font:inherit; font-size:11.5px;
  }
  .ctx-item input[type="text"]:focus { outline:none; border-bottom-color:#596691; }
  .ctx-item input[type="checkbox"] { accent-color:#7180bd; }
  .ctx-icon-btn {
      width:26px; height:26px; padding:0; border-radius:6px; color:#73798a; background:transparent;
      border:1px solid transparent; box-shadow:none;
  }
  .ctx-icon-btn:hover { color:#ffb4bd; border-color:#56333b; background:#2e1d22; filter:none; }
  .ctx-layer-actions { display:flex; flex-direction:column; align-items:flex-end; gap:7px; min-width:92px; }
  .ctx-save-state { color:var(--text-faint); font-size:10.5px; min-height:16px; }
  .ctx-add {
      margin-top:6px; padding:5px 9px; font-size:10.5px; border:1px dashed #3c4254;
      background:transparent; color:#9aa0b0; box-shadow:none;
  }
  .ctx-add:hover { background:#232631; border-color:#6673a8; filter:none; }
  .ctx-reset-menu { display:none; flex-wrap:wrap; gap:7px; padding:10px 0 0; }
  .ctx-reset-menu.on { display:flex; }
  .ctx-todo-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:10px; }
  #ctx-todo-editor {
      display:block; width:100%; min-height:310px; resize:vertical; background:#101219; color:#dfe1e7;
      border:1px solid #2c303c; border-radius:9px; padding:13px 14px;
      font:12px/1.7 "JetBrains Mono",Consolas,monospace;
  }
  #ctx-todo-editor[readonly] { color:#aeb1bc; background:#12141a; }
  .ctx-warning {
      padding:9px 11px; border-radius:8px; font-size:11px; line-height:1.55;
      color:#c9b98a; border:1px solid #4a4234; background:#232120;
  }
  .context-flow { display:flex; flex-direction:column; gap:8px; }
  .context-step { display:grid; grid-template-columns:42px minmax(145px,210px) 1fr auto; align-items:center; gap:12px;
                  padding:12px; border:1px solid var(--line-soft); border-radius:10px; background:#1b1e27; }
  .context-step .step-no { width:32px; height:32px; display:grid; place-items:center; border-radius:9px; background:#11131a;
                           color:#8793c8; font:600 11px Consolas,monospace; border:1px solid #2c3140; }
  .context-step strong { color:#edf0f7; font-size:12.5px; }
  .context-step small { display:block; margin-top:4px; color:var(--text-faint); font-size:10.5px; line-height:1.45; }
  .context-step .load-rule { color:#aeb8e8; font-size:10.5px; line-height:1.5; }
  .context-step.fixed { border-color:#354064; background:#202432; }
  .context-step.off { opacity:.62; }
  .context-note { margin-top:10px; color:var(--text-faint); font-size:10.5px; line-height:1.6; }
  .context-sources { display:flex; flex-direction:column; gap:10px; }
  .context-source { border:1px solid var(--line-soft); border-radius:11px; background:#1b1e27; overflow:hidden; }
  .context-source-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; padding:13px 14px; }
  .context-source-title { color:#f0f1f5; font-size:13px; font-weight:650; }
  .context-source-meta { margin-top:4px; color:var(--text-faint); font-size:10.5px; line-height:1.5; }
  .context-source-preview { padding:0 14px 13px; color:#c7c9d4; font:11.5px/1.65 "Microsoft YaHei",sans-serif;
                            white-space:pre-wrap; max-height:150px; overflow:auto; }
  .context-source-editor { display:none; padding:0 14px 14px; }
  .context-source.editing .context-source-preview { display:none; }
  .context-source.editing .context-source-editor { display:block; }
  .context-source-editor textarea { min-height:220px; resize:vertical; }
  .context-source-actions { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-top:9px; }
  .context-source-status { color:var(--text-faint); font-size:10.5px; }
  .memory-episode { padding:14px 15px; border:1px solid var(--line); border-radius:10px; background:var(--surface-2); }
  .memory-episode .when { color:var(--text-faint); font-size:10.5px; }
  .memory-episode h3 { margin:6px 0 7px; color:#eef0f6; font-size:13px; }
  .memory-episode p { margin:0; color:#c9ccd5; font-size:12px; line-height:1.75; white-space:pre-wrap; }
  .memory-episode .origin { margin-top:8px; color:#777e90; font-size:10px; }
  @media (max-width:840px) {
      #tabs { overflow-x:auto; padding:8px 10px; }
      #tabs .brand-copy, #tabs .hint, #tabs .spacer { display:none; }
      #tabs .tab { flex:0 0 auto; padding:7px 10px; }
      .view { padding:14px 12px; }
      .core-status-grid,.quick-nav,.read-policy { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .memory-map { grid-template-columns:1fr; }
      .memory-stage:not(:last-child)::after { content:"↓"; top:auto; right:50%; bottom:-17px; }
      .context-step { grid-template-columns:36px 1fr auto; }
      .context-step .load-rule { grid-column:2 / -1; }
      .ctx-layer { grid-template-columns:36px 1fr auto; }
      .ctx-items { grid-column:2 / -1; }
      .ctx-layer-actions { grid-column:2 / -1; flex-direction:row; align-items:center; justify-content:space-between; }
  }
  @media (max-width:520px) {
      .core-hero-top { display:block; }
      .core-state { display:inline-block; margin-top:12px; }
      .core-status-grid,.quick-nav,.read-policy { grid-template-columns:1fr; }
      .cardgrid { grid-template-columns:1fr; }
      .nav-divider { display:none; }
  }
</style>
</head>
<body>
<div id="app">
  <div id="tabs">
    <div class="brand"><span class="brand-mark">520</span><span class="brand-copy"><strong>Cyberlink</strong><small>MEMORY CONSOLE</small></span></div>
    <div class="tab on" data-view="health">总览</div>
    <div class="tab" data-view="memorymap">记忆数据</div>
    <div class="tab" data-view="context">上下文控制</div>
    <div class="tab" data-view="continuity">事件流水</div>
    <div class="tab" data-view="octant">八维状态</div>
    <div class="tab" data-view="timeline">Timeline</div>
    <div class="nav-divider"></div>
    <div class="tab secondary" data-view="care">关怀</div>
    <div class="tab secondary" data-view="theater">剧场</div>
    <div class="tab secondary" data-view="files">文件</div>
    <div class="spacer"></div>
    <div id="auto-indicator" onclick="toggleAutoRefresh()" title="20 秒自动刷新中(点击暂停)" style="cursor:pointer;font-size:14px;padding:0 10px;user-select:none;">●</div>
    <div class="hint">记忆面板 v3 · 127.0.0.1:520</div>
  </div>

  <div id="views">
    <!-- 1 健康度 -->
    <div class="view on" id="view-health">
      <div id="core-health-summary"></div>
      <div class="quick-nav">
        <button class="quick-link" onclick="switchView('memorymap')"><strong>查看记忆怎么运转</strong><small>Episode、Portrait、Self-note 与候选层</small></button>
        <button class="quick-link" onclick="switchView('context')"><strong>控制本轮加载内容</strong><small>三个真实开关与固定载入顺序</small></button>
        <button class="quick-link" onclick="switchView('continuity')"><strong>查看刚才发生了什么</strong><small>可读事件、Review 决策与正式 Canon</small></button>
        <button class="quick-link" onclick="switchView('context')"><strong>编辑所有缝入内容</strong><small>Persona、Re-entry、Live State 与 Memory Context</small></button>
      </div>
      <details class="advanced-details"><summary>详细诊断与原始指标</summary>
        <div class="details-body"><div id="alertbar"></div><div class="cardgrid" id="health-cards"></div></div>
      </details>
    </div>

    <div class="view" id="view-continuity">
      <div class="notice">Phase 4 read-only console. Canon and Desire writes remain frozen; re-review only invokes the controlled review service.</div>
      <div class="view-stack">
        <div><div class="section-head">Module state</div><div id="continuity-modules"></div></div>
        <div><div class="section-head">Context Trace</div><div id="continuity-trace"></div></div>
        <div><div class="section-head">Candidates</div><div id="continuity-candidates"></div></div>
        <div><div class="section-head">Decisions</div><div id="continuity-decisions"></div></div>
      </div>
    </div>

    <!-- 注入 -->
    <div class="view" id="view-injection">
      <div class="notice">这里看“当前线程到底吃了什么”。重点不是 memory/ 里有哪些文件，而是当前 runtime persona、operations、记忆块、reentry 有没有真的进到 Cyberboss 的线程里。</div>
      <div class="view-stack">
        <div class="cardgrid" id="injection-head"></div>
        <div>
          <div class="section-head">当前注入顺序</div>
          <div class="cardgrid" id="injection-runtime-chain"></div>
        </div>
        <div>
          <div class="section-head">源头文件 / 同步工具</div>
          <div class="cardgrid" id="injection-source-chain"></div>
        </div>
        <div>
          <div class="section-head">当前真正的注入内容</div>
          <div class="cardgrid" id="injection-sections"></div>
        </div>
        <div>
          <div class="section-head">实际模型提示词（完整内容）</div>
          <div class="notice" id="runtime-prompt-meta">读取中…</div>
          <textarea id="runtime-prompt-editor" readonly style="min-height:420px; margin-top:10px;"></textarea>
          <div class="row" style="margin-top:10px;">
            <button id="runtime-prompt-edit" onclick="editRuntimePrompt()">修改实际提示词</button>
            <button id="runtime-prompt-save" onclick="previewRuntimePromptSave()" style="display:none;">查看差异并保存</button>
            <button class="ghost" id="runtime-prompt-cancel" onclick="cancelRuntimePromptEdit()" style="display:none;">取消</button>
            <select id="runtime-prompt-backups" aria-label="历史提示词版本"></select>
            <button class="ghost" onclick="restoreRuntimePrompt()">恢复所选版本</button>
            <span id="runtime-prompt-status" class="status"></span>
          </div>
        </div>
      </div>
    </div>

    <!-- 记忆 -->
    <div class="view" id="view-memorymap">
      <div class="view-stack">
        <section class="ctx-section">
          <div class="ctx-section-head"><div><h3 class="ctx-section-title">记忆是怎么流动的</h3>
            <div class="ctx-section-copy">先看流程，再看每层真实数据。候选不会自动冒充正式记忆。</div></div></div>
          <div class="ctx-section-body">
            <div class="memory-map">
              <div class="memory-stage"><span class="num">01</span><strong>对话与运行事件</strong><p>Telegram 对话、上下文 Trace 和八维状态是原始来源。</p></div>
              <div class="memory-stage"><span class="num">02</span><strong>证据与候选</strong><p>Janitor 补漏，只形成待审材料，不直接改变 AI 的长期记忆。</p></div>
              <div class="memory-stage"><span class="num">03</span><strong>Review</strong><p>判断接受、合并、延后或拒绝，并保留决定依据。</p></div>
              <div class="memory-stage"><span class="num">04</span><strong>正式记忆</strong><p>Episode、Timeline、Portrait 与 Self-note 分工保存。</p></div>
              <div class="memory-stage"><span class="num">05</span><strong>下次载入</strong><p>Re-entry、八维摘要和按需回忆经真实 gate 进入上下文。</p></div>
            </div>
            <div class="read-policy">
              <div class="policy-card"><span class="policy-pill">新线程首轮</span><strong>Re-entry</strong><span>醒来第一包，短、慢变化，受 Re-entry 开关控制。</span></div>
              <div class="policy-card"><span class="policy-pill">首轮 / 刷新</span><strong>八维与当前状态</strong><span>告诉模型“现在是什么状态”，不是长期事实。</span></div>
              <div class="policy-card"><span class="policy-pill">按需读取</span><strong>Episode / Timeline</strong><span>需要回忆时检索，不应每轮把全部历史塞进上下文。</span></div>
              <div class="policy-card"><span class="policy-pill">后台私有</span><strong>AI Self-note</strong><span>AI 的反思日记，普通对话默认不整本载入。</span></div>
            </div>
          </div>
        </section>
        <div class="cardgrid" id="memory-head"></div>
        <div>
          <div class="section-head">最近正式 Episodes 与主体记忆</div>
          <div class="cardgrid" id="memory-current"></div>
        </div>
        <details class="advanced-details"><summary>正式层文件状态</summary><div class="details-body"><div class="cardgrid" id="memory-formal"></div></div></details>
        <details class="advanced-details"><summary>自动补记与待审候选</summary><div class="details-body"><div class="cardgrid" id="memory-auto"></div></div></details>
        <details class="advanced-details"><summary>运行时缓存与历史归档</summary><div class="details-body"><div class="cardgrid" id="memory-runtime"></div></div></details>
        <details class="advanced-details"><summary>最近几天的文件更新痕迹</summary><div class="details-body"><div id="memory-daily"></div></div></details>
      </div>
    </div>

    <!-- 2 时间线 -->
    <div class="view" id="view-timeline">
      <div id="timeline-meta" class="notice"></div>
      <div id="timeline-body"></div>
    </div>

    <!-- 3 八维 -->
    <div class="view" id="view-octant">
      <div id="octant-notice">AI 自报状态,非关系测量。这页用来看写入断档,不用来读心。</div>
      <div class="hcard" id="desire-schedule-card" style="margin:12px 0;">
        <h3>八维调度设置</h3>
        <div class="form-row"><label>启用状态</label><input type="checkbox" id="desire-schedule-enabled"></div>
        <div class="form-row"><label>Cadence</label><input type="text" value="55 分钟" disabled id="desire-schedule-interval"></div>
        <div class="form-row"><label>夜间跳过</label><input type="checkbox" id="desire-schedule-night-enabled"></div>
        <div class="form-row"><label>夜间开始</label><input type="time" id="desire-schedule-night-start"></div>
        <div class="form-row"><label>夜间结束</label><input type="time" id="desire-schedule-night-end"></div>
        <div class="form-row"><label>调度时区</label><input list="desire-timezone-options" id="desire-schedule-timezone" placeholder="搜索城市或 IANA 名称"><datalist id="desire-timezone-options"></datalist></div>
        <div id="desire-schedule-current" class="meta">读取中…</div>
        <div id="desire-schedule-status" class="form-status"></div>
        <div style="margin-top:10px;"><button onclick="saveDesireSchedule()">保存调度设置</button></div>
      </div>
      <div id="octant-source"></div>
      <div id="octant-live"></div>
      <div id="octant-archive-note" class="notice"></div>
      <div id="curve-box">
        <div id="curve-legend"></div>
        <canvas id="octant-canvas" width="1000" height="260"></canvas>
      </div>
      <div class="spark-row" id="spark-row"></div>
      <div style="max-height:60vh; overflow-y:auto;">
        <table class="octant" id="octant-table"></table>
      </div>
    </div>

    <!-- 4 关怀 -->
    <div class="view" id="view-care">
      <div class="notice">这页只是表单和展示:数据只由她录入/确认,不做分析、不做预测、不画周期图表;cycle 永不进 memory/(user_portrait / episodes)。默认全关——开任何提醒之前,先在聊天里问过她。</div>
      <div class="cardgrid">
        <div class="hcard">
          <h3>关怀设置(care/config.json)</h3>
          <div class="form-row"><label>城市(天气用)</label><input disabled type="text" id="care-city" placeholder="如 Shanghai;留空 = 不取天气"></div>
          <div class="form-row"><label>天气轻触</label><input disabled type="checkbox" id="care-weather"></div>
          <div class="form-row"><label>经期·沉默档</label><input disabled type="checkbox" id="care-silent"></div>
          <div class="form-row"><label>经期·轻触档</label><input disabled type="checkbox" id="care-touch"></div>
          <div class="form-row"><label>每天轻触上限</label><input disabled type="number" id="care-max" min="0" max="10" step="1"></div>
          <div class="form-row"><label>https 代理(可选)</label><input disabled type="text" id="care-proxy" placeholder="wttr.in 直连不通再填,如 http://127.0.0.1:7890"></div>
          <div style="margin-top:12px;"><span id="care-status" class="form-status">只读</span></div>
        </div>
        <div class="hcard">
          <h3>cycle 录入(只由她填,追加进 care/cycle.md)</h3>
          <div class="form-row"><label>日期</label><input disabled type="date" id="cycle-date"></div>
          <div class="form-row"><label>类型</label><select disabled id="cycle-kind"><option value="开始">开始</option><option value="结束">结束</option></select></div>
          <div class="form-row"><label>备注(可选)</label><input disabled type="text" id="cycle-note" maxlength="100"></div>
          <div style="margin-top:12px;"><span id="cycle-status" class="form-status">只读</span></div>
        </div>
        <div class="hcard" style="grid-column:1/-1;">
          <h3>cycle.md 现有内容(只读展示;写错了直接改文件本体,面板不提供删除)</h3>
          <pre id="cycle-view"></pre>
        </div>
      </div>
    </div>

    <!-- 5 剧场 -->
    <div class="view" id="view-theater">
      <div class="notice">剧本是两个人一起翻着挑的,这页只是把链接放在一处——不是推荐算法。战役档案在 theater/campaigns/,戏内内容永不进 memory/。</div>
      <div id="theater-intro"></div>
      <div id="theater-list"></div>
    </div>

    <!-- 上下文编排 -->
    <div class="view" id="view-context">
      <div class="ctx-shell">
        <section class="ctx-hero">
          <div class="ctx-kicker">Context Control</div>
          <h2 class="ctx-title">本轮模型会看到什么</h2>
          <div class="ctx-lead">
            这里是上下文的唯一控制入口。修改硬上下文或开关后，Telegram 会在下一条消息自动换一个干净线程，旧内容不会继续留在模型上下文里。
          </div>
          <div class="ctx-toolbar">
            <span class="ctx-meta" id="ctx-runtime-summary">读取中…</span>
          </div>
        </section>

        <details class="advanced-details">
          <summary>运行路径与模块诊断</summary>
          <div class="details-body"><div class="ctx-runtime-grid" id="ctx-runtime-grid"></div></div>
        </details>

        <section class="ctx-section">
          <div class="ctx-section-head"><div><h3 class="ctx-section-title">实际载入顺序与真实注入开关</h3>
            <div class="ctx-section-copy">从上到下进入模型上下文；固定层不能关闭，记忆层可即时开关。</div></div>
            <span class="ctx-save-state" id="ctx-gate-status"></span></div>
          <div class="ctx-section-body"><div class="ctx-gates" id="ctx-gates"></div></div>
        </section>

        <section class="ctx-section">
          <div class="ctx-section-head"><div><h3 class="ctx-section-title">实际缝入内容</h3>
            <div class="ctx-section-copy">四个入口对应四种真实来源。Live State 和 Memory Context 留空时恢复自动模式。</div></div></div>
          <div class="ctx-section-body"><div class="context-sources" id="context-sources">读取中…</div></div>
        </section>

      </div>
    </div>

    <!-- 6 文件 -->
    <div class="view" id="view-files">
      <div id="files-layout">
        <div id="side"><h1>memory/</h1><div id="filelist"></div></div>
        <div id="main">
          <div id="bar">
            <span id="fname">← 选一个文件</span>
            <span id="rolabel"></span>
            <button id="editbtn" style="display:none" onclick="enterEdit()">编辑</button>
            <button id="savebtn" style="display:none" onclick="tryShowDiff()">保存</button>
            <button class="ghost" id="cancelbtn" style="display:none" onclick="cancelEdit()">取消</button>
            <span id="status"></span>
          </div>
          <div id="cards"></div>
          <textarea id="ed" spellcheck="false" style="display:none" readonly></textarea>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="modal-mask">
  <div id="modal-box">
    <h3>确认改动(逐行 diff)</h3>
    <div id="modal-diff"></div>
    <div id="modal-actions">
      <button class="ghost" onclick="closeModal()">取消</button>
      <button onclick="confirmSave()">确认保存</button>
    </div>
  </div>
</div>

<script>
let labels = %LABELS%;
let guardConfirm = %GUARD_CONFIRM%;
let curView = 'health';
let curFile = null, origContent = '', editing = false;
let contextLayoutPayload = null;
let contextLayoutSaveTimer = null;
let contextDraggedGroup = null;
let contextTodoOriginal = '';
let contextTodoEditing = false;
let contextSourcesPayload = null;
let contextSourceEditingKey = '';
let runtimePromptOriginal = '';
let runtimePromptPayload = null;
let runtimePromptEditing = false;
let pendingAction = null;

// ---------- tab 切换 ----------
function switchView(name) {
  curView = name;
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('on', t.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
  document.getElementById('view-' + name).classList.add('on');
  if (name === 'health') loadHealth();
  if (name === 'continuity') loadContinuity();
  if (name === 'injection') loadInjection();
  if (name === 'memorymap') loadMemoryMap();
  if (name === 'timeline') loadTimeline();
  if (name === 'octant') loadOctant();
  if (name === 'care') loadCare();
  if (name === 'theater') loadTheater();
  if (name === 'context') loadContextManager();
  if (name === 'files') refreshFilesView();
}
document.querySelectorAll('#tabs .tab').forEach(t => {
  t.onclick = () => switchView(t.dataset.view);
});

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

async function retryContinuityReview(candidateId, button) {
  button.disabled = true;
  try {
    const r = await fetch('/api/review/retry', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Api-Token': getApiToken()},
      body: JSON.stringify({candidate_id: candidateId}),
    });
    const data = await r.json();
    button.textContent = data.ok ? 'Review requested' : ('Unavailable: ' + (data.error || r.status));
    if (data.ok) setTimeout(loadContinuity, 500);
  } catch (e) {
    button.textContent = 'Unavailable';
  }
}

function renderContinuityRows(targetId, rows, allowRetry) {
  const target = document.getElementById(targetId);
  target.innerHTML = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'continuity-row'; empty.textContent = 'No records.'; target.appendChild(empty);
    return;
  }
  rows.slice().reverse().forEach(row => {
    const box = document.createElement('div'); box.className = 'continuity-row';
    const event = describeContinuityEvent(row, targetId);
    const title = document.createElement('div'); title.className = 'event-title'; title.textContent = event.title; box.appendChild(title);
    if (event.meta) { const meta = document.createElement('div'); meta.className = 'event-meta'; meta.textContent = event.meta; box.appendChild(meta); }
    if (event.body) { const body = document.createElement('div'); body.className = 'event-body'; body.textContent = event.body; box.appendChild(body); }
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '查看原始记录'; details.appendChild(summary);
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(row, null, 2); details.appendChild(pre); box.appendChild(details);
    if (allowRetry && ['deferred', 'rejected'].includes(row.result || row.action) && row.candidate_id) {
      const button = document.createElement('button'); button.className = 'ghost'; button.textContent = 'Re-review';
      button.onclick = () => retryContinuityReview(row.candidate_id, button); box.appendChild(button);
    }
    target.appendChild(box);
  });
}

function continuityTypeLabel(value) {
  return ({episode:'事件记忆', self_note:'AI 私人日记', reentry_draft:'下次醒来交接稿',
    accepted:'已接受', rejected:'已拒绝', deferred:'已延后', merged:'已合并'})[value] || value || '';
}

function continuityReasonLabel(value) {
  return ({default_hidden:'默认不加载', existing_thread:'已是现有线程', already_injected:'本线程已经加载过',
    gated_off:'运行开关已关闭', missing:'来源不存在', reviewed:'证据与边界检查通过',
    subject_review_required:'需要主体 AI 复核', boundary_touch:'涉及边界内容，需要复核',
    semantic_authority_missing:'来源没有语义执笔权', legacy_uncovered:'历史会话区间尚未覆盖',
    imperative_style:'以祈使句开头，已打回重写'})[value] || value || '';
}

function continuityCheckLabel(value) {
  return ({source_ref_located:'来源可定位', length_ok:'长度合规', safety_ok:'安全检查通过',
    imperative_warning:'含命令式措辞', duplicate_of:'重复于', publication_allowed:'允许发布',
    imperative_style:'开头是祈使句', imperative_pattern:'命中的祈使模式', imperative_exempt:'祈使检查豁免'})[value] || value;
}

function sourceRefText(ref) {
  if (!ref) return '';
  if (typeof ref === 'string') return ref;
  const file = ref.file ? String(ref.file).split(/[\\/]/).pop() : '';
  return [file, ref.window ? ('行 ' + ref.window) : ''].filter(Boolean).join(' · ');
}

function describeContinuityEvent(row, targetId) {
  const when = row.ts || row.time || row.detected_at || row.created_at || row.updated_at || '';
  const id = row.trace_entry_id || row.gap_id || row.evidence_id || row.candidate_id || row.decision_id || row.ep_id || row.id || '';
  const source = sourceRefText(row.source_ref);
  if (targetId === 'continuity-trace' || Array.isArray(row.blocks) || Array.isArray(row.skipped)) {
    const loaded = (row.blocks || []).map(item => typeof item === 'string' ? item : item.type).filter(Boolean);
    const skipped = (row.skipped || []).map(item => typeof item === 'string' ? item : ((item.type || '未知块') + '（' + continuityReasonLabel(item.reason || '未说明') + '）'));
    const mode = row.opening === true ? '新线程首轮' : (row.opening === false ? '普通对话' : '上下文记录');
    const lines = [loaded.length ? ('实际载入：' + loaded.join('、')) : '本轮没有额外载入记忆块。',
      skipped.length ? ('未载入：' + skipped.join('；')) : '',
      row.recall_calls && row.recall_calls.length ? ('主动回忆调用：' + row.recall_calls.length + ' 次') : '主动回忆：未调用',
      '受控上下文记录量：' + Number(row.total_chars || 0) + ' 字符' + (row.fallback ? '；使用了回退路径' : '')].filter(Boolean);
    return {title:'上下文事件 · ' + mode, meta:[when, row.thread ? ('线程 ' + row.thread) : '', row.turn || id].filter(Boolean).join(' · '), body:lines.join('\n')};
  }
  if (targetId === 'continuity-evidence' || row.evidence_id) return {title:'已保存证据材料', meta:[when,row.evidence_id || id,source,row.origin].filter(Boolean).join(' · '), body:row.body || row.text || row.excerpt || '材料已保存，但它本身还不是正式记忆。'};
  if (targetId === 'continuity-gaps' || row.gap_id) return {title:'发现技术断档', meta:[when,id,source].filter(Boolean).join(' · '), body:continuityReasonLabel(row.reason) || row.note || '这段会话尚未被记忆流水线覆盖，等待补取证据。'};
  if (targetId === 'continuity-decisions' || row.result || row.action) {
    const result = row.result || row.action || 'unknown'; const checks = row.checks || {};
    const checkText = Object.keys(checks).length ? Object.entries(checks).map(([key,value]) => continuityCheckLabel(key) + '：' + String(value)).join('；') : '';
    return {title:'Review 决策 · ' + continuityTypeLabel(result), meta:[when,row.decision_id || id,row.candidate_id].filter(Boolean).join(' · '), body:[row.reason ? ('原因：' + continuityReasonLabel(row.reason)) : '', row.merged_into ? ('合并到：' + row.merged_into) : '', checkText ? ('检查：' + checkText) : ''].filter(Boolean).join('\n') || '审核完成。'};
  }
  if ((targetId || '').includes('candidates') || (row.candidate_id && !row.ep_id)) {
    const authority = row.author_role === 'subject_ai' ? '主体 AI 执笔' : (row.author_role === 'background_proxy' ? '后台代理草稿' : '待确认来源');
    return {title:continuityTypeLabel(row.type) + '候选', meta:[when,id,authority,source].filter(Boolean).join(' · '), body:humanizeEpisodeText(row.body || row.what_happened || row.summary || '候选已生成，尚未看到可展示的正文。')};
  }
  if (targetId === 'continuity-canon' || row.ep_id || row.title || row.what_happened) return {title:'正式事件 · ' + humanizeEpisodeText(row.title || row.ep_id || row.candidate_id || 'Episode'), meta:[when,row.ep_id || id,source].filter(Boolean).join(' · '), body:humanizeEpisodeText(row.what_happened || row.body || row.summary || '已发布到正式记忆。')};
  if (targetId === 'continuity-config-events' || ['prompt_saved','context_source_saved'].includes(row.event)) {
    const labels = {prompt:'System / Persona',reentry:'Re-entry',current_state:'Live State',memory_context:'Memory Context'};
    const label = row.event === 'prompt_saved' ? 'System / Persona' : (labels[row.context_key] || row.context_key || '上下文');
    return {title:label + ' 已更新', meta:[when,row.after_sha256 ? ('新版本 ' + row.after_sha256.slice(0,12)) : ''].filter(Boolean).join(' · '), body:'修改来源：' + (row.source || '520') + '\n旧版本已自动备份。'};
  }
  const summaryText = row.body || row.text || row.note || row.summary || row.reason || '';
  return {title:'系统事件' + (id ? (' · ' + id) : ''), meta:[when,source].filter(Boolean).join(' · '), body:summaryText || '这条记录没有标准摘要，可展开查看原始字段。'};
}

async function loadContinuity() {
  const [moduleRes, traceRes, candidateRes, decisionRes] = await Promise.all([
    fetch('/api/module-state'), fetch('/api/context-trace?limit=30'),
    fetch('/api/continuity/candidates?limit=30'), fetch('/api/continuity/decisions?limit=30'),
  ]);
  const [moduleData, traceData, candidateData, decisionData] = await Promise.all([
    moduleRes.json(), traceRes.json(), candidateRes.json(), decisionRes.json(),
  ]);
  const modules = document.getElementById('continuity-modules'); modules.innerHTML = '';
  Object.entries(moduleData.modules || {}).forEach(([name, state]) => {
    const item = document.createElement('span'); item.className = 'module-state ' + state;
    item.textContent = name + ': ' + state; modules.appendChild(item);
  });
  await loadContextGates(modules);
  renderContinuityRows('continuity-trace', traceData.rows || [], false);
  renderContinuityRows('continuity-candidates', candidateData.rows || [], false);
  renderContinuityRows('continuity-decisions', decisionData.rows || [], true);
}

// ---------- 上下文缝入开关(即时生效,runtime 每轮读取) ----------
const CONTEXT_GATE_LABELS = { reentry: 'Re-entry 注入', current_state: '当前姿态注入', memory_context: '记忆缝入上下文' };
async function loadContextGates(container) {
  try {
    const r = await fetch('/api/context-gates'); const gates = await r.json();
    Object.entries(CONTEXT_GATE_LABELS).forEach(([key, label]) => {
      const on = gates[key] !== false;
      const item = document.createElement('span');
      item.className = 'module-state ' + (on ? 'on' : 'failed');
      item.style.cursor = 'pointer';
      item.title = '点击切换,下一轮生效';
      item.textContent = label + ': ' + (on ? '开' : '关');
      item.onclick = async () => {
        const body = {}; body[key] = !on;
        const res = await fetch('/api/context-gates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': TOKEN },
          body: JSON.stringify(body),
        });
        if (res.ok) { loadContinuity(); } else { alert('切换失败: ' + res.status); }
      };
      container.appendChild(item);
    });
  } catch (e) { /* gates 面板失败不影响其余 */ }
}

// ---------- 1 健康度 ----------
function renderCoreHealthSummary(h) {
  const host = document.getElementById('core-health-summary');
  const alerts = h.alerts || [];
  const redCount = alerts.filter(item => item.level === 'red').length;
  const stateClass = redCount ? 'bad' : (alerts.length ? '' : 'ok');
  const stateText = redCount ? '存在故障' : (alerts.length ? alerts.length + ' 项需要留意' : '运行正常');
  const bridge = h.bridge_status || {};
  const bridgeGap = bridge.latest_long_gap;
  const bridgeClass = bridgeGap ? 'bad' : (bridge.runtime_exit_at ? 'warn' : '');
  const bridgeTitle = bridgeGap ? '发现长断档' : (bridge.runtime_exit_at ? '近期曾异常退出' : '近 48 小时无长断档');
  const bridgeDetail = bridgeGap ? (Math.round(Number(bridgeGap.minutes || 0)) + ' 分钟') : 'Telegram 链路观察';
  const reentryOver = Number(h.reentry_chars || 0) > Number(h.reentry_budget || 0);
  const octantAge = Number((h.desire_state || {}).hours_since_update || h.hours_since_state || 0);
  const octantClass = octantAge > 8 ? 'warn' : '';
  const candidateClass = Number(h.candidates_n || 0) > 50 ? 'warn' : '';
  host.innerHTML = '<section class="core-hero"><div class="core-hero-top"><div>' +
    '<div class="core-eyebrow">Cyberlink status</div><h1 class="core-title">现在的系统状态</h1>' +
    '<div class="core-copy">只显示会影响使用的结论。底层路径、原始 JSON 和开发诊断已收进折叠区。</div></div>' +
    '<div class="core-state ' + stateClass + '">' + esc(stateText) + '</div></div>' +
    '<div class="core-status-grid">' +
      '<div class="core-status ' + bridgeClass + '"><div class="label">TELEGRAM / RUNTIME</div><strong>' + esc(bridgeTitle) + '</strong><small>' + esc(bridgeDetail) + '</small></div>' +
      '<div class="core-status ' + (reentryOver ? 'bad' : '') + '"><div class="label">RE-ENTRY</div><strong>' + esc(h.reentry_chars) + ' / ' + esc(h.reentry_budget) + ' 字符</strong><small>' + (reentryOver ? '已超过预算，需要收缩' : '醒来第一包在预算内') + '</small></div>' +
      '<div class="core-status ' + octantClass + '"><div class="label">八维状态</div><strong>' + (octantAge ? esc(octantAge) + ' 小时前' : '暂无时间') + '</strong><small>' + (octantAge > 8 ? '心跳偏旧，但数据结构完整' : '状态刷新正常') + '</small></div>' +
      '<div class="core-status ' + candidateClass + '"><div class="label">待审候选</div><strong>' + esc(h.candidates_n || 0) + ' 条</strong><small>候选不会自动进入正式记忆</small></div>' +
    '</div></section>';
}

async function loadHealth() {
  const r = await fetch('/api/health'); const h = await r.json();
  renderCoreHealthSummary(h);
  const ab = document.getElementById('alertbar');
  ab.innerHTML = '';
  if (h.alerts.length === 0) {
    const d = document.createElement('div'); d.className = 'alert ok';
    d.textContent = '没有检测到异常。';
    ab.appendChild(d);
  } else {
    for (const a of h.alerts) {
      const d = document.createElement('div'); d.className = 'alert ' + (a.level === 'red' ? 'red' : 'amber');
      d.textContent = a.text;
      ab.appendChild(d);
    }
  }

  const cards = document.getElementById('health-cards');
  cards.innerHTML = '';

  // reentry 字数
  const pct = Math.min(100, Math.round(h.reentry_chars / h.reentry_budget * 100));
  const barClass = h.reentry_chars > h.reentry_budget ? 'danger' : (pct > 80 ? 'warn' : '');
  cards.innerHTML += '<div class="hcard"><h3>reentry 字数(全面板最重要的数字)</h3>' +
    '<div class="big">' + h.reentry_chars + ' / ' + h.reentry_budget + '</div>' +
    '<div class="barwrap"><div class="barfill ' + barClass + '" style="width:' + pct + '%"></div></div>' +
    '<div class="sub">这个数字悄悄涨 = 系统在坏掉,不管感觉多好。</div></div>';

  // episodes 总数 + importance 分布
  let impHtml = '<div class="impbars">';
  const maxCount = Math.max(1, ...Object.values(h.importance_dist));
  for (let i = 1; i <= 5; i++) {
    const c = h.importance_dist[String(i)] || 0;
    const hgt = Math.round(c / maxCount * 60) + (c > 0 ? 4 : 0);
    impHtml += '<div class="impbar-col"><div class="impbar" style="height:' + hgt + 'px"></div>' +
      '<div class="impbar-label">' + i + ' · ' + c + '</div></div>';
  }
  impHtml += '</div>';
  cards.innerHTML += '<div class="hcard"><h3>episodes 总数 / 重要度分布</h3>' +
    '<div class="big">' + h.episodes_total + '</div>' + impHtml + '</div>';

  const mf = h.memory_files || {};
  const formalRe = mf.formal_reentry || {};
  const formalEp = mf.formal_episodes || {};
  const autoRe = mf.auto_reentry || {};
  const autoCand = mf.auto_candidates || {};
  const autoRePreview = autoRe.preview
    ? '<pre style="white-space:pre-wrap; font-size:11px; color:#9aa0b0; margin:8px 0 0; max-height:120px; overflow-y:auto;">' + esc(autoRe.preview) + '</pre>'
    : '<div class="sub">(暂无补记稿)</div>';
  cards.innerHTML += '<div class="hcard"><h3>最新自动补记(reentry.extracted.md)</h3>' +
    '<div class="big" style="font-size:16px;">' + esc(autoRe.updated_at || '(无记录)') + '</div>' +
    '<div class="sub">' + (autoRe.hours_since_update != null ? ('距今 ' + autoRe.hours_since_update + ' 小时') : '') + '</div>' +
    autoRePreview + '</div>';
  cards.innerHTML += '<div class="hcard"><h3>记忆分层更新时间</h3>' +
    '<div class="sub">formal reentry.md: ' + esc(formalRe.updated_at || '(无记录)') + '</div>' +
    '<div class="sub">formal episodes.jsonl: ' + esc(formalEp.updated_at || '(无记录)') + '</div>' +
    '<div class="sub">auto episodes.candidates.jsonl: ' + esc(autoCand.updated_at || '(无记录)') + '</div>' +
    '<div class="sub">正式层旧是正常现象;自动层最新值看 extracted/candidates。</div></div>';

  const ds = h.desire_state || {};
  let dsHtml = '';
  if (!ds.exists) {
    dsHtml = '<div class="sub">未找到: ' + esc(ds.path || '') + '</div>';
  } else if (ds.error) {
    dsHtml = '<div class="big" style="font-size:16px; color:#ff6b7a;">读取失败</div>' +
      '<div class="sub">' + esc(ds.error) + '</div>';
  } else {
    const preview = ds.data == null ? '(空)' : JSON.stringify(ds.data, null, 2);
    dsHtml = '<div class="big" style="font-size:16px;">' + esc(ds.updated_at || '(无时间戳)') + '</div>' +
      '<div class="sub">' + (ds.hours_since_update != null ? ('距今 ' + ds.hours_since_update + ' 小时') : '未解析到更新时间') + '</div>' +
      '<div class="sub">' + esc(ds.path || '') + '</div>' +
      '<pre style="white-space:pre-wrap; font-size:11px; color:#9aa0b0; margin:8px 0 0; max-height:120px; overflow-y:auto;">' + esc(preview) + '</pre>';
  }
  cards.innerHTML += '<div class="hcard"><h3>八维实时态(desire-state.json)</h3>' + dsHtml + '</div>';

  // state_log 历史写入 + 断档
  let gapHtml = '<div class="gaplist">';
  if (h.gaps_7d.length === 0) {
    gapHtml += '<div style="color:#6b7080">最近 7 天没有超过 2h 的断档。</div>';
  } else {
    for (const g of h.gaps_7d) {
      gapHtml += '<div>' + esc(g.from) + ' → ' + esc(g.to) + '(断档 ' + g.hours + 'h)</div>';
    }
  }
  gapHtml += '</div>';
  const octantSourceLabel = h.octant_history_source === 'desire_history' ? 'desire-history 连续八维' : 'state_log 历史八维';
  cards.innerHTML += '<div class="hcard"><h3>' + esc(octantSourceLabel) + ' / 最近 7 天断档</h3>' +
    '<div class="big" style="font-size:16px;">' + esc(h.last_state_time || '(无记录)') + '</div>' +
    '<div class="sub">' + (h.hours_since_state != null ? ('距今 ' + h.hours_since_state + ' 小时') : '') + '</div>' +
    '<div class="sub">' + esc(h.octant_history_path || '') + '</div>' +
    gapHtml + '</div>';

  // janitor + backups
  cards.innerHTML += '<div class="hcard"><h3>janitor 上次运行</h3>' +
    '<div class="big" style="font-size:16px;">' + esc(h.janitor_last_run || '(无记录)') + '</div>' +
    '<div class="sub">待审候选 ' + h.candidates_n + ' 条(episodes.candidates.jsonl)</div></div>';

  cards.innerHTML += '<div class="hcard"><h3>.backups 份数</h3><div class="big">' + h.backups_count + '</div>' +
    '<div class="sub">每次保存前自动备份旧版</div></div>';

  // 自动补记(v2.1)
  const rt = h.runtime_memory || {};
  const rtSeven = rt.seven_day || {};
  const bgWrite = rt.background_write_enabled ? '已开启' : '未开启';
  const bgWriteClass = rt.background_write_enabled ? 'ok' : 'warn';
  cards.innerHTML += '<div class="hcard"><h3>runtime 7-day memory</h3>' +
    '<div class="big" style="font-size:16px;">' + esc(rtSeven.updated_at || '(无记录)') + '</div>' +
    '<div class="status-pill ' + esc(bgWriteClass) + '">' + esc(bgWrite) + '</div>' +
    '<div class="sub">' + esc(rt.memory_dir || '') + '</div>' +
    '<div class="sub">这里才是“背景写入有没有开起来”的真实落点</div></div>';

  const bridge = h.bridge_status || {};
  const latestBridgeGap = bridge.latest_long_gap || bridge.latest_gap;
  let bridgeHtml = '<div class="sub">' + esc(bridge.path || '') + '</div>';
  if (latestBridgeGap) {
    const gapHours = Math.round((Number(latestBridgeGap.minutes || 0) / 60) * 10) / 10;
    bridgeHtml += '<div class="big" style="font-size:16px;">' + esc(gapHours) + ' 小时</div>' +
      '<div class="sub">' + esc(latestBridgeGap.from) + ' → ' + esc(latestBridgeGap.to) + '</div>';
  } else {
    bridgeHtml += '<div class="big" style="font-size:16px;">(近 48 小时无明显断档)</div>';
  }
  if (bridge.runtime_exit_at) {
    bridgeHtml += '<div class="sub">最近一次 runtime 异常退出: ' + esc(bridge.runtime_exit_at) + '</div>';
  }
  cards.innerHTML += '<div class="hcard"><h3>Telegram / runtime 断档</h3>' + bridgeHtml + '</div>';

  const aj = h.auto_janitor || {};
  let ajStatusHtml;
  if (aj.running) {
    ajStatusHtml = '<div class="big" style="font-size:16px; color:#c9b458;">运行中…</div>';
  } else if (aj.last_error) {
    ajStatusHtml = '<div class="big" style="font-size:16px; color:#ff6b7a;">失败:' + esc(aj.last_error) + '</div>';
  } else if (aj.last_returncode != null && aj.last_returncode !== 0) {
    ajStatusHtml = '<div class="big" style="font-size:16px; color:#ff6b7a;">退出码 ' + esc(aj.last_returncode) + '</div>';
  } else if (aj.last_run_at) {
    ajStatusHtml = '<div class="big" style="font-size:16px;">' + esc(aj.last_run_at) + '</div>';
  } else {
    ajStatusHtml = '<div class="big" style="font-size:16px; color:#6b7080;">尚未运行</div>';
  }
  let ajTailHtml = '';
  if (aj.last_tail) {
    ajTailHtml = '<pre style="white-space:pre-wrap; font-size:11px; color:#9aa0b0; margin:8px 0 0; max-height:90px; overflow-y:auto;">' + esc(aj.last_tail) + '</pre>';
  }
  const ajIntervalLabel = (aj.interval_hours && aj.interval_hours > 0) ? ('每 ' + esc(aj.interval_hours) + ' 小时') : '已关闭定时';
  cards.innerHTML += '<div class="hcard"><h3>自动补记(janitor,' + ajIntervalLabel + ')</h3>' +
    ajStatusHtml +
    '<div class="sub">下次运行:' + esc(aj.next_run_at || '(未排定)') + '</div>' +
    (aj.consecutive_failures > 0 ? '<div class="sub" style="color:#ff6b7a;">连续失败 ' + esc(aj.consecutive_failures) + ' 次</div>' : '') +
    ajTailHtml +
    '<div class="sub" style="margin-top:10px;">只读观察；手动 Janitor 写入口已冻结。</div></div>';
}

// 面板自身操作走本机 API,token 由后端在页面里内嵌(仅本机可见,不对外)
function getApiToken() { return %API_TOKEN%; }

function renderAuditCard(item) {
  const when = item.updated_at
    ? (esc(item.updated_at) + (item.hours_since_update != null ? (' · 距今 ' + item.hours_since_update + ' 小时') : ''))
    : '(无记录)';
  let html = '<div class="hcard">';
  html += '<h3>' + esc(item.label || item.name || '') + '</h3>';
  html += '<div class="meta-row">谁写: ' + esc(item.writer || '') + '</div>';
  html += '<div class="meta-row">更新节奏: ' + esc(item.cadence || '') + '</div>';
  html += '<div class="meta-row">最后更新: ' + when + '</div>';
  html += '<div class="meta-row">作用: ' + esc(item.purpose || '') + '</div>';
  if (typeof item.active === 'boolean') {
    html += '<div class="status-pill ' + (item.active ? 'ok' : 'warn') + '">' + (item.active ? '本轮启用' : '当前未启用') + '</div>';
  }
  if (item.rows != null) {
    html += '<div class="meta-row">条目数: ' + esc(item.rows) + (item.latest_day ? (' · 最新日期 ' + esc(item.latest_day)) : '') + '</div>';
  }
  if (item.active === false) {
    html += '<div class="meta-row">文件存在，但当前运行开关关闭，本轮不会加载正文。</div>';
  } else if (item.recent_lines && item.recent_lines.length) {
    html += '<div class="line-list">' + item.recent_lines.map(line => '<div>' + esc(line) + '</div>').join('') + '</div>';
  } else if (item.preview) {
    html += '<pre class="mini-pre">' + esc(item.preview) + '</pre>';
  }
  html += '<div class="path-row">' + esc(item.path || '') + '</div>';
  html += '</div>';
  return html;
}

function renderTextPanel(title, text) {
  const body = text ? '<pre class="mono-block">' + esc(text) + '</pre>' : '<div class="meta-row">(当前为空或未启用)</div>';
  return '<div class="hcard" style="grid-column:1/-1;"><h3>' + esc(title) + '</h3>' + body + '</div>';
}

function renderLinePanel(title, lines) {
  let body = '<div class="meta-row">(当前为空)</div>';
  if (lines && lines.length) {
    body = '<div class="line-list">' + lines.map(line => '<div>' + esc(line) + '</div>').join('') + '</div>';
  }
  return '<div class="hcard"><h3>' + esc(title) + '</h3>' + body + '</div>';
}

function humanizeEpisodeText(value) {
  return String(value || '')
    .replace(/用户发现其AI伴侣/g, '她发现我')
    .replace(/用户发现AI伴侣/g, '她发现我')
    .replace(/用户的AI伴侣/g, '她熟悉的我')
    .replace(/其AI伴侣/g, '我')
    .replace(/用户/g, '她')
    .replace(/\bAI\b/g, '我');
}

function renderMemoryEpisode(item) {
  const body = humanizeEpisodeText(item.body || '');
  const title = humanizeEpisodeText(item.title || '') || (body ? body.slice(0, 34) + (body.length > 34 ? '…' : '') : (item.id || 'Episode'));
  return '<article class="memory-episode"><div class="when">' + esc(item.time || '') + '</div><h3>' + esc(title) + '</h3>' +
    (body && body !== title ? '<p>' + esc(body) + '</p>' : '') + '<div class="origin">' + esc(item.id || '正式 Episode') + '</div></article>';
}

async function loadInjection() {
  const r = await fetch('/api/injection');
  const d = await r.json();
  const head = document.getElementById('injection-head');
  const rt = d.runtime_memory_status || {};
  const bgWrite = d.runtime_background_write_enabled ? '已开启' : '未开启';
  const bgWriteClass = d.runtime_background_write_enabled ? 'ok' : 'warn';
  const syncLabel = d.memory_block_sync == null ? '未比对' : (d.memory_block_sync ? '已同步' : '未同步');
  const syncClass = d.memory_block_sync ? 'ok' : 'warn';
  head.innerHTML =
    '<div class="hcard"><h3>当前主模型</h3><div class="big" style="font-size:18px;">' + esc(d.chat_writer || '(未知)') + '</div></div>' +
    '<div class="hcard"><h3>提取小模型</h3><div class="big" style="font-size:18px;">' + esc(d.extract_writer || '(未知)') + '</div></div>' +
    '<div class="hcard"><h3>运行时 state dir</h3><div class="meta-row">' + esc(d.runtime_state_dir || '') + '</div></div>' +
    '<div class="hcard"><h3>模板记忆块同步</h3><div class="big" style="font-size:18px;">' + esc(syncLabel) + '</div><div class="status-pill ' + esc(syncClass) + '">' + esc(syncLabel) + '</div></div>';

  head.innerHTML += '<div class="hcard"><h3>runtime 背景记忆写入</h3><div class="big" style="font-size:18px;">'
    + esc(bgWrite) + '</div><div class="status-pill ' + esc(bgWriteClass) + '">' + esc(bgWrite)
    + '</div><div class="meta-row">' + esc(rt.memory_dir || '') + '</div></div>';
  document.getElementById('injection-runtime-chain').innerHTML = (d.runtime_chain || []).map(renderAuditCard).join('');
  document.getElementById('injection-source-chain').innerHTML = (d.source_files || []).map(renderAuditCard).join('');

  const sections = d.sections || {};
  document.getElementById('injection-sections').innerHTML =
    renderTextPanel('当前角色卡 / 人格与关系', sections.role_card) +
    renderTextPanel('当前记忆与连续性块', sections.memory_continuity) +
    renderTextPanel('当前 reentry（醒来第一包）', sections.reentry) +
    renderTextPanel('operations 规则摘录', sections.operations_excerpt) +
    renderTextPanel('STATE RELAY（若启用）', sections.state_relay) +
    renderTextPanel('PENDING PROMISES（若启用）', sections.pending_promises) +
    renderTextPanel('思考方式段', sections.thinking_style);
  document.getElementById('injection-sections').innerHTML +=
    renderTextPanel('runtime 7-day-memory.md（背景写入池）', sections.runtime_seven_day) +
    renderTextPanel('runtime pending-promises.md', sections.runtime_pending_promises);
  renderRuntimePrompt(d.runtime_prompt || {});
}

function renderRuntimePrompt(prompt) {
  runtimePromptPayload = prompt;
  if (!runtimePromptEditing) {
    runtimePromptOriginal = prompt.content || '';
    document.getElementById('runtime-prompt-editor').value = runtimePromptOriginal;
  }
  const flags = [
    '模型 ' + (prompt.model || '未知'),
    'Operations ' + (prompt.operations_enabled ? '开启' : '关闭'),
    '记忆检索 ' + (prompt.memory_retrieval_enabled ? '开启' : '关闭'),
    '背景写入 ' + (prompt.background_write_enabled ? '开启' : '关闭'),
  ].join(' · ');
  document.getElementById('runtime-prompt-meta').textContent =
    (prompt.exists ? '正在生效' : '文件不存在') + ' · ' + (prompt.chars || 0) + ' 字符 · ' + (prompt.lines || 0) + ' 行 · ' +
    flags + '\n' + (prompt.path || '') + '\n' + (prompt.apply_note || '');
  const select = document.getElementById('runtime-prompt-backups');
  const selected = select.value;
  select.innerHTML = '<option value="">历史版本</option>' + (prompt.backups || []).map(item =>
    '<option value="' + esc(item.name) + '">' + esc((item.updated_at || '') + ' · ' + item.chars + ' 字') + '</option>'
  ).join('');
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function editRuntimePrompt() {
  runtimePromptEditing = true;
  const editor = document.getElementById('runtime-prompt-editor'); editor.readOnly = false; editor.focus();
  document.getElementById('runtime-prompt-edit').style.display = 'none';
  document.getElementById('runtime-prompt-save').style.display = '';
  document.getElementById('runtime-prompt-cancel').style.display = '';
  document.getElementById('runtime-prompt-status').textContent = '编辑中；尚未写入运行时。';
}

function cancelRuntimePromptEdit() {
  runtimePromptEditing = false;
  const editor = document.getElementById('runtime-prompt-editor'); editor.value = runtimePromptOriginal; editor.readOnly = true;
  document.getElementById('runtime-prompt-edit').style.display = '';
  document.getElementById('runtime-prompt-save').style.display = 'none';
  document.getElementById('runtime-prompt-cancel').style.display = 'none';
  document.getElementById('runtime-prompt-status').textContent = '';
}

function previewRuntimePromptSave() {
  pendingAction = {kind:'prompt-save'};
  showDiff(runtimePromptOriginal, document.getElementById('runtime-prompt-editor').value);
}

async function runtimePromptPost(path, payload) {
  const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json','X-Api-Token':getApiToken()}, body:JSON.stringify(payload)});
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.err || data.error || ('HTTP ' + response.status));
  return data.prompt;
}

async function commitRuntimePromptSave() {
  const prompt = await runtimePromptPost('/api/runtime-prompt/save', {
    content: document.getElementById('runtime-prompt-editor').value,
    expected_sha256: runtimePromptPayload ? runtimePromptPayload.sha256 : '', source:'520 injection page',
  });
  runtimePromptEditing = false; renderRuntimePrompt(prompt); cancelRuntimePromptEdit();
  document.getElementById('runtime-prompt-status').textContent = '已保存并备份旧版本；新线程生效。';
}

async function restoreRuntimePrompt() {
  const backup = document.getElementById('runtime-prompt-backups').value;
  if (!backup) { document.getElementById('runtime-prompt-status').textContent = '请先选择历史版本。'; return; }
  if (!confirm('恢复这个提示词版本？当前版本会自动备份。')) return;
  try {
    const prompt = await runtimePromptPost('/api/runtime-prompt/restore', {backup, expected_sha256:runtimePromptPayload ? runtimePromptPayload.sha256 : '', source:'520 injection page'});
    runtimePromptEditing = false; renderRuntimePrompt(prompt); cancelRuntimePromptEdit();
    document.getElementById('runtime-prompt-status').textContent = '历史版本已恢复；新线程生效。';
  } catch (error) { document.getElementById('runtime-prompt-status').textContent = '恢复失败：' + error.message; }
}

async function loadMemoryMap() {
  const r = await fetch('/api/memory_overview');
  const d = await r.json();
  const formal = d.formal_entries || [];
  const auto = d.auto_entries || [];
  const runtime = d.runtime_entries || [];
  const formalEp = formal.find(item => item.key === 'episodes') || {};
  const selfNotes = formal.find(item => item.key === 'ai_self_notes') || {};
  const autoCand = auto.find(item => item.key === 'episodes_candidates') || {};
  const formalization = d.formalization_status || {};

  document.getElementById('memory-head').innerHTML =
    '<div class="hcard"><h3>正式 Episodes</h3><div class="big" style="font-size:18px;">' + esc(formalEp.rows || 0) + ' 条</div><div class="sub">最近更新 ' + esc(formalEp.updated_at || '(无记录)') + '</div></div>' +
    '<div class="hcard"><h3>AI Self-note</h3><div class="big" style="font-size:18px;">' + esc(selfNotes.updated_at || '(无记录)') + '</div><div class="sub">只写给未来的我，不作为用户画像展示</div></div>' +
    '<div class="hcard"><h3>待审候选</h3><div class="big" style="font-size:18px;">' + esc(formalization.candidate_count || 0) + ' 条</div><div class="sub">候选层最新 ' + esc(autoCand.updated_at || '(无记录)') + '</div></div>';

  const current = d.current || {};
  document.getElementById('memory-current').innerHTML =
    '<div style="grid-column:1/-1;display:grid;gap:10px;">' + (d.recent_formal_episodes || []).map(renderMemoryEpisode).join('') + '</div>' +
    renderLinePanel('她的长期画像', current.user_portrait_lines) +
    renderLinePanel('我的自我画像', current.ai_self_portrait_lines) +
    renderLinePanel('我的 Self-note', current.ai_self_notes_lines) +
    renderLinePanel('后来重新理解的事', current.rereadings_lines);

  document.getElementById('memory-formal').innerHTML = formal.map(renderAuditCard).join('');
  document.getElementById('memory-auto').innerHTML = auto.map(renderAuditCard).join('');
  document.getElementById('memory-runtime').innerHTML = runtime.map(renderAuditCard).join('');

  const fileRows = (d.recent_file_updates || []).map(item =>
    '<tr><td>' + esc(item.day) + '</td><td>' + esc((item.items || []).join('、')) + '</td></tr>'
  ).join('') || '<tr><td colspan="2">(暂无记录)</td></tr>';
  const formalRows = (d.formal_episode_days || []).map(item =>
    '<tr><td>' + esc(item.day) + '</td><td>' + esc(item.count) + '</td></tr>'
  ).join('') || '<tr><td colspan="2">(暂无记录)</td></tr>';
  const candidateRows = (d.candidate_episode_days || []).map(item =>
    '<tr><td>' + esc(item.day) + '</td><td>' + esc(item.count) + '</td></tr>'
  ).join('') || '<tr><td colspan="2">(暂无记录)</td></tr>';

  document.getElementById('memory-daily').innerHTML =
    '<div class="cardgrid">' +
      '<div class="hcard"><h3>最近触碰过哪些文件</h3><table class="meta-table"><tr><th>日期</th><th>文件</th></tr>' + fileRows + '</table></div>' +
      '<div class="hcard"><h3>正式 episodes 每日新增</h3><table class="meta-table"><tr><th>日期</th><th>条数</th></tr>' + formalRows + '</table></div>' +
      '<div class="hcard"><h3>候选 episodes 每日新增</h3><table class="meta-table"><tr><th>日期</th><th>条数</th></tr>' + candidateRows + '</table></div>' +
    '</div>';
}

// ---------- 2 时间线 ----------
let episodesIndex = {}, rereadingsIndex = {};
async function loadTimeline() {
  const [tlRes, epRes, rrRes] = await Promise.all([
    fetch('/api/file?f=relationship_timeline.md'),
    fetch('/api/episodes_index'),
    fetch('/api/rereadings_index'),
  ]);
  const tl = await tlRes.json();
  episodesIndex = await epRes.json();
  rereadingsIndex = await rrRes.json();

  const metaBox = document.getElementById('timeline-meta');
  metaBox.textContent = 'Timeline 只讲我们关系真正发生变化的节点。Episode 是脚注，点击编号再展开；候选和处理状态不在这里重复。';

  const body = document.getElementById('timeline-body');
  body.innerHTML = '';
  // 先整体去掉 <!-- ... --> 多行注释块,再按行渲染,避免注释中间行漏成段落
  const cleaned = (tl.content || '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = cleaned.split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' ) continue;
    if (line.startsWith('# ')) continue; // 顶部标题跳过,tab 已经说明是时间线
    if (line.startsWith('## ')) {
      const h2 = document.createElement('h2');
      h2.textContent = line.replace(/^##\s*/, '');
      body.appendChild(h2);
      continue;
    }
    const p = document.createElement('p');
    p.innerHTML = renderLineWithEpLinks(line);
    body.appendChild(p);
  }
  // 绑定点击
  body.querySelectorAll('.epid').forEach(el => {
    el.onclick = () => toggleEpCard(el);
  });
}

function renderLineWithEpLinks(line) {
  const escLine = esc(line);
  return escLine.replace(/ep\d+/g, m => '<span class="epid" data-ep="' + m + '">' + m + '</span>');
}

function toggleEpCard(el) {
  const eid = el.dataset.ep;
  // 如果已经展开(下一个兄弟是这个 ep 的卡片),就收起
  const next = el.parentElement.nextElementSibling;
  if (next && next.classList && next.classList.contains('epcard') && next.dataset.ep === eid) {
    next.remove();
    return;
  }
  const ep = episodesIndex[eid];
  const card = document.createElement('div');
  card.className = 'epcard';
  card.dataset.ep = eid;
  if (!ep) {
    card.innerHTML = '<span class="epclose">×</span><div class="epwhat">找不到 ' + esc(eid) + ' 对应的 episode。</div>';
  } else {
    let html = '<span class="epclose">×</span>';
    html += '<div class="eptitle">' + esc(eid) + ' · ' + esc(humanizeEpisodeText(ep.title || '')) + '</div>';
    html += '<div class="eptime">' + esc(ep.time || '') + '</div>';
    if (ep.what_happened) html += '<div class="epwhat">' + esc(humanizeEpisodeText(ep.what_happened)) + '</div>';
    if (ep.misread_repair) html += '<div class="epwhat">误读与修复:' + esc(humanizeEpisodeText(ep.misread_repair)) + '</div>';
    (ep.anchor_quotes || []).forEach(q => {
      html += '<blockquote>' + esc(q) + '</blockquote>';
    });
    if (ep.future_effect) html += '<div class="epwhat">→ ' + esc(ep.future_effect) + '</div>';
    html += '<div class="epimp">重要度 ' + esc(ep.importance) + '</div>';
    const rereads = rereadingsIndex[eid];
    if (rereads && rereads.length) {
      html += '<div class="epreread"><span class="tag">年轮</span>';
      rereads.forEach(l => { html += '<div class="line">' + esc(l) + '</div>'; });
      html += '</div>';
    }
    card.innerHTML = html;
  }
  card.querySelector('.epclose').onclick = () => card.remove();
  el.parentElement.insertAdjacentElement('afterend', card);
}

// ---------- 3 八维 ----------
const OCT_DIMS = ['依恋','好奇','沉思','责任','社交','疲惫','性欲','压力'];
const OCT_COLORS = {'依恋':'#e06c9f','好奇':'#5ab0e0','沉思':'#9a7ae0','责任':'#4a9d6a',
                    '社交':'#e0a44a','疲惫':'#8a9099','性欲':'#d65656','压力':'#c9b458'};
let octRows = [], octHidden = {};

async function loadOctant() {
  await loadDesireSchedule();
  // 曲线要长一点的历史(最多 200 行),表格只看最近 30 行
  const r = await fetch('/api/state_rows?n=200'); const d = await r.json();
  const dims = OCT_DIMS;
  const historyRows = d.rows || [];
  const historySource = d.history_source || 'state_log';
  const historyLastTime = historyRows.length ? historyRows[historyRows.length - 1].time : '';
  const liveRow = buildOctantRealtimeRow(d.realtime || {}, historyLastTime, historySource);
  octRows = liveRow ? historyRows.concat([liveRow]) : historyRows;
  renderOctantRealtime(d.realtime || {}, historyLastTime, historySource);
  renderOctantSource(d, historyRows, liveRow);
  const archiveNote = document.getElementById('octant-archive-note');
  if (historySource === 'desire_history') {
    archiveNote.textContent =
      '这页主数据现在来自 runtime desire-history.jsonl 连续记录。'
      + ' 最新历史时间: ' + (historyLastTime || '(无记录)');
  } else if (liveRow) {
    archiveNote.textContent =
      '这页仍以旧 state_log.jsonl 归档为主体，但会把 desire-state.json 最新快照挂到末尾。'
      + ' 历史 state_log 最后一条: ' + (historyLastTime || '(无记录)')
      + '；实时快照时间: ' + (liveRow.time || '(无记录)');
  } else {
    archiveNote.textContent =
      '下面的 sparkline、曲线、表格仍来自历史 state_log.jsonl 归档。'
      + ' 历史最后一条停在: ' + (historyLastTime || '(无记录)');
  }
  buildOctantLegend();
  drawOctantCurves();

  const tableRows = octRows.slice(-30);

  // sparklines(每维一条,纯 inline SVG,灰色细线,无坐标)
  const sparkRow = document.getElementById('spark-row');
  sparkRow.innerHTML = '';
  for (const dim of dims) {
    const vals = tableRows.map(r => (r[dim] == null ? 0 : Number(r[dim])));
    sparkRow.appendChild(makeSparkItem(dim, vals));
  }

  // 表格:最近 30 行
  const table = document.getElementById('octant-table');
  let head = '<tr><th>时间</th>';
  for (const dim of dims) head += '<th>' + dim + '</th>';
  head += '<th>most_want</th><th>note</th><th>断档</th></tr>';
  let body = '';
  for (const r of tableRows) {
    const rowClasses = [];
    if (r._gap) rowClasses.push('gap');
    if (r._realtime) rowClasses.push('live');
    let gapCell = '';
    if (r._gap && r._gap_hours != null) gapCell += '<span class="gaptag">断档 ' + r._gap_hours + 'h</span>';
    if (r._realtime) gapCell += (gapCell ? '<br>' : '') + '<span class="livetag">实时</span>';
    body += '<tr class="' + rowClasses.join(' ') + '">';
    body += '<td>' + esc(formatScheduleTime(r.time, desireSchedulePayload && desireSchedulePayload.timezone)) + '</td>';
    for (const dim of dims) body += '<td>' + esc(r[dim] == null ? '' : r[dim]) + '</td>';
    body += '<td>' + esc(r.most_want || '') + '</td>';
    body += '<td>' + esc(r.note || '') + '</td>';
    body += '<td>' + gapCell + '</td>';
    body += '</tr>';
  }
  table.innerHTML = head + body;
}

let desireSchedulePayload = null;
function formatScheduleTime(value, timezone) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value || '');
  return parsed.toLocaleString('zh-CN', {timeZone: timezone || 'Australia/Sydney', timeZoneName: 'shortOffset', hour12: false}) + ` (${timezone || 'Australia/Sydney'})`;
}

async function loadDesireSchedule() {
  const response = await fetch('/api/desire-schedule');
  if (!response.ok) return;
  const data = await response.json(); desireSchedulePayload = data;
  const set = (id, value) => { const el = document.getElementById(id); if (el != null) el.value = value; };
  document.getElementById('desire-schedule-enabled').checked = data.enabled !== false;
  document.getElementById('desire-schedule-night-enabled').checked = data.night_skip_enabled !== false;
  set('desire-schedule-night-start', data.night_start); set('desire-schedule-night-end', data.night_end); set('desire-schedule-timezone', data.timezone);
  const list = document.getElementById('desire-timezone-options');
  list.innerHTML = (data.timezone_options || []).map(item => `<option value="${esc(item.iana)}">${esc(item.label)} · ${esc(item.iana)}</option>`).join('');
  const now = data.now || {};
  const last = data.last_call ? ` · 上次：${formatScheduleTime(data.last_call.timestamp, data.timezone)} · ${data.last_call.outcome || ''}` : ' · 尚无调用记录';
  const next = data.next_planned_at ? ` · 下一次预计：${formatScheduleTime(data.next_planned_at, data.timezone)}` : '';
  const master = data.master_enabled ? '开启' : '关闭';
  document.getElementById('desire-schedule-current').textContent = `当前调度时区：${data.timezone} · ${now.offset || ''} · 当地时间 ${formatScheduleTime(now.utc_now, data.timezone)} · ${now.is_night_skip ? '当前处于夜间跳过区间' : '当前不在夜间跳过区间'} · cadence ${data.interval_minutes} 分钟${next}${last} · 总开关 CYBERBOSS_DESIRE_DRIVEN：${master}（schedule enabled 只是子开关）`;
}

async function saveDesireSchedule() {
  const status = document.getElementById('desire-schedule-status');
  const body = {
    enabled: document.getElementById('desire-schedule-enabled').checked,
    interval_minutes: 55,
    night_skip_enabled: document.getElementById('desire-schedule-night-enabled').checked,
    night_start: document.getElementById('desire-schedule-night-start').value,
    night_end: document.getElementById('desire-schedule-night-end').value,
    timezone: document.getElementById('desire-schedule-timezone').value,
    expected_revision: desireSchedulePayload ? desireSchedulePayload.revision : '',
    source: '520 desire schedule',
  };
  try {
    const response = await fetch('/api/desire-schedule', {method:'POST', headers:{'Content-Type':'application/json','X-Api-Token':TOKEN}, body:JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.err || data.error || `HTTP ${response.status}`);
    status.textContent = data.apply_note || '已保存，下一轮生效。'; await loadDesireSchedule();
  } catch (error) { status.textContent = '保存失败：' + error.message; }
}

function renderOctantSource(payload, historyRows, liveRow) {
  const box = document.getElementById('octant-source');
  if (!box) return;
  const ds = payload.realtime || {};
  const count = Number(ds.dimension_count || Object.keys(ds.dimensions || {}).length || 0);
  const missing = Array.isArray(ds.missing_dimensions) ? ds.missing_dimensions.join('、') : '';
  const age = ds.hours_since_update == null ? '时间未知' : ('距今 ' + ds.hours_since_update + ' 小时');
  const sourceName = payload.history_source === 'desire_history' ? '连续历史（权威）' : '冻结归档（回退）';
  box.innerHTML =
    '<div class="source-card"><strong>520 数据入口</strong><span>http://' + esc(location.host) + ' · 每 20 秒只读刷新</span></div>' +
    '<div class="source-card"><strong>实时八维 ' + count + '/8</strong><span>' + esc(age) +
      (missing ? ' · 缺少 ' + esc(missing) : ' · 维度完整') + '</span></div>' +
    '<div class="source-card"><strong>' + esc(sourceName) + ' · ' + historyRows.length + ' 条</strong><span>' +
      esc(payload.history_path || '') + '</span></div>' +
    '<div class="source-card"><strong>曲线末端</strong><span>' +
      (liveRow ? '已接入最新实时快照' : '未追加重复或无效快照') + '</span></div>';
}

function buildOctantRealtimeRow(ds, historyLastTime, historySource) {
  if (!ds || !ds.exists || ds.error) return null;
  const data = ds.data || {};
  const dimensions = ds.dimensions || {};
  const row = {
    time: ds.updated_at || '',
    most_want: data.most_want || (data.intent || {}).want_action || '',
    note: '实时快照(desire-state.json)',
    _gap: false,
    _gap_hours: null,
    _realtime: true,
  };
  let found = false;
  for (const label of OCT_DIMS) {
    const score = Number(dimensions[label]);
    if (!Number.isFinite(score)) continue;
    row[label] = Number.isFinite(score) ? Number(score.toFixed(2)) : '';
    found = true;
  }
  if (!found) return null;
  if (historySource === 'desire_history' && historyLastTime && String(historyLastTime) === String(row.time || '')) {
    return null;
  }
  if (historyLastTime) {
    row._gap = true;
    const prevMs = Date.parse(String(historyLastTime || '').replace(' ', 'T'));
    const liveMs = Date.parse(String(ds.updated_at || '').replace(' ', 'T'));
    if (Number.isFinite(prevMs) && Number.isFinite(liveMs) && liveMs > prevMs) {
      row._gap_hours = Math.round(((liveMs - prevMs) / 3600000) * 10) / 10;
    }
  }
  return row;
}

function renderOctantRealtime(ds, historyLastTime, historySource) {
  const box = document.getElementById('octant-live');
  if (!box) return;
  if (!ds.exists) {
    box.innerHTML = '<h3>实时八维(desire-state.json)</h3><div class="meta">未找到: ' + esc(ds.path || '') + '</div>' +
      '<div class="most">下方曲线和表格仍来自 state_log.jsonl 历史存档。</div>';
    return;
  }
  if (ds.error) {
    box.innerHTML = '<h3>实时八维(desire-state.json)</h3><div class="meta">读取失败</div>' +
      '<div class="most">' + esc(ds.error) + '</div>';
    return;
  }
  const data = ds.data || {};
  const drives = Array.isArray(data.drives) ? data.drives : [];
  const dimensions = ds.dimensions || {};
  const driveByLabel = Object.fromEntries(drives.map(d => [d.label || d.key, d]));
  const driveHtml = Object.keys(dimensions).length
    ? '<div class="grid">' + OCT_DIMS.filter(label => dimensions[label] != null).map(label => {
        const score = Number(dimensions[label]);
        const detail = driveByLabel[label] || {};
        const cause = detail.cause ? '<div class="cause">' + esc(detail.cause) + '</div>' : '';
        const pct = Math.max(0, Math.min(100, score * 100));
        return '<div class="item"><strong>' + esc(label) + '</strong><div class="score">' + esc(score.toFixed(2)) + '</div>' + cause +
          '<div class="octant-bar"><i style="width:' + pct + '%;background:' + OCT_COLORS[label] + '"></i></div></div>';
      }).join('') + '</div>'
    : '<div class="meta">desire-state.json 里暂未找到可识别的八维值。</div>';
  const metaParts = [];
  if (ds.updated_at) metaParts.push('最新时间: ' + esc(ds.updated_at));
  if (ds.hours_since_update != null) metaParts.push('距今 ' + ds.hours_since_update + ' 小时');
  if (historyLastTime) metaParts.push((historySource === 'desire_history' ? '历史 desire-history 最后记录: ' : '历史 state_log 最后记录: ') + esc(historyLastTime));
  box.innerHTML = '<h3>实时八维(desire-state.json)</h3>' +
    '<div class="meta">' + metaParts.join(' | ') + '</div>' +
    '<div class="most"><strong>most_want:</strong> ' + esc(data.most_want || (data.intent || {}).want_action || '(空)') +
      '<br><span class="meta">' + (historySource === 'desire_history'
        ? '下方曲线和表格主体已经切到 desire-history.jsonl 连续记录。'
        : '下方曲线和表格会把最新 realtime 快照挂在末尾，但主体仍是 state_log.jsonl 旧归档。') + '</span></div>' +
    driveHtml;
}

function makeSparkItem(label, vals) {
  const wrap = document.createElement('div'); wrap.className = 'spark-item';
  const w = 90, h = 24;
  const n = vals.length;
  let points = '';
  if (n > 0) {
    const maxV = Math.max(1e-6, ...vals);
    const minV = Math.min(0, ...vals);
    const range = (maxV - minV) || 1;
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : (i / (n - 1)) * w;
      const y = h - ((vals[i] - minV) / range) * h;
      points += (i === 0 ? '' : ' ') + x.toFixed(1) + ',' + y.toFixed(1);
    }
  }
  const svg = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<polyline points="' + points + '" fill="none" stroke="#5c6070" stroke-width="1"/></svg>';
  wrap.innerHTML = '<div class="lbl">' + esc(label) + '</div>' + svg;
  return wrap;
}

// 八维曲线:内联 canvas 手绘(无外部 CDN)。y 固定 0~1;断档处断线;图例点击隐藏/显示维度。
function buildOctantLegend() {
  const box = document.getElementById('curve-legend');
  box.innerHTML = '';
  for (const dim of OCT_DIMS) {
    const item = document.createElement('span');
    item.className = 'lg' + (octHidden[dim] ? ' off' : '');
    item.innerHTML = '<span class="sw" style="background:' + OCT_COLORS[dim] + '"></span>' + esc(dim);
    item.onclick = () => { octHidden[dim] = !octHidden[dim]; buildOctantLegend(); drawOctantCurves(); };
    box.appendChild(item);
  }
}

function drawOctantCurves() {
  const cv = document.getElementById('octant-canvas');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const padL = 34, padR = 12, padT = 10, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // 水平网格线 + y 轴刻度(0 / 0.5 / 1)
  ctx.font = '11px sans-serif';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const y = padT + (1 - v) * plotH;
    ctx.strokeStyle = (v === 0 || v === 1) ? '#2f323e' : '#232630';
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    if (v === 0 || v === 0.5 || v === 1) {
      ctx.fillStyle = '#6b7080';
      ctx.fillText(v.toFixed(1), 6, y + 4);
    }
  }

  const rows = octRows;
  const n = rows.length;
  if (n === 0) {
    ctx.fillStyle = '#6b7080';
    ctx.fillText('state_log.jsonl 还没有记录。', padL + 10, padT + 20);
    return;
  }
  const xAt = i => (n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const yAt = v => padT + (1 - Math.max(0, Math.min(1, v))) * plotH;

  // 断档标记:断档行的位置画一条淡红竖虚线
  for (let i = 0; i < n; i++) {
    if (rows[i]._gap) {
      ctx.strokeStyle = 'rgba(217,138,138,0.35)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(xAt(i), padT); ctx.lineTo(xAt(i), padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 每维一条折线;断档处断开(不把断档画成连续变化)
  for (const dim of OCT_DIMS) {
    if (octHidden[dim]) continue;
    ctx.strokeStyle = OCT_COLORS[dim];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      const raw = rows[i][dim];
      if (raw == null || isNaN(Number(raw))) { pen = false; continue; }
      const x = xAt(i), y = yAt(Number(raw));
      if (!pen || rows[i]._gap) { ctx.moveTo(x, y); pen = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1;

  // x 轴时间标签:首 / 中 / 尾
  ctx.fillStyle = '#6b7080';
  const marks = n >= 3 ? [0, Math.floor((n - 1) / 2), n - 1] : (n === 2 ? [0, 1] : [0]);
  for (const i of marks) {
    const t = String(rows[i].time || '');
    const tw = ctx.measureText(t).width;
    let x = xAt(i) - tw / 2;
    x = Math.max(padL, Math.min(W - padR - tw, x));
    ctx.fillText(t, x, H - 8);
  }
}

// ---------- 4 关怀(care/:表单与展示,不做分析) ----------
async function loadCare() {
  const st = document.getElementById('care-status');
  try {
    const [cfgRes, cyRes] = await Promise.all([
      fetch('/api/care/config'), fetch('/api/care/cycle'),
    ]);
    const cfg = await cfgRes.json();
    const cy = await cyRes.json();
    document.getElementById('care-city').value = cfg.city || '';
    document.getElementById('care-weather').checked = !!cfg.weather_enabled;
    document.getElementById('care-silent').checked = !!cfg.cycle_silent_enabled;
    document.getElementById('care-touch').checked = !!cfg.cycle_light_touch_enabled;
    document.getElementById('care-max').value = (cfg.max_touch_per_day == null ? 1 : cfg.max_touch_per_day);
    document.getElementById('care-proxy').value = cfg.https_proxy || '';
    document.getElementById('cycle-view').textContent =
      cy.text || '(还没有 care/cycle.md — 第一次「记一行」时会自动按模板建出来)';
  } catch (e) {
    if (st) st.textContent = '读取失败:' + e;
  }
}

async function saveCareConfig() {
  document.getElementById('care-status').textContent = '只读：写入口已冻结。';
}

async function submitCycle() {
  document.getElementById('cycle-status').textContent = '只读：写入口已冻结。';
}

// ---------- 5 剧场(theater/scripts_index.md 的外链列表,只读) ----------
async function loadTheater() {
  const intro = document.getElementById('theater-intro');
  const list = document.getElementById('theater-list');
  intro.innerHTML = ''; list.innerHTML = '';
  try {
    const r = await fetch('/api/theater/scripts');
    const d = await r.json();
    if (!d.exists) {
      list.innerHTML = '<div class="th-intro">还没有 theater/scripts_index.md。</div>';
      return;
    }
    for (const p of (d.intro || [])) {
      const el = document.createElement('div');
      el.className = 'th-intro';
      el.textContent = p;
      intro.appendChild(el);
    }
    const rows = d.rows || [];
    if (rows.length === 0) {
      list.innerHTML = '<div class="th-intro">目录还是空的——链接由她提供,或聊天里一起搜到了再一起加进来。</div>';
      return;
    }
    for (const row of rows) {
      const isSample = /示例/.test(row.link + row.note);
      const card = document.createElement('div');
      card.className = 'th-card' + (isSample ? ' sample' : '');
      let html = '';
      if (row.url) {
        const label = row.link.replace(row.url, '').trim() || row.url;
        html += '<a href="' + esc(row.url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
      } else {
        html += '<span style="color:#9aa0b0;">' + esc(row.link) + '</span>';
      }
      if (row.note) html += '<div class="th-note">' + esc(row.note) + '</div>';
      const meta = [row.duration, row.players, row.tags].filter(x => x).join(' · ');
      if (meta) html += '<div class="th-meta">' + esc(meta) + '</div>';
      card.innerHTML = html;
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = '<div class="th-intro">读取失败:' + esc(String(e)) + '</div>';
  }
}


// ---------- 上下文管理 ----------
const CONTEXT_GATE_LABELS_V2 = {
  reentry: ['Re-entry', '慢变化层与醒来第一包'],
  current_state: ['Live State', '八维、承诺与当前关注事项'],
  memory_context: ['Memory Context', '记忆缝入与按需工具上下文'],
};

async function contextPost(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Api-Token': getApiToken()},
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await response.json(); } catch (e) {}
  if (!response.ok || data.ok === false) {
    throw new Error(data.err || data.error || ('HTTP ' + response.status));
  }
  return data;
}

function contextEscAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

function setContextSaveState(text, bad=false) {
  const el = document.getElementById('ctx-layout-save-state');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = bad ? '#ff9ca8' : '';
}

function renderContextRuntime(data, injection) {
  const repo = data.repo || {};
  const modules = data.modules || {};
  const prompt = (injection || {}).runtime_prompt || {};
  const moduleValues = Object.values(modules);
  const healthyModules = moduleValues.filter(value => value === 'on').length;
  const promptName = String(prompt.path || '').split(/[\\/]/).pop() || '未识别';
  const cards = [
    ['运行版本', (repo.branch || '-') + ' · ' + ((repo.commit || '').slice(0, 12) || '-'), repo.dirty ? '工作区包含未提交改动' : '工作区干净'],
    ['实际提示词', promptName, (prompt.chars || 0) + ' 字符 · ' + (prompt.updated_at || '无时间')],
    ['核心模块', healthyModules + ' / ' + moduleValues.length + ' 正常', Object.entries(modules).map(([k,v]) => k + ':' + v).join(' · ') || '无模块状态'],
  ];
  const host = document.getElementById('ctx-runtime-grid');
  host.innerHTML = cards.map(([label, value, detail]) =>
    '<div class="ctx-runtime-card"><div class="label">' + esc(label) + '</div>' +
    '<div class="value">' + esc(value) + '</div><div class="detail">' + esc(detail) + '</div></div>'
  ).join('');
  const summary = document.getElementById('ctx-runtime-summary');
  if (summary) summary.textContent = '当前模型：' + (prompt.model || '未识别') + ' · ' + promptName;
}

function renderContextGates(gates) {
  const host = document.getElementById('ctx-gates');
  host.className = 'context-flow';
  const fixedStep = (number, title, copy, rule) =>
    '<div class="context-step fixed"><span class="step-no">' + number + '</span><div><strong>' + esc(title) +
    '</strong><small>' + esc(copy) + '</small></div><div class="load-rule">' + esc(rule) + '</div><span class="status-pill ok">固定</span></div>';
  const gateSteps = Object.entries(CONTEXT_GATE_LABELS_V2).map(([key, pair], index) => {
    const on = gates[key] !== false;
    const rules = {
      reentry:'仅新线程首轮；同一线程不会反复注入',
      current_state:'首轮或状态刷新时提供八维与当前关注',
      memory_context:'按需检索与连续性缝入，不加载整库',
    };
    return '<div class="context-step ' + (on ? '' : 'off') + '"><span class="step-no">0' + (index + 2) + '</span><div><strong>' + esc(pair[0]) +
      '</strong><small>' + esc(pair[1]) + '</small></div><div class="load-rule">' + esc(rules[key]) + '</div>' +
      '<label class="ctx-switch" title="下一轮 Telegram 对话生效"><input type="checkbox" data-gate="' + key + '" ' +
      (on ? 'checked' : '') + ' onchange="setContextGate(\'' + key + '\', this.checked)"><span></span></label></div>';
  }).join('');
  host.innerHTML = fixedStep('01','System / Persona','实际模型提示词与稳定身份','每轮固定加载；在下方“实际缝入内容”编辑') +
    gateSteps + fixedStep('05','Current Context / 当前对话','最近消息、工具结果与本轮用户输入','每轮固定加载，位于上下文末端') +
    '<div class="context-note">开关会真实改变 Telegram 上下文；顺序由 runtime 固定，所有可编辑来源都集中在本页下方。</div>';
}

function renderContextSources(payload) {
  contextSourcesPayload = payload || {sources:[]};
  const host = document.getElementById('context-sources');
  host.innerHTML = (contextSourcesPayload.sources || []).map(source => {
    const gateOff = source.gate === false;
    const effective = gateOff ? '当前开关已关闭：这部分不会进入下一条消息。' :
      (source.effective_content || (source.mode === '按话题自动检索' ? '下一轮会根据消息内容自动检索；当前没有固定文本。' : '(当前为空)'));
    const model = source.model ? (' · 模型 ' + source.model) : '';
    return '<div class="context-source" id="context-source-' + esc(source.key) + '">' +
      '<div class="context-source-head"><div><div class="context-source-title">' + esc(source.label) + '</div>' +
      '<div class="context-source-meta">' + esc(source.mode) + ' · ' + esc(source.content.length) + ' 字符 / 预算 ' + esc(source.budget) + model +
      '<br>' + esc(source.description) + '</div></div><button class="ghost" onclick="editContextSource(\'' + source.key + '\')">修改</button></div>' +
      '<div class="context-source-preview">' + esc(effective) + '</div>' +
      '<div class="context-source-editor"><textarea id="context-source-editor-' + esc(source.key) + '" spellcheck="false"></textarea>' +
      '<div class="context-source-actions"><button onclick="previewContextSourceSave(\'' + source.key + '\')">查看差异并保存</button>' +
      '<button class="ghost" onclick="cancelContextSourceEdit()">取消</button><span class="context-source-status" id="context-source-status-' + esc(source.key) + '"></span></div></div></div>';
  }).join('') || '<div class="meta-row">没有可编辑的上下文来源。</div>';
}

function contextSourceByKey(key) {
  return ((contextSourcesPayload || {}).sources || []).find(source => source.key === key);
}

function editContextSource(key) {
  contextSourceEditingKey = key;
  document.querySelectorAll('.context-source').forEach(node => node.classList.remove('editing'));
  const source = contextSourceByKey(key);
  const card = document.getElementById('context-source-' + key);
  const editor = document.getElementById('context-source-editor-' + key);
  if (!source || !card || !editor) return;
  card.classList.add('editing'); editor.value = source.content || ''; editor.focus();
}

function cancelContextSourceEdit() {
  contextSourceEditingKey = '';
  document.querySelectorAll('.context-source').forEach(node => node.classList.remove('editing'));
}

function previewContextSourceSave(key) {
  const source = contextSourceByKey(key);
  const editor = document.getElementById('context-source-editor-' + key);
  if (!source || !editor) return;
  pendingAction = {kind:'context-source-save', key};
  showDiff(source.content || '', editor.value);
}

async function commitContextSourceSave(key) {
  const source = contextSourceByKey(key);
  const editor = document.getElementById('context-source-editor-' + key);
  if (!source || !editor) return;
  const data = await contextPost('/api/context-source/save', {
    key, content:editor.value, expected_sha256:source.sha256 || '', source:'520 context control',
  });
  contextSourceEditingKey = '';
  renderContextSources(data.context_sources || {});
  const status = document.getElementById('ctx-gate-status');
  status.textContent = key === 'memory_context' ? '已保存；下一轮生效' : '已保存；下一条消息会重建上下文';
}

async function setContextGate(key, enabled) {
  const status = document.getElementById('ctx-gate-status');
  status.textContent = '保存中…';
  try {
    const body = {}; body[key] = !!enabled;
    const result = await contextPost('/api/context-gates', body);
    status.textContent = result.thread_rebuild ? '已保存；下一条消息会换干净线程' : '已保存；下一轮即时生效';
    await loadContextGatesForManager();
    const sourceResponse = await fetch('/api/context-sources');
    renderContextSources(await sourceResponse.json());
  } catch (e) {
    status.textContent = '失败：' + e.message;
    await loadContextGatesForManager();
  }
}

async function loadContextGatesForManager() {
  const response = await fetch('/api/context-gates');
  const gates = await response.json();
  renderContextGates(gates || {});
  return gates || {};
}

function contextGroups() {
  return ((contextLayoutPayload || {}).layout || {}).groups || [];
}

function moduleInputId(groupId, moduleId) {
  return 'ctx-module-' + String(groupId) + '-' + String(moduleId);
}

function renderContextBoard() {
  const host = document.getElementById('ctx-board');
  const groups = contextGroups();
  host.innerHTML = '';
  groups.forEach((group, index) => {
    const fixed = !!group.fixed;
    const gateLinked = !!group.runtime_gate;
    const card = document.createElement('div');
    card.className = 'ctx-layer' + (fixed ? ' fixed' : '');
    card.dataset.groupId = group.id;
    if (!fixed) {
      card.draggable = true;
      card.addEventListener('dragstart', event => {
        contextDraggedGroup = group.id;
        card.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', group.id);
      });
      card.addEventListener('dragend', () => {
        contextDraggedGroup = null;
        document.querySelectorAll('.ctx-layer').forEach(node => node.classList.remove('dragging', 'drop-target'));
      });
      card.addEventListener('dragover', event => {
        event.preventDefault();
        card.classList.add('drop-target');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
      card.addEventListener('drop', event => {
        event.preventDefault();
        card.classList.remove('drop-target');
        reorderContextGroups(contextDraggedGroup || event.dataTransfer.getData('text/plain'), group.id);
      });
    }
    const modules = (group.modules || []).map(module => {
      const inputId = moduleInputId(group.id, module.id);
      return '<div class="ctx-item"><input type="checkbox" ' + (module.enabled !== false ? 'checked' : '') +
        ' onchange="updateContextModule(\'' + contextEscAttr(group.id) + '\',\'' + contextEscAttr(module.id) +
        '\',\'enabled\',this.checked)"><input id="' + contextEscAttr(inputId) + '" type="text" value="' +
        contextEscAttr(module.name || '') + '" onchange="updateContextModule(\'' + contextEscAttr(group.id) +
        '\',\'' + contextEscAttr(module.id) + '\',\'name\',this.value)"><button class="ctx-icon-btn" title="删除小模块" ' +
        'onclick="removeContextModule(\'' + contextEscAttr(group.id) + '\',\'' + contextEscAttr(module.id) + '\')">×</button></div>';
    }).join('');
    card.innerHTML =
      '<div class="ctx-order" title="' + (fixed ? '固定层' : '拖动调整顺序') + '">' + String(index + 1).padStart(2, '0') + '</div>' +
      '<div><div class="ctx-layer-name">' + esc(group.title || group.id) + '</div><div class="ctx-layer-sub">' +
      esc(group.subtitle || '') + '</div><span class="ctx-layer-badge ' + (gateLinked ? '' : 'draft') + '">' +
      (gateLinked ? '实时 gate 对应层' : (fixed ? '固定层' : '编排配置')) + '</span></div>' +
      '<div class="ctx-items">' + (modules || '<div class="ctx-meta">暂无小模块</div>') +
      '<button class="ctx-add" onclick="addContextModule(\'' + contextEscAttr(group.id) + '\')">＋ 添加小模块</button></div>' +
      '<div class="ctx-layer-actions"><label class="ctx-switch" title="' + (fixed ? '固定层始终开启' : '开启或关闭整层') +
      '"><input type="checkbox" ' + (group.enabled !== false ? 'checked' : '') + (fixed ? ' disabled' : '') +
      ' onchange="updateContextGroup(\'' + contextEscAttr(group.id) + '\',this.checked)"><span></span></label>' +
      '<span class="ctx-meta">' + (fixed ? '始终开启' : (group.enabled !== false ? '已开启' : '已关闭')) + '</span></div>';
    host.appendChild(card);
  });
}

function findContextGroup(groupId) {
  return contextGroups().find(group => group.id === groupId);
}

function scheduleContextLayoutSave() {
  if (contextLayoutSaveTimer) clearTimeout(contextLayoutSaveTimer);
  setContextSaveState('待保存…');
  contextLayoutSaveTimer = setTimeout(saveContextLayoutNow, 550);
}

async function saveContextLayoutNow() {
  contextLayoutSaveTimer = null;
  setContextSaveState('保存中…');
  try {
    const data = await contextPost('/api/context-layout/save', {
      layout: (contextLayoutPayload || {}).layout,
      source: '520 context manager',
    });
    contextLayoutPayload = data.context;
    renderContextSnapshotMeta();
    setContextSaveState('已保存');
    setTimeout(() => setContextSaveState(''), 1300);
  } catch (e) {
    setContextSaveState('保存失败：' + e.message, true);
  }
}

function updateContextGroup(groupId, enabled) {
  const group = findContextGroup(groupId);
  if (!group || group.fixed) return;
  group.enabled = !!enabled;
  renderContextBoard();
  scheduleContextLayoutSave();
}

function updateContextModule(groupId, moduleId, field, value) {
  const group = findContextGroup(groupId);
  const module = (group && group.modules || []).find(item => item.id === moduleId);
  if (!module) return;
  if (field === 'enabled') module.enabled = !!value;
  if (field === 'name') module.name = String(value || '').slice(0, 160);
  scheduleContextLayoutSave();
}

function removeContextModule(groupId, moduleId) {
  const group = findContextGroup(groupId);
  if (!group) return;
  group.modules = (group.modules || []).filter(item => item.id !== moduleId);
  renderContextBoard();
  scheduleContextLayoutSave();
}

function addContextModule(groupId) {
  const group = findContextGroup(groupId);
  if (!group) return;
  const id = 'custom_' + Date.now().toString(36);
  group.modules = group.modules || [];
  group.modules.push({id, name: '新模块', enabled: true});
  renderContextBoard();
  const input = document.getElementById(moduleInputId(groupId, id));
  if (input) { input.focus(); input.select(); }
  scheduleContextLayoutSave();
}

function reorderContextGroups(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const groups = contextGroups();
  const from = groups.findIndex(group => group.id === sourceId);
  const to = groups.findIndex(group => group.id === targetId);
  if (from < 0 || to < 0 || groups[from].fixed || groups[to].fixed) return;
  const moved = groups.splice(from, 1)[0];
  groups.splice(to, 0, moved);
  renderContextBoard();
  scheduleContextLayoutSave();
}

function renderContextSnapshotMeta() {
  const payload = contextLayoutPayload || {};
  const snapshots = payload.snapshots || [];
  const select = document.getElementById('ctx-snapshot-select');
  const manualSlots = snapshots.filter(item => ['slot1','slot2','slot3'].includes(item.slot));
  select.innerHTML = manualSlots.map(item => {
    const labels = {slot1:'快照 1',slot2:'快照 2',slot3:'快照 3'};
    return '<option value="' + esc(item.slot) + '">' + esc(labels[item.slot] || item.slot) +
      (item.exists ? (item.updated_at ? ' · ' + esc(item.updated_at) : ' · 已存档') : ' · 空') + '</option>';
  }).join('');
  const bits = [];
  if (payload.updated_at) bits.push('配置 ' + payload.updated_at);
  if (payload.last_saved_by) bits.push('来源 ' + payload.last_saved_by);
  document.getElementById('ctx-layout-meta').textContent = bits.join(' · ') || '使用默认配置';
}

async function saveContextSnapshot(slot) {
  try {
    const data = await contextPost('/api/context-layout/snapshot', {slot});
    document.getElementById('ctx-layout-meta').textContent = '已存档到 ' + data.slot;
    await loadContextLayout();
  } catch (e) {
    setContextSaveState('存档失败：' + e.message, true);
  }
}

async function restoreContextSnapshot(slot) {
  try {
    const data = await contextPost('/api/context-layout/restore', {slot, source:'520 snapshot restore'});
    contextLayoutPayload = data.context;
    renderContextSnapshotMeta();
    renderContextBoard();
    setContextSaveState('已载入 ' + slot);
  } catch (e) {
    setContextSaveState('载入失败：' + e.message, true);
  }
}

async function saveSelectedContextSnapshot() {
  const select = document.getElementById('ctx-snapshot-select');
  if (select && select.value) await saveContextSnapshot(select.value);
}

async function restoreSelectedContextSnapshot() {
  const select = document.getElementById('ctx-snapshot-select');
  if (select && select.value) await restoreContextSnapshot(select.value);
}

function toggleContextResetMenu() {
  document.getElementById('ctx-reset-menu').classList.toggle('on');
}

async function loadContextLayout() {
  const response = await fetch('/api/context-layout');
  contextLayoutPayload = await response.json();
  renderContextSnapshotMeta();
  renderContextBoard();
}

async function loadContextTodo() {
  const response = await fetch('/api/todo');
  const data = await response.json();
  contextTodoOriginal = data.content || '';
  const editor = document.getElementById('ctx-todo-editor');
  editor.value = contextTodoOriginal;
  editor.readOnly = !contextTodoEditing;
  const bits = [];
  if (data.updated_at) bits.push('文件 ' + data.updated_at);
  if (data.last_saved_by) bits.push('来源 ' + data.last_saved_by);
  document.getElementById('ctx-todo-meta').textContent = bits.join(' · ');
}

function enterContextTodoEdit() {
  contextTodoEditing = true;
  document.getElementById('ctx-todo-editor').readOnly = false;
  document.getElementById('ctx-todo-edit').style.display = 'none';
  document.getElementById('ctx-todo-save').style.display = '';
  document.getElementById('ctx-todo-cancel').style.display = '';
  document.getElementById('ctx-todo-status').textContent = '编辑中';
  document.getElementById('ctx-todo-editor').focus();
}

function cancelContextTodoEdit() {
  contextTodoEditing = false;
  const editor = document.getElementById('ctx-todo-editor');
  editor.value = contextTodoOriginal;
  editor.readOnly = true;
  document.getElementById('ctx-todo-edit').style.display = '';
  document.getElementById('ctx-todo-save').style.display = 'none';
  document.getElementById('ctx-todo-cancel').style.display = 'none';
  document.getElementById('ctx-todo-status').textContent = '';
}

function showContextTodoDiff() {
  pendingAction = {kind:'todo-save'};
  showDiff(contextTodoOriginal, document.getElementById('ctx-todo-editor').value);
}

async function commitContextTodoSave() {
  const data = await contextPost('/api/todo/save', {
    content: document.getElementById('ctx-todo-editor').value,
    source: '520 context manager',
  });
  contextTodoEditing = false;
  document.getElementById('ctx-todo-editor').readOnly = true;
  document.getElementById('ctx-todo-edit').style.display = '';
  document.getElementById('ctx-todo-save').style.display = 'none';
  document.getElementById('ctx-todo-cancel').style.display = 'none';
  document.getElementById('ctx-todo-status').textContent = '已保存';
  contextTodoOriginal = ((data.todo || {}).content || '');
  await loadContextTodo();
}

async function loadContextManager() {
  try {
    const [overviewRes, injectionRes, sourcesRes] = await Promise.all([
      fetch('/api/context-overview'),
      fetch('/api/injection'),
      fetch('/api/context-sources'),
      loadContextGatesForManager(),
    ]);
    renderContextRuntime(await overviewRes.json(), await injectionRes.json());
    renderContextSources(await sourcesRes.json());
  } catch (e) {
    setContextSaveState('加载失败：' + e.message, true);
  }
}

// ---------- 6 文件 ----------
async function loadFileList() {
  const r = await fetch('/api/list'); const fs = await r.json();
  const box = document.getElementById('filelist'); box.innerHTML = '';
  for (const f of fs) {
    const d = document.createElement('div');
    d.className = 'f' + (f === curFile ? ' on' : '');
    d.innerHTML = (labels[f] || f) + '<small>' + f + '</small>';
    d.onclick = () => openFile(f);
    box.appendChild(d);
  }
}

function applyFileContent(f, content) {
  origContent = content;
  document.getElementById('fname').textContent = (labels[f] || f);
  document.getElementById('rolabel').textContent = '只读';
  document.getElementById('editbtn').style.display = '';
  document.getElementById('savebtn').style.display = 'none';
  document.getElementById('cancelbtn').style.display = 'none';
  document.getElementById('status').textContent = '';
  const ed = document.getElementById('ed');
  ed.style.display = ''; ed.value = content; ed.readOnly = true;
  renderCards(f, content);
}

async function openFile(f) {
  curFile = f; editing = false; loadFileList();
  const r = await fetch('/api/file?f=' + encodeURIComponent(f));
  const d = await r.json();
  applyFileContent(f, d.content);
  return;
  origContent = d.content;
  document.getElementById('fname').textContent = (labels[f] || f);
  document.getElementById('rolabel').textContent = '只读';
  document.getElementById('editbtn').style.display = '';
  document.getElementById('savebtn').style.display = 'none';
  document.getElementById('cancelbtn').style.display = 'none';
  document.getElementById('status').textContent = '';
  const ed = document.getElementById('ed');
  ed.style.display = ''; ed.value = d.content; ed.readOnly = true;
  renderCards(f, d.content);
}

async function refreshFilesView() {
  await loadFileList();
  if (!curFile || editing) return;
  const r = await fetch('/api/file?f=' + encodeURIComponent(curFile));
  const d = await r.json();
  applyFileContent(curFile, d.content);
}

function enterEdit() {
  document.getElementById('status').textContent = '只读：文件写入口已冻结。';
}

function cancelEdit() {
  editing = false;
  const ed = document.getElementById('ed');
  ed.value = origContent; ed.readOnly = true;
  document.getElementById('rolabel').textContent = '只读';
  document.getElementById('editbtn').style.display = '';
  document.getElementById('savebtn').style.display = 'none';
  document.getElementById('cancelbtn').style.display = 'none';
  document.getElementById('status').textContent = '';
  renderCards(curFile, origContent);
}

function renderCards(f, content) {
  const c = document.getElementById('cards');
  if (!f.endsWith('.jsonl')) { c.style.display = 'none'; return; }
  c.style.display = ''; c.innerHTML = '';
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    const div = document.createElement('div'); div.className = 'card';
    if (o.title) { // episodes
      div.innerHTML = '<b>' + esc(o.id ? o.id + ' · ' : '') + esc(o.title) + '</b>'
        + ' <span class="t">' + esc(o.time || '') + ' · 重要度 ' + esc(o.importance) + '</span>'
        + '<div class="kv">' + esc(o.what_happened || '') + '</div>'
        + (o.misread_repair ? '<div class="kv">误读与修复:' + esc(o.misread_repair) + '</div>' : '')
        + (o.anchor_quotes || []).map(q => '<div class="q">「' + esc(q) + '」</div>').join('')
        + (o.future_effect ? '<div class="kv">→ ' + esc(o.future_effect) + '</div>' : '');
    } else { // state_log 或其他
      let rest = Object.entries(o).filter(([k]) => k !== 'time' && k !== 'most_want' && k !== 'note')
        .map(([k, v]) => esc(k) + ' ' + esc(v)).join(' · ');
      div.innerHTML = '<b>' + esc(o.time || '') + '</b>'
        + (o.most_want ? ' <span class="kv">最想:' + esc(o.most_want) + '</span>' : '')
        + '<div class="kv">' + rest + '</div>'
        + (o.note ? '<div class="q">' + esc(o.note) + '</div>' : '');
    }
    c.appendChild(div);
  }
}

function tryShowDiff() {
  document.getElementById('status').textContent = '只读：文件写入口已冻结。';
}

function showDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const box = document.getElementById('modal-diff');
  box.innerHTML = '';
  // 简单逐行对比(客户端,非最长公共子序列,够用):按位置比较,相同则灰,不同则老行标删/新行标增
  const maxLen = Math.max(oldLines.length, newLines.length);
  let anyDiff = false;
  for (let i = 0; i < maxLen; i++) {
    const o = i < oldLines.length ? oldLines[i] : null;
    const nl = i < newLines.length ? newLines[i] : null;
    if (o === nl) {
      const s = document.createElement('span'); s.className = 'same'; s.textContent = (o == null ? '' : o);
      box.appendChild(s);
    } else {
      anyDiff = true;
      if (o != null) {
        const s = document.createElement('span'); s.className = 'del'; s.textContent = '- ' + o;
        box.appendChild(s);
      }
      if (nl != null) {
        const s = document.createElement('span'); s.className = 'add'; s.textContent = '+ ' + nl;
        box.appendChild(s);
      }
    }
  }
  if (!anyDiff) {
    box.innerHTML = '<span class="same">(没有改动)</span>';
  }
  document.getElementById('modal-mask').classList.add('on');
}

function closeModal() {
  document.getElementById('modal-mask').classList.remove('on');
}

async function confirmSave() {
  closeModal();
  if (pendingAction && pendingAction.kind === 'context-source-save') {
    const key = pendingAction.key;
    try {
      await commitContextSourceSave(key);
    } catch (e) {
      const status = document.getElementById('context-source-status-' + key);
      if (status) status.textContent = '保存失败：' + e.message;
    } finally {
      pendingAction = null;
    }
    return;
  }
  if (pendingAction && pendingAction.kind === 'prompt-save') {
    try {
      await commitRuntimePromptSave();
    } catch (e) {
      document.getElementById('runtime-prompt-status').textContent = '保存失败：' + e.message;
    } finally {
      pendingAction = null;
    }
    return;
  }
  if (pendingAction && pendingAction.kind === 'todo-save') {
    try {
      await commitContextTodoSave();
    } catch (e) {
      document.getElementById('ctx-todo-status').textContent = '保存失败：' + e.message;
    } finally {
      pendingAction = null;
    }
    return;
  }
  document.getElementById('status').textContent = '只读：文件写入口已冻结。';
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (curView === 'files' && editing) tryShowDiff();
    if (curView === 'context' && contextTodoEditing) showContextTodoDiff();
  }
});

// 初始加载:健康度是落地页
loadHealth();

// ---------- 自动轮询(每 20s;只 health / timeline / octant;编辑中的文件页不刷) ----------
const AUTO_REFRESH_MS = 20000;
const AUTO_REFRESH_VIEWS = { health: loadHealth, injection: loadInjection, memorymap: loadMemoryMap, timeline: loadTimeline, octant: loadOctant, files: refreshFilesView };
AUTO_REFRESH_VIEWS.context = loadContextManager;
let autoTimer = null;
let autoPaused = false;
try { autoPaused = localStorage.getItem('dash_auto_paused') === '1'; } catch (e) {}

function updateAutoIndicator() {
  const el = document.getElementById('auto-indicator');
  if (!el) return;
  const supported = Object.prototype.hasOwnProperty.call(AUTO_REFRESH_VIEWS, curView);
  if (!supported) {
    el.textContent = '·';
    el.title = '此页不自动刷新';
    el.style.opacity = '0.35';
  } else if (autoPaused) {
    el.textContent = '⏸';
    el.title = '自动刷新已暂停(点击恢复)';
    el.style.opacity = '0.6';
  } else {
    el.textContent = '●';
    el.title = '20 秒自动刷新中(点击暂停)';
    el.style.opacity = '1';
  }
}
function toggleAutoRefresh() {
  autoPaused = !autoPaused;
  try { localStorage.setItem('dash_auto_paused', autoPaused ? '1' : '0'); } catch (e) {}
  updateAutoIndicator();
  scheduleAutoRefresh();
}
function scheduleAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (autoPaused) return;
  autoTimer = setInterval(() => {
    const fn = AUTO_REFRESH_VIEWS[curView];
    if (!fn) return;               // 只在 health/timeline/octant 三页轮询
    if (document.hidden) return;   // 页面不在前台不刷,省事
    try { fn(); } catch (e) { /* 静默;下轮再试 */ }
  }, AUTO_REFRESH_MS);
}
// 挂到 switchView:切页时重置计时,避免刚切过去就刷一次
(function () {
  const _orig = switchView;
  switchView = function (name) {
    _orig(name);
    updateAutoIndicator();
    scheduleAutoRefresh();
  };
})();
updateAutoIndicator();
scheduleAutoRefresh();
const _renderOctantRealtimeWithTimezone = renderOctantRealtime;
renderOctantRealtime = function(ds, historyLastTime, historySource) {
  _renderOctantRealtimeWithTimezone(ds, historyLastTime, historySource);
  const timezone = desireSchedulePayload && desireSchedulePayload.timezone;
  document.querySelectorAll('#octant-live .meta').forEach(node => {
    node.textContent = node.textContent.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, value => formatScheduleTime(value, timezone));
  });
};
</script>
</body>
</html>
"""


class H(BaseHTTPRequestHandler):
    # 请求体是否已经被读走。
    #
    # 提前返回的响应（401 token 校验失败、403 冻结端点、400 非法 body）如果不先把请求
    # 体读掉就关连接，Windows 会对接收缓冲里的未读数据回 RST，客户端拿到的是
    # `ConnectionAbortedError / ConnectionResetError [WinError 10053/10054]`，**而不是
    # 那个状态码**。面板于是显示「连接被中止」而不是「token 校验失败」。
    #
    # 小请求体塞得进 socket 缓冲，所以平时看不出来；大请求体必然复现（实测 200KB 未授权
    # POST 三次三中）。这也是 `tests/test_dashboard_context_manager.py` 在 CI 上间歇性
    # 把 main 弄红的根因 —— 它第一个 POST 就是预期 401 的未授权请求。
    #
    # 注意顺序：本类的所有 POST 路径都是「先读体、再回响应」或「不读体直接回错误」，
    # 没有「先回响应、后读体」的路径。若将来新增那种路径，`_read_json_body()` 会读到空。
    _body_consumed = False

    # 超过这个大小不再排空。面板是 localhost 单用户，真实请求远小于此；
    # 上限只为挡住畸形或恶意的 Content-Length，避免无界读取。
    _DRAIN_LIMIT = 16 * 1024 * 1024

    def _drain_request_body(self):
        """把尚未读取的请求体读掉再回响应，避免关连接时触发 RST。

        只排空一次。排空本身失败就放弃 —— 它的目的是让错误响应能干净送达，
        不该反过来把响应也搞没了（fail-open）。
        """
        if self._body_consumed:
            return
        self._body_consumed = True
        try:
            remaining = int(self.headers.get("Content-Length", 0) or 0)
        except (TypeError, ValueError):
            return
        if remaining <= 0 or remaining > self._DRAIN_LIMIT:
            return
        try:
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
        except OSError:
            return

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        self._drain_request_body()
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            page = PAGE.replace("%LABELS%", json.dumps(LABELS, ensure_ascii=False))
            page = page.replace("%GUARD_CONFIRM%", json.dumps(GUARD_CONFIRM, ensure_ascii=False))
            page = page.replace("%API_TOKEN%", json.dumps(API_TOKEN, ensure_ascii=False))
            self._send(200, page, "text/html; charset=utf-8")

        elif u.path == "/api/context-overview":
            try:
                self._send(200, json.dumps(compute_context_overview(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/context-layout":
            try:
                self._send(200, json.dumps(context_layout_payload(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/todo":
            try:
                self._send(200, json.dumps(todo_payload(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/list":
            self._send(200, json.dumps(list_files(), ensure_ascii=False))

        elif u.path == "/api/file":
            f = safe_path(parse_qs(u.query).get("f", [""])[0])
            if not f:
                self._send(404, '{"err":"no such file"}')
                return
            content = read_text(f)
            self._send(200, json.dumps({"name": f.name, "content": content}, ensure_ascii=False))

        elif u.path == "/api/health":
            try:
                h = compute_health()
                self._send(200, json.dumps(h, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/injection":
            try:
                data = compute_injection_overview()
                self._send(200, json.dumps(data, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/runtime-prompt":
            try:
                self._send(200, json.dumps(get_runtime_prompt_payload(include_content=True), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/context-sources":
            try:
                self._send(200, json.dumps(get_context_sources_payload(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/memory_overview":
            try:
                data = compute_memory_overview()
                self._send(200, json.dumps(data, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/module-state":
            try:
                self._send(200, json.dumps({
                    "modules": compute_module_state(),
                    "continuity_dir": str(CONTINUITY_DIR),
                    "write_mode": "controlled_context_write",
                    "capabilities": {
                        "controlled_context_write": [
                            "runtime_prompt",
                            "reentry",
                            "live_state_override",
                            "memory_context_override",
                            "context_gates",
                            "context_layout",
                        ],
                        "frozen": ["canon", "episodes", "portrait", "desire", "candidate_publication"],
                    },
                }, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path in ("/api/context-trace", "/api/continuity/candidates", "/api/continuity/decisions"):
            try:
                kind = {
                    "/api/context-trace": "trace",
                    "/api/continuity/candidates": "candidates",
                    "/api/continuity/decisions": "decisions",
                }[u.path]
                limit = _parse_limit(parse_qs(u.query).get("limit", ["50"])[0], default=50)
                self._send(200, json.dumps({"kind": kind, "rows": get_continuity_rows(kind, limit)}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/episodes_index":
            try:
                idx = compute_episodes_index()
                self._send(200, json.dumps(idx, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/rereadings_index":
            try:
                idx = compute_rereadings_index()
                self._send(200, json.dumps(idx, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/state_rows":
            try:
                # n:返回最近多少行(默认 30,曲线图会要 200)
                n = _parse_limit(parse_qs(u.query).get("n", ["30"])[0], default=30)
                history = load_octant_history_rows(limit=n)
                self._send(200, json.dumps({
                    "rows": history["rows"],
                    "history_source": history["source"],
                    "history_path": history["path"],
                    "history_row_count": history["row_count"],
                    "history_fallback": history["fallback"],
                    "realtime": load_desire_state(),
                }, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/context-gates":
            try:
                self._send(200, json.dumps(load_context_gates(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        # ---- v2.1 API 桥:只读端点(无需 token,只绑本机) ----

        elif u.path == "/api/reentry":
            try:
                self._send(200, json.dumps(get_reentry_payload(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/timeline":
            try:
                self._send(200, json.dumps(get_text_payload("relationship_timeline.md"), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/rereadings":
            try:
                self._send(200, json.dumps(get_text_payload("rereadings.md"), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/episodes":
            try:
                limit = _parse_limit(parse_qs(u.query).get("limit", ["20"])[0], default=20)
                rows = get_episodes_limited(limit)
                self._send(200, json.dumps(rows, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/state_log":
            try:
                limit = _parse_limit(parse_qs(u.query).get("limit", ["24"])[0], default=24)
                rows = get_state_log_limited(limit)
                self._send(200, json.dumps(rows, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/desire-schedule":
            try:
                self._send(200, json.dumps(load_desire_schedule_config(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/config":
            # 返回脱敏的 keys.local.json 视图:key 只显示 provider 和末 4 位
            try:
                k = load_keys()
                def mask(v):
                    v = str(v or "")
                    return f"…{v[-4:]}" if len(v) >= 8 else ("(空)" if not v else "…")
                view = {
                    "chat_provider": k.get("chat_provider", ""),
                    "chat_model": k.get("chat_model", ""),
                    "chat_haiku_model": k.get("chat_haiku_model", ""),
                    "chat_keys_masked": {p: mask(v) for p, v in (k.get("chat_keys") or {}).items()},
                    "chat_endpoints": k.get("chat_endpoints") or {},
                    "extract_provider": k.get("extract_provider") or k.get("MEM_PROVIDER", ""),
                    "extract_model": k.get("extract_model") or k.get("GLM_MODEL") or k.get("DS_MODEL", ""),
                    "extract_keys_masked": {p: mask(v) for p, v in (k.get("extract_keys") or {}).items()},
                    "extract_endpoints": k.get("extract_endpoints") or {},
                    "telegram_bot_token_masked": mask(k.get("telegram_bot_token")),
                    "telegram_allowed_user_ids": k.get("telegram_allowed_user_ids", ""),
                    "https_proxy": k.get("https_proxy", ""),
                }
                self._send(200, json.dumps(view, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/config":
            self._send(410, "Configuration writes are retired; the Phase 4 console is read-only.",
                       "text/plain; charset=utf-8")

        # ---- v3:关怀 / 剧场只读端点 ----

        elif u.path == "/api/care/config":
            try:
                self._send(200, json.dumps(load_care_config(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/care/cycle":
            try:
                self._send(200, json.dumps({"text": read_cycle_text()}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        elif u.path == "/api/theater/scripts":
            try:
                self._send(200, json.dumps(parse_scripts_index(), ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"err": str(e)}, ensure_ascii=False))

        else:
            self._send(404, '{"err":"not found"}')

    def _check_token(self):
        token = self.headers.get("X-Api-Token", "")
        if not token or token != API_TOKEN:
            self._send(401, json.dumps({"ok": False, "err": "token 校验失败"}, ensure_ascii=False))
            return False
        return True

    def _read_json_body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except Exception:
            n = 0
        # 标记体已消费，`_send()` 的排空就会跳过 —— 请求体只读一次。
        self._body_consumed = True
        raw = self.rfile.read(n).decode("utf-8", errors="replace") if n > 0 else ""
        if not raw.strip():
            return None, "请求体为空"
        try:
            return json.loads(raw), None
        except Exception as e:
            return None, f"请求体不是合法 JSON: {e}"

    def do_POST(self):
        u = urlparse(self.path)

        if u.path in FROZEN_WRITE_ENDPOINTS:
            self._send(403, json.dumps({
                "ok": False,
                "error": "write_frozen",
                "path": u.path,
            }, ensure_ascii=False))
            return

        if u.path in ("/api/runtime-prompt/save", "/api/runtime-prompt/restore"):
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err or not isinstance(obj, dict):
                self._send(400, json.dumps({"ok": False, "error": "invalid_body", "err": err}, ensure_ascii=False))
                return
            try:
                if u.path.endswith("/save"):
                    prompt = save_runtime_prompt(obj.get("content"), obj.get("expected_sha256"), obj.get("source"))
                else:
                    prompt = restore_runtime_prompt(obj.get("backup"), obj.get("expected_sha256"), obj.get("source"))
                self._send(200, json.dumps({"ok": True, "prompt": prompt}, ensure_ascii=False))
            except (ValueError, FileNotFoundError) as e:
                self._send(400, json.dumps({"ok": False, "error": "invalid_prompt", "err": str(e)}, ensure_ascii=False))
            except RuntimeError as e:
                self._send(409, json.dumps({"ok": False, "error": "prompt_conflict", "err": str(e)}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "error": "prompt_write_failed", "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/context-source/save":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err or not isinstance(obj, dict):
                self._send(400, json.dumps({"ok": False, "error": "invalid_body", "err": err}, ensure_ascii=False))
                return
            try:
                payload = save_context_source(obj.get("key"), obj.get("content"), obj.get("expected_sha256"), obj.get("source"))
                self._send(200, json.dumps({"ok": True, "context_sources": payload}, ensure_ascii=False))
            except ValueError as e:
                self._send(400, json.dumps({"ok": False, "error": "invalid_context_source", "err": str(e)}, ensure_ascii=False))
            except RuntimeError as e:
                self._send(409, json.dumps({"ok": False, "error": "context_source_conflict", "err": str(e)}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "error": "context_source_write_failed", "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/desire-schedule":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err:
                self._send(400, json.dumps({"ok": False, "err": err}, ensure_ascii=False))
                return
            try:
                payload = save_desire_schedule_config(obj, obj.get("expected_revision", ""), obj.get("source", "520"))
                self._send(200, json.dumps({"ok": True, "schedule": payload, "apply_note": "已保存，下一轮生效；当前调用不会被中断。"}, ensure_ascii=False))
            except ValueError as e:
                self._send(400, json.dumps({"ok": False, "error": "invalid_schedule", "err": str(e)}, ensure_ascii=False))
            except RuntimeError as e:
                self._send(409, json.dumps({"ok": False, "error": "schedule_conflict", "err": str(e)}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "error": "schedule_write_failed", "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/context-layout/save":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err or not isinstance(obj, dict):
                self._send(400, json.dumps({"ok": False, "error": "invalid_body"}, ensure_ascii=False))
                return
            try:
                payload = save_context_layout(obj.get("layout"), obj.get("source"))
                self._send(200, json.dumps({"ok": True, "context": payload}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/context-layout/snapshot":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err or not isinstance(obj, dict):
                self._send(400, json.dumps({"ok": False, "error": "invalid_body"}, ensure_ascii=False))
                return
            try:
                result = archive_context_snapshot(obj.get("slot"))
                self._send(200, json.dumps({"ok": True, **result}, ensure_ascii=False))
            except Exception as e:
                self._send(400, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/context-layout/restore":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err or not isinstance(obj, dict):
                self._send(400, json.dumps({"ok": False, "error": "invalid_body"}, ensure_ascii=False))
                return
            try:
                payload = restore_context_snapshot(obj.get("slot"), obj.get("source"))
                self._send(200, json.dumps({"ok": True, "context": payload}, ensure_ascii=False))
            except Exception as e:
                self._send(400, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/todo/save":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err or not isinstance(obj, dict):
                self._send(400, json.dumps({"ok": False, "error": "invalid_body"}, ensure_ascii=False))
                return
            try:
                payload = save_todo_content(obj.get("content"), obj.get("source"))
                self._send(200, json.dumps({"ok": True, "todo": payload}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/context-gates":
            # 上下文缝入开关:只写 CYBERBOSS_STATE_DIR/context-gates.json,
            # 不碰 Desire / canon。Memory Context 下一轮即时生效；硬上下文变化由 runtime 下一轮换干净线程。
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err or not isinstance(obj, dict):
                self._send(400, json.dumps({"ok": False, "error": "invalid_body"}, ensure_ascii=False))
                return
            try:
                gates = load_context_gates()
                for key in CONTEXT_GATE_KEYS:
                    if key in obj:
                        gates[key] = bool(obj[key])
                gates["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                gate_file = resolve_runtime_state_dir() / "context-gates.json"
                write_text_atomic(gate_file, json.dumps(gates, ensure_ascii=False, indent=2))
                self._send(200, json.dumps({
                    "ok": True, **gates,
                    "thread_rebuild": any(key in obj for key in ("reentry", "current_state")),
                    "apply_note": "硬上下文改变后，Telegram 会在下一条消息自动换干净线程。",
                }, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/review/retry":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err:
                self._send(400, json.dumps({"ok": False, "error": "invalid_body"}, ensure_ascii=False))
                return
            result, code = run_review_retry((obj or {}).get("candidate_id"))
            self._send(code, json.dumps(result, ensure_ascii=False))
            return

        if u.path == "/api/save":
            if not self._check_token():
                return
            f = safe_path(parse_qs(u.query).get("f", [""])[0])
            if not f:
                self._send(404, '{"err":"no such file"}')
                return
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n).decode("utf-8", errors="replace")
            if f.suffix == ".jsonl":
                for i, line in enumerate(body.split("\n")):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        json.loads(line)
                    except Exception as e:
                        self._send(400, json.dumps({"ok": False, "err": f"第 {i+1} 行不是合法 JSON: {e}"}, ensure_ascii=False))
                        return
            try:
                BACKUPS.mkdir(exist_ok=True)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                bak = BACKUPS / (f.name + "." + stamp + ".bak")
                if f.exists():
                    bak.write_text(read_text(f), encoding="utf-8")
                f.write_text(body, encoding="utf-8")
                self._send(200, '{"ok":true}')
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/state_log":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err:
                self._send(400, json.dumps({"ok": False, "err": err}, ensure_ascii=False))
                return
            ok, verr = validate_state_log_body(obj)
            if not ok:
                self._send(400, json.dumps({"ok": False, "err": verr}, ensure_ascii=False))
                return
            try:
                append_state_log(obj)
                self._send(200, json.dumps({"ok": True}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/episode_candidate":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err:
                self._send(400, json.dumps({"ok": False, "err": err}, ensure_ascii=False))
                return
            ok, verr = validate_episode_candidate_body(obj)
            if not ok:
                self._send(400, json.dumps({"ok": False, "err": verr}, ensure_ascii=False))
                return
            try:
                new_id = append_episode_candidate(obj)
                self._send(200, json.dumps({"ok": True, "id": new_id}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/janitor/run":
            if not self._check_token():
                return
            if JANITOR_STATE["running"]:
                self._send(409, json.dumps({"status": "already_running"}, ensure_ascii=False))
                return
            try:
                t = threading.Thread(target=_run_janitor_once, name="manual-janitor", daemon=True)
                t.start()
                self._send(200, json.dumps({"ok": True, "status": "started"}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        # ---- v3:关怀写端点(带 token;只写 care/ 下两个文件,永不碰 memory/) ----

        if u.path == "/api/care/config":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err:
                self._send(400, json.dumps({"ok": False, "err": err}, ensure_ascii=False))
                return
            ok, verr = validate_care_config_body(obj)
            if not ok:
                self._send(400, json.dumps({"ok": False, "err": verr}, ensure_ascii=False))
                return
            try:
                cfg = save_care_config(obj)
                self._send(200, json.dumps({"ok": True, "config": cfg}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/care/cycle":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err:
                self._send(400, json.dumps({"ok": False, "err": err}, ensure_ascii=False))
                return
            ok, verr = validate_cycle_entry(obj)
            if not ok:
                self._send(400, json.dumps({"ok": False, "err": verr}, ensure_ascii=False))
                return
            try:
                line = append_cycle_entry(obj)
                self._send(200, json.dumps({"ok": True, "line": line}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        if u.path == "/api/config":
            if not self._check_token():
                return
            obj, err = self._read_json_body()
            if err:
                self._send(400, json.dumps({"ok": False, "err": err}, ensure_ascii=False))
                return
            try:
                keys = load_keys()
                if "chat_provider" in obj:
                    keys["chat_provider"] = str(obj["chat_provider"]).strip().lower()
                if "chat_model" in obj:
                    keys["chat_model"] = str(obj["chat_model"]).strip()
                if "chat_haiku_model" in obj:
                    keys["chat_haiku_model"] = str(obj["chat_haiku_model"]).strip()
                if "https_proxy" in obj:
                    keys["https_proxy"] = str(obj["https_proxy"]).strip()
                if "extract_provider" in obj:
                    keys["extract_provider"] = str(obj["extract_provider"]).strip().lower()
                if "extract_model" in obj:
                    keys["extract_model"] = str(obj["extract_model"]).strip()
                for group in ("chat_keys", "extract_keys"):
                    if isinstance(obj.get(group), dict):
                        existing = keys.get(group) or {}
                        for prov, val in obj[group].items():
                            v = str(val or "").strip()
                            if v and not v.startswith("…"):
                                existing[prov] = v
                        keys[group] = existing
                if "telegram_bot_token" in obj:
                    v = str(obj["telegram_bot_token"] or "").strip()
                    if v and not v.startswith("…"):
                        keys["telegram_bot_token"] = v
                if "telegram_allowed_user_ids" in obj:
                    keys["telegram_allowed_user_ids"] = str(obj["telegram_allowed_user_ids"]).strip()
                if any(isinstance(obj.get(group), dict) and any(str(value or "").strip() for value in obj[group].values()) for group in ("chat_keys", "extract_keys")):
                    raise ValueError("API keys must be supplied through the process environment, not saved by the dashboard.")
                if str(obj.get("telegram_bot_token") or "").strip():
                    raise ValueError("Telegram credentials must be supplied through the process environment, not saved by the dashboard.")
                KEYS_FILE.write_text(json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8")
                apply_msg = ""
                try:
                    apply_script = KIT_DIR / "apply_keys_to_env.py"
                    if apply_script.exists():
                        r = subprocess.run(
                            [sys.executable, str(apply_script)],
                            capture_output=True, text=True, timeout=10,
                        )
                        apply_msg = (r.stdout + r.stderr).strip()[:400]
                except Exception as e:
                    apply_msg = f"apply_keys 失败: {e}"
                self._send(200, json.dumps({"ok": True, "apply": apply_msg}, ensure_ascii=False))
            except Exception as e:
                self._send(500, json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False))
            return

        self._send(404, '{"err":"not found"}')

    def log_message(self, *a):
        pass


def _open_browser(url):
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        pass


if __name__ == "__main__":
    if not ROOT.exists():
        safe_print(f"找不到 {ROOT} — 请确认 memory/ 文件夹在工作区根目录。")
        raise SystemExit(1)

    try:
        srv = HTTPServer((HOST, PORT), H)
    except OSError:
        url = f"http://{HOST}:{PORT}"
        safe_print(f"端口 {PORT} 已被占用,面板可能已在运行 — 打开现有实例:{url}")
        _open_browser(url)
        raise SystemExit(0)

    write_pid_file()
    atexit.register(remove_pid_file)

    try:
        start_auto_janitor_thread()
    except Exception as e:
        safe_print(f"自动补记线程启动失败(不影响面板本体):{e}")

    url = f"http://{HOST}:{PORT}"
    safe_print(f"记忆面板 v3: {url}   (Ctrl+C 退出)")
    _open_browser(url)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        remove_pid_file()

# v3(2026-07-06):修复 v2.1 尾部重复粘贴导致的语法损坏(旧文件在 dashboard_v3.bak.py);
# 新增 关怀/剧场 两页与八维 canvas 曲线。
