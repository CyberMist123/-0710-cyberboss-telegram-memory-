"""REPLAY_HARNESS §8 测试清单，逐条对应，编号见各测试 docstring。

PathGuardTests / RetrievalUnitTests 是独立审计修复新增的测试类：
- PathGuardTests：正式库路径守卫改为 fail-closed 白名单后的专项测试。
- RetrievalUnitTests：dynamic alpha 与 MMR 的直接单元测试，不经过完整 replay pipeline。
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

TOOL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOL))

from sr_replay.admission import validate_and_gate  # noqa: E402
from sr_replay.cli import run_cases  # noqa: E402
from sr_replay.core import (Index, file_sha256, fuse_dyn_alpha, fuse_rrf,  # noqa: E402
                            guard_episodes_path, guard_index_source_path,
                            guard_snapshot_read_path, make_embedder, mmr_select)
from sr_replay.store import compare, open_db, report  # noqa: E402
from sr_replay.textproc import Tokenizer  # noqa: E402

EPISODES = TOOL / "tests" / "fixtures" / "episodes.sample.jsonl"
CASES = TOOL / "tests" / "fixtures" / "dev_cases.seed.jsonl"


def make_cfg(workdir: str) -> dict:
    return {
        "paths": {"episodes_snapshot": str(EPISODES), "workdir": str(workdir)},
        "trusted_snapshot_roots": [],
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


def build_index(workdir: str):
    cfg = make_cfg(workdir)
    tok = Tokenizer("builtin", str(TOOL / "user_dict.txt"))
    embedder = make_embedder(cfg["embedding"], tok, {})
    idx = Index.build(str(EPISODES), cfg, tok, embedder, workdir)
    meta_path = sorted(Path(workdir).glob("index/*/meta.json"))[-1]
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    return cfg, tok, embedder, idx, meta


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
        try:
            dec, viol = conn.execute(
                "SELECT decision, violations FROM shadow_runs WHERE run_id='run-json'"
            ).fetchone()
        finally:
            conn.close()
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
        try:
            row = conn.execute(
                "SELECT embedding_model, index_version, retrieval_config_version,"
                " admission_prompt_version, admission_model, delivery_schema_version,"
                " input_payload_json, raw_output, conversation_snapshot_hash"
                " FROM shadow_runs WHERE run_id='run-snap'").fetchone()
        finally:
            conn.close()
        for v in row:
            self.assertTrue(v, f"快照字段为空：{row}")
        payload = json.loads(row[6])
        self.assertIn("query", payload)
        self.assertIn("candidates", payload)

    # 10 冻结集保护：由 case-set 元数据识别（case_set_frozen 字段），不看文件名。
    #    独立审计修复：旧版本靠 cases 文件名里有没有 "test_cases" 字符串判断，
    #    这里故意用一个完全不含该字符串的文件名，证明判定确实不依赖文件名。
    def test_10_frozen_set_by_metadata(self):
        cases = [base_case("c-frozen-1", case_set_frozen=True),
                 base_case("c-frozen-2", query="随便聊聊", case_set_frozen=True)]
        p = write_cases(self.tmp, cases, "arbitrary_name_20260712.jsonl")
        run_cases(self.cfg, "cfg-test", p, "run-fa")
        run_cases(self.cfg, "cfg-test", p, "run-fb")
        conn = open_db(self.tmp)
        try:
            out = report(conn, "run-fa", cases, p) + compare(conn, "run-fa", "run-fb", cases, p)
        finally:
            conn.close()
        self.assertNotIn("c-frozen", out)
        self.assertIn("冻结集", out)

    # 10b 反向证明：文件名叫 test_cases 但没有 case_set_frozen 元数据 → 不再被误保护
    def test_10b_filename_alone_does_not_freeze(self):
        cases = [base_case("c-visible-1"), base_case("c-visible-2", query="随便聊聊")]
        p = write_cases(self.tmp, cases, "test_cases_legacy_name.jsonl")
        run_cases(self.cfg, "cfg-test", p, "run-nf")
        conn = open_db(self.tmp)
        try:
            out = report(conn, "run-nf", cases, p)
        finally:
            conn.close()
        self.assertIn("c-visible-1", out)

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
        try:
            raw = conn.execute("SELECT input_payload_json FROM shadow_runs "
                               "WHERE run_id='run-emoji'").fetchone()[0]
        finally:
            conn.close()
        self.assertIn("😊", raw)

    # 13 目录守卫：正式库路径拒绝启动（index 源守卫；guard_episodes_path 是
    #    guard_index_source_path 的向后兼容别名）
    def test_13_path_guard(self):
        with self.assertRaises(SystemExit):
            guard_episodes_path("extensions/relationship-memory/memory/episodes.jsonl")
        with self.assertRaises(SystemExit):
            guard_episodes_path("/somewhere/episodes.jsonl")
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


class PathGuardTests(unittest.TestCase):
    """独立审计新增：正式库路径守卫改为 fail-closed 白名单后的专项测试。

    覆盖审计要求的 8 个场景：
      - 伪装成快照的路径拒绝（正斜杠/反斜杠两种写法）
      - 名称伪装拒绝
      - ../ 逃逸拒绝
      - symlink/junction 逃逸拒绝
      - snapshot 文件被替换或 hash 变化拒绝
      - 正确 index 生成的 snapshot 通过
      - 现有普通正式库路径继续拒绝
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # 现有普通正式库路径继续拒绝
    def test_formal_store_path_still_rejected(self):
        with self.assertRaises(SystemExit):
            guard_index_source_path("extensions/relationship-memory/memory/episodes.jsonl")
        with self.assertRaises(SystemExit):
            guard_index_source_path(str(Path(Path(self.tmp).anchor) / "somewhere" / "episodes.jsonl"))
        guard_index_source_path(str(EPISODES))  # 真正的快照仍然允许

    # 伪装成快照的路径拒绝（正斜杠；文件名/目录名带 snapshot
    # 关键词但既不在 tests/fixtures，也没有被显式声明为 trusted_snapshot_roots）
    def test_fake_snapshot_forward_slash_rejected(self):
        d = Path(self.tmp) / "real" / "snapshot"
        d.mkdir(parents=True)
        f = d / "episodes.jsonl"
        f.write_text('{"id":"ep-x"}\n', encoding="utf-8")
        with self.assertRaises(SystemExit):
            guard_index_source_path(str(f).replace("\\", "/"))

    # 伪装成快照的路径拒绝（反斜杠变体；混合分隔符不得绕过）
    def test_fake_snapshot_backslash_rejected(self):
        d = Path(self.tmp) / "real" / "snapshot"
        d.mkdir(parents=True)
        f = d / "episodes.jsonl"
        f.write_text('{"id":"ep-x"}\n', encoding="utf-8")
        backslash_path = str(f).replace("/", "\\")
        with self.assertRaises(SystemExit):
            guard_index_source_path(backslash_path)

    # 名称伪装拒绝：文件名/目录名同时堆砌 fixture、snapshot、test 关键词，
    # 但物理位置既不在工具自带 tests/fixtures，也没有被显式信任
    def test_name_disguise_rejected(self):
        d = Path(self.tmp) / "totally_a_fixture" / "snapshot_test"
        d.mkdir(parents=True)
        f = d / "test_fixture_snapshot_episodes.jsonl"
        f.write_text('{"id":"ep-x"}\n', encoding="utf-8")
        with self.assertRaises(SystemExit):
            guard_index_source_path(str(f))

    # ../ 逃逸拒绝：字符串前缀看起来落在 snapshot_root 下，
    # 实际靠 .. 跳出去；必须用 resolve() 后的祖先关系判断，不能用字符串前缀比较
    def test_dotdot_escape_from_snapshot_root_rejected(self):
        _, _, _, _, meta = build_index(self.tmp)
        snapshot_root = meta["snapshot_root"]
        outside_dir = Path(self.tmp).parent / "dotdot_escape_target"
        outside_dir.mkdir(exist_ok=True)
        outside_file = outside_dir / "episodes.jsonl"
        outside_file.write_text('{"id":"ep-x"}\n', encoding="utf-8")
        # 字符串层面从 snapshot_root 出发、用 .. 跳出去再绕回 outside_file——
        # 只有真正 resolve() 之后按祖先关系判断，才能识破这条路径根本不在
        # snapshot_root 内（单纯的字符串前缀比较会被这种构造骗过）。
        rel = os.path.relpath(str(outside_file), start=str(Path(snapshot_root)))
        escaped = str(Path(snapshot_root) / rel)
        try:
            with self.assertRaises(SystemExit):
                guard_snapshot_read_path(escaped, snapshot_root,
                                         meta["episodes_snapshot_hash"])
        finally:
            shutil.rmtree(outside_dir, ignore_errors=True)

    # symlink/junction 逃逸拒绝：诱饵文件字节内容与冻结副本完全一致（hash 会
    # 通过），证明真正拦住它的是“resolve() 后不在 snapshot_root 内”，而不
    # 只是 hash 校验。
    def test_symlink_escape_rejected(self):
        _, _, _, _, meta = build_index(self.tmp)
        snapshot_root = meta["snapshot_root"]
        real_copy = Path(meta["episodes_path"])
        outside = Path(self.tmp) / "outside_decoy.jsonl"
        shutil.copyfile(real_copy, outside)
        link = real_copy.parent / "escape_link.jsonl"
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError):
            self.skipTest("此平台不支持创建 symlink（如未开发者模式的 Windows）")
        try:
            with self.assertRaises(SystemExit):
                guard_snapshot_read_path(str(link), snapshot_root,
                                         meta["episodes_snapshot_hash"])
        finally:
            link.unlink(missing_ok=True)

    # snapshot 文件被替换或 hash 变化拒绝
    def test_tampered_snapshot_hash_mismatch_rejected(self):
        _, _, _, _, meta = build_index(self.tmp)
        frozen = Path(meta["episodes_path"])
        with open(frozen, "a", encoding="utf-8") as f:
            f.write('{"id":"ep-tampered"}\n')
        with self.assertRaises(SystemExit):
            guard_snapshot_read_path(str(frozen), meta["snapshot_root"],
                                     meta["episodes_snapshot_hash"])

    # 正确 index 生成的 snapshot 通过，且 Index.load 能正常复用
    def test_properly_indexed_snapshot_passes(self):
        cfg, tok, embedder, idx, meta = build_index(self.tmp)
        verified = guard_snapshot_read_path(
            meta["episodes_path"], meta["snapshot_root"], meta["episodes_snapshot_hash"])
        self.assertTrue(verified.exists())
        reloaded = Index.load(self.tmp, embedder.model_name, tok)
        self.assertEqual(len(reloaded.episodes), len(idx.episodes))

    # fixture 只能通过显式 test root 放行：packaged tests/fixtures 之外的
    # “看起来像 fixture”的路径必须拒绝（已由 test_name_disguise_rejected /
    # test_fake_snapshot_* 覆盖），这里补一条反向确认：真正在 tests/fixtures
    # 下的文件必须被放行。
    def test_real_test_root_fixture_allowed(self):
        guard_index_source_path(str(EPISODES))
        guard_index_source_path(str(CASES.parent / "episodes.sample.jsonl"))


