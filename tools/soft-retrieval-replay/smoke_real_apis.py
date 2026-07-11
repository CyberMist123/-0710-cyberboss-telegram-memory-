"""真实 API 冒烟测试（在你自己的机器上运行，读取本目录 .env）。

用法：cd tools/soft-retrieval-replay && python smoke_real_apis.py
只各调用一次，token 消耗极小。不打印任何密钥。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sr_replay.admission import DeepSeekAdmission, load_prompt, validate_and_gate
from sr_replay.cli import load_env
from sr_replay.core import GeminiEmbedder


def main():
    env = load_env()
    ok = True

    try:
        g = GeminiEmbedder("text-embedding-004", env["GEMINI_API_KEY"])
        v = g.embed(["今天有点累", "蓝鲸时间"])
        print(f"[OK] Gemini embedding: shape={v.shape}")
    except Exception as e:  # noqa: BLE001
        ok = False
        print(f"[FAIL] Gemini: {type(e).__name__}: {str(e)[:200]}")

    try:
        d = DeepSeekAdmission("deepseek-chat", env["DEEPSEEK_API_KEY"])
        payload = {
            "context": ["下午跑了十公里"], "query": "累瘫了哈哈哈",
            "explicit_recall": False,
            "candidates": [{
                "episode_id": "ep-s01",
                "summary_key": "白费的一周：项目被砍后的意义感崩溃",
                "event_time": "2026-03-11", "lane": "episode",
                "reliability": "canon", "superseded_by": None}],
        }
        prompt = load_prompt(str(Path(__file__).parent / "prompts" / "admission_v0_1.txt"))
        raw = d.judge(payload, prompt)
        eps = {"ep-s01": {"id": "ep-s01", "title": "白费的一周",
                          "anchor_quotes": ["我不是累，是觉得白费。"]}}
        r = validate_and_gate(raw, eps, set())
        print(f"[OK] DeepSeek admission: decision={r['decision']} violations={r['violations']}")
        print("     （这条虚构 query 的合理判定是 NONE——身体累，旧事不适用）")
    except Exception as e:  # noqa: BLE001
        ok = False
        print(f"[FAIL] DeepSeek: {type(e).__name__}: {str(e)[:200]}")

    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
