#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
janitor.py — 断档发现与证据保全

Janitor 只处理技术覆盖问题：扫描尚未处理的会话行，写入 Gap Record 和
Evidence Packet。它不判断关系意义，不调用模型，不生成可发布 Episode
Candidate，也不写任何 canon / Re-entry / Self-note。

产出（全部在 --outdir）：
  gaps/gaps.jsonl
  evidence/janitor.evidence.jsonl
  .janitor_state.json

幂等：位点 + 稳定 ID。重复运行不会重复写 gap/evidence；无新增内容时
api_calls 始终为 0。
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_memory as em

DEFAULT_INPUT = os.environ.get("CYBERBOSS_CLAUDE_TRANSCRIPT_DIR", "")
DEFAULT_OUTDIR = os.environ.get("CYBERBOSS_MEMORY_DIR", "")
MOCK = os.environ.get("JANITOR_MOCK") == "1"
API_CALLS = 0  # Janitor S2 起不调用模型；保留计数用于运维与回归断言。


def now_text():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def sha256(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def stable_id(prefix, seed, length=20):
    return f"{prefix}-{sha256(seed)[:length]}"


# ---------------- 位点 ----------------

def load_state(state_path: Path):
    if state_path.exists():
        try:
            parsed = json.loads(state_path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict) and isinstance(parsed.get("files"), dict):
                return parsed
        except Exception:
            print(f"[warn] 位点文件损坏,视为从零开始:{state_path}")
    return {"version": 2, "files": {}}


def save_state(state_path: Path, state):
    state["version"] = 2
    state["last_run"] = now_text()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(state_path)


# ---------------- 断档扫描 ----------------

def find_gaps(input_dir: Path, state):
    """返回会话覆盖差异；turns 只含可用对话，不含工具/元数据噪音。"""
    gaps = []
    files = sorted(input_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    for file_path in files:
        try:
            lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception as exc:
            print(f"[skip] {file_path.name}: {exc}")
            continue
        record = state["files"].get(file_path.name, {})
        done = int(record.get("lines_done", 0))
        if done > len(lines):
            print(f"[warn] {file_path.name} 比上次记录短({len(lines)} < {done}),从头重处理")
            done = 0
        new_lines = lines[done:]
        turns = []
        for line in new_lines:
            turn = em.turn_from_line(line)
            if turn is not None:
                turns.append(turn)
        gaps.append({
            "name": file_path.name,
            "file": str(file_path),
            "total_lines": len(lines),
            "lines_done": done,
            "new_lines": len(new_lines),
            "turns": turns,
        })
    return gaps


def source_ref_for(gap):
    return {
        "file": gap["file"],
        "window": f"{gap['lines_done'] + 1}-{gap['total_lines']}",
    }


def make_gap_record(gap):
    source_ref = source_ref_for(gap)
    idem = sha256(f"gap\n{source_ref['file']}:{source_ref['window']}")
    return {
        "gap_id": f"gap-{idem[:20]}",
        "detected_at": now_text(),
        "source_ref": source_ref,
        "reason": "legacy_uncovered",
        "status": "pending",
        "idempotency_key": idem,
    }


def make_evidence_packet(gap, gap_record, chunk, index):
    clean = em.strip_prompt_artifacts(str(chunk or "")).strip()
    if not clean:
        return None
    source_ref = source_ref_for(gap)
    idem = sha256(
        f"evidence\n{gap_record['gap_id']}\n{source_ref['file']}:{source_ref['window']}\n"
        f"{' '.join(clean.split())}\n{index}"
    )
    return {
        "evidence_id": f"evidence-{idem[:20]}",
        "gap_id": gap_record["gap_id"],
        "ts": now_text(),
        "source_ref": source_ref,
        "excerpt": clean,
        "origin": "janitor",
        "author_role": "extractor",
        "context_scope": "isolated_chunk",
        "semantic_authority": "none",
        "idempotency_key": idem,
    }


# ---------------- 追加式幂等存储 ----------------

def load_existing_ids(path: Path, id_field):
    ids = set()
    if not path.exists():
        return ids
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except Exception:
            continue
        value = str(item.get(id_field) or "").strip()
        if value:
            ids.add(value)
    return ids


def append_unique(path: Path, rows, id_field):
    rows = [row for row in rows if isinstance(row, dict) and row.get(id_field)]
    if not rows:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = load_existing_ids(path, id_field)
    added = 0
    with open(path, "a", encoding="utf-8") as handle:
        for row in rows:
            row_id = str(row[id_field])
            if row_id in existing:
                continue
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            existing.add(row_id)
            added += 1
    return added


# ---------------- 主流程 ----------------

def main():
    parser = argparse.ArgumentParser(description="断档发现:只写 gap/evidence,不调用模型")
    parser.add_argument("--input", default=DEFAULT_INPUT, help="会话 jsonl 目录")
    parser.add_argument("--outdir", default=DEFAULT_OUTDIR, help="continuity 输出目录")
    parser.add_argument("--dry-run", action="store_true", help="只报告,不写文件")
    args = parser.parse_args()

    if not str(args.input or "").strip():
        print("缺少 --input 或 CYBERBOSS_CLAUDE_TRANSCRIPT_DIR,拒绝猜测会话目录。")
        sys.exit(1)
    input_dir = Path(args.input)
    if not input_dir.is_dir():
        print(f"输入目录不存在:{input_dir}")
        sys.exit(1)
    if not str(args.outdir or "").strip():
        print("缺少 --outdir 或 CYBERBOSS_MEMORY_DIR,拒绝猜测输出目录。")
        sys.exit(1)

    outdir = Path(args.outdir)
    state_path = outdir / ".janitor_state.json"
    gaps_path = outdir / "gaps" / "gaps.jsonl"
    evidence_path = outdir / "evidence" / "janitor.evidence.jsonl"

    state = load_state(state_path)
    scanned = find_gaps(input_dir, state)
    dirty = [gap for gap in scanned if gap["new_lines"] > 0]
    semantic_gaps = [gap for gap in dirty if gap["turns"]]
    chunks = em.make_chunks([(gap["name"], gap["turns"]) for gap in semantic_gaps])

    print(
        f"[janitor] 会话文件 {len(scanned)} 个,覆盖差异 {len(dirty)} 个,"
        f"有效对话断档 {len(semantic_gaps)} 个,新增 {sum(g['new_lines'] for g in dirty)} 行,"
        f"证据分块 {len(chunks)} 个"
    )
    for gap in dirty:
        print(
            f"  - {gap['name']}: 第 {gap['lines_done'] + 1}-{gap['total_lines']} 行,"
            f"有效对话 {len(gap['turns'])} 轮"
        )

    if args.dry_run:
        print(f"[janitor] dry-run,不调 API,不写文件。api_calls={API_CALLS}")
        return

    if not MOCK and os.environ.get("CYBERBOSS_WRITER_LEASE_HELD") != "1":
        print("缺少受控 writer lease;请通过 continuity:phase3 janitor 入口运行。")
        sys.exit(1)

    gap_records = {gap["name"]: make_gap_record(gap) for gap in semantic_gaps}
    evidence_rows = []
    per_name_index = {}
    by_name = {gap["name"]: gap for gap in semantic_gaps}
    for name, chunk in chunks:
        gap = by_name.get(name)
        if not gap:
            continue
        index = per_name_index.get(name, 0)
        per_name_index[name] = index + 1
        packet = make_evidence_packet(gap, gap_records[name], chunk, index)
        if packet:
            evidence_rows.append(packet)

    # 先写证据，再推进位点。任何写入异常都会阻止 state 更新，便于下次重试。
    gap_added = append_unique(gaps_path, list(gap_records.values()), "gap_id")
    evidence_added = append_unique(evidence_path, evidence_rows, "evidence_id")

    for gap in dirty:
        state["files"][gap["name"]] = {
            "lines_done": gap["total_lines"],
            "updated": now_text(),
        }
    save_state(state_path, state)

    print(f"[janitor] 完成:gap 新增 {gap_added} 条 → {gaps_path}")
    print(f"[janitor] 完成:evidence 新增 {evidence_added} 条 → {evidence_path}")
    print("[janitor] Candidate 新增 0 条;Janitor 无语义发布权。")
    print(f"[janitor] api_calls={API_CALLS}")


if __name__ == "__main__":
    main()
