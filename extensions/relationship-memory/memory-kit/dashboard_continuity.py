#!/usr/bin/env python3
"""520 launcher overlay for the layered Continuity view.

The legacy dashboard remains untouched. This module patches only its in-memory
Continuity page and adds one bounded, read-only endpoint.
"""

import atexit
import json
import os
from http.server import HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import dashboard as legacy
from continuity_layers import build_continuity_layers


PID_FILE_OVERRIDE = os.environ.get("CYBERBOSS_DASHBOARD_PID_FILE", "").strip()
if PID_FILE_OVERRIDE:
    legacy.PID_FILE = Path(PID_FILE_OVERRIDE)


OLD_CONTINUITY_HTML = '''    <div class="view" id="view-continuity">
      <div class="notice">Phase 4 read-only console. Canon and Desire writes remain frozen; re-review only invokes the controlled review service.</div>
      <div class="view-stack">
        <div><div class="section-head">Module state</div><div id="continuity-modules"></div></div>
        <div><div class="section-head">Context Trace</div><div id="continuity-trace"></div></div>
        <div><div class="section-head">Candidates</div><div id="continuity-candidates"></div></div>
        <div><div class="section-head">Decisions</div><div id="continuity-decisions"></div></div>
      </div>
    </div>'''

NEW_CONTINUITY_HTML = '''    <div class="view" id="view-continuity">
      <div class="notice">只读观察页：这里把技术断档、证据、语义候选、Review 决策和正式 Canon 分开显示。页面不直接写记忆。</div>
      <div class="view-stack">
        <div><div class="section-head">模块与 Nightly 模式</div><div id="continuity-modules"></div><div id="continuity-nightly" class="notice"></div></div>
        <div><div class="section-head">上下文 Trace</div><div id="continuity-trace"></div></div>
        <div><div class="section-head">技术断档</div><div id="continuity-gaps-meta" class="notice"></div><div id="continuity-gaps"></div></div>
        <div><div class="section-head">证据材料</div><div id="continuity-evidence-meta" class="notice"></div><div id="continuity-evidence"></div></div>
        <div><div class="section-head">主体 AI 候选</div><div id="continuity-subject-candidates-meta" class="notice"></div><div id="continuity-subject-candidates"></div></div>
        <div><div class="section-head">后台代理候选</div><div id="continuity-background-candidates-meta" class="notice"></div><div id="continuity-background-candidates"></div></div>
        <div><div class="section-head">冻结的旧候选</div><div id="continuity-blocked-candidates-meta" class="notice"></div><div id="continuity-blocked-candidates"></div></div>
        <div><div class="section-head">Review 决策</div><div id="continuity-decisions-meta" class="notice"></div><div id="continuity-decisions"></div></div>
        <div><div class="section-head">已发布 Canon</div><div id="continuity-canon-meta" class="notice"></div><div id="continuity-canon"></div></div>
        <div><div class="section-head">520 配置变更事件</div><div id="continuity-config-events-meta" class="notice"></div><div id="continuity-config-events"></div></div>
      </div>
    </div>'''

OLD_LOAD_CONTINUITY = '''async function loadContinuity() {
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
}'''

NEW_LOAD_CONTINUITY = '''async function loadContinuity() {
  const [moduleRes, traceRes, layersRes] = await Promise.all([
    fetch('/api/module-state'),
    fetch('/api/context-trace?limit=30'),
    fetch('/api/continuity/layers?limit=30'),
  ]);
  const [moduleData, traceData, layersData] = await Promise.all([
    moduleRes.json(), traceRes.json(), layersRes.json(),
  ]);
  const modules = document.getElementById('continuity-modules'); modules.innerHTML = '';
  Object.entries(moduleData.modules || {}).forEach(([name, state]) => {
    const item = document.createElement('span'); item.className = 'module-state ' + state;
    item.textContent = name + ': ' + state; modules.appendChild(item);
  });
  await loadContextGates(modules);
  const nightly = document.getElementById('continuity-nightly');
  const modeText = {
    evidence: 'Evidence：自动补漏，零模型调用，零 Canon 写入',
    shadow: 'Shadow：自动生成候选与 Decision，但不写 Canon',
    auto: 'Auto：自动 Review 并由 History Writer 发布 Canon',
    invalid: '配置无效：Nightly 将拒绝运行',
  }[layersData.nightly_mode] || layersData.nightly_mode;
  nightly.textContent = '当前 Nightly 模式：' + modeText;
  renderContinuityRows('continuity-trace', traceData.rows || [], false);
  const targets = {
    gaps: 'continuity-gaps',
    evidence: 'continuity-evidence',
    subject_candidates: 'continuity-subject-candidates',
    background_candidates: 'continuity-background-candidates',
    blocked_candidates: 'continuity-blocked-candidates',
    decisions: 'continuity-decisions',
    canon: 'continuity-canon',
    config_events: 'continuity-config-events',
  };
  (layersData.layers || []).forEach(layer => {
    const targetId = targets[layer.key];
    if (!targetId) return;
    const meta = document.getElementById(targetId + '-meta');
    if (meta) meta.textContent = (layer.description || '') + ' 共 ' + (layer.count || 0) + ' 条。';
    renderContinuityRows(targetId, layer.rows || [], layer.key === 'decisions');
  });
}'''


