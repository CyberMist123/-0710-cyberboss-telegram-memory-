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
      <div class="notice">这里按时间显示系统刚刚做过什么：载入了哪些上下文、发现了什么材料、怎样处理候选、最终写进了什么。记忆正文请去“记忆数据”，这里不再按内部目录重复陈列。</div>
      <div class="view-stack">
        <div class="ctx-toolbar" id="continuity-filters">
          <button data-filter="all" onclick="filterContinuityFeed('all',this)">全部</button>
          <button class="ghost" data-filter="context" onclick="filterContinuityFeed('context',this)">上下文载入</button>
          <button class="ghost" data-filter="memory" onclick="filterContinuityFeed('memory',this)">记忆处理</button>
          <button class="ghost" data-filter="alert" onclick="filterContinuityFeed('alert',this)">断档与异常</button>
          <button class="ghost" data-filter="config" onclick="filterContinuityFeed('config',this)">配置变更</button>
        </div>
        <div id="continuity-feed"></div>
        <details class="advanced-details"><summary>运行模块与 Nightly 诊断</summary><div class="details-body"><div id="continuity-modules"></div><div id="continuity-nightly" class="notice"></div></div></details>
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

NEW_LOAD_CONTINUITY = '''let continuityFeedItems = [];

function continuityEventTarget(layer) {
  if (layer === 'trace') return 'continuity-trace';
  if (layer === 'gaps') return 'continuity-gaps';
  if (layer === 'evidence') return 'continuity-evidence';
  if (layer === 'decisions') return 'continuity-decisions';
  if (layer === 'canon') return 'continuity-canon';
  if (layer === 'config_events') return 'continuity-config-events';
  if (layer && layer.includes('candidates')) return 'continuity-' + layer.replace(/_/g, '-');
  return 'continuity-feed';
}

function continuityEventTime(row) {
  return row.ts || row.time || row.detected_at || row.created_at || row.updated_at || '';
}

function renderContinuityFeed(filter='all') {
  const host = document.getElementById('continuity-feed'); host.innerHTML = '';
  const items = continuityFeedItems.filter(item => filter === 'all' || item.category === filter).slice(0, 100);
  if (!items.length) { host.innerHTML = '<div class="continuity-row">暂无这一类事件。</div>'; return; }
  items.forEach(item => {
    const row = item.row || {};
    const box = document.createElement('div'); box.className = 'continuity-row';
    const isRoutineGroup = item.layer === 'trace_routine';
    const event = isRoutineGroup ? {
      title: '普通对话上下文 · ' + item.rows.length + ' 轮',
      meta: continuityEventTime(row) + ' · 最近线程 ' + (row.thread || '—'),
      body: '这些轮次只包含固定 Persona 与当前对话，没有额外记忆缝入；合并显示以免刷屏。',
    } : describeContinuityEvent(row, continuityEventTarget(item.layer));
    const title = document.createElement('div'); title.className = 'event-title'; title.textContent = event.title; box.appendChild(title);
    if (event.meta) { const meta = document.createElement('div'); meta.className = 'event-meta'; meta.textContent = event.meta; box.appendChild(meta); }
    if (event.body) {
      const body = document.createElement('div'); body.className = 'event-body';
      const bodyText = String(event.body); body.textContent = bodyText.length > 600 ? bodyText.slice(0, 600) + '…' : bodyText;
      box.appendChild(body);
    }
    const details = document.createElement('details'); const summary = document.createElement('summary');
    summary.textContent = isRoutineGroup ? '查看 ' + item.rows.length + ' 条轮次' : '原始记录'; details.appendChild(summary);
    const rawValue = isRoutineGroup
      ? item.rows.map(entry => ({ts:entry.ts, thread:entry.thread, turn:entry.turn, total_chars:entry.total_chars}))
      : row;
    let rawText = JSON.stringify(rawValue, null, 2);
    if (rawText.length > 8000) rawText = rawText.slice(0, 8000) + '\\n…完整底稿请在“文件”中查看。';
    const pre = document.createElement('pre'); pre.textContent = rawText; details.appendChild(pre); box.appendChild(details);
    if (item.layer === 'decisions' && ['deferred','rejected'].includes(row.result || row.action) && row.candidate_id) {
      const button = document.createElement('button'); button.className = 'ghost'; button.textContent = '异常重审';
      button.onclick = () => retryContinuityReview(row.candidate_id, button); box.appendChild(button);
    }
    host.appendChild(box);
  });
}

function filterContinuityFeed(filter, button) {
  document.querySelectorAll('#continuity-filters button').forEach(node => node.classList.toggle('ghost', node !== button));
  renderContinuityFeed(filter);
}

async function loadContinuity() {
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
  const traceRows = traceData.rows || [];
  const routineRows = traceRows.filter(row => !row.opening && !row.fallback && !(row.blocks || []).length && !(row.recall_calls || []).length);
  continuityFeedItems = traceRows
    .filter(row => !routineRows.includes(row))
    .map(row => ({row, layer:'trace', category:'context'}));
  if (routineRows.length) {
    routineRows.sort((a,b) => String(continuityEventTime(b)).localeCompare(String(continuityEventTime(a))));
    continuityFeedItems.push({row:routineRows[0], rows:routineRows, layer:'trace_routine', category:'context'});
  }
  (layersData.layers || []).forEach(layer => {
    const category = layer.key === 'gaps' ? 'alert' : (layer.key === 'config_events' ? 'config' : 'memory');
    (layer.rows || []).forEach(row => continuityFeedItems.push({row, layer:layer.key, category}));
  });
  continuityFeedItems.sort((a,b) => String(continuityEventTime(b.row)).localeCompare(String(continuityEventTime(a.row))));
  renderContinuityFeed('all');
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
