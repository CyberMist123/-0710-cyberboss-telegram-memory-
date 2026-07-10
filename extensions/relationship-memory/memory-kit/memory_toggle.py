#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""memory_toggle — 一键关/开记忆系统,用于 A/B 对比。

用法:
    python memory_toggle.py off      # 拆掉记忆:CLAUDE.md 去掉记忆指针,runtime weixin-instructions 去掉记忆块
    python memory_toggle.py on       # 挂回记忆:还原 CLAUDE.md,重新写入记忆块
    python memory_toggle.py status   # 显示当前状态

关掉后 cyberboss 退回原生行为(不读 reentry.md);打开后恢复。
必须 /reread 或重启 TG 才会真的生效——脚本不动 runtime 进程。
"""
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parent
STATE_DIR = Path(os.environ.get("CYBERBOSS_STATE_DIR") or (Path.home() / ".cyberboss"))

CLAUDE_MD = WORKSPACE / "CLAUDE.md"
CLAUDE_MD_ON_BAK = WORKSPACE / "CLAUDE.md.memory-on.bak"
RUNTIME_INSTR = STATE_DIR / "weixin-instructions.md"
DISABLED_MARKER = WORKSPACE / "memory" / ".disabled"
HEADING = "## 记忆与连续性"

CLAUDE_MD_WITHOUT_MEMORY = """# 醒来

(记忆系统已关闭,本次会话不引用 memory/ 下任何文件。)

## Compact Instructions

压缩对话时,优先保留关系连续性、人物声音、关键原句、近期互动细节、未解决话题、承诺、当前场景和时间线。

不要把复杂互动压成抽象人格标签。
记录事件的因果链与双方立场变化。
保留最近一段对话的具体措辞和节奏。
删除工具日志、状态输出、内部协议、重复回复和已解决的技术噪音。
"""


def _now_tag() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _strip_memory_block(text: str) -> str:
    """从 text 中删除 `## 记忆与连续性` 到下一个二级标题(或文件末)之间的整段。"""
    pattern = re.compile(
        r"(^" + re.escape(HEADING) + r"\s*$)(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    return pattern.sub("", text).rstrip() + "\n"


def _has_memory_block(text: str) -> bool:
    return re.search(r"^" + re.escape(HEADING) + r"\s*$", text, re.MULTILINE) is not None


def cmd_off() -> int:
    # 1. 备份 workspace CLAUDE.md,写入无记忆版
    if CLAUDE_MD.exists():
        if not CLAUDE_MD_ON_BAK.exists():
            shutil.copy2(CLAUDE_MD, CLAUDE_MD_ON_BAK)
            print(f"[off] 备份 CLAUDE.md -> {CLAUDE_MD_ON_BAK.name}")
        else:
            print(f"[off] {CLAUDE_MD_ON_BAK.name} 已存在,不覆盖旧备份。")
        CLAUDE_MD.write_text(CLAUDE_MD_WITHOUT_MEMORY, encoding="utf-8")
        print(f"[off] 已写入无记忆版 CLAUDE.md")
    else:
        print(f"[off] {CLAUDE_MD} 不存在,跳过")

    # 2. 从 runtime weixin-instructions 里删除记忆块
    if RUNTIME_INSTR.exists():
        text = RUNTIME_INSTR.read_text(encoding="utf-8")
        if _has_memory_block(text):
            bak = RUNTIME_INSTR.with_suffix(f".md.bak.off-{_now_tag()}")
            shutil.copy2(RUNTIME_INSTR, bak)
            new_text = _strip_memory_block(text)
            RUNTIME_INSTR.write_text(new_text, encoding="utf-8")
            print(f"[off] 已从 {RUNTIME_INSTR.name} 删除记忆块 (备份: {bak.name})")
        else:
            print(f"[off] {RUNTIME_INSTR.name} 里没有记忆块,跳过")
    else:
        print(f"[off] runtime 副本不存在: {RUNTIME_INSTR} — 下次 TG 启动会从模板生成,届时再跑 off")

    # 3. 写标记
    DISABLED_MARKER.parent.mkdir(parents=True, exist_ok=True)
    DISABLED_MARKER.write_text(datetime.now().isoformat(), encoding="utf-8")
    print(f"[off] 标记文件写入: {DISABLED_MARKER}")
    print("[off] 完成。/reread 或双击 重启TG.bat 生效。")
    return 0


def cmd_on() -> int:
    # 1. 还原 CLAUDE.md
    if CLAUDE_MD_ON_BAK.exists():
        shutil.move(str(CLAUDE_MD_ON_BAK), str(CLAUDE_MD))
        print(f"[on] 还原 CLAUDE.md(带记忆版)")
    else:
        print(f"[on] 找不到 {CLAUDE_MD_ON_BAK.name},CLAUDE.md 不动 —— 如果没被 off 过就是正常的")

    # 2. 复用 sync_memory_block.py 把记忆块 push 回 runtime
    sync_script = HERE / "sync_memory_block.py"
    if sync_script.exists():
        print(f"[on] 调用 {sync_script.name} 同步记忆块 ...")
        try:
            subprocess.run([sys.executable, str(sync_script)], check=True)
        except subprocess.CalledProcessError as e:
            print(f"[on] sync_memory_block 报错(退出码 {e.returncode}),但继续。")
    else:
        print(f"[on] 找不到 {sync_script},请手工 sync 记忆块。")

    # 3. 移除标记
    if DISABLED_MARKER.exists():
        DISABLED_MARKER.unlink()
        print(f"[on] 删除标记 {DISABLED_MARKER.name}")
    print("[on] 完成。/reread 或双击 重启TG.bat 生效。")
    return 0


def cmd_status() -> int:
    disabled = DISABLED_MARKER.exists()
    has_backup = CLAUDE_MD_ON_BAK.exists()
    claude_text = CLAUDE_MD.read_text(encoding="utf-8") if CLAUDE_MD.exists() else ""
    claude_has_reentry_ref = "reentry.md" in claude_text
    runtime_has_memory = False
    if RUNTIME_INSTR.exists():
        runtime_has_memory = _has_memory_block(RUNTIME_INSTR.read_text(encoding="utf-8"))
    print("记忆系统状态:")
    print(f"  .disabled 标记          : {'存在(off)' if disabled else '不存在(on)'}")
    print(f"  CLAUDE.md 引用 reentry  : {'是' if claude_has_reentry_ref else '否'}")
    print(f"  runtime 记忆块          : {'在(on)' if runtime_has_memory else '不在(off)'}")
    print(f"  CLAUDE.md 有 on-备份    : {'是' if has_backup else '否'}")
    if disabled and (claude_has_reentry_ref or runtime_has_memory):
        print("  → 状态不一致:标记是 off,但某处还挂着。跑 off 重推一下。")
    elif not disabled and not (claude_has_reentry_ref and runtime_has_memory):
        print("  → 状态不一致:标记是 on,但某处没挂上。跑 on 重推一下。")
    else:
        print("  → 一致。")
    return 0


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] not in ("on", "off", "status"):
        print("用法: python memory_toggle.py [on|off|status]")
        return 2
    return {"on": cmd_on, "off": cmd_off, "status": cmd_status}[sys.argv[1]]()


if __name__ == "__main__":
    sys.exit(main())