def patch_continuity_page(page):
    patched = page
    if OLD_CONTINUITY_HTML not in patched:
        raise RuntimeError("legacy Continuity HTML marker changed")
    patched = patched.replace(OLD_CONTINUITY_HTML, NEW_CONTINUITY_HTML, 1)

    if OLD_LOAD_CONTINUITY not in patched:
        raise RuntimeError("legacy loadContinuity marker changed")
    patched = patched.replace(OLD_LOAD_CONTINUITY, NEW_LOAD_CONTINUITY, 1)

    patched = patched.replace(
        "['deferred', 'rejected'].includes(row.action)",
        "['deferred', 'rejected'].includes(row.result || row.action)",
        1,
    )
    patched = patched.replace("empty.textContent = 'No records.'", "empty.textContent = '暂无记录。'", 1)
    patched = patched.replace("button.textContent = 'Re-review'", "button.textContent = '异常重审'", 1)
    patched = patched.replace(
        "const AUTO_REFRESH_VIEWS = { health: loadHealth, injection: loadInjection, memorymap: loadMemoryMap, timeline: loadTimeline, octant: loadOctant, files: refreshFilesView };",
        "const AUTO_REFRESH_VIEWS = { health: loadHealth, continuity: loadContinuity, injection: loadInjection, memorymap: loadMemoryMap, timeline: loadTimeline, octant: loadOctant, files: refreshFilesView };",
        1,
    )
    return patched


legacy.PAGE = patch_continuity_page(legacy.PAGE)


class H(legacy.H):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/continuity/layers":
            try:
                raw_limit = parse_qs(parsed.query).get("limit", ["50"])[0]
                payload = build_continuity_layers(legacy.CONTINUITY_DIR, limit=raw_limit)
                prompt_events = legacy.read_jsonl(legacy.PROMPT_AUDIT_FILE)
                try:
                    bounded_limit = max(1, min(int(raw_limit), 200))
                except Exception:
                    bounded_limit = 50
                payload["layers"].append({
                    "key": "config_events",
                    "label": "520 配置变更事件",
                    "description": "从网页保存或恢复实际模型提示词时产生的审计记录。",
                    "count": len(prompt_events),
                    "rows": prompt_events[-bounded_limit:],
                })
                payload = legacy.normalize_display_value(payload)
                self._send(200, json.dumps(payload, ensure_ascii=False))
            except Exception as error:
                self._send(500, json.dumps({"err": str(error)}, ensure_ascii=False))
            return
        super().do_GET()


def _open_browser_if_enabled(url):
    disabled = os.environ.get("CYBERBOSS_DASHBOARD_NO_BROWSER", "").strip().lower()
    if disabled in {"1", "true", "yes", "on"}:
        return
    legacy._open_browser(url)


def main():
    if not legacy.ROOT.exists():
        legacy.safe_print(f"找不到 {legacy.ROOT} — 请确认 memory/ 文件夹在工作区根目录。")
        raise SystemExit(1)

    try:
        server = HTTPServer((legacy.HOST, legacy.PORT), H)
    except OSError:
        url = f"http://{legacy.HOST}:{legacy.PORT}"
        legacy.safe_print(f"端口 {legacy.PORT} 已被占用，520 可能已在运行：{url}")
        _open_browser_if_enabled(url)
        raise SystemExit(0)

    legacy.write_pid_file()
    atexit.register(legacy.remove_pid_file)
    try:
        legacy.start_auto_janitor_thread()
    except Exception as error:
        legacy.safe_print(f"Janitor 观察线程启动失败（不影响 520）：{error}")

    url = f"http://{legacy.HOST}:{legacy.PORT}"
    legacy.safe_print(f"520 Continuity layered view: {url}   (Ctrl+C 退出)")
    _open_browser_if_enabled(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        legacy.remove_pid_file()


if __name__ == "__main__":
    main()
