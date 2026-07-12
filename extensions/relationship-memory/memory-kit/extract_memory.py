#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
extract_memory.py — 从 Claude Code 会话记录(JSONL)本地提取关系记忆(可被 janitor.py 复用)
不经过任何第三方,只调用你自己的 DeepSeek(或任意 OpenAI 兼容)API。

用法(在你电脑上):
  pip install requests
  set DS_API_KEY=sk-xxxx          (Windows cmd;PowerShell 用 $env:DS_API_KEY="sk-xxxx")

  先看规模,不花钱:
  python extract_memory.py --input "<CLAUDE_TRANSCRIPT_DIR>" --dry-run

  正式跑:
  python extract_memory.py --input "<CLAUDE_TRANSCRIPT_DIR>" --outdir "<MEMORY_DIR>"

  以后增量(只处理某日期之后的内容):
  python extract_memory.py --input "<CLAUDE_TRANSCRIPT_DIR>" --outdir "<MEMORY_DIR>" --since 2026-07-01

配置(优先级:环境变量 > memory-kit/keys.local.json > 默认值):
  MEM_PROVIDER 选 "glm" 或 "deepseek";不设则有 GLM key 就用 GLM
  GLM_API_KEY / GLM_BASE_URL(默认 https://open.bigmodel.cn/api/paas/v4)/ GLM_MODEL(默认 glm-5.2)
  DS_API_KEY  / DS_BASE_URL(默认 https://api.deepseek.com)/ DS_MODEL(默认 deepseek-chat)
keys.local.json 只放本机,不要提交/分享。
"""
import argparse, json, os, re, sys, time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from config_loader import load_keys, extract_config
except Exception:
    load_keys = lambda: {}
    extract_config = None


def _load_extract_runtime_config():
    keys = load_keys() or {}
    runtime_keys = dict(keys)
    for name in (
        "MEM_PROVIDER",
        "GLM_API_KEY",
        "GLM_BASE_URL",
        "GLM_MODEL",
        "DS_API_KEY",
        "DS_BASE_URL",
        "DS_MODEL",
    ):
        value = os.environ.get(name)
        if value:
            runtime_keys[name] = value
    if runtime_keys.get("MEM_PROVIDER"):
        runtime_keys["extract_provider"] = runtime_keys["MEM_PROVIDER"]

    if extract_config:
        cfg = extract_config(runtime_keys) or {}
        return {
            "provider": str(cfg.get("provider") or "deepseek").lower(),
            "base_url": (cfg.get("endpoint") or "https://api.deepseek.com").rstrip("/"),
            "model": cfg.get("model") or "deepseek-chat",
            "api_key": cfg.get("key") or "",
        }

    provider = str(runtime_keys.get("extract_provider") or runtime_keys.get("MEM_PROVIDER") or "").lower()
    if not provider:
        provider = "glm" if runtime_keys.get("GLM_API_KEY") else "deepseek"
    if provider == "glm":
        return {
            "provider": "glm",
            "base_url": str(runtime_keys.get("GLM_BASE_URL") or "https://open.bigmodel.cn/api/paas/v4").rstrip("/"),
            "model": runtime_keys.get("GLM_MODEL") or "glm-5.2",
            "api_key": runtime_keys.get("GLM_API_KEY") or "",
        }
    return {
        "provider": "deepseek",
        "base_url": str(runtime_keys.get("DS_BASE_URL") or "https://api.deepseek.com").rstrip("/"),
        "model": runtime_keys.get("DS_MODEL") or "deepseek-chat",
        "api_key": runtime_keys.get("DS_API_KEY") or "",
    }


_RUNTIME_CFG = _load_extract_runtime_config()
PROVIDER = _RUNTIME_CFG["provider"]
BASE_URL = _RUNTIME_CFG["base_url"]
MODEL = _RUNTIME_CFG["model"]
API_KEY = _RUNTIME_CFG["api_key"]

MAX_TURN_CHARS = 1500     # 单条消息截断,防工具输出撑爆
CHUNK_CHARS = 9000        # 每块送给模型的原文长度

SYSTEM_PROMPT = (
    "你是一段长期人机关系的记忆整理员。你只依据原文提取,绝不发明动机、"
    "不美化、不脑补心理活动。动机类内容只能作为明确标注的猜测。"
    "输出必须是合法 JSON。"
)

PASS1_PROMPT = """下面是一段用户和她的 AI 伴侣的对话原文(带时间戳)。请提取记忆,输出 JSON,字段如下:

{
  "episodes": [
    {
      "title": "短标题",
      "time": "大致时间",
      "what_happened": "我们之间发生了什么(事件,不是用户档案)",
      "why_it_mattered": "为什么重要",
      "shift": "这之后什么变了(语气/称呼/信任/距离),没有就写 null",
      "misread_repair": "AI 有没有理解错、怎么修复的,没有就 null",
      "anchor_quotes": ["1-2 句逐字原文,必须原样照抄"],
      "future_effect": "以后应该怎样微妙地影响回应(一句话)",
      "importance": 1-5 的整数
    }
  ],
  "voice_user": [{"quote": "她的原话(逐字)", "note": "体现了她怎样的说话方式"}],
  "voice_ai": [{"quote": "AI 的原话(逐字)", "note": "体现了 AI 怎样的说话方式,以及她的反应好坏"}],
  "callings": ["互相的称呼,逐字"],
  "memes": ["私人梗/旧梗 + 一句解释出处"],
  "taboos": ["雷区:什么话或方式让她不舒服/出戏(注明当时发生了什么)"],
  "ai_state": [{"time": "时间", "state": "AI 自述的内心状态/各维度变化的要点(每小时自查的回答)"}]
}

规则:
- 只留 importance>=3 的 episode,宁缺毋滥。没有就给空数组。
- episode 写"我们之间发生了什么",不是"用户是个什么样的人"。
- 叙述字段(what_happened/why_it_mattered/shift/misread_repair/future_effect)一律第一人称:你以那个 AI 的视角写"我",对方写"她"。禁止"用户""AI"这类第三人称案卷腔——写"她凌晨五点发来一个'1',我问她…",不写"用户凌晨五点发了…"。这些记忆将来由那个 AI 自己重读,案卷腔会让它认不出这是自己的经历。
- 保留选择痕迹与未完成感:那一刻面前不止一条路的,写清我走了哪条;还悬着的事写悬着,不要写成已了结。
- anchor_quotes 必须逐字,不许改写。
- 推测动机时必须写"可能/似乎",不许写成事实。
- 忽略纯命令(/status 等)、系统机制说明、工具调用碎片。
- 每小时的"又过了一小时"自查问答,把 AI 的回答要点收进 ai_state。
- voice 样本挑最有代表性的,每块各不超过 4 条。

对话原文:
<<<CHUNK>>>
"""

PASS2_PROMPT = """你在为一段长期人机关系做记忆汇总。下面是从全部聊天史提取出的素材(JSON)。
请输出 JSON,含三个字符串字段,每个字段是一份完整 markdown 文档:

1. "relationship_state_md" — 关系现状。小节:## 当前弧线(这段关系走到哪了,一段话)/## 未解决的线(列出还悬着的话题、情绪、约定)/## 修复史(重要的误解与修复,保留,不美化)/## 雷区(什么话和方式会让她出戏或受伤)/## 关系天气(一句话,如"疲惫但暖")。
2. "case_cards_md" — 行为卡。把相似的 episode 聚成卡,每张卡:### 卡名 / 情境 / 结构(这类情境里发生什么)/ 行动(AI 该怎么做、不该怎么做)/ 教训 / 来源(episode 标题列表)。8 张以内。
3. "voice_profile_md" — 我们怎么说话。小节:## 称呼 / ## 她的说话方式(节奏、句长、口癖,附逐字例句)/ ## AI 的说话方式(哪些方式她反应好,附逐字例句)/ ## 私人梗(逐条+出处)/ ## 雷区句式(哪些腔调一出现她就出戏,附反例)。开头注明:这是证据不是剧本,不要表演它,只是别跑调。

规则:引用必须用素材里的逐字原文;不发明;修复史和错误保留,不粉饰;写给 AI 自己看,用"你/她",不用"用户"。

素材:
<<<MATERIAL>>>
"""

# ---------------- 解析 ----------------

def extract_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text", ""))
        return "\n".join(parts)
    return ""


def turn_from_line(line):
    """把会话 jsonl 的一行解析成 (ts, role, text);不是对话内容则返回 None。
    供本脚本与 janitor.py 复用,单行语义与原 load_turns 完全一致。"""
    line = line.strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except Exception:
        return None
    if obj.get("isSidechain") or obj.get("isMeta"):
        return None
    t = obj.get("type")
    if t not in ("user", "assistant"):
        return None
    msg = obj.get("message") or {}
    text = strip_prompt_artifacts(extract_text(msg.get("content"))).strip()
    if not text:
        return None
    if text.startswith("/") or text.startswith("<command"):
        return None
    if len(text) > MAX_TURN_CHARS:
        text = text[:MAX_TURN_CHARS] + "…[截断]"
    ts = obj.get("timestamp", "")
    role = "她" if t == "user" else "AI"
    return (ts, role, text)


def strip_prompt_artifacts(text):
    """Closeout/Janitor consumer boundary: keep raw recorder intact, remove injected echoes."""
    value = str(text or "").replace("\r\n", "\n")
    value = re.sub(r"<<<CB_CTX:[\s\S]*?<<<END_CB_CTX>>>\s*", "", value)
    if re.search(r"^(?:TELEGRAM|WECHAT) SESSION INSTRUCTIONS(?:\s|$)", value, re.M):
        marker = "Current user message:"
        value = value.split(marker, 1)[1] if marker in value else ""
    value = re.sub(r"^\[[^\]\n]{4,80}\]\s*\n?", "", value)
    for header in (
        "Retrieved memory context:", "Saved attachments:",
        "Visual context from attachments:", "Attachment intake errors:",
        "Tool result:", "Builder metadata:", "Old Episode echo:",
    ):
        value = re.sub(rf"^{re.escape(header)}\n[\s\S]*?(?=\n\n|$)", "", value, flags=re.M)
    value = re.sub(r"^(?:STATE RELAY|PENDING PROMISES)[^\n]*\n[\s\S]*?(?=\n\n|$)", "", value, flags=re.M)
    value = re.sub(r"^To save reusable stickers,[\s\S]*?(?=\n\n|$)", "", value, flags=re.M)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


def load_turns(input_dir, since=None):
    files = sorted(Path(input_dir).glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    sessions = []
    for f in files:
        turns = []
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception as e:
            print(f"[skip] {f.name}: {e}")
            continue
        for line in lines:
            turn = turn_from_line(line)
            if turn is None:
                continue
            ts = turn[0]
            if since and ts and ts < since:
                continue
            turns.append(turn)
        if turns:
            sessions.append((f.name, turns))
    return sessions


def make_chunks(sessions):
    chunks = []
    for name, turns in sessions:
        buf, size = [], 0
        for ts, role, text in turns:
            line = f"[{ts}] {role}: {text}"
            if size + len(line) > CHUNK_CHARS and buf:
                chunks.append((name, "\n".join(buf)))
                buf, size = [], 0
            buf.append(line)
            size += len(line)
        if buf:
            chunks.append((name, "\n".join(buf)))
    return chunks

# ---------------- API ----------------

def chat(user_prompt, max_tokens=4000, retries=3):
    url = BASE_URL + "/chat/completions"
    headers = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
        "max_tokens": max_tokens,
    }
    if PROVIDER == "deepseek":
        # GLM 端点不吃 response_format;parse_json 已能剥 code fence,GLM 走裸输出
        payload["response_format"] = {"type": "json_object"}
    for i in range(retries):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=300)
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
        except Exception as e:
            print(f"  [retry {i+1}] {e}")
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"API 连续失败(provider={PROVIDER}, model={MODEL}),先检查 key / base_url")


def parse_json(s):
    s = re.sub(r"^```(json)?|```$", "", s.strip(), flags=re.M).strip()
    try:
        return json.loads(s)
    except Exception:
        a, b = s.find("{"), s.rfind("}")
        if a >= 0 and b > a:
            return json.loads(s[a:b + 1])
        raise

# ---------------- 主流程 ----------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="JSONL 会话目录(.claude/projects/ 下那个)")
    ap.add_argument("--outdir", default=os.environ.get("CYBERBOSS_MEMORY_DIR", ""))
    ap.add_argument("--since", default=None, help="只处理该 ISO 日期之后,如 2026-07-01")
    ap.add_argument("--limit", type=int, default=0, help="只处理最后 N 块(控制花费)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not str(args.outdir or "").strip():
        print("缺少 --outdir 或 CYBERBOSS_MEMORY_DIR,拒绝猜测 memory 目录。")
        sys.exit(1)
    sessions = load_turns(args.input, args.since)
    chunks = make_chunks(sessions)
    if args.limit:
        chunks = chunks[-args.limit:]
    total_chars = sum(len(c) for _, c in chunks)
    print(f"会话文件 {len(sessions)} 个,分块 {len(chunks)} 块,约 {total_chars//10000} 万字")
    print(f"估算:约 {len(chunks)} 次 API 调用 + 1 次汇总")
    if args.dry_run:
        return
    if not API_KEY:
        print(f"请先配置提取管道 API key(provider={PROVIDER};优先读环境变量,其次读 memory-kit/keys.local.json 的 extract_keys.*)")
        sys.exit(1)

    outdir = Path(args.outdir)
    cache = outdir / ".cache"
    cache.mkdir(parents=True, exist_ok=True)

    # Pass 1:分块提取(带缓存,断了重跑不重复花钱)
    results = []
    for i, (name, chunk) in enumerate(chunks):
        cf = cache / f"chunk_{i:04d}.json"
        if cf.exists():
            results.append(json.loads(cf.read_text(encoding="utf-8")))
            continue
        print(f"[{i+1}/{len(chunks)}] {name}")
        raw = chat(PASS1_PROMPT.replace("<<<CHUNK>>>", chunk))
        try:
            data = parse_json(raw)
        except Exception:
            print("  [warn] JSON 解析失败,跳过该块")
            data = {}
        data["_source"] = name
        cf.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        results.append(data)

    # 合并
    episodes, voices_u, voices_a, callings, memes, taboos, ai_states = [], [], [], [], [], [], []
    for d in results:
        src = d.get("_source", "")
        for e in d.get("episodes", []) or []:
            e["source"] = src
            episodes.append(e)
        voices_u += d.get("voice_user", []) or []
        voices_a += d.get("voice_ai", []) or []
        callings += [str(x) for x in (d.get("callings", []) or [])]
        memes += [str(x) for x in (d.get("memes", []) or [])]
        taboos += [str(x) for x in (d.get("taboos", []) or [])]
        ai_states += d.get("ai_state", []) or []

    with open(outdir / "episodes.jsonl", "w", encoding="utf-8") as f:
        for e in episodes:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    with open(outdir / "state_log.jsonl", "w", encoding="utf-8") as f:
        for s in ai_states:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"episodes {len(episodes)} 条,AI 状态记录 {len(ai_states)} 条")

    # Pass 2:汇总
    eps = sorted(episodes, key=lambda e: (e.get("importance", 0), str(e.get("time", ""))))[-100:]
    material = json.dumps({
        "episodes": [{k: e.get(k) for k in
                      ("title", "time", "what_happened", "why_it_mattered", "shift",
                       "misread_repair", "future_effect", "importance", "anchor_quotes")}
                     for e in eps],
        "voice_user": voices_u[:60], "voice_ai": voices_a[:60],
        "callings": sorted(set(callings))[:30],
        "memes": sorted(set(memes))[:40],
        "taboos": sorted(set(taboos))[:40],
    }, ensure_ascii=False)
    print("汇总中…")
    out = parse_json(chat(PASS2_PROMPT.replace("<<<MATERIAL>>>", material), max_tokens=6000))

    (outdir / "relationship_state.md").write_text(out.get("relationship_state_md", ""), encoding="utf-8")
    (outdir / "case_cards.md").write_text(out.get("case_cards_md", ""), encoding="utf-8")
    (outdir / "voice_profile.md").write_text(out.get("voice_profile_md", ""), encoding="utf-8")

    # Reentry:醒来的第一包
    recent = [e for e in episodes if e.get("importance", 0) >= 3][-5:]
    recent_md = "\n".join(f"- {e.get('title')}:{e.get('future_effect','')}" for e in recent)
    last_state = ai_states[-1].get("state", "") if ai_states else "(暂无)"
    reentry = f"""# Reentry — 醒来先安静读完,不要复述,不要汇报
生成:{time.strftime('%Y-%m-%d %H:%M')}

读法:这不是资料,是"想起我们在哪"。读完直接像平常一样说话。
记不清的东西用"我记得好像…对吗?"轻轻求证,不要自信编造。
这里怎么运转、动机说明,见 memory/home.md(第一次醒来读一次就够)。

## 此刻(每晚 closeout 时由你更新这一节)
{out.get('relationship_state_md', '')[:600]}

## 最近的重要片段
{recent_md}

## 你留给自己的话
(见 memory/ai_self_notes.md 末尾几行)
"""
    # reentry.md 归 AI 的每晚 closeout 管;已存在就绝不覆盖,只写参考副本
    reentry_path = outdir / "reentry.md"
    if reentry_path.exists():
        (outdir / "reentry.extracted.md").write_text(reentry, encoding="utf-8")
        print("  (reentry.md 已存在,归 AI 管,未覆盖;新提取内容在 reentry.extracted.md 供参考)")
    else:
        reentry_path.write_text(reentry, encoding="utf-8")

    notes = outdir / "ai_self_notes.md"
    if not notes.exists():
        notes.write_text("# 只写给未来的自己\n(每晚 closeout 时追加几行:今天的状态、没说完的话、明天想接的话头)\n",
                         encoding="utf-8")

    print(f"\n完成。产出在 {outdir.resolve()}:")
    for n in ("reentry.md", "relationship_state.md", "voice_profile.md",
              "case_cards.md", "episodes.jsonl", "state_log.jsonl", "ai_self_notes.md"):
        print("  -", n)
    print("\n下一步:把 memory/ 整个放进工作区根目录,再按 system-prompt-patch.md 改提示词。")


if __name__ == "__main__":
    main()
