#!/usr/bin/env python3
"""stutter-skip-gen.py — generate skip_ranges for stutter/fillers from WhisperX word_segments.

This is a *first-pass* automation to remove common spoken disfluencies:
- fillers: 嗯/啊/呃/这个/那个/就是/然后…
- repeats: same token repeated quickly (e.g. 我 我)
- partial restart: prefix token followed by longer token (e.g. 编 → 编程)

It outputs JSON compatible with llm-skip-apply.py:
  {"skip_ranges":[{"start":..,"end":..,"reason":"..."}, ...]}

NOTE:
- This is rule-based. It’s meant to produce good candidates and be safe.
- Keep boundaries aligned to word start/end with small padding.

Usage:
  python3 scripts/stutter-skip-gen.py in.whisperx.json out.json --mode normal
  python3 scripts/stutter-skip-gen.py in.whisperx.json out.json --mode conservative
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


FILLERS = {
    "嗯", "啊", "呃", "额", "欸", "诶",
    "这个", "那个", "就是", "然后", "其实", "可能", "反正", "怎么说",
    "你知道", "我觉得", "就是说", "相当于", "基本上",
}

# tokens that are meaningful in a tech clip and should never be auto-dropped
WHITELIST = {"OpenClaw", "AI", "cron", "GitHub", "skills", "Vibe", "Coding"}


def norm(t: str) -> str:
    return (t or "").strip()


def load_words(path: Path) -> list[dict]:
    j = json.loads(path.read_text(encoding="utf-8"))
    words = j.get("word_segments") or []
    out = []
    for w in words:
        if "start" not in w or "end" not in w:
            continue
        out.append({
            "start": float(w["start"]),
            "end": float(w["end"]),
            "word": norm(w.get("word", "")),
        })
    return out


def is_filler_token(tok: str) -> bool:
    if tok in WHITELIST:
        return False
    if tok in FILLERS:
        return True
    # single char filler (like 嗯 啊) is covered above
    return False


def gen(words: list[dict], mode: str, pad: float) -> list[dict]:
    ranges: list[dict] = []

    def add(s: float, e: float, reason: str):
        if e <= s:
            return
        ranges.append({
            "start": max(0.0, round(s, 3)),
            "end": max(0.0, round(e, 3)),
            "reason": reason,
        })

    # 1) fillers
    if mode == "normal":
        for w in words:
            tok = w["word"]
            dur = w["end"] - w["start"]
            if is_filler_token(tok) and dur <= 0.45:
                add(w["start"] - pad, w["end"] + pad, f"filler:{tok}")

    # 2) repeats (same token quickly repeated)
    def is_likely_word(tok: str) -> bool:
        # Avoid trimming single latin letters like "l" from spelling (skills etc.)
        if not tok:
            return False
        if tok.isascii() and tok.isalpha() and len(tok) <= 2:
            return False
        return True

    for i in range(1, len(words)):
        a, b = words[i - 1], words[i]
        if not a["word"] or not b["word"]:
            continue
        if not is_likely_word(a["word"]):
            continue
        gap = b["start"] - a["end"]
        if gap < 0:
            gap = 0
        if gap <= 0.22 and a["word"] == b["word"] and a["word"] not in WHITELIST:
            # drop the first one if both are short
            if (a["end"] - a["start"]) <= 0.5 and (b["end"] - b["start"]) <= 0.6:
                add(a["start"] - pad, a["end"] + pad, f"repeat:{a['word']}")

    # 3) partial restart (prefix → longer)
    for i in range(1, len(words)):
        a, b = words[i - 1], words[i]
        wa, wb = a["word"], b["word"]
        if not wa or not wb:
            continue
        gap = b["start"] - a["end"]
        if gap < 0:
            gap = 0
        # chinese-char prefix; keep conservative on timing
        if gap <= 0.3 and len(wa) == 1 and wb.startswith(wa) and wb != wa:
            if wa not in WHITELIST and wb not in WHITELIST:
                add(a["start"] - pad, a["end"] + pad, f"restart:{wa}->{wb}")

    # merge overlaps
    if not ranges:
        return []
    merged = []
    ranges.sort(key=lambda x: x["start"])
    cur = ranges[0].copy()
    for r in ranges[1:]:
        if r["start"] <= cur["end"] + 0.02:
            cur["end"] = max(cur["end"], r["end"])
            cur["reason"] = cur["reason"] + "+" + r["reason"]
        else:
            merged.append(cur)
            cur = r.copy()
    merged.append(cur)
    return merged


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("whisperx_json")
    ap.add_argument("out_json")
    ap.add_argument("--mode", choices=["conservative", "normal"], default="normal")
    ap.add_argument("--pad", type=float, default=0.03)
    args = ap.parse_args()

    inp = Path(args.whisperx_json).expanduser().resolve()
    out = Path(args.out_json).expanduser().resolve()

    words = load_words(inp)
    skip = gen(words, mode=args.mode, pad=args.pad)

    out.write_text(json.dumps({"skip_ranges": skip}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(str(out))


if __name__ == "__main__":
    main()
