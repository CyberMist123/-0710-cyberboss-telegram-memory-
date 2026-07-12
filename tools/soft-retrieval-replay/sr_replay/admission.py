"""Admission：候选卡构造、providers、严格校验与 fail-closed 门。

核心纪律（SPEC R2/R3/R4/R5）：
- 解析失败 / 违规输出 → 一律判 NONE（fail-closed），原始输出保留；
- decision 单值；admit=true 至多一个；NONE 时 selected 与 payload 必须为 null；
- superseded 的旧版本禁止放行；
- 载荷只有 evidence/question/constraint 三字段；禁结论、禁指令、禁人格定性；
- STANCE 载荷 evidence 必为 null，且不得泄露所选 Episode 的实体。
"""

import json
import re
from pathlib import Path

VALID_DECISIONS = ("NONE", "STANCE", "LIGHT", "EXPLICIT", "HIGHLIGHT")
PAYLOAD_FIELDS = {"evidence", "question", "constraint"}

# 结论 / 指令 / 人格定性句式（SPEC R4 禁令，代码级兜底，不只靠 prompt 承诺）
BANNED_PATTERNS = [
    "你应该", "要认可", "回复时要", "记得要",
    "她其实", "他其实", "这说明", "这表明",
    "她就是", "他就是", "总是", "从来都",
    "人格", "讨好型", "天生就",
]


# ---------------------------------------------------------------- 输入构造

def build_input_payload(context: list[str], query: str, explicit_recall: bool,
                        candidates: list[dict], episodes_by_id: dict) -> dict:
    """HARNESS §5 输入 schema。候选卡不含正文（Admission Card，SPEC §2 表示③）。"""
    cards = []
    for c in candidates:
        ep = episodes_by_id[c["episode_id"]]
        cards.append({
            "episode_id": ep["id"],
            "summary_key": f"{ep.get('title', '')}：{(ep.get('what_happened') or '')[:60]}",
            "event_time": ep.get("time"),
            "lane": "episode",
            "reliability": "canon",
            "superseded_by": ep.get("superseded_by"),
        })
    return {"context": context, "query": query,
            "explicit_recall": explicit_recall, "candidates": cards}


# ---------------------------------------------------------------- Providers

class FixtureAdmission:
    """测试用：按队列原样吐出预置的原始输出（可以是坏 JSON）。"""

    model_name = "fixture"

    def __init__(self, queued_raw: list[str]):
        self.queue = list(queued_raw)

    def judge(self, input_payload: dict, prompt_text: str) -> str:
        return self.queue.pop(0) if self.queue else "{}"


class MockAdmission:
    """确定性启发式替身，用于无密钥跑通全链。不代表真实判定质量，仅供管道验证。"""

    model_name = "mock-heuristic"

    def judge(self, input_payload: dict, prompt_text: str) -> str:
        query = input_payload["query"]
        cands = input_payload["candidates"]
        live = [c for c in cands if not c.get("superseded_by")]
        if input_payload.get("explicit_recall") or "记得" in query:
            if live:
                c = live[0]
                return json.dumps({
                    "decision": "EXPLICIT", "selected_episode_id": c["episode_id"],
                    "delivery_payload": {
                        "evidence": f"（anchor_quotes 由载荷组装注入）candidate={c['episode_id']}",
                        "question": "确认用户想回顾的具体侧面。",
                        "constraint": "只回应被问到的部分，不外扩。"},
                    "per_candidate": [{
                        "episode_id": c["episode_id"], "admit": True,
                        "current_evidence": [query], "missing_if_ignored": "用户明确拉线，不答即失忆",
                        "risk_if_used": "低", "why_now": "explicit_recall",
                        "reject_reason": None, "would_request_full_text": False}]},
                    ensure_ascii=False)
        return json.dumps({
            "decision": "NONE", "selected_episode_id": None, "delivery_payload": None,
            "per_candidate": [{
                "episode_id": c["episode_id"], "admit": False, "current_evidence": [],
                "missing_if_ignored": None, "risk_if_used": "n/a",
                "why_now": None, "reject_reason": "mock 默认拒绝",
                "would_request_full_text": False} for c in cands]}, ensure_ascii=False)


