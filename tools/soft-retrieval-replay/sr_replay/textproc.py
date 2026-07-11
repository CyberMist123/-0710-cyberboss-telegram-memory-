"""中文分词。

builtin 后端：自定义词典最长匹配优先（暗语、人名、地名不被切碎），
其余 CJK 串回退为字符二元组（bigram）——中文 BM25 的稳健基线。
可选 jieba 后端（机器上装了 jieba 时在 config 里切换），词典同样生效。
"""

import re
from pathlib import Path

_SEG = re.compile(r"[一-鿿]+|[A-Za-z0-9_]+")
_ASCII = re.compile(r"[A-Za-z0-9_]+")


class Tokenizer:
    def __init__(self, backend: str = "builtin", user_dict: str | None = None):
        self.words: set[str] = set()
        if user_dict and Path(user_dict).exists():
            for line in Path(user_dict).read_text(encoding="utf-8").splitlines():
                w = line.strip().split()[0] if line.strip() else ""
                if w and not w.startswith("#"):
                    self.words.add(w)
        self.maxlen = max((len(w) for w in self.words), default=0)
        self.backend = backend
        self._jieba = None
        if backend == "jieba":
            try:
                import jieba  # type: ignore

                jb = jieba.Tokenizer()
                for w in self.words:
                    jb.add_word(w)
                self._jieba = jb
            except ImportError:  # 回退，不中断
                self.backend = "builtin"

    def _cjk_tokens(self, seg: str) -> list[str]:
        out: list[str] = []
        i, run_start = 0, 0

        def flush(run: str):
            if not run:
                return
            if len(run) == 1:
                out.append(run)
            else:
                out.extend(run[j : j + 2] for j in range(len(run) - 1))

        while i < len(seg):
            matched = None
            for L in range(min(self.maxlen, len(seg) - i), 1, -1):
                if seg[i : i + L] in self.words:
                    matched = seg[i : i + L]
                    break
            if matched:
                flush(seg[run_start:i])
                out.append(matched)
                i += len(matched)
                run_start = i
            else:
                i += 1
        flush(seg[run_start:i])
        return out

    def tokenize(self, text: str) -> list[str]:
        if self._jieba is not None:
            return [t for t in self._jieba.lcut(text) if t.strip()]
        out: list[str] = []
        for m in _SEG.finditer(text):
            seg = m.group(0)
            if _ASCII.fullmatch(seg):
                out.append(seg.lower())
            else:
                out.extend(self._cjk_tokens(seg))
        return out
