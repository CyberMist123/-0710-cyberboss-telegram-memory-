"""检索核心：episodes 加载与守卫、多检索键、embedding、BM25、融合、多样化、索引。

对 episodes 快照严格只读（R1）。禁止指向正式库路径（HARNESS §2）。
"""

import hashlib
import json
import math
import os
import re
import shutil
from pathlib import Path

import numpy as np

from .textproc import Tokenizer

# ---------------------------------------------------------------- 守卫
#
# 正式库路径守卫（fail-closed，见独立审计 Blocker）。
#
# 旧版本靠路径字符串里出现 sample/snapshot/fixture 之类关键词做“看起来
# 像快照就放行”的启发式判断——这个判断可以被任意重命名或挪目录绕过
# （例如把正式库整份复制到一个叫 .../snapshot/episodes.jsonl 的路径下，
# 字符串关键词一样命中，内容却是正式库本体）。新模型改为默认拒绝
# （allowlist），分两段，语义不同，不能混用：
#
#   1) index 命令读取的“源文件”（guard_index_source_path）：
#      只信任两类显式声明的位置——工具自带的 tests/fixtures/ 目录，
#      或运营者在配置 paths.trusted_snapshot_roots 里显式列出的目录；
#      此外一律拒绝。已知的正式库目录（extensions/relationship-memory/
#      memory/）额外做硬拒绝兜底，即使被误放进 trusted_snapshot_roots
#      也不放行。
#
#   2) run / report / compare 实际读取的 episodes 文件
#      （guard_snapshot_read_path）：只信任 index 命令自己生成、落在
#      <workdir>/index/ 下的冻结副本，并且必须与 index 时写入的
#      meta.json（加载时使用的完整性 manifest）里的 sha256 一致；
#      SQLite index_versions 只是构建与审计留痕，不参与当前加载校验。
#      任何外部路径一律拒绝，不看文件名、不看是否叫
#      snapshot/episodes.jsonl。
#
# 两段判断都基于 resolve() 之后的真实路径做祖先关系比较（os.path.
# commonpath，不是字符串前缀比较），symlink/junction、..、混合斜杠、
# 盘符大小写都在 resolve() 这一步被拍平，无法绕过。

_TOOL_ROOT = Path(__file__).resolve().parent.parent
_TEST_ROOT = (_TOOL_ROOT / "tests" / "fixtures").resolve()

# 已知正式库目录的路径段序列；在任意已 resolve 的路径里出现即拒绝。
_FORBIDDEN_SUFFIXES = (
    ("extensions", "relationship-memory", "memory"),
)


def _resolve(path_str, strict: bool) -> Path:
    """反斜杠归一化后再 resolve：吃掉 .. /symlink/junction/大小写差异。"""
    return Path(str(path_str).replace("\\", "/")).resolve(strict=strict)


def _is_within(child: Path, parent: Path) -> bool:
    """真正的祖先关系判断（commonpath），不是脆弱的字符串前缀比较。"""
    c, p = os.path.normcase(str(child)), os.path.normcase(str(parent))
    try:
        common = os.path.commonpath([c, p])
    except ValueError:
        return False
    return common == p


def _touches_forbidden_real_store(resolved: Path) -> bool:
    parts = tuple(p.lower() for p in resolved.parts)
    for suffix in _FORBIDDEN_SUFFIXES:
        n = len(suffix)
        for i in range(len(parts) - n + 1):
            if parts[i : i + n] == suffix:
                return True
    return False


def guard_index_source_path(path: str, trusted_roots: list | None = None) -> Path:
    """index 命令读取源文件前的守卫：默认拒绝，只信任显式声明的位置。"""
    try:
        resolved = _resolve(path, strict=False)
    except OSError as e:
        raise SystemExit(f"拒绝启动：episodes 源路径无法解析：{path}（{e}）")

    if _touches_forbidden_real_store(resolved):
        raise SystemExit(f"拒绝启动：episodes 源路径指向正式库目录：{path}")

    allowed_roots = [_TEST_ROOT]
    for r in trusted_roots or []:
        try:
            allowed_roots.append(_resolve(r, strict=False))
        except OSError:
            continue

    if not any(_is_within(resolved, root) for root in allowed_roots):
        raise SystemExit(
            "拒绝启动：episodes 源路径不在任何受信任位置（工具自带 "
            "tests/fixtures，或配置 paths.trusted_snapshot_roots 显式声明的目录）："
            f"{path}"
        )
    return resolved


