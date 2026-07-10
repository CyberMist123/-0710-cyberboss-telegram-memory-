#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_janitor.py — janitor.py 的离线验收(不需要 DS_API_KEY,不碰真 memory/)

自己在临时目录里造合成 session jsonl(格式同 Claude Code 会话日志),
用 JANITOR_MOCK=1 跑 janitor,逐项验证:
  1. 断档检测:新增行被识别,dry-run 报告规模且零调用、零写入
  2. 位点推进:state 文件记录的 lines_done 与实际行数一致
  3. 幂等:连跑两次,第二次 api_calls=0,候选文件不变
  4. 增量:fixture 追加新行(模拟 /new 断档)→ 再跑,只处理新增部分
  5. 候选格式:episodes.candidates.jsonl 每行合法 JSON,id 为 cand- 前缀
  6. 铁律:memory 目录下除候选文件/位点/缓存外,不产生也不改动任何手工文件

用法:python memory-kit/tests/test_janitor.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
JANITOR = KIT / "janitor.py"

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [ok] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")


def run(args, extra_env=None):
    env = dict(os.environ)
    env["JANITOR_MOCK"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    if extra_env:
        env.update(extra_env)
    r = subprocess.run([sys.executable, str(JANITOR)] + args,
                       capture_output=True, text=True, encoding="utf-8", env=env)
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr)
        raise RuntimeError(f"janitor 退出码 {r.returncode}")
    return r.stdout


def api_calls(stdout):
    m = re.search(r"api_calls=(\d+)", stdout)
    return int(m.group(1)) if m else -1


def turn(ts, role, text):
    return json.dumps({"type": role, "timestamp": ts,
                       "message": {"content": text}}, ensure_ascii=False)


def turn_blocks(ts, role, text):
    """assistant 消息常见的 content 块数组格式"""
    return json.dumps({"type": role, "timestamp": ts,
                       "message": {"content": [{"type": "text", "text": text}]}},
                      ensure_ascii=False)


def noise():
    """应被解析器忽略的行:meta / sidechain / 工具碎片 / 命令"""
    return [
        json.dumps({"type": "user", "isMeta": True,
                    "message": {"content": "meta 行"}}),
        json.dumps({"type": "assistant", "isSidechain": True,
                    "message": {"content": "sidechain 行"}}),
        json.dumps({"type": "system", "subtype": "tool_result", "content": "工具输出"}),
        json.dumps({"type": "user", "timestamp": "2026-07-01T10:00:00Z",
                    "message": {"content": "/status"}}),
        "这不是合法JSON",
    ]


def write_fixtures(input_dir: Path):
    """3 个模拟 session,内容和轮数各不同"""
    s1 = [turn("2026-07-01T05:08:00Z", "user", "1"),
          turn_blocks("2026-07-01T05:08:30Z", "assistant", "醒这么早,还是没睡?"),
          turn("2026-07-01T05:09:00Z", "user", "被抓到了")] + noise()
    s2 = [turn("2026-07-02T21:00:00Z", "user", "今天有点累,不想说话"),
          turn_blocks("2026-07-02T21:00:40Z", "assistant", "那就不说,我在。")]
    s3 = noise()  # 纯噪音 session:应被扫到但零轮
    (input_dir / "session-aaa.jsonl").write_text("\n".join(s1) + "\n", encoding="utf-8")
    (input_dir / "session-bbb.jsonl").write_text("\n".join(s2) + "\n", encoding="utf-8")
    (input_dir / "session-ccc.jsonl").write_text("\n".join(s3) + "\n", encoding="utf-8")


def snapshot(d: Path):
    return {p.relative_to(d).as_posix(): p.read_bytes()
            for p in sorted(d.rglob("*")) if p.is_file()}


