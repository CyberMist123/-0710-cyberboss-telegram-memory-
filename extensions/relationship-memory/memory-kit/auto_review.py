#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Phase 3 Auto Review subprocess. Reads one JSON object from stdin, writes one decision fragment."""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_memory as em


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False))


def deferred(reason):
    return {"result": "deferred", "reason": reason, "checks": {"safety_ok": False}}


def mock_review(mode, candidate, source_ref_located):
    warning = contains_imperative(str(candidate.get("body") or ""))
    checks = {
        "source_ref_located": bool(source_ref_located),
        "length_ok": True,
        "safety_ok": True,
        "imperative_warning": warning,
        "duplicate_of": None,
    }
    if mode == "reject_conflict":
        return {"result": "rejected", "reason": "reject_conflict", "checks": checks, "pushed_to_user": True}
    if mode == "boundary_touch":
        return {"result": "deferred", "reason": "boundary_touch", "checks": checks, "pushed_to_user": True}
    if mode == "defer":
        return {"result": "deferred", "reason": "mock_deferred", "checks": checks}
    return {"result": "accepted", "reason": "checks_passed", "checks": checks}


def contains_imperative(text):
    lowered = text.lower()
    return any(token in lowered for token in ("必须", "务必", "永远不要", "记住要", " must ", " should "))


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        emit(deferred("invalid_input"))
        return 0
    candidate = payload.get("candidate") or {}
    source_ref_located = payload.get("source_ref_located") is True
    mode = str(os.environ.get("AUTO_REVIEW_MOCK") or "").strip().lower()
    if mode:
        emit(mock_review(mode, candidate, source_ref_located))
        return 0
    if not em.API_KEY:
        emit(deferred("review_model_unavailable"))
        return 0
    prompt = """你是 Auto Review 海关，不是编辑。只检查候选，不改写正文。
输出一个 JSON 对象，只含 result/reason/checks/pushed_to_user：
- result 只能 accepted/rejected/deferred；
- source_ref 不可定位、事实不确定、模型无法判断时 deferred；
- 与用户确认边界冲突时 rejected + reason=reject_conflict + pushed_to_user=true；
- 触及边界需用户确认时 deferred + reason=boundary_touch + pushed_to_user=true；
- 祈使句只把 checks.imperative_warning=true，不因此拒绝；
- 禁止输出 body、rewrite、edited_text 或任何改写正文。

候选：
""" + json.dumps(candidate, ensure_ascii=False) + "\nsource_ref_located=" + str(source_ref_located).lower()
    try:
        parsed = em.parse_json(em.chat(prompt, max_tokens=800))
    except Exception:
        emit(deferred("review_model_failed"))
        return 0
    result = str(parsed.get("result") or "deferred")
    if result not in ("accepted", "rejected", "deferred"):
        result = "deferred"
    checks = parsed.get("checks") if isinstance(parsed.get("checks"), dict) else {}
    checks["source_ref_located"] = source_ref_located
    checks["imperative_warning"] = bool(checks.get("imperative_warning")) or contains_imperative(str(candidate.get("body") or ""))
    safe = {
        "result": result,
        "reason": str(parsed.get("reason") or "reviewed")[:200],
        "checks": checks,
        "pushed_to_user": parsed.get("pushed_to_user") is True,
    }
    emit(safe)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
