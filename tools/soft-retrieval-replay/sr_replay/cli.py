"""CLI：index / run / report / compare。执行完即退出，无常驻进程。"""

import argparse
import datetime
import hashlib
import json
import sys
from pathlib import Path

import yaml

from . import DELIVERY_SCHEMA_VERSION
from .admission import (build_input_payload, load_prompt, make_admission,
                        validate_and_gate, FixtureAdmission)
from .core import Index, file_sha256, make_embedder
from .store import compare, compute_metrics, open_db, report
from .textproc import Tokenizer

TOOL_ROOT = Path(__file__).resolve().parent.parent


def load_env() -> dict:
    """读 tools/soft-retrieval-replay/.env（gitignore 覆盖），不打印任何值。"""
    env = {}
    p = TOOL_ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def load_config(path: str) -> tuple[dict, str]:
    raw = Path(path).read_text(encoding="utf-8")
    cfg = yaml.safe_load(raw)
    base = Path(path).resolve().parent
    paths = cfg.get("paths", {})
    for k, v in list(paths.items()):
        if v and not Path(v).is_absolute():
            paths[k] = str((base / v).resolve())
    cfg_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return cfg, cfg_hash


def load_cases(path: str) -> list[dict]:
    cases = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            cases.append(json.loads(line))
    return cases


def make_tokenizer(cfg: dict) -> Tokenizer:
    t = cfg.get("tokenizer", {})
    ud = t.get("user_dict")
    if ud and not Path(ud).is_absolute():
        ud = str(TOOL_ROOT / ud)
    return Tokenizer(t.get("backend", "builtin"), ud)


def _admission_provider(cfg: dict, env: dict, fixture_queue):
    if fixture_queue is not None:
        return FixtureAdmission(fixture_queue)
    return make_admission(cfg.get("admission", {}), env)


def cmd_index(args):
    cfg, _ = load_config(args.config)
    env = load_env()
    tok = make_tokenizer(cfg)
    embedder = make_embedder(cfg.get("embedding", {}), tok, env)
    episodes = args.episodes or cfg["paths"]["episodes_snapshot"]
    idx = Index.build(episodes, cfg, tok, embedder, cfg["paths"]["workdir"])
    conn = open_db(cfg["paths"]["workdir"])
    conn.execute(
        "INSERT OR REPLACE INTO index_versions VALUES (?,?,?,?,?)",
        (idx.meta["index_version"], idx.meta["embedding_model"],
         idx.meta["episode_count"], datetime.datetime.now().isoformat(),
         idx.meta["episodes_snapshot_hash"]))
    conn.commit()
    print(f"index built: version={idx.meta['index_version']} "
          f"model={idx.meta['embedding_model']} episodes={idx.meta['episode_count']}")