class DeepSeekAdmission:
    """DeepSeek 适配器（独立调用，temperature 0）。【未经真实调用测试的部分以首次冒烟为准】"""

    def __init__(self, model: str, api_key: str):
        self.model_name = model
        self.api_key = api_key

    def judge(self, input_payload: dict, prompt_text: str) -> str:
        import urllib.request

        body = json.dumps({
            "model": self.model_name,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": prompt_text},
                {"role": "user", "content": json.dumps(input_payload, ensure_ascii=False)},
            ],
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.deepseek.com/chat/completions", data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {self.api_key}"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]


def make_admission(cfg: dict, env: dict):
    provider = cfg.get("provider", "mock")
    if provider == "mock":
        return MockAdmission()
    if provider == "deepseek":
        key = env.get("DEEPSEEK_API_KEY")
        if not key:
            raise SystemExit("admission.provider=deepseek 但未找到 DEEPSEEK_API_KEY")
        return DeepSeekAdmission(cfg.get("model", "deepseek-chat"), key)
    raise SystemExit(f"未知 admission provider：{provider}")


def load_prompt(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


# ---------------------------------------------------------------- 校验与 fail-closed 门

def _strip_fence(raw: str) -> str:
    m = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    return m.group(1) if m else raw


def episode_entities(ep: dict, dict_words: set[str]) -> list[str]:
    """实体清单：标题、原话（含去标点变体）、出现在该 Episode 文本里的词典词。"""
    ents = [ep.get("title", "")]
    for q in ep.get("anchor_quotes", []) or []:
        ents.append(q)
        stripped = q.strip("。！？!?…，,、 “”\"'")
        if len(stripped) >= 4:
            ents.append(stripped)
    text = json.dumps(ep, ensure_ascii=False)
    ents += [w for w in dict_words if w in text]
    return [e for e in ents if e]


def validate_and_gate(raw: str, episodes_by_id: dict, dict_words: set[str],
                      extra_forbidden: list[str] | None = None) -> dict:
    """任何违规 → decision=NONE（fail-closed），violations 记录原因，raw 原样保留。"""
    violations: list[str] = []
    result = {"decision": "NONE", "selected_episode_id": None,
              "delivery_payload": None, "per_candidate": [],
              "violations": violations, "raw_output": raw}

    try:
        data = json.loads(_strip_fence(raw))
    except (json.JSONDecodeError, TypeError):
        violations.append("json_parse_failed")
        return result

    decision = data.get("decision")
    per = data.get("per_candidate") or []
    result["per_candidate"] = per
    if decision not in VALID_DECISIONS:
        violations.append(f"invalid_decision:{decision}")
        return result

    admits = [c for c in per if c.get("admit")]
    if len(admits) > 1:
        violations.append("multi_admit")           # 单条放行守卫（HARNESS §8-5）
        return result

    if decision == "NONE":
        if data.get("selected_episode_id") or data.get("delivery_payload"):
            violations.append("none_with_payload")
            return result
        return result

    # ---- 非空 decision
    sel = data.get("selected_episode_id")
    payload = data.get("delivery_payload")
    if not sel or not isinstance(payload, dict) or not admits or admits[0].get("episode_id") != sel:
        violations.append("decision_selected_mismatch")
        return result
    ep = episodes_by_id.get(sel)
    if ep is None:
        violations.append("unknown_episode")
        return result
    if ep.get("superseded_by"):
        violations.append("superseded_admitted")    # 修正链守卫（SPEC R10）
        return result
    if set(payload.keys()) != PAYLOAD_FIELDS:
        violations.append("payload_schema")
        return result
    if not admits[0].get("current_evidence"):
        violations.append("missing_current_evidence")
        return result

    text = " ".join(str(payload.get(k) or "") for k in ("evidence", "question", "constraint"))
    for pat in BANNED_PATTERNS:
        if pat in text:
            violations.append(f"banned_pattern:{pat}")
    for pat in extra_forbidden or []:
        if pat and pat in text:
            violations.append(f"case_forbidden:{pat}")
    if decision == "STANCE":
        if payload.get("evidence") is not None:
            violations.append("stance_evidence_not_null")
        for ent in episode_entities(ep, dict_words):
            if ent and ent in text:
                violations.append(f"stance_entity_leak:{ent}")

    if violations:
        return result
    result.update({"decision": decision, "selected_episode_id": sel,
                   "delivery_payload": payload})
    return result
