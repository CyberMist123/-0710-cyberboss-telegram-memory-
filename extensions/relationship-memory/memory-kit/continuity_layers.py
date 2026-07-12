#!/usr/bin/env python3
"""Read-only presentation model for the 520 Continuity view.

This module never writes continuity files. It only separates technical gaps,
evidence, semantic candidates, review decisions, and published canon so the UI
does not flatten every object into "Candidate".
"""

import json
import os
from pathlib import Path


LAYER_DEFINITIONS = (
    ("gaps", "技术断档", "系统发现哪些会话区间没有被记忆流水线覆盖。"),
    ("evidence", "证据材料", "Janitor 保存的原始材料；没有语义执笔权。"),
    ("subject_candidates", "主体 AI 候选", "主体 AI 在当前关系上下文中写出的候选。"),
    ("background_candidates", "后台代理候选", "Nightly Closeout 根据当日材料写出的候选。"),
    ("blocked_candidates", "冻结的旧候选", "提取器或权限不足的旧 Candidate，不允许发布。"),
    ("decisions", "Review 决策", "海关式核对结果：接受、拒绝、延后或合并。"),
    ("canon", "已发布 Canon", "History Writer 已正式发布的 Episode。"),
)


def build_continuity_layers(continuity_dir, limit=50, nightly_mode=None):
    root = Path(continuity_dir)
    bounded_limit = _bounded_limit(limit)

    candidates = _read_jsonl(root / "candidates" / "episodes.candidates.jsonl")
    classified = {
        "subject_candidates": [],
        "background_candidates": [],
        "blocked_candidates": [],
    }
    for row in candidates:
        classified[_candidate_layer(row)].append(row)

    rows_by_layer = {
        "gaps": _read_jsonl(root / "gaps" / "gaps.jsonl"),
        "evidence": _read_jsonl(root / "evidence" / "janitor.evidence.jsonl"),
        **classified,
        "decisions": _read_jsonl(root / "decisions" / "decisions.jsonl"),
        "canon": _read_jsonl(root / "episodes.jsonl"),
    }

    layers = []
    for key, label, description in LAYER_DEFINITIONS:
        all_rows = rows_by_layer[key]
        layers.append({
            "key": key,
            "label": label,
            "description": description,
            "count": len(all_rows),
            "rows": all_rows[-bounded_limit:],
        })

    return {
        "kind": "continuity_layers",
        "nightly_mode": normalize_nightly_mode(
            nightly_mode if nightly_mode is not None else os.environ.get("CYBERBOSS_NIGHTLY_MODE", "")
        ),
        "write_mode": "read_only",
        "continuity_dir": str(root),
        "layers": layers,
    }


def normalize_nightly_mode(value):
    text = str(value or "").strip().lower()
    if not text:
        return "evidence"
    if text not in {"evidence", "shadow", "auto"}:
        return "invalid"
    return text


def _candidate_layer(row):
    author_role = str(row.get("author_role") or "").strip().lower()
    authority = str(row.get("semantic_authority") or "").strip().lower()
    origin = str(row.get("origin") or "").strip().lower()
    author = str(row.get("author") or "").strip().lower()
    needs_subject_review = row.get("needs_subject_review") is True

    if author_role == "subject_ai" and authority == "high" and not needs_subject_review:
        return "subject_candidates"
    if author_role == "background_proxy" or origin == "nightly_closeout":
        return "background_candidates"
    if author_role == "extractor" or authority == "none" or author == "janitor":
        return "blocked_candidates"

    # Unknown legacy rows are shown as blocked instead of being presented as
    # publishable. This is a display safety default, not a data migration.
    return "blocked_candidates"


def _read_jsonl(path):
    if not path.is_file():
        return []
    rows = []
    try:
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if not raw.strip():
                continue
            try:
                value = json.loads(raw)
            except Exception:
                continue
            if isinstance(value, dict):
                rows.append(value)
    except Exception:
        return []
    return rows


def _bounded_limit(value):
    try:
        parsed = int(value)
    except Exception:
        parsed = 50
    return max(1, min(parsed, 200))