def run_cases(cfg: dict, cfg_hash: str, cases_path: str, run_id: str,
              fixture_queue=None) -> dict:
    """核心执行；返回指标。fixture_queue 供测试注入原始输出。"""
    env = load_env()
    tok = make_tokenizer(cfg)
    embedder = make_embedder(cfg.get("embedding", {}), tok, env)
    idx = Index.load(cfg["paths"]["workdir"], embedder.model_name, tok)
    admission = _admission_provider(cfg, env, fixture_queue)
    prompt_path = cfg["admission"].get("prompt_path", "prompts/admission_v0_1.txt")
    if not Path(prompt_path).is_absolute():
        prompt_path = str(TOOL_ROOT / prompt_path)
    prompt_text = load_prompt(prompt_path)
    cases = load_cases(cases_path)
    conn = open_db(cfg["paths"]["workdir"])
    r_cfg = cfg.get("retrieval", {})

    for case in cases:
        query = case["query"]
        context = case.get("context", [])
        explicit = case.get("case_type") == "explicit_recall" or "记得" in query
        candidates = idx.search(query, r_cfg, embedder)
        input_payload = build_input_payload(context, query, explicit,
                                            candidates, idx.episodes)
        raw = admission.judge(input_payload, prompt_text)
        gated = validate_and_gate(raw, idx.episodes, tok.words,
                                  case.get("payload_must_not_contain"))
        per = {c.get("episode_id"): c for c in gated["per_candidate"]
               if isinstance(c, dict)}
        conn.execute(
            "INSERT OR REPLACE INTO shadow_runs VALUES "
            "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, case["case_id"], datetime.datetime.now().isoformat(),
             hashlib.sha256(json.dumps(context + [query], ensure_ascii=False)
                            .encode("utf-8")).hexdigest()[:16],
             idx.meta["episodes_snapshot_hash"][:16], idx.meta["embedding_model"],
             idx.meta["index_version"], cfg_hash,
             cfg["admission"].get("prompt_version", "v0.1-draft"),
             admission.model_name, None, DELIVERY_SCHEMA_VERSION,
             json.dumps(input_payload, ensure_ascii=False),
             gated["decision"], gated["selected_episode_id"],
             json.dumps(gated["delivery_payload"], ensure_ascii=False)
             if gated["delivery_payload"] else None,
             json.dumps(gated["violations"], ensure_ascii=False),
             gated["raw_output"]))
        for c in candidates:
            pc = per.get(c["episode_id"], {})
            admitted = 1 if (gated["selected_episode_id"] == c["episode_id"]) else 0
            conn.execute(
                "INSERT OR REPLACE INTO retrieval_candidates VALUES "
                "(?,?,?,?,?,?,?,?,?,?,?)",
                (run_id, case["case_id"], c["episode_id"], c["rank"],
                 c["fusion_score"], c["vector_score"], c["bm25_score"], admitted,
                 pc.get("reject_reason"), pc.get("why_now"),
                 1 if pc.get("would_request_full_text") else 0))
    m = compute_metrics(conn, run_id, cases)
    conn.execute(
        "INSERT OR REPLACE INTO eval_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, cfg_hash, str(cases_path),
         json.dumps(m["none_rate_by_type"], ensure_ascii=False),
         m["hit_at_5"], m["hit_at_10"], m["block_rate"], m["admit_rate"],
         m["mode_accuracy"], m["payload_violation_rate"],
         m["concentration_top1"], datetime.datetime.now().isoformat()))
    conn.commit()
    conn.close()
    return m


def cmd_run(args):
    cfg, cfg_hash = load_config(args.config)
    m = run_cases(cfg, cfg_hash, args.cases, args.out)
    print(f"run {args.out} 完成：{json.dumps(m, ensure_ascii=False)}")


def cmd_report(args):
    cfg, _ = load_config(args.config)
    conn = open_db(cfg["paths"]["workdir"])
    print(report(conn, args.run_id, load_cases(args.cases), args.cases))


def cmd_compare(args):
    cfg, _ = load_config(args.config)
    conn = open_db(cfg["paths"]["workdir"])
    print(compare(conn, args.run_a, args.run_b, load_cases(args.cases), args.cases))


def main(argv=None):
    p = argparse.ArgumentParser(prog="sr_replay", description="Soft Retrieval 离线回放器")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("index"); s.add_argument("--config", required=True)
    s.add_argument("--episodes"); s.set_defaults(fn=cmd_index)
    s = sub.add_parser("run"); s.add_argument("--config", required=True)
    s.add_argument("--cases", required=True); s.add_argument("--out", required=True)
    s.set_defaults(fn=cmd_run)
    s = sub.add_parser("report"); s.add_argument("run_id")
    s.add_argument("--config", required=True); s.add_argument("--cases", required=True)
    s.set_defaults(fn=cmd_report)
    s = sub.add_parser("compare"); s.add_argument("run_a"); s.add_argument("run_b")
    s.add_argument("--config", required=True); s.add_argument("--cases", required=True)
    s.set_defaults(fn=cmd_compare)
    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