def guard_snapshot_read_path(path: str, snapshot_root, expected_hash: str) -> Path:
    """run/report/compare 加载索引时的守卫：只信任 index 自己生成、hash 校验通过的冻结副本。"""
    try:
        root = Path(snapshot_root).resolve(strict=True)
    except OSError as e:
        raise SystemExit(f"拒绝启动：snapshot root 不存在：{snapshot_root}（{e}）")
    try:
        resolved = _resolve(path, strict=True)
    except OSError as e:
        raise SystemExit(f"拒绝启动：episodes 快照文件无法解析：{path}（{e}）")

    if not _is_within(resolved, root):
        raise SystemExit(
            f"拒绝启动：episodes 快照路径不在受控 snapshot root 内：{path}"
        )
    if _touches_forbidden_real_store(resolved):
        raise SystemExit(f"拒绝启动：episodes 快照路径指向正式库目录：{path}")

    actual_hash = file_sha256(str(resolved))
    if actual_hash != expected_hash:
        raise SystemExit(
            "拒绝启动：episodes 快照文件 hash 与 index 时 manifest 记录不一致"
            f"（可能被替换或篡改）：{path}"
        )
    return resolved


# 向后兼容别名：旧调用点/文档提到的“episodes 路径守卫”特指 index 源守卫。
guard_episodes_path = guard_index_source_path


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- Episodes

def load_episodes(path: str) -> list[dict]:
    """只读加载。坏行跳过并告警，不整体崩溃。

    不含路径守卫——调用方（Index.build / Index.load）需先分别调用
    guard_index_source_path / guard_snapshot_read_path 完成对应场景的校验。
    """
    eps: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:  # 只读句柄，全模块无写路径
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                ep = json.loads(line)
                if "id" not in ep:
                    raise ValueError("missing id")
                eps.append(ep)
            except (json.JSONDecodeError, ValueError) as e:
                print(f"[warn] episodes 第 {i} 行无法解析，已跳过：{e}")
    return eps


def retrieval_keys(ep: dict) -> list[tuple[str, str]]:
    """一条 Episode 派生多个检索键（SPEC §2 表示②）。命中任一键归并回原 Episode。"""
    keys: list[tuple[str, str]] = []
    summary = f"{ep.get('title', '')}。{ep.get('what_happened', '')}"
    keys.append(("summary", summary))
    for q in ep.get("anchor_quotes", []) or []:
        keys.append(("anchor", q))
    if ep.get("why_it_mattered"):
        keys.append(("why", ep["why_it_mattered"]))
    if ep.get("future_effect"):
        keys.append(("future", ep["future_effect"]))
    return keys


# ---------------------------------------------------------------- Embedding providers

