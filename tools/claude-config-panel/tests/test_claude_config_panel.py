# -*- coding: utf-8 -*-
"""claude-config-panel 验收测试：纯函数 + HTTP 黑盒，全部跑在临时目录上，
不碰真实 Claude 配置。直接 `python` 运行（模式同 memory-kit 的测试）。"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "ccp_server", os.path.join(_HERE, "..", "server.py"))
ccp = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ccp)


class PanelFixture(unittest.TestCase):
    """临时目录里搭一套最小但真实形状的 Claude 配置。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ccp-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.root = os.path.join(self.tmp, "cyberlink")
        self.claude_home = os.path.join(self.tmp, "dot-claude")
        self.claude_json = os.path.join(self.tmp, "dot-claude.json")
        os.makedirs(self.root)
        os.makedirs(self.claude_home)

        self.project_dir = os.path.join(self.root, "proj")
        os.makedirs(self.project_dir)
        self._write(os.path.join(self.project_dir, ".mcp.json"),
                    {"mcpServers": {"proj_tools": {"command": "node"}}})

        # 同一项目路径的正反斜杠两个变体条目——真实 ~\.claude.json 就长这样
        fwd = self.project_dir.replace("\\", "/")
        self._write(self.claude_json, {
            "numStartups": 42,
            "mcpServers": {
                "codex": {"command": "codex-mcp", "args": ["--x"]},
                "chrome": {"command": "chrome-mcp"},
            },
            "projects": {
                self.project_dir: {"allowedTools": ["Bash"]},
                fwd: {"disabledMcpjsonServers": []},
            },
        })
        self._write(os.path.join(self.claude_home, "settings.json"), {
            "model": "opus",
            "skillOverrides": {"anthropic-skills:docx": "off"},
        })
        plugin_dir = os.path.join(self.tmp, "plugin-install")
        os.makedirs(os.path.join(plugin_dir, "skills", "rescue"))
        with open(os.path.join(plugin_dir, "skills", "rescue", "SKILL.md"), "w", encoding="utf-8") as f:
            f.write("# rescue\n")
        self._write(os.path.join(self.claude_home, "plugins", "installed_plugins.json"),
                    {"version": 2, "plugins": {"codex@openai-codex": [{"installPath": plugin_dir}]}})

        self.paths = ccp.Paths(self.root, claude_home=self.claude_home,
                               claude_json=self.claude_json)

    def _write(self, path, obj):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)

    def _read(self, path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def backups(self):
        d = self.paths.backup_dir
        return sorted(os.listdir(d)) if os.path.isdir(d) else []


class TestPaths(PanelFixture):
    def test_root_is_required_and_validated(self):
        with self.assertRaises(ccp.PanelError):
            ccp.Paths(None)
        with self.assertRaises(ccp.PanelError):
            ccp.Paths(os.path.join(self.tmp, "no-such-dir"))


class TestSkillToggle(PanelFixture):
    def test_off_writes_off_and_on_removes_key(self):
        ccp.set_skill(self.paths, "dataviz", off=True)
        settings = self._read(self.paths.settings_json)
        self.assertEqual(settings["skillOverrides"]["dataviz"], "off")
        # 其余键原样保留
        self.assertEqual(settings["model"], "opus")
        self.assertEqual(settings["skillOverrides"]["anthropic-skills:docx"], "off")

        ccp.set_skill(self.paths, "dataviz", off=False)
        settings = self._read(self.paths.settings_json)
        self.assertNotIn("dataviz", settings["skillOverrides"])
        # 两次写 = 两份备份
        self.assertEqual(len([b for b in self.backups() if b.startswith("settings.json.")]), 2)

    def test_empty_name_rejected(self):
        with self.assertRaises(ccp.PanelError):
            ccp.set_skill(self.paths, "  ", off=True)


class TestProjectMcpToggle(PanelFixture):
    def test_disable_hits_every_slash_variant(self):
        ccp.set_project_mcp(self.paths, self.project_dir, "proj_tools", disabled=True)
        cfg = self._read(self.claude_json)
        for key, entry in cfg["projects"].items():
            self.assertIn("proj_tools", entry["disabledMcpjsonServers"], key)
            self.assertNotIn("proj_tools", entry["enabledMcpjsonServers"], key)
        self.assertEqual(cfg["projects"][self.project_dir]["allowedTools"], ["Bash"])

        ccp.set_project_mcp(self.paths, self.project_dir, "proj_tools", disabled=False)
        cfg = self._read(self.claude_json)
        for key, entry in cfg["projects"].items():
            self.assertNotIn("proj_tools", entry["disabledMcpjsonServers"], key)
            self.assertIn("proj_tools", entry["enabledMcpjsonServers"], key)

    def test_unknown_project_fails_closed(self):
        with self.assertRaises(ccp.PanelError):
            ccp.set_project_mcp(self.paths, os.path.join(self.tmp, "elsewhere"),
                                "proj_tools", disabled=True)


class TestUserMcpParking(PanelFixture):
    def test_park_and_restore_round_trip_is_lossless(self):
        original = self._read(self.claude_json)["mcpServers"]["codex"]
        ccp.set_user_mcp(self.paths, "codex", park=True)

        cfg = self._read(self.claude_json)
        self.assertNotIn("codex", cfg["mcpServers"])
        self.assertIn("chrome", cfg["mcpServers"])  # 别的 server 不动
        self.assertEqual(cfg["numStartups"], 42)     # 无关键原样
        parked = self._read(self.paths.parked_json)["mcpServers"]
        self.assertEqual(parked["codex"], original)

        ccp.set_user_mcp(self.paths, "codex", park=False)
        cfg = self._read(self.claude_json)
        self.assertEqual(cfg["mcpServers"]["codex"], original)
        self.assertEqual(self._read(self.paths.parked_json)["mcpServers"], {})

    def test_unknown_server_fails_closed(self):
        with self.assertRaises(ccp.PanelError):
            ccp.set_user_mcp(self.paths, "nope", park=True)
        with self.assertRaises(ccp.PanelError):
            ccp.set_user_mcp(self.paths, "nope", park=False)


class TestState(PanelFixture):
    def test_state_surfaces_all_three_panes(self):
        state = ccp.get_state(self.paths)
        self.assertEqual(state["user_mcp"], ["chrome", "codex"])
        self.assertEqual(state["parked_mcp"], [])
        self.assertEqual(len(state["projects"]), 1)
        self.assertEqual(state["projects"][0]["servers"], ["proj_tools"])
        names = {s["name"]: s["off"] for s in state["skills"]}
        self.assertTrue(names["anthropic-skills:docx"])   # overrides 里的
        self.assertIn("codex:rescue", names)              # 插件磁盘扫出来的
        self.assertFalse(names["codex:rescue"])

    def test_unicode_survives_write(self):
        ccp.set_skill(self.paths, "写作风格", off=True)
        with open(self.paths.settings_json, encoding="utf-8") as f:
            raw = f.read()
        self.assertIn("写作风格", raw)  # ensure_ascii=False，中文不转义


class TestHttpBlackbox(PanelFixture):
    """黑盒：真起 HTTP 服务，走网页路径改临时配置。"""

    def setUp(self):
        super().setUp()
        self.server = ccp.make_server(self.paths, 0)  # 临时端口
        self.port = self.server.server_address[1]
        t = threading.Thread(target=self.server.serve_forever, daemon=True)
        t.start()
        # LIFO：先 shutdown 退出 serve_forever，再 server_close 关套接字
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def _get(self, path="/"):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}") as r:
            return r.status, r.read().decode("utf-8")

    def _post(self, data):
        body = urllib.parse.urlencode(data).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/toggle", data=body)
        with urllib.request.urlopen(req) as r:
            return r.status, r.read().decode("utf-8")

    def test_page_renders_and_toggle_persists(self):
        status, page = self._get()
        self.assertEqual(status, 200)
        for expected in ("codex", "chrome", "proj_tools", "anthropic-skills:docx"):
            self.assertIn(expected, page)

        status, page = self._post({"op": "skill", "name": "dataviz", "value": "off"})
        self.assertEqual(status, 200)
        self.assertEqual(self._read(self.paths.settings_json)["skillOverrides"]["dataviz"], "off")
        self.assertIn("dataviz 已关", page)

        status, page = self._post({"op": "user_mcp", "name": "codex", "value": "off"})
        self.assertEqual(status, 200)
        self.assertNotIn("codex", self._read(self.claude_json)["mcpServers"])
        self.assertIn("已停车", page)

    def test_bad_op_reports_instead_of_500(self):
        status, page = self._post({"op": "explode", "name": "x", "value": "off"})
        self.assertEqual(status, 200)
        self.assertIn("没改成", page)

    def test_unknown_path_is_404(self):
        try:
            status, _ = self._get("/etc/passwd")
        except urllib.error.HTTPError as e:
            status = e.code
            e.close()
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
