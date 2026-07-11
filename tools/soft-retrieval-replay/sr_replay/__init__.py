"""Soft Retrieval 离线回放器。

规范来源（唯一权威）：docs/soft-retrieval/SPEC.md 与 docs/soft-retrieval/REPLAY_HARNESS.md
纪律：不连 Telegram、不写任何记忆结构、不启动常驻进程；对 episodes 快照只读。
"""

__version__ = "0.1.0"
DELIVERY_SCHEMA_VERSION = "dsv-1"
