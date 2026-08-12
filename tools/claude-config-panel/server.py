# -*- coding: utf-8 -*-
r"""Claude Code MCP/skill 开关面板 —— 本地零依赖小服务（标准库，模式同 structure-map）。

http://127.0.0.1:7822  网页开关 Claude Code 的 MCP server 与 skill。
每次请求现读配置文件渲染，自己不存状态，永远不与配置文件打架。

三个开关面，对应三个真实配置位：
- skill        -> <claude home>\settings.json 的 skillOverrides（"off" / 删键还原默认）
- 项目级 MCP   -> ~\.claude.json 里对应 project 条目的 disabledMcpjsonServers /
                  enabledMcpjsonServers（官方字段；同一路径的正反斜杠变体条目一起改）
- 用户级 MCP   -> Claude Code 没有用户级禁用清单，"关"是把条目搬进
                  <claude home>\mcp-parked.json 停车文件，"开"搬回 mcpServers

纪律：
- 开关只对**新开的** Claude Code 窗口生效，已开窗口不热重载。
- 每次写入前把被改文件备份到 <root>\backup\claude-config-edits\。
- ~\.claude.json 由 Claude Code 自己频繁重写：面板只做最小读改写 + 原子替换，
  与 app 同时写的竞态窗口极小但存在，页面每次刷新回读磁盘真相。
- 遵守 D8：root 必须显式传入（--root 或 CYBERLINK_ROOT），不向上摸目录找根。
"""

import argparse
import html
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DEFAULT_PORT = 7822
SKILL_OFF = "off"


class PanelError(Exception):
    """面板层面的可预期错误，message 直接进页面。"""


class Paths:
    """全部路径一次算清。root 必填并校验（D8），claude 侧路径可用 env 覆盖（测试用）。"""

    def __init__(self, root, claude_home=None, claude_json=None):
        if not root:
            raise PanelError("root is required: pass --root or set CYBERLINK_ROOT (D8: no upward directory search)")
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            raise PanelError(f"root is not a directory: {root}")
        self.root = root
        home = claude_home or os.environ.get("CCP_CLAUDE_HOME") or os.path.join(os.path.expanduser("~"), ".claude")
        self.claude_home = os.path.abspath(home)
        cj = claude_json or os.environ.get("CCP_CLAUDE_JSON") or os.path.join(os.path.expanduser("~"), ".claude.json")
        self.claude_json = os.path.abspath(cj)
        self.settings_json = os.path.join(self.claude_home, "settings.json")
        self.parked_json = os.path.join(self.claude_home, "mcp-parked.json")
        self.installed_plugins = os.path.join(self.claude_home, "plugins", "installed_plugins.json")
        self.backup_dir = os.path.join(self.root, "backup", "claude-config-edits")