class MockEmbedder:
    """确定性 embedding：token 哈希装桶。同文本恒同向量；token 重叠产生真实的余弦相似。"""

    model_name = "mock-hash-256"

    def __init__(self, tokenizer: Tokenizer, dim: int = 256):
        self.tok, self.dim = tokenizer, dim

    def embed(self, texts: list[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for r, text in enumerate(texts):
            for t in self.tok.tokenize(text):
                h = int.from_bytes(hashlib.sha1(t.encode("utf-8")).digest()[:8], "big")
                sign = 1.0 if (h >> 62) & 1 else -1.0  # 符号位，避免全部同号
                out[r, h % self.dim] += sign
        norms = np.linalg.norm(out, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return out / norms


class GeminiEmbedder:
    """Google Gemini embedding 适配器。【未经真实调用测试的部分以 Trace 实跑为准】"""

    def __init__(self, model: str, api_key: str):
        self.model_name = model
        self.api_key = api_key

    def embed(self, texts: list[str]) -> np.ndarray:
        import urllib.request

        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self.model_name}:batchEmbedContents?key={self.api_key}"
        )
        vecs: list[list[float]] = []
        for i in range(0, len(texts), 50):  # 分批
            batch = texts[i : i + 50]
            body = json.dumps(
                {
                    "requests": [
                        {
                            "model": f"models/{self.model_name}",
                            "content": {"parts": [{"text": t}]},
                        }
                        for t in batch
                    ]
                }
            ).encode("utf-8")
            req = urllib.request.Request(
                url, data=body, headers={"Content-Type": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            vecs.extend(e["values"] for e in data["embeddings"])
        arr = np.array(vecs, dtype=np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return arr / norms


def make_embedder(cfg: dict, tokenizer: Tokenizer, env: dict):
    provider = cfg.get("provider", "mock")
    if provider == "mock":
        return MockEmbedder(tokenizer, dim=int(cfg.get("dim", 256)))
    if provider == "gemini":
        key = env.get("GEMINI_API_KEY") or env.get("GOOGLE_API_KEY")
        if not key:
            raise SystemExit("embedding.provider=gemini 但未找到 GEMINI_API_KEY / GOOGLE_API_KEY")
        return GeminiEmbedder(cfg.get("model", "text-embedding-004"), key)
    raise SystemExit(f"未知 embedding provider：{provider}")


# ---------------------------------------------------------------- BM25（Okapi，自实现）

class BM25:
    def __init__(self, docs_tokens: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.k1, self.b = k1, b
        self.docs = docs_tokens
        self.N = len(docs_tokens)
        self.avgdl = (sum(len(d) for d in docs_tokens) / self.N) if self.N else 0.0
        self.df: dict[str, int] = {}
        for d in docs_tokens:
            for t in set(d):
                self.df[t] = self.df.get(t, 0) + 1

    def scores(self, query_tokens: list[str]) -> np.ndarray:
        out = np.zeros(self.N, dtype=np.float32)
        for t in query_tokens:
            df = self.df.get(t)
            if not df:
                continue
            idf = math.log((self.N - df + 0.5) / (df + 0.5) + 1.0)
            for i, d in enumerate(self.docs):
                tf = d.count(t)
                if tf:
                    dl = len(d)
                    out[i] += idf * tf * (self.k1 + 1) / (
                        tf + self.k1 * (1 - self.b + self.b * dl / self.avgdl)
                    )
        return out


# ---------------------------------------------------------------- 融合与多样化

def _minmax(x: np.ndarray) -> np.ndarray:
    lo, hi = float(x.min()), float(x.max())
    if hi - lo < 1e-9:
        return np.zeros_like(x)
    return (x - lo) / (hi - lo)


def fuse_rrf(vec_rank_ids: list[str], bm25_rank_ids: list[str], k: int) -> dict[str, float]:
    """RRF：只消费排名，不比较原始分数（分数隔离，HARNESS §8-3）。"""
    score: dict[str, float] = {}
    for ranking in (vec_rank_ids, bm25_rank_ids):
        for rank, eid in enumerate(ranking):
            score[eid] = score.get(eid, 0.0) + 1.0 / (k + rank + 1)
    return score


def fuse_dyn_alpha(
    ep_ids: list[str], vec_scores: np.ndarray, bm25_scores: np.ndarray
) -> tuple[dict[str, float], float]:
    """dynamic α = confAbs × confMargin（实验组，SPEC 检索配置基线）。"""
    order = np.argsort(-vec_scores)
    top1 = float(vec_scores[order[0]]) if len(order) else 0.0
    top2 = float(vec_scores[order[1]]) if len(order) > 1 else 0.0
    conf_abs = max(0.0, min(1.0, top1))
    conf_margin = max(0.0, min(1.0, (top1 - top2) / top1)) if top1 > 1e-9 else 0.0
    alpha = conf_abs * conf_margin
    v, b = _minmax(vec_scores), _minmax(bm25_scores)
    fused = alpha * v + (1 - alpha) * b
    return {ep_ids[i]: float(fused[i]) for i in range(len(ep_ids))}, alpha


def mmr_select(
    ordered_ids: list[str], emb_by_id: dict[str, np.ndarray], final_k: int, lam: float
) -> list[str]:
    """MMR 只做多样化（top_pool → final_k），不做准入判断。"""
    selected: list[str] = []
    pool = list(ordered_ids)
    base = {eid: 1.0 - i / max(1, len(pool)) for i, eid in enumerate(pool)}  # 排名代相关性
    while pool and len(selected) < final_k:
        best, best_v = None, -1e9
        for eid in pool:
            div = 0.0
            if selected:
                div = max(float(np.dot(emb_by_id[eid], emb_by_id[s])) for s in selected)
            v = lam * base[eid] - (1 - lam) * div
            if v > best_v:
                best, best_v = eid, v
        selected.append(best)
        pool.remove(best)
    return selected


# ---------------------------------------------------------------- 索引

class Index:
    """内存矩阵 + BM25。持久化为 workdir/index/<version>/{embeddings.npy, meta.json}。"""

    def __init__(self, episodes, keys, key_owner, emb, meta, tokenizer):
        self.episodes = {e["id"]: e for e in episodes}
        self.keys = keys                # list[str] 键文本
        self.key_owner = key_owner      # list[str] 键 → episode_id
        self.emb = emb                  # np.ndarray (n_keys, dim) 已归一化
        self.meta = meta
        self.tok = tokenizer
        self.bm25 = BM25([tokenizer.tokenize(k) for k in keys])
        # episode 向量 = 其键向量均值（MMR 用）
        self.ep_emb: dict[str, np.ndarray] = {}
        for eid in self.episodes:
            rows = [i for i, o in enumerate(key_owner) if o == eid]
            v = emb[rows].mean(axis=0)
            n = float(np.linalg.norm(v)) or 1.0
            self.ep_emb[eid] = v / n

    # ---- 构建 / 加载

    @staticmethod
    def build(episodes_path, cfg, tokenizer, embedder, workdir) -> "Index":
        trusted_roots = (cfg or {}).get("trusted_snapshot_roots") or []
        source = guard_index_source_path(episodes_path, trusted_roots)
        episodes = load_episodes(source)
        keys, owner = [], []
        for ep in episodes:
            for _, text in retrieval_keys(ep):
                keys.append(text)
                owner.append(ep["id"])
        emb = embedder.embed(keys)
        snap_hash = file_sha256(str(source))
        version = hashlib.sha256(
            (embedder.model_name + snap_hash).encode("utf-8")
        ).hexdigest()[:12]

        idx_root = Path(workdir) / "index"
        d = idx_root / version
        d.mkdir(parents=True, exist_ok=True)

        # 冻结副本：run/report/compare 阶段只信任这一份 index 自己生成的
        # 只读拷贝，不再回读原始外部 episodes_path（HARNESS §2 / SPEC R9）。
        frozen_copy = d / "episodes.snapshot.jsonl"
        shutil.copyfile(str(source), str(frozen_copy))
        copy_hash = file_sha256(str(frozen_copy))
        if copy_hash != snap_hash:
            raise SystemExit("拒绝：快照复制后 hash 与源文件不一致，可能存在竞态写入")

        meta = {
            "index_version": version,
            "embedding_model": embedder.model_name,
            "episode_count": len(episodes),
            "episodes_snapshot_hash": snap_hash,
            "episodes_path": str(frozen_copy),
            "episodes_source_path_at_index_time": str(source),
            "snapshot_root": str(idx_root),
            "keys": keys,
            "key_owner": owner,
        }
        np.save(d / "embeddings.npy", emb)
        (d / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False), encoding="utf-8"
        )
        return Index(episodes, keys, owner, emb, meta, tokenizer)

    @staticmethod
    def load(workdir, expected_model, tokenizer) -> "Index":
        idx_root = Path(workdir) / "index"
        versions = sorted(idx_root.glob("*/meta.json"), key=lambda p: p.stat().st_mtime)
        if not versions:
            raise SystemExit("找不到索引，先运行 index 命令")
        meta = json.loads(versions[-1].read_text(encoding="utf-8"))
        if meta["embedding_model"] != expected_model:
            raise SystemExit(
                f"拒绝运行：索引 embedding_model={meta['embedding_model']} "
                f"与配置 {expected_model} 不一致，禁止混用（SPEC R9）。"
            )
        snapshot_root = meta.get("snapshot_root", str(idx_root))
        verified_path = guard_snapshot_read_path(
            meta["episodes_path"], snapshot_root, meta["episodes_snapshot_hash"]
        )
        emb = np.load(versions[-1].parent / "embeddings.npy")
        episodes = load_episodes(verified_path)
        return Index(episodes, meta["keys"], meta["key_owner"], emb, meta, tokenizer)

    # ---- 检索

    def search(self, query: str, cfg: dict, embedder) -> list[dict]:
        """返回按融合分排序的候选（每 episode 一条），含各通道分数。"""
        q_emb = embedder.embed([query])[0]
        key_vec = self.emb @ q_emb
        q_tokens = self.tok.tokenize(query)
        key_bm = self.bm25.scores(q_tokens)

        ep_ids = list(self.episodes.keys())
        vec_by_ep = np.array(
            [max(float(key_vec[i]) for i, o in enumerate(self.key_owner) if o == e) for e in ep_ids],
            dtype=np.float32,
        )
        bm_by_ep = np.array(
            [max(float(key_bm[i]) for i, o in enumerate(self.key_owner) if o == e) for e in ep_ids],
            dtype=np.float32,
        )
        vec_rank = [ep_ids[i] for i in np.argsort(-vec_by_ep, kind="stable")]
        bm_rank = [ep_ids[i] for i in np.argsort(-bm_by_ep, kind="stable")]

        fusion = cfg.get("fusion", "rrf")
        if fusion == "rrf":
            fused = fuse_rrf(vec_rank, bm_rank, int(cfg.get("rrf_k", 60)))
        elif fusion == "dyn_alpha":
            fused, _ = fuse_dyn_alpha(ep_ids, vec_by_ep, bm_by_ep)
        else:
            raise SystemExit(f"未知 fusion：{fusion}")

        # 确定性排序：分数降序，episode_id 升序打破平局
        ordered = sorted(ep_ids, key=lambda e: (-fused.get(e, 0.0), e))
        pool = ordered[: int(cfg.get("top_pool", 30))]
        final = mmr_select(
            pool, self.ep_emb, int(cfg.get("final_k", 10)), float(cfg.get("mmr_lambda", 0.7))
        )
        vmap = dict(zip(ep_ids, vec_by_ep.tolist()))
        bmap = dict(zip(ep_ids, bm_by_ep.tolist()))
        return [
            {
                "episode_id": e,
                "rank": r + 1,
                "fusion_score": round(fused.get(e, 0.0), 6),
                "vector_score": round(vmap[e], 6),
                "bm25_score": round(bmap[e], 6),
            }
            for r, e in enumerate(final)
        ]
