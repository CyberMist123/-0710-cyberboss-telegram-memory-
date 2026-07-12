#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Janitor S2 离线验收：只写 gap/evidence，不调用模型，不碰 canon。"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
JANITOR = KIT / "janitor.py"
sys.path.insert(0, str(KIT))
import extract_memory as em

PASS = 0
FAIL = 0


def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  [ok] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")


def run(args):
    env = dict(os.environ)
    env["JANITOR_MOCK"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    result = subprocess.run(
        [sys.executable, str(JANITOR)] + args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
    )
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr)
        raise RuntimeError(f"janitor 退出码 {result.returncode}")
    return result.stdout


def api_calls(stdout):
    match = re.search(r"api_calls=(\d+)", stdout)
    return int(match.group(1)) if match else -1


def turn(ts, role, text):
    return json.dumps({
        "type": role,
        "timestamp": ts,
        "message": {"content": text},
    }, ensure_ascii=False)


def turn_blocks(ts, role, text):
    return json.dumps({
        "type": role,
        "timestamp": ts,
        "message": {"content": [{"type": "text", "text": text}]},
    }, ensure_ascii=False)


def noise():
    return [
        json.dumps({"type": "user", "isMeta": True, "message": {"content": "meta 行"}}),
        json.dumps({"type": "assistant", "isSidechain": True, "message": {"content": "sidechain 行"}}),
        json.dumps({"type": "system", "subtype": "tool_result", "content": "工具输出"}),
        json.dumps({"type": "user", "timestamp": "2026-07-01T10:00:00Z", "message": {"content": "/status"}}),
        "这不是合法JSON",
    ]