def read_json(path, default):
    if not os.path.isfile(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def atomic_write_json(path, obj):
    """临时文件 + os.replace，掉电也不会留半个 JSON。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".ccp-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def backup_file(path, backup_dir):
    """写前备份；文件不存在则无事发生。返回备份文件名或 None。"""
    if not os.path.isfile(path):
        return None
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    name = f"{os.path.basename(path)}.{stamp}.bak"
    shutil.copy2(path, os.path.join(backup_dir, name))
    return name


def normalize_project_key(key):
    return os.path.normcase(key.replace("/", os.sep).replace("\\", os.sep)).rstrip(os.sep)


# ---------------------------------------------------------------- state 读取


def discover_skills(paths, overrides):
    """能发现的 skill：overrides 里已有的 + 插件缓存里带 SKILL.md 的 + 个人 skills 目录。
    App 内建 skill（如 dataviz）不在磁盘上，发现不了的用页面上的手动框加。"""
    names = set(overrides)
    installed = read_json(paths.installed_plugins, {})
    for plugin_name, entries in (installed.get("plugins") or {}).items():
        short = plugin_name.split("@")[0]
        for entry in entries or []:
            skills_dir = os.path.join(entry.get("installPath") or "", "skills")
            if not os.path.isdir(skills_dir):
                continue
            for child in os.listdir(skills_dir):
                if os.path.isfile(os.path.join(skills_dir, child, "SKILL.md")):
                    names.add(f"{short}:{child}")
    personal = os.path.join(paths.claude_home, "skills")
    if os.path.isdir(personal):
        for child in os.listdir(personal):
            if os.path.isfile(os.path.join(personal, child, "SKILL.md")):
                names.add(child)
    return sorted(names)


def project_groups(claude_cfg):
    r"""~\.claude.json projects 按归一路径分组：{normkey: [原始 key, ...]}。"""
    groups = {}
    for key in (claude_cfg.get("projects") or {}):
        groups.setdefault(normalize_project_key(key), []).append(key)
    return groups


def get_state(paths):
    claude_cfg = read_json(paths.claude_json, {})
    settings = read_json(paths.settings_json, {})
    parked = read_json(paths.parked_json, {}).get("mcpServers") or {}
    overrides = settings.get("skillOverrides") or {}

    user_mcp = sorted((claude_cfg.get("mcpServers") or {}).keys())
    parked_mcp = sorted(k for k in parked if k not in user_mcp)

    projects = []
    for normkey, orig_keys in sorted(project_groups(claude_cfg).items()):
        mcp_json = os.path.join(normkey, ".mcp.json")
        servers = sorted((read_json(mcp_json, {}).get("mcpServers") or {}).keys())
        disabled = set()
        for key in orig_keys:
            entry = claude_cfg["projects"].get(key) or {}
            disabled.update(entry.get("disabledMcpjsonServers") or [])
        if servers or disabled:
            projects.append({"dir": normkey, "servers": servers, "disabled": sorted(disabled)})

    skills = [{"name": n, "off": overrides.get(n) == SKILL_OFF} for n in discover_skills(paths, overrides)]
    return {"user_mcp": user_mcp, "parked_mcp": parked_mcp, "projects": projects, "skills": skills}


# ---------------------------------------------------------------- 三个写操作


def set_skill(paths, skill, off):
    skill = (skill or "").strip()
    if not skill:
        raise PanelError("empty skill name")
    settings = read_json(paths.settings_json, {})
    overrides = settings.setdefault("skillOverrides", {})
    if off:
        overrides[skill] = SKILL_OFF
    else:
        overrides.pop(skill, None)
    backup_file(paths.settings_json, paths.backup_dir)
    atomic_write_json(paths.settings_json, settings)
    return {"ok": True, "skill": skill, "off": off}


def set_project_mcp(paths, project_dir, server, disabled):
    server = (server or "").strip()
    if not server:
        raise PanelError("empty server name")
    target = normalize_project_key(project_dir or "")
    claude_cfg = read_json(paths.claude_json, {})
    hit = False
    for key, entry in (claude_cfg.get("projects") or {}).items():
        if normalize_project_key(key) != target or not isinstance(entry, dict):
            continue
        hit = True
        dis = [s for s in (entry.get("disabledMcpjsonServers") or []) if s != server]
        ena = [s for s in (entry.get("enabledMcpjsonServers") or []) if s != server]
        if disabled:
            dis.append(server)
        else:
            ena.append(server)
        entry["disabledMcpjsonServers"] = dis
        entry["enabledMcpjsonServers"] = ena
    if not hit:
        raise PanelError(f"project not found in claude.json: {project_dir}")
    backup_file(paths.claude_json, paths.backup_dir)
    atomic_write_json(paths.claude_json, claude_cfg)
    return {"ok": True, "project": target, "server": server, "disabled": disabled}


def set_user_mcp(paths, server, park):
    server = (server or "").strip()
    if not server:
        raise PanelError("empty server name")
    claude_cfg = read_json(paths.claude_json, {})
    servers = claude_cfg.setdefault("mcpServers", {})
    parked_doc = read_json(paths.parked_json, {})
    parked = parked_doc.setdefault("mcpServers", {})

    if park:
        if server not in servers:
            raise PanelError(f"user-scope mcp server not found: {server}")
        # 先落停车文件再从 claude.json 删：中间崩溃最多两边同名，活的一侧为准
        parked[server] = servers[server]
        backup_file(paths.parked_json, paths.backup_dir)
        atomic_write_json(paths.parked_json, parked_doc)
        del servers[server]
        backup_file(paths.claude_json, paths.backup_dir)
        atomic_write_json(paths.claude_json, claude_cfg)
    else:
        if server not in parked:
            raise PanelError(f"parked mcp server not found: {server}")
        if server not in servers:
            servers[server] = parked[server]
            backup_file(paths.claude_json, paths.backup_dir)
            atomic_write_json(paths.claude_json, claude_cfg)
        del parked[server]
        backup_file(paths.parked_json, paths.backup_dir)
        atomic_write_json(paths.parked_json, parked_doc)
    return {"ok": True, "server": server, "parked": park}


# ---------------------------------------------------------------- HTTP 层


PAGE_CSS = """
body{font-family:system-ui,sans-serif;max-width:56rem;margin:1.5rem auto;padding:0 1rem;line-height:1.5}
h1{font-size:1.3rem}h2{font-size:1.05rem;margin-top:1.6rem;border-bottom:1px solid #ccc;padding-bottom:.2rem}
.item{display:flex;align-items:center;gap:.6rem;padding:.18rem 0}
.item form{margin:0}
.on{color:#0a7a2f}.off{color:#a33}
button{cursor:pointer;padding:.1rem .55rem}
.note{color:#666;font-size:.85rem}
input[type=text]{width:18rem}
code{background:#f2f2f2;padding:0 .25rem}
"""


def esc(s):
    return html.escape(str(s), quote=True)


def render(state, paths, message=""):
    out = ["<!doctype html><meta charset='utf-8'><title>Claude 开关面板</title>",
           f"<style>{PAGE_CSS}</style>", "<h1>Claude Code MCP / Skill 开关面板</h1>",
           "<p class='note'>开关只对<strong>新开窗口</strong>生效，已开的窗口不会热重载。每次写入前自动备份到 "
           f"<code>{esc(os.path.relpath(paths.backup_dir, paths.root))}</code>。</p>"]
    if message:
        out.append(f"<p><strong>{esc(message)}</strong></p>")

    def button(op, fields, label):
        hidden = "".join(f"<input type='hidden' name='{esc(k)}' value='{esc(v)}'>" for k, v in fields.items())
        return f"<form method='post' action='/toggle'><input type='hidden' name='op' value='{op}'>{hidden}<button>{label}</button></form>"

    out.append("<h2>用户级 MCP（对所有窗口生效）</h2>")
    for name in state["user_mcp"]:
        out.append(f"<div class='item'><span class='on'>●</span> {esc(name)} "
                   + button("user_mcp", {"name": name, "value": "off"}, "关（停车）") + "</div>")
    for name in state["parked_mcp"]:
        out.append(f"<div class='item'><span class='off'>○</span> {esc(name)}（已停车） "
                   + button("user_mcp", {"name": name, "value": "on"}, "开（恢复）") + "</div>")
    if not state["user_mcp"] and not state["parked_mcp"]:
        out.append("<p class='note'>没有用户级 mcpServers。</p>")

    out.append("<h2>项目级 MCP（.mcp.json，按项目目录）</h2>")
    for proj in state["projects"]:
        out.append(f"<p><code>{esc(proj['dir'])}</code></p>")
        known = list(proj["servers"]) + [s for s in proj["disabled"] if s not in proj["servers"]]
        for name in known:
            off = name in proj["disabled"]
            dot = "<span class='off'>○</span>" if off else "<span class='on'>●</span>"
            btn = button("project_mcp", {"name": name, "project": proj["dir"],
                                         "value": "on" if off else "off"},
                         "开" if off else "关")
            out.append(f"<div class='item'>{dot} {esc(name)}{'（已禁用）' if off else ''} {btn}</div>")
    if not state["projects"]:
        out.append("<p class='note'>没有发现带 .mcp.json 的项目条目。</p>")

    out.append("<h2>Skill</h2>")
    for sk in state["skills"]:
        off = sk["off"]
        dot = "<span class='off'>○</span>" if off else "<span class='on'>●</span>"
        btn = button("skill", {"name": sk["name"], "value": "on" if off else "off"},
                     "开" if off else "关")
        out.append(f"<div class='item'>{dot} {esc(sk['name'])}{'（已关）' if off else ''} {btn}</div>")
    out.append("<p class='note'>App 内建 skill（如 dataviz）磁盘上扫不到，第一次关它用下面的框手动输名字；关过一次之后就会常驻在上面的清单里。</p>")
    out.append("<form method='post' action='/toggle'><input type='hidden' name='op' value='skill'>"
               "<input type='hidden' name='value' value='off'>"
               "<input type='text' name='name' placeholder='skill 名，如 dataviz 或 codex:rescue'> "
               "<button>关掉这个 skill</button></form>")

    out.append(f"<hr><p class='note'>配置位：<code>{esc(paths.claude_json)}</code> ｜ "
               f"<code>{esc(paths.settings_json)}</code> ｜ 停车文件 <code>{esc(paths.parked_json)}</code></p>")
    return "".join(out)


class Handler(BaseHTTPRequestHandler):
    paths = None  # 由 make_server 注入

    def log_message(self, *args):
        pass

    def _html(self, body, status=200):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path != "/":
            self.send_response(404)
            self.end_headers()
            return
        try:
            self._html(render(get_state(self.paths), self.paths))
        except Exception as e:  # 页面永远给出诊断而不是白屏
            self._html(f"<pre>panel error: {esc(e)}</pre>", status=500)

    def do_POST(self):
        if urlparse(self.path).path != "/toggle":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 100_000:
            self._html("<pre>request too large</pre>", status=413)
            return
        form = parse_qs(self.rfile.read(length).decode("utf-8", errors="replace"))

        def field(key):
            return (form.get(key) or [""])[0]

        op, name, value = field("op"), field("name"), field("value")
        try:
            if op == "skill":
                result = set_skill(self.paths, name, off=(value == "off"))
                message = f"skill {result['skill']} 已{'关' if result['off'] else '开'}"
            elif op == "user_mcp":
                result = set_user_mcp(self.paths, name, park=(value == "off"))
                message = f"用户级 MCP {result['server']} 已{'停车' if result['parked'] else '恢复'}"
            elif op == "project_mcp":
                result = set_project_mcp(self.paths, field("project"), name, disabled=(value == "off"))
                message = f"项目级 MCP {result['server']} 已{'禁用' if result['disabled'] else '启用'}"
            else:
                raise PanelError(f"unknown op: {op!r}")
        except PanelError as e:
            message = f"没改成：{e}"
        self._html(render(get_state(self.paths), self.paths, message=message))


def make_server(paths, port, host="127.0.0.1"):
    handler = type("BoundHandler", (Handler,), {"paths": paths})
    return ThreadingHTTPServer((host, port), handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Claude Code MCP/skill 开关面板（127.0.0.1）")
    parser.add_argument("--root", default=os.environ.get("CYBERLINK_ROOT"),
                        help="cyberlink 根目录（必填，或设 CYBERLINK_ROOT；D8 不向上摸根）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("CCP_PORT") or DEFAULT_PORT))
    args = parser.parse_args(argv)
    try:
        paths = Paths(args.root)
    except PanelError as e:
        print(f"claude-config-panel: {e}", file=sys.stderr)
        return 2
    server = make_server(paths, args.port)
    print(f"claude-config-panel: http://127.0.0.1:{args.port}/  (root={paths.root})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