def main():
    tmp = Path(tempfile.mkdtemp(prefix="janitor_test_"))
    input_dir = tmp / "sessions"
    outdir = tmp / "memory"
    input_dir.mkdir()
    outdir.mkdir()
    # 预置一个"手工文件",验证 janitor 不碰它
    manual = outdir / "reentry.md"
    manual.write_text("手工 reentry,谁都不许动\n", encoding="utf-8")
    write_fixtures(input_dir)
    base = [f"--input={input_dir}", f"--outdir={outdir}"]
    cand = outdir / "episodes.candidates.jsonl"
    state_path = outdir / ".janitor_state.json"

    print("== 1. dry-run:报告断档,零调用零写入 ==")
    before = snapshot(outdir)
    out = run(base + ["--dry-run"])
    check("dry-run 零 API 调用", api_calls(out) == 0, out)
    check("dry-run 识别出断档行数", "新增" in out and "session-aaa.jsonl" in out)
    check("dry-run 不写任何文件", snapshot(outdir) == before)

    print("== 2. 首跑:断档检测 + 位点推进 + 候选格式 ==")
    out = run(base)
    calls1 = api_calls(out)
    check("首跑有 API 调用(2 个有效 session → 2 块)", calls1 == 2, f"calls={calls1}")
    check("候选文件已生成", cand.exists())
    ids = set()
    fmt_ok = True
    required = {"id", "title", "what_happened", "importance", "source"}
    for line in cand.read_text(encoding="utf-8").splitlines():
        try:
            e = json.loads(line)
        except Exception:
            fmt_ok = False
            break
        if not e["id"].startswith("cand-") or not required <= set(e):
            fmt_ok = False
            break
        ids.add(e["id"])
    check("候选每行合法 JSON、cand- 前缀、字段齐全", fmt_ok and len(ids) == 2,
          f"ids={ids}")
    check("reentry.extracted.md 已生成且标明是参考件",
          "候选" in (outdir / "reentry.extracted.md").read_text(encoding="utf-8"))
    st = json.loads(state_path.read_text(encoding="utf-8"))
    lines_aaa = len((input_dir / "session-aaa.jsonl").read_text(encoding="utf-8").splitlines())
    check("位点=文件实际行数(aaa)",
          st["files"]["session-aaa.jsonl"]["lines_done"] == lines_aaa, str(st))
    check("纯噪音 session 位点也推进(不反复扫)",
          st["files"].get("session-ccc.jsonl", {}).get("lines_done", -1) > 0, str(st))
    check("手工文件未被动过",
          manual.read_text(encoding="utf-8") == "手工 reentry,谁都不许动\n")

    print("== 3. 幂等:第二次零调用、候选不变 ==")
    cand_before = cand.read_bytes()
    out = run(base)
    check("第二跑 api_calls=0", api_calls(out) == 0, out)
    check("候选文件字节级不变", cand.read_bytes() == cand_before)

    print("== 4. 增量:模拟 /new 后的新断档 ==")
    with open(input_dir / "session-aaa.jsonl", "a", encoding="utf-8") as f:
        f.write(turn("2026-07-03T02:00:00Z", "user", "又是我,刚崩了个窗口") + "\n")
        f.write(turn_blocks("2026-07-03T02:00:30Z", "assistant", "回来了就好。") + "\n")
    (input_dir / "session-ddd.jsonl").write_text(
        turn("2026-07-04T09:00:00Z", "user", "新 session 的断档内容") + "\n" +
        turn_blocks("2026-07-04T09:00:20Z", "assistant", "收到。") + "\n",
        encoding="utf-8")
    out = run(base)
    calls3 = api_calls(out)
    check("只为新增内容调用(2 个断档 → 2 块)", calls3 == 2, f"calls={calls3}")
    new_ids = set()
    for line in cand.read_text(encoding="utf-8").splitlines():
        new_ids.add(json.loads(line)["id"])
    check("候选追加而非覆盖", ids < new_ids and len(new_ids) == 4, f"ids={new_ids}")
    st = json.loads(state_path.read_text(encoding="utf-8"))
    lines_aaa2 = len((input_dir / "session-aaa.jsonl").read_text(encoding="utf-8").splitlines())
    check("aaa 位点推进到新行数", st["files"]["session-aaa.jsonl"]["lines_done"] == lines_aaa2)
    check("新 session 进入位点表", "session-ddd.jsonl" in st["files"])
    out = run(base)
    check("增量后再跑仍幂等", api_calls(out) == 0, out)

    print("== 5. 产物白名单:memory 下只多了候选/位点/缓存 ==")
    produced = set(snapshot(outdir)) - set(before)
    allowed = all(p in ("episodes.candidates.jsonl", "reentry.extracted.md",
                        ".janitor_state.json")
                  or p.startswith(".cache/") for p in produced)
    check("没有越界写入其他文件", allowed, str(produced))

    print(f"\n结果:{PASS} 通过,{FAIL} 失败(fixture 目录:{tmp})")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
