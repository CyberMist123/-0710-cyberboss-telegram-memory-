#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""同步「## 记忆与连续性」块 —— template → ~/.cyberboss/weixin-instructions.md

背景:cyberboss 的 src/index.js 只在运行时文件不存在时才从模板拷贝;
模板改了、运行时副本不会自动跟。这个脚本手动同步,只碰记忆块,不动别的段落。

用法:双击 同步记忆块.bat 或 `python memory-kit/sync_memory_block.py`。
- 找到运行时 weixin-instructions.md(默认 %USERPROFILE%\.cyberboss\)
- 读模板尾部「## 记忆与连续性」整段
- 用新块替换运行时文件中同名段落(旧内容备份到 .bak.<时间戳>)
- 找不到目标段落时:追加到文件末尾,不覆盖任何东西
- 找不到运行时副本时:什么都不做(下次启动会从模板重生成)

覆盖策略:只替换从「## 记忆与连续性」这个二级标题开始,到下一个同级标题(或文件末尾)之间的内容。
"""
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parent
TEMPLATE = (
    WORKSPACE.parent
    / "cyberboss-deepseek-test"
    / "templates"
    / "weixin-instructions.md"
)
STATE_DIR = Path(
    os.environ.get("CYBERBOSS_STATE_DIR")
    or (Path.home() / ".cyberboss")
)
RUNTIME_FILE = STATE_DIR / "weixin-instructions.md"

HEADING = "## 记忆与连续性"


def extract_block(text: str, heading: str) -> str:
    """从 heading 开始,直到下一个同级(##)标题或文件末尾。"""
    pattern = re.compile(
        r"(^" + re.escape(heading) + r"\s*$)(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        return ""
    return (m.group(1) + m.group(2)).rstrip() + "\n"


def replace_or_append(runtime_text: str, new_block: str, heading: str) -> str:
    """替换 runtime 里同名段落;找不到就追加到末尾。"""
    pattern = re.compile(
        r"(^" + re.escape(heading) + r"\s*$)(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    if pattern.search(runtime_text):
        return pattern.sub(new_block, runtime_text, count=1)
    # 未找到:追加(前后各留一个空行)
    stripped = runtime_text.rstrip()
    return stripped + "\n\n" + new_block


def main() -> int:
    if not TEMPLATE.exists():
        print(f"[skip] 模板不存在: {TEMPLATE}")
        return 1
    if not RUNTIME_FILE.exists():
        print(f"[skip] 运行时副本不存在: {RUNTIME_FILE}")
        print("     (下次 TG 启动会从新模板生成,不用管)")
        return 0

    template_text = TEMPLATE.read_text(encoding="utf-8")
    new_block = extract_block(template_text, HEADING)
    if not new_block:
        print(f"[error] 模板里没找到「{HEADING}」段落: {TEMPLATE}")
        return 2

    runtime_text = RUNTIME_FILE.read_text(encoding="utf-8")
    old_block = extract_block(runtime_text, HEADING)
    if old_block.strip() == new_block.strip():
        print("[ok] 运行时副本已是最新,无需同步")
        return 0

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = RUNTIME_FILE.with_suffix(f".md.bak.{ts}")
    shutil.copy2(RUNTIME_FILE, backup)
    print(f"[backup] {backup}")

    updated = replace_or_append(runtime_text, new_block, HEADING)
    RUNTIME_FILE.write_text(updated, encoding="utf-8")
    print(f"[ok] 已同步: {RUNTIME_FILE}")
    print("     记得 /reread 或重启 TG 让它吃到新块。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