class RetrievalUnitTests(unittest.TestCase):
    """dynamic alpha 与 MMR 的直接单元测试，不经过完整 replay pipeline。"""

    # dynamic alpha：top1 绝对值高且与 top2 差距大 → alpha 高，向量分主导融合分
    def test_dyn_alpha_high_confidence_favors_vector(self):
        ep_ids = ["a", "b", "c"]
        vec = np.array([0.95, 0.10, 0.05], dtype=np.float32)
        bm25 = np.array([0.05, 0.95, 0.50], dtype=np.float32)
        fused, alpha = fuse_dyn_alpha(ep_ids, vec, bm25)
        self.assertGreater(alpha, 0.7)
        self.assertGreater(fused["a"], fused["b"])

    # dynamic alpha：top1/top2 差距极小（margin 低）→ alpha 趋近 0，融合分几乎全靠 bm25
    def test_dyn_alpha_low_margin_favors_bm25(self):
        ep_ids = ["a", "b"]
        vec = np.array([0.51, 0.50], dtype=np.float32)
        bm25 = np.array([0.10, 0.95], dtype=np.float32)
        fused, alpha = fuse_dyn_alpha(ep_ids, vec, bm25)
        self.assertLess(alpha, 0.1)
        self.assertGreater(fused["b"], fused["a"])

    # dynamic alpha：向量分全 0（无信号）时 alpha=0，且不因除零崩溃
    def test_dyn_alpha_all_zero_vector_no_div_by_zero(self):
        ep_ids = ["a", "b"]
        vec = np.zeros(2, dtype=np.float32)
        bm25 = np.array([0.2, 0.8], dtype=np.float32)
        fused, alpha = fuse_dyn_alpha(ep_ids, vec, bm25)
        self.assertEqual(alpha, 0.0)
        self.assertEqual(set(fused), {"a", "b"})

    # dynamic alpha：单候选（无 top2）时不崩溃，margin 按 top2=0 计算
    def test_dyn_alpha_single_candidate_no_crash(self):
        fused, alpha = fuse_dyn_alpha(["a"], np.array([0.8], dtype=np.float32),
                                      np.array([0.3], dtype=np.float32))
        self.assertEqual(set(fused), {"a"})
        self.assertGreaterEqual(alpha, 0.0)

    # MMR：final_k 生效且确定性（同输入两次结果一致），第一名必先入选
    def test_mmr_selects_final_k_and_is_deterministic(self):
        ordered = ["a", "b", "c", "d"]
        emb = {
            "a": np.array([1.0, 0.0]), "b": np.array([1.0, 0.0]),
            "c": np.array([0.0, 1.0]), "d": np.array([0.7071, 0.7071]),
        }
        r1 = mmr_select(ordered, emb, final_k=3, lam=0.5)
        r2 = mmr_select(ordered, emb, final_k=3, lam=0.5)
        self.assertEqual(r1, r2)
        self.assertEqual(len(r1), 3)
        self.assertEqual(r1[0], "a")

    # MMR：低 lambda 时几乎纯看多样性，排名第二但与已选高度相似的候选让位
    def test_mmr_diversity_prefers_dissimilar_over_pure_rank(self):
        ordered = ["a", "b", "c"]
        emb = {
            "a": np.array([1.0, 0.0]),
            "b": np.array([0.999, 0.0447]),   # 与 a 几乎同向
            "c": np.array([0.0, 1.0]),        # 与 a 正交
        }
        for k, v in emb.items():
            emb[k] = v / np.linalg.norm(v)
        r = mmr_select(ordered, emb, final_k=2, lam=0.1)
        self.assertEqual(r[0], "a")
        self.assertEqual(r[1], "c")

    # MMR：lambda=1 退化为纯排名（不看多样性）
    def test_mmr_lambda_one_is_pure_rank(self):
        ordered = ["a", "b", "c"]
        emb = {"a": np.array([1.0, 0.0]), "b": np.array([1.0, 0.0]),
               "c": np.array([1.0, 0.0])}  # 三者完全同向，多样性项恒为常数
        r = mmr_select(ordered, emb, final_k=3, lam=1.0)
        self.assertEqual(r, ["a", "b", "c"])

    # MMR：final_k 大于候选池大小时返回全部候选，不报错
    def test_mmr_final_k_larger_than_pool_returns_all(self):
        ordered = ["a", "b"]
        emb = {"a": np.array([1.0, 0.0]), "b": np.array([0.0, 1.0])}
        r = mmr_select(ordered, emb, final_k=10, lam=0.5)
        self.assertEqual(set(r), {"a", "b"})
        self.assertEqual(len(r), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
