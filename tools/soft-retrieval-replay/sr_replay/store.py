"""SQLite 存储、指标计算、report / compare（含冻结集可见性规则）。

表结构与 HARNESS §4 一致。NONE 率是分层诊断指标，不设统一目标（SPEC R3）。
本地盘走 WAL；不支持 WAL 锁的挂载盘自动降级 DELETE 模式。

冻结集判定（is_frozen）读 case-set 里每条 case 自带的 case_set_frozen
元数据字段，不依赖 cases 文件名——文件名可以被改名绕过或误判。

`meta.json` 是加载时使用的完整性 manifest；`index_versions` 只保留构建与审计留痕，
不参与当前加载过程的联合校验。
"""

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS shadow_runs (
  run_id TEXT, case_id TEXT, ts TEXT,
  conversation_snapshot_hash TEXT,
  episode_canon_version TEXT, embedding_model TEXT, index_version TEXT,
  retrieval_config_version TEXT, admission_prompt_version TEXT,
  admission_model TEXT, response_model TEXT,
  delivery_schema_version TEXT,
  input_payload_json TEXT,
  decision TEXT, selected_episode_id TEXT, delivery_payload_json TEXT,
  violations TEXT, raw_output TEXT,
  PRIMARY KEY (run_id, case_id)
);
CREATE TABLE IF NOT EXISTS retrieval_candidates (
  run_id TEXT, case_id TEXT, episode_id TEXT,
  rank INTEGER, fusion_score REAL, vector_score REAL, bm25_score REAL,
  admitted INTEGER, reject_reason TEXT, why_now TEXT,
  would_request_full_text INTEGER,
  PRIMARY KEY (run_id, case_id, episode_id)
);
CREATE TABLE IF NOT EXISTS verified_cases (
  case_id TEXT PRIMARY KEY,
  verified_mode TEXT, verified_positive_ids TEXT, verified_negative_ids TEXT,
  verdict_source TEXT, note TEXT, verified_at TEXT
);
CREATE TABLE IF NOT EXISTS eval_runs (
  run_id TEXT PRIMARY KEY, config_hash TEXT, cases_file TEXT,
  none_rate_by_type TEXT, hit_at_5 REAL, hit_at_10 REAL,
  block_rate REAL, admit_rate REAL, mode_accuracy REAL,
  payload_violation_rate REAL, concentration_top1 REAL, created_at TEXT
);
CREATE TABLE IF NOT EXISTS index_versions (
  index_version TEXT PRIMARY KEY, embedding_model TEXT,
  episode_count INTEGER, built_at TEXT, episodes_snapshot_hash TEXT
);
"""


def open_db(workdir: str) -> sqlite3.Connection:
    Path(workdir).mkdir(parents=True, exist_ok=True)
    db = str(Path(workdir) / "soft_retrieval.sqlite")
    conn = sqlite3.connect(db)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
    except sqlite3.OperationalError:
        conn.close()
        conn = sqlite3.connect(db)
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.executescript(SCHEMA)
    return conn


def is_frozen(cases: list[dict]) -> bool:
    """冻结集判定：读 case-set 自带的元数据字段，不依赖文件名（HARNESS §7）。

    旧版本靠 cases 文件名里有没有 "test_cases" 字符串判断，这个判断可以被
    文件改名绕过（冻结集换个名字就能看到逐案例明细），也可能被误判（dev
    集恰好叫成含 test_cases 的名字就被错误保护）。新版本要求每条 case 自
    带 case_set_frozen 字段；只要有任意一条声明为 true，整份就按冻结集处
    理（宁可多保护、不可少保护——载荷可见性是隐私边界，默认从严）。
    """
    return any(bool(c.get("case_set_frozen")) for c in cases)


# ---------------------------------------------------------------- 指标

def compute_metrics(conn, run_id: str, cases: list[dict]) -> dict:
    by_id = {c["case_id"]: c for c in cases}
    rows = conn.execute(
        "SELECT case_id, decision, selected_episode_id, violations FROM shadow_runs WHERE run_id=?",
        (run_id,)).fetchall()
    cand = {}
    for cid, eid, rank, admitted in conn.execute(
            "SELECT case_id, episode_id, rank, admitted FROM retrieval_candidates WHERE run_id=?",
            (run_id,)):
        cand.setdefault(cid, {})[eid] = (rank, admitted)

    none_by_type, type_totals = {}, {}
    hit5 = hit10 = pos_total = 0
    admitted_pos = 0
    neg_total = neg_blocked = 0
    mode_ok = 0
    payload_attempted = payload_violated = 0
    admit_count_by_ep: dict[str, int] = {}

    for cid, decision, selected, violations in rows:
        case = by_id.get(cid)
        if case is None:
            continue
        t = case.get("case_type", "?")
        type_totals[t] = type_totals.get(t, 0) + 1
        if decision == "NONE":
            none_by_type[t] = none_by_type.get(t, 0) + 1
        if decision == case.get("expected_mode"):
            mode_ok += 1
        viol = json.loads(violations or "[]")
        if viol and "json_parse_failed" not in viol:
            payload_violated += 1
        if decision != "NONE" or viol:
            payload_attempted += 1
        if selected:
            admit_count_by_ep[selected] = admit_count_by_ep.get(selected, 0) + 1
        for pid in case.get("positive_ids", []):
            pos_total += 1
            info = cand.get(cid, {}).get(pid)
            if info:
                if info[0] <= 5:
                    hit5 += 1
                if info[0] <= 10:
                    hit10 += 1
                if info[1]:
                    admitted_pos += 1
        for nid in case.get("negative_ids", []):
            neg_total += 1
            info = cand.get(cid, {}).get(nid)
            if not info or not info[1]:
                neg_blocked += 1

    n = len(rows) or 1
    total_admits = sum(admit_count_by_ep.values())
    return {
        "cases": len(rows),
        "none_rate_by_type": {
            t: round(none_by_type.get(t, 0) / c, 3) for t, c in sorted(type_totals.items())},
        "hit_at_5": round(hit5 / pos_total, 3) if pos_total else None,
        "hit_at_10": round(hit10 / pos_total, 3) if pos_total else None,
        "admit_rate": round(admitted_pos / pos_total, 3) if pos_total else None,
        "block_rate": round(neg_blocked / neg_total, 3) if neg_total else None,
        "mode_accuracy": round(mode_ok / n, 3),
        "payload_violation_rate": round(payload_violated / payload_attempted, 3)
        if payload_attempted else 0.0,
        "concentration_top1": round(max(admit_count_by_ep.values()) / total_admits, 3)
        if total_admits else 0.0,
    }


# ---------------------------------------------------------------- 报告

def report(conn, run_id: str, cases: list[dict], cases_file: str = "") -> str:
    m = compute_metrics(conn, run_id, cases)
    lines = [f"== report {run_id} ==", json.dumps(m, ensure_ascii=False, indent=2)]
    if is_frozen(cases):
        lines.append("[冻结集] 只输出聚合分数（HARNESS §7）。")
        return "\n".join(lines)
    by_id = {c["case_id"]: c for c in cases}
    for cid, decision, selected in conn.execute(
            "SELECT case_id, decision, selected_episode_id FROM shadow_runs "
            "WHERE run_id=? ORDER BY case_id", (run_id,)):
        exp = by_id.get(cid, {}).get("expected_mode", "?")
        mark = "OK " if decision == exp else "DIFF"
        lines.append(f"  [{mark}] {cid}: expected={exp} got={decision} selected={selected}")
    return "\n".join(lines)


def compare(conn, run_a: str, run_b: str, cases: list[dict], cases_file: str = "") -> str:
    ma = compute_metrics(conn, run_a, cases)
    mb = compute_metrics(conn, run_b, cases)
    lines = [f"== compare {run_a} vs {run_b} ==",
             f"A: {json.dumps(ma, ensure_ascii=False)}",
             f"B: {json.dumps(mb, ensure_ascii=False)}"]
    if is_frozen(cases):
        lines.append("[冻结集] 不输出逐案例差异（HARNESS §7）。")
        return "\n".join(lines)
    a_rows = dict(conn.execute(
        "SELECT case_id, decision FROM shadow_runs WHERE run_id=?", (run_a,)).fetchall())
    b_rows = dict(conn.execute(
        "SELECT case_id, decision FROM shadow_runs WHERE run_id=?", (run_b,)).fetchall())
    diffs = [cid for cid in sorted(set(a_rows) | set(b_rows))
             if a_rows.get(cid) != b_rows.get(cid)]
    lines.append(f"结论不同的案例（{len(diffs)}）——这是最有信息量的部分：")
    for cid in diffs:
        lines.append(f"  {cid}: A={a_rows.get(cid)} B={b_rows.get(cid)}")
    return "\n".join(lines)
