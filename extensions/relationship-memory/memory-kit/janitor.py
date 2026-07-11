#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
janitor.py — 断档补记(WO-1)

closeout 依赖每晚 pass;白天 /new、崩窗、忘了收尾,session 会静默丢失。
本脚本在醒来前(或手动)跑一次:扫会话 jsonl,对比上次处理位点,
把断档内容增量提取成**候选文件**,绝不直接改 memory/ 下任何手工文件。

产出:
  continuity/candidates/episodes.candidates.jsonl   追加式 Phase 3 candidate schema

位点:memory/.janitor_state.json 记录每个 session 文件已处理的行数
(会话 jsonl 只追加,行数单调递增;若发现文件变短则视为重写,从头重处理)。

幂等:位点 + 内容哈希缓存(memory/.cache/janitor_*.json)双保险,
连跑两次第二次零 API 调用;中途断掉重跑也不重复计费。

用法:
  python janitor.py --input <CLAUDE_TRANSCRIPT_DIR> --outdir <MEMORY_DIR> --dry-run
  python janitor.py --input <CLAUDE_TRANSCRIPT_DIR> --outdir <MEMORY_DIR>
  set JANITOR_MOCK=1                     测试用:不打真 API,返回固定 JSON

环境变量:DS_API_KEY / DS_BASE_URL / DS_MODEL 同 extract_memory.py;
JANITOR_MOCK=1 时不需要 key。
"""
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 复用 extract_memory 的解析/分块/提示词/API 逻辑
sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_memory as em

DEFAULT_INPUT = os.environ.get("CYBERBOSS_CLAUDE_TRANSCRIPT_DIR", "")
DEFAULT_OUTDIR = os.environ.get("CYBERBOSS_MEMORY_DIR", "")

MOCK = os.environ.get("JANITOR_MOCK") == "1"

# JANITOR_MOCK=1 时 API 返回的固定 JSON(结构同 PASS1 输出)
MOCK_RESPONSE = json.dumps({
    "episodes": [{
        "title": "mock:断档补记测试片段",
        "time": "2026-07-05",
        "what_happened": "这是 mock 模式生成的固定测试内容,不是真实提取。",
        "why_it_mattered": "用于验证 janitor 的断档检测/位点/幂等,不代表真实关系事件。",
        "shift": None,
        "misread_repair": None,
        "anchor_quotes": ["mock quote"],
        "future_effect": "无(测试数据)",
        "importance": 3,
    }],
    "voice_user": [],
    "voice_ai": [],
    "callings": [],
    "memes": [],
    "taboos": [],
    "ai_state": [{"time": "2026-07-05", "state": "mock 状态行"}],
}, ensure_ascii=False)

API_CALLS = 0  # 本次运行真实(或 mock)调用次数,幂等验收看它


def chat(prompt):
    global API_CALLS
    API_CALLS += 1
    if MOCK:
        return MOCK_RESPONSE
    return em.chat(prompt)


# ---------------- 位点 ----------------

def load_state(state_path: Path):
    if state_path.exists():
        try:
            return json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            print(f"[warn] 位点文件损坏,视为从零开始:{state_path}")
    return {"version": 1, "files": {}}


def save_state(state_path: Path, state):
    state["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    tmp = state_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(state_path)


# ---------------- 断档扫描 ----------------

def find_gaps(input_dir: Path, state):
    """返回 [{name, total_lines, lines_done, new_lines, turns}],turns 为新增对话轮。"""
    gaps = []
    files = sorted(input_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    for f in files:
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception as e:
            print(f"[skip] {f.name}: {e}")
            continue
        rec = state["files"].get(f.name, {})
        done = int(rec.get("lines_done", 0))
        if done > len(lines):
            # 文件被重写/截断:位点失效,从头重处理(缓存兜底不重复计费)
            print(f"[warn] {f.name} 比上次记录短({len(lines)} < {done}),从头重处理")
            done = 0
        new_lines = lines[done:]
        turns = []
        for line in new_lines:
            t = em.turn_from_line(line)
            if t is not None:
                turns.append(t)
        gaps.append({
            "name": f.name,
            "total_lines": len(lines),
            "lines_done": done,
            "new_lines": len(new_lines),
            "turns": turns,
        })
    return gaps


# ---------------- 增量提取 ----------------

def chunk_key(name, chunk):
    return hashlib.sha1((name + "\n" + chunk).encode("utf-8")).hexdigest()[:16]


def extract_chunk(cache_dir: Path, name, chunk):
    """带内容哈希缓存的单块提取;命中缓存则零 API 调用。"""
    key = chunk_key(name, chunk)
    cf = cache_dir / f"janitor_{key}.json"
    if cf.exists():
        try:
            return json.loads(cf.read_text(encoding="utf-8")), key
        except Exception:
            pass  # 缓存坏了就重新提
    raw = chat(em.PASS1_PROMPT.replace("<<<CHUNK>>>", chunk))
    try:
        data = em.parse_json(raw)
    except Exception:
        print("  [warn] JSON 解析失败,该块记空结果")
        data = {}
    data["_source"] = name
    cf.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return data, key


# ---------------- 候选输出 ----------------

def load_existing_candidate_ids(path: Path):
    ids = set()
    if path.exists():
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
                ids.add(item.get("candidate_id") or item.get("id", ""))
            except Exception:
                continue
    return ids


def append_candidates(path: Path, episodes):
    """追加候选 episode,id=cand-<块哈希>-<序号>,已存在的 id 跳过(幂等)。"""
    existing = load_existing_candidate_ids(path)
    added = 0
    with open(path, "a", encoding="utf-8") as f:
        for e in episodes:
            candidate_id = e.get("candidate_id") or e.get("id", "")
            if candidate_id in existing:
                continue
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
            existing.add(candidate_id)
            added += 1
    return added


def episode_body(entry):
    parts = []
    anchor = str(entry.get("time") or "").strip()
    title = str(entry.get("title") or "").strip()
    happened = str(entry.get("what_happened") or "").strip()
    if anchor or title:
        parts.append(f"{anchor} {title}".strip() + "。")
    if happened:
        parts.append(happened.rstrip("。") + "。")
    quotes = [str(q).strip() for q in (entry.get("anchor_quotes") or []) if str(q).strip()]
    if quotes:
        parts.append("转折处的原话是：“" + "”“".join(quotes[:2]) + "”。")
    shift = str(entry.get("shift") or entry.get("misread_repair") or "").strip()
    if shift:
        parts.append(shift.rstrip("。") + "。")
    return "".join(parts).strip()


def make_candidate(entry, source_name, source_window, chunk_hash, index):
    body = episode_body(entry)
    source_ref = {"file": source_name, "window": source_window}
    idem_seed = f"{entry.get('time','')}\n{source_name}:{source_window}\n{' '.join(body.split())}"
    idem = hashlib.sha256(idem_seed.encode("utf-8")).hexdigest()
    return {
        "candidate_id": f"cand-{chunk_hash[:8]}-{index}",
        "ts": str(entry.get("time") or time.strftime("%Y-%m-%d")),
        "type": "episode",
        "author": "janitor",
        "body": body,
        "source_ref": source_ref,
        "idempotency_key": idem,
    }


# ---------------- 主流程 ----------------

def main():
    ap = argparse.ArgumentParser(description="断档补记:增量提取,只写候选文件")
    ap.add_argument("--input", default=DEFAULT_INPUT,
                    help="会话 jsonl 目录(.claude/projects/ 下那个)")
    ap.add_argument("--outdir", default=DEFAULT_OUTDIR,
                    help="memory 目录(位点/缓存/候选文件都在这里)")
    ap.add_argument("--dry-run", action="store_true",
                    help="只报告断档规模,不调 API,不写任何文件")
    args = ap.parse_args()

    if not str(args.input or "").strip():
        print("缺少 --input 或 CYBERBOSS_CLAUDE_TRANSCRIPT_DIR,拒绝猜测会话目录。")
        sys.exit(1)
    input_dir = Path(args.input)
    if not input_dir.is_dir():
        print(f"输入目录不存在:{input_dir}")
        sys.exit(1)
    if not str(args.outdir or "").strip():
        print("缺少 --outdir 或 CYBERBOSS_MEMORY_DIR,拒绝猜测 memory 目录。")
        sys.exit(1)
    outdir = Path(args.outdir)
    state_path = outdir / ".janitor_state.json"
    cache_dir = outdir / ".cache"
    cand_path = outdir / "candidates" / "episodes.candidates.jsonl"

    state = load_state(state_path)
    gaps = find_gaps(input_dir, state)

    dirty = [g for g in gaps if g["turns"]]
    sessions = [(g["name"], g["turns"]) for g in dirty]
    chunks = em.make_chunks(sessions)
    total_chars = sum(len(c) for _, c in chunks)

    print(f"[janitor] 会话文件 {len(gaps)} 个,断档 {len(dirty)} 个,"
          f"新增 {sum(g['new_lines'] for g in gaps)} 行 / "
          f"{sum(len(g['turns']) for g in gaps)} 轮,分块 {len(chunks)} 块,"
          f"约 {total_chars} 字")
    for g in gaps:
        if g["new_lines"] > 0:
            print(f"  - {g['name']}: 第 {g['lines_done']} 行起新增 {g['new_lines']} 行,"
                  f"有效对话 {len(g['turns'])} 轮")

    if args.dry_run:
        print(f"[janitor] dry-run,不调 API,不写文件。api_calls={API_CALLS}")
        return

    if not MOCK and os.environ.get("CYBERBOSS_WRITER_LEASE_HELD") != "1":
        print("缺少受控 writer lease;请通过 continuity:phase3 janitor 入口运行。")
        sys.exit(1)

    if not MOCK and chunks and not em.API_KEY:
        print(f"请先配置 API key(当前 provider={em.PROVIDER};GLM_API_KEY / DS_API_KEY 或 memory-kit/keys.local.json;或用 JANITOR_MOCK=1 测试)")
        sys.exit(1)

    outdir.mkdir(parents=True, exist_ok=True)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cand_path.parent.mkdir(parents=True, exist_ok=True)

    new_eps, ai_states = [], []
    per_file_ok = {g["name"]: True for g in dirty}
    for i, (name, chunk) in enumerate(chunks):
        print(f"[{i+1}/{len(chunks)}] {name}")
        try:
            data, key = extract_chunk(cache_dir, name, chunk)
        except Exception as e:
            print(f"  [error] 该块提取失败:{e};此文件位点不推进,下次重试")
            per_file_ok[name] = False
            continue
        gap = next((item for item in gaps if item["name"] == name), None) or {}
        source_window = f"{int(gap.get('lines_done', 0)) + 1}-{int(gap.get('total_lines', 0))}"
        for j, e in enumerate(data.get("episodes", []) or []):
            candidate = make_candidate(e, str(input_dir / name), source_window, key, j)
            if candidate["body"]:
                new_eps.append(candidate)
        ai_states += data.get("ai_state", []) or []

    added = append_candidates(cand_path, new_eps)

    # 推进位点:只推进本次全部块都成功的文件
    for g in gaps:
        if g["new_lines"] == 0:
            continue
        if not per_file_ok.get(g["name"], True):
            continue
        state["files"][g["name"]] = {
            "lines_done": g["total_lines"],
            "updated": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
    save_state(state_path, state)

    print(f"[janitor] 完成:候选片段新增 {added} 条 → {cand_path}")
    print(f"[janitor] api_calls={API_CALLS}")


if __name__ == "__main__":
    main()