def write_fixtures(input_dir):
    first = [
        turn("2026-07-01T05:08:00Z", "user", "1"),
        turn_blocks("2026-07-01T05:08:30Z", "assistant", "醒这么早,还是没睡?"),
        turn("2026-07-01T05:09:00Z", "user", "被抓到了"),
    ] + noise()
    second = [
        turn("2026-07-02T21:00:00Z", "user", "今天有点累,不想说话"),
        turn_blocks("2026-07-02T21:00:40Z", "assistant", "那就不说,我在。"),
    ]
    (input_dir / "session-aaa.jsonl").write_text("\n".join(first) + "\n", encoding="utf-8")
    (input_dir / "session-bbb.jsonl").write_text("\n".join(second) + "\n", encoding="utf-8")
    (input_dir / "session-ccc.jsonl").write_text("\n".join(noise()) + "\n", encoding="utf-8")


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def snapshot(root):
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def main():
    temp = Path(tempfile.mkdtemp(prefix="janitor_evidence_test_"))
    input_dir = temp / "sessions"
    outdir = temp / "continuity"
    input_dir.mkdir()
    outdir.mkdir()

    manual = outdir / "reentry.md"
    manual.write_text("手工 reentry,谁都不许动\n", encoding="utf-8")
    write_fixtures(input_dir)

    args = [f"--input={input_dir}", f"--outdir={outdir}"]
    gaps_path = outdir / "gaps" / "gaps.jsonl"
    evidence_path = outdir / "evidence" / "janitor.evidence.jsonl"
    candidate_path = outdir / "candidates" / "episodes.candidates.jsonl"
    state_path = outdir / ".janitor_state.json"

    print("== 1. dry-run：零调用、零写入 ==")
    before = snapshot(outdir)
    stdout = run(args + ["--dry-run"])
    check("dry-run api_calls=0", api_calls(stdout) == 0, stdout)
    check("dry-run 识别覆盖差异", "覆盖差异" in stdout and "session-aaa.jsonl" in stdout)
    check("dry-run 不写文件", snapshot(outdir) == before)

    print("== 2. 首跑：只写 gap/evidence ==")
    stdout = run(args)
    check("首跑仍为零 API", api_calls(stdout) == 0, stdout)
    check("gap 文件生成", gaps_path.exists())
    check("evidence 文件生成", evidence_path.exists())
    check("不生成 Candidate", not candidate_path.exists())

    gaps = read_jsonl(gaps_path)
    evidence = read_jsonl(evidence_path)
    gap_required = {"gap_id", "detected_at", "source_ref", "reason", "status", "idempotency_key"}
    evidence_required = {
        "evidence_id", "gap_id", "ts", "source_ref", "excerpt", "origin",
        "author_role", "context_scope", "semantic_authority", "idempotency_key",
    }
    check("两个有效会话各一条 gap", len(gaps) == 2, str(gaps))
    check("两个有效会话各一条 evidence", len(evidence) == 2, str(evidence))
    check("gap schema 完整", all(gap_required <= set(row) and row["gap_id"].startswith("gap-") for row in gaps))
    check("evidence schema 完整", all(evidence_required <= set(row) and row["evidence_id"].startswith("evidence-") for row in evidence))
    check("Janitor 明确无语义权限", all(
        row["origin"] == "janitor"
        and row["author_role"] == "extractor"
        and row["semantic_authority"] == "none"
        for row in evidence
    ))
    gap_ids = {row["gap_id"] for row in gaps}
    check("每条 evidence 指向 gap", all(row["gap_id"] in gap_ids for row in evidence))
    check("原始来源可定位", all(Path(row["source_ref"]["file"]).exists() and row["source_ref"]["window"] for row in evidence))

    state = json.loads(state_path.read_text(encoding="utf-8"))
    lines_aaa = len((input_dir / "session-aaa.jsonl").read_text(encoding="utf-8").splitlines())
    check("位点推进到实际行数", state["files"]["session-aaa.jsonl"]["lines_done"] == lines_aaa)
    check("纯噪音会话也推进位点", state["files"].get("session-ccc.jsonl", {}).get("lines_done", 0) > 0)
    check("手工 Re-entry 字节不变", manual.read_text(encoding="utf-8") == "手工 reentry,谁都不许动\n")

    print("== 3. 幂等：第二跑无新增 ==")
    gaps_before = gaps_path.read_bytes()
    evidence_before = evidence_path.read_bytes()
    stdout = run(args)
    check("第二跑 api_calls=0", api_calls(stdout) == 0, stdout)
    check("gap 字节不变", gaps_path.read_bytes() == gaps_before)
    check("evidence 字节不变", evidence_path.read_bytes() == evidence_before)
    check("仍无 Candidate", not candidate_path.exists())

    print("== 4. 增量：只为新增覆盖差异追加 ==")
    with open(input_dir / "session-aaa.jsonl", "a", encoding="utf-8") as handle:
        handle.write(turn("2026-07-03T02:00:00Z", "user", "又是我,刚崩了个窗口") + "\n")
        handle.write(turn_blocks("2026-07-03T02:00:30Z", "assistant", "回来了就好。") + "\n")
    (input_dir / "session-ddd.jsonl").write_text(
        turn("2026-07-04T09:00:00Z", "user", "新 session 的断档内容") + "\n"
        + turn_blocks("2026-07-04T09:00:20Z", "assistant", "收到。") + "\n",
        encoding="utf-8",
    )
    stdout = run(args)
    check("增量处理仍零 API", api_calls(stdout) == 0, stdout)
    check("新增两条 gap", len(read_jsonl(gaps_path)) == 4)
    check("新增两条 evidence", len(read_jsonl(evidence_path)) == 4)
    check("增量后仍无 Candidate", not candidate_path.exists())

    print("== 5. 产物白名单 ==")
    produced = set(snapshot(outdir)) - set(before)
    allowed = all(
        name in {".janitor_state.json", "gaps/gaps.jsonl", "evidence/janitor.evidence.jsonl"}
        for name in produced
    )
    check("没有越界写入 canon/候选/缓存", allowed, str(produced))

    print("== 6. 消费边界纯度 ==")
    polluted = """TELEGRAM SESSION INSTRUCTIONS
persona

<<<CB_CTX:REENTRY v1 hash=x chars=4>>>
旧回声
<<<END_CB_CTX>>>

Current user message:
此刻原话

Saved attachments:
- secret.png

Old Episode echo:
- 旧 Episode 正文"""
    cleaned = em.strip_prompt_artifacts(polluted)
    check("保留当前原话", "此刻原话" in cleaned, cleaned)
    check("剥除注入/附件/旧 Episode", all(
        token not in cleaned for token in ("旧回声", "secret.png", "旧 Episode 正文")
    ), cleaned)

    print(f"\n结果:{PASS} 通过,{FAIL} 失败(fixture 目录:<TMPDIR>)")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
