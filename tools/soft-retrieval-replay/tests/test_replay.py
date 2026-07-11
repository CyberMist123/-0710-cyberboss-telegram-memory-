"""REPLAY_HARNESS §8 测试清单，逐条对应，编号见各测试 docstring。"""

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOL))

from sr_replay.admission import validate_and_gate  # noqa: E402
from sr_replay.cli import run_cases  # noqa: E402
from sr_replay.core import Index, file_sha256, fuse_rrf, guard_episodes_path, make_embedder  # noqa: E402
from sr_replay.store import compare, open_db, report  # noqa: E402
from sr_replay.textproc import Tokenizer  # noqa: E402

EPISODES = TOOL / "tests" / "fixtures" / "episodes.sample.jsonl"
CASES = TOOL / "tests" / "fixtures" / "dev_cases.seed.jsonl"


def make_cfg(workdir: str) -> dict:
    return {
        "paths": {"episodes_snapshot": str(EPISODES), "workdir": str(workdir)},
        "tokenizer": {"backend": "builtin", "user_dict": str(TOOL / "user_dict.txt")},
        "embedding": {"provider": "mock", "model": "mock-hash-256", "dim": 256},
        "retrieval": {"fusion": "rrf", "rrf_k": 60, "top_pool": 30,
                      "final_k": 10, "mmr_lambda": 0.7},
        "admission": {"provider": "mock",
                      "prompt_path": str(TOOL / "prompts" / "admission_v0_1.txt"),
                      "prompt_version": "v0.1-draft"},
    }


def write_cases(dirpath: str, cases: list[dict], name="cases.jsonl") -> str:
    p = Path(dirpath) / name
    p.write_text("\n".join(json.dumps(c, ensure_ascii=False) for c in cases),
                 encoding="utf-8")
    return str(p)


def base_case(cid="c-t1", query="这周又是我给所有人收尾", **kw) -> dict:
    d = {"case_id": cid, "case_type": "implicit_cue", "context": ["最近还行"],
         "query": query, "expected_mode": "NONE",
         "positive_ids": [], "negative_ids": [],
         "label_source": "synthetic", "vintage": "2026-07"}
    d.update(kw)
    return d


class ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.cfg = make_cfg(cls.tmp)
        cls.tok = Tokenizer("builtin", str(TOOL / "user_dict.txt"))
        cls.embedder = make_embedder(cls.cfg["embedding"], cls.tok, {})
        cls.idx = Index.build(str(EPISODES), cls.cfg, cls.tok, cls.embedder, cls.tmp)
        cls.eps = cls.idx.episodes

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # 1 融合确定性
    def test_01_deterministic_ranking(self):
        q = "今天有点累，又在给别人收尾"
        r1 = self.idx.search(q, self.cfg["retrieval"], self.embedder)
        r2 = self.idx.search(q, self.cfg["retrieval"], self.embedder)
        self.assertEqual([c["episode_id"] for c in r1], [c["episode_id"] for c in r2])
        self.assertEqual(r1, r2)

    # 2 中文分词：词典词不被切碎
    def test_02_user_dict_intact(self):
        toks = self.tok.tokenize("今天进入蓝鲸时间哦")
        self.assertIn("蓝鲸时间", toks)

    # 3 分数隔离：RRF 只消费排名
    def test_03_rrf_rank_only(self):
        s = fuse_rrf(["a", "b", "c"], ["c", "a", "b"], 60)
        expect_a = 1 / 61 + 1 / 62
        self.assertAlmostEqual(s["a"], expect_a, places=9)
        # 无任何原始分数参与——API 层面只接受排名列表
        self.assertEqual(set(s), {"a", "b", "c"})

    # 4 JSON 兜底：畸形输出 → NONE + 记录，不崩溃
    def test_04_malformed_json_fail_closed(self):
        cases = write_cases(self.tmp, [base_case("c-json")], "json_cases.jsonl")
        run_cases(self.cfg, "cfg-test", cases, "run-json",
                  fixture_queue=["这不是 JSON ｛"])
        conn = open_db(self.tmp)
        dec, viol = conn.execute(
            "SELECT decision, violations FROM shadow_runs WHERE run_id='run-json'"
        ).fetchone()
        self.assertEqual(dec, "NONE")
        self.assertIn("json_parse_failed", viol)

    # 5 单条放行守卫：admit>1 → 违规 fail-closed
    def test_05_multi_admit_guard(self):
        raw = json.dumps({
            "decision": "STANCE", "selected_episode_id": "ep-s01",
            "delivery_payload": {"evidence": None, "question": "q", "constraint": "c"},
            "per_candidate": [
                {"episode_id": "ep-s01", "admit": True, "current_evidence": ["x"]},
                {"episode_id": "ep-s02", "admit": True, "current_evidence": ["y"]},
            ]}, ensure_ascii=False)
        r = validate_and_gate(raw, self.eps, self.tok.words)
        self.assertEqual(r["decision"], "NONE")
        self.assertIn("multi_admit", r["violations"])

    # 6 载荷裁剪：STANCE evidence 必为 null 且不泄露实体
    def test_06_stance_leak_guard(self):
        leaky = json.dumps({
            "decision": "STANCE", "selected_episode_id": "ep-s02",
            "delivery_payload": {"evidence": None,
                                 "question": "她说过'我好像天生就该补位一样'，是否又如此？",
                                 "constraint": "先观察"},
            "per_candidate": [{"episode_id": "ep-s02", "admit": True,
                               "current_evidence": ["这周又是我收尾"]}]},
            ensure_ascii=False)
        r = validate_and_gate(leaky, self.eps, self.tok.words)
        self.assertEqual(r["decision"], "NONE")
        self.assertTrue(any(v.startswith("stance_entity_leak") for v in r["violations"]))
        not_null = json.dumps({
            "decision": "STANCE", "selected_episode_id": "ep-s02",
            "delivery_payload": {"evidence": "有过一次出行", "question": "q", "constraint": "c"},
            "per_candidate": [{"episode_id": "ep-s02", "admit": True,
                               "current_evidence": ["x"]}]}, ensure_ascii=False)
        r2 = validate_and_gate(not_null, self.eps, self.tok.words)
        self.assertIn("stance_evidence_not_null", r2["violations"])

    # 7 载荷句式：结论/指令句式被拦截
    def test_07_banned_patterns(self):
        raw = json.dumps({
            "decision": "LIGHT", "selected_episode_id": "ep-s01",
            "delivery_payload": {"evidence": "过去有类似感受", "question": "q",
                                 "constraint": "你应该先认可她的感受"},
            "per_candidate": [{"episode_id": "ep-s01", "admit": True,
                               "current_evidence": ["x"]}]}, ensure_ascii=False)
        r = validate_and_gate(raw, self.eps, self.tok.words)
        self.assertEqual(r["decision"], "NONE")
        self.assertTrue(any(v.startswith("banned_pattern") for v in r["violations"]))

    # 8 只读守卫：全流程后快照未被修改
    def test_08_snapshot_read_only(self):
        before = file_sha256(str(EPISODES))
        cases = write_cases(self.tmp, [base_case("c-ro")], "ro_cases.jsonl")
        run_cases(self.cfg, "cfg-test", cases, "run-ro")
        self.assertEqual(before, file_sha256(str(EPISODES)))

    # 9 快照完整：版本字段与完整输入非空
    def test_09_snapshot_fields(self):
        cases = write_cases(self.tmp, [base_case("c-snap")], "snap_cases.jsonl")
        run_cases(self.cfg, "cfg-test", cases, "run-snap")
        conn = open_db(self.tmp)
        row = conn.execute(
            "SELECT embedding_model, index_version, retrieval_config_version,"
            " admission_prompt_version, admission_model, delivery_schema_version,"
            " input_payload_json, raw_output, conversation_snapshot_hash"
            " FROM shadow_runs WHERE run_id='run-snap'").fetchone()
        for v in row:
            self.assertTrue(v, f"快照字段为空：{row}")
        payload = json.loads(row[6])
        self.assertIn("query", payload)
        self.assertIn("candidates", payload)

    # 10 冻结集保护：只输出聚合，不泄露 case_id
    def test_10_frozen_set(self):
        cases = [base_case("c-frozen-1"), base_case("c-frozen-2", query="随便聊聊")]
        p = write_cases(self.tmp, cases, "test_cases_frozen.jsonl")
        run_cases(self.cfg, "cfg-test", p, "run-fa")
        run_cases(self.cfg, "cfg-test", p, "run-fb")
        conn = open_db(self.tmp)
        out = report(conn, "run-fa", cases, p) + compare(conn, "run-fa", "run-fb", cases, p)
        self.assertNotIn("c-frozen", out)
        self.assertIn("冻结集", out)

    # 11 embedding 版本守卫
    def test_11_embedding_model_guard(self):
        with self.assertRaises(SystemExit):
            Index.load(self.tmp, "text-embedding-004", self.tok)

    # 12 UTF-8：中文与 emoji 全链无乱码
    def test_12_utf8_emoji(self):
        cases = write_cases(self.tmp, [base_case("c-emoji", query="累瘫了😊哈哈哈",
                                                 case_type="chitchat_zero")],
                            "emoji_cases.jsonl")
        run_cases(self.cfg, "cfg-test", cases, "run-emoji")
        conn = open_db(self.tmp)
        raw = conn.execute("SELECT input_payload_json FROM shadow_runs "
                           "WHERE run_id='run-emoji'").fetchone()[0]
        self.assertIn("😊", raw)

    # 13 目录守卫：正式库路径拒绝启动
    def test_13_path_guard(self):
        with self.assertRaises(SystemExit):
            guard_episodes_path("extensions/relationship-memory/memory/episodes.jsonl")
        with self.assertRaises(SystemExit):
            guard_episodes_path("D:/somewhere/episodes.jsonl")
        guard_episodes_path(str(EPISODES))  # 快照允许，不抛

    # 附加：superseded 守卫（SPEC R10）
    def test_14_superseded_guard(self):
        raw = json.dumps({
            "decision": "LIGHT", "selected_episode_id": "ep-s04",
            "delivery_payload": {"evidence": "e", "question": "q", "constraint": "c"},
            "per_candidate": [{"episode_id": "ep-s04", "admit": True,
                               "current_evidence": ["x"]}]}, ensure_ascii=False)
        r = validate_and_gate(raw, self.eps, self.tok.words)
        self.assertEqual(r["decision"], "NONE")
        self.assertIn("superseded_admitted", r["violations"])

    # 附加：全量种子案例端到端跑通（mock admission）
    def test_15_end_to_end_seed_cases(self):
        m = run_cases(self.cfg, "cfg-test", str(CASES), "run-e2e")
        self.assertEqual(m["cases"], 12)
        self.assertIsNotNone(m["hit_at_10"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
