#!/usr/bin/env python3
"""drag-skip-gen.py — rule-based skip_ranges for *dragged* syllables/tokens.

Motivation:
- WhisperX Chinese word_segments often come as *single characters*, so classic filler-token matching ("这个"/"那个")
  doesn't work well.
- What we actually want for stutter is often: a single character being held for unusually long (e.g. “我——”).

This script finds long-duration tokens on a small safe allowlist (pronouns/fillers) and emits skip_ranges
aligned to word boundaries.

Usage:
  python3 scripts/drag-skip-gen.py in.whisperx.json out.json --mode normal
  python3 scripts/drag-skip-gen.py in.whisperx.json out.json --mode conservative

Output JSON is compatible with llm-skip-apply.py:
  {"skip_ranges":[{"start":..,"end":..,"reason":"..."}, ...]}
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

# Keep this conservative: only tokens that are rarely meaningful when dragged.
DRAGGABLE = {
    "我", "那", "这", "就", "嗯", "啊", "呃", "额", "欸", "诶",
}

WHITELIST = {"AI", "IP", "SSH", "OpenClaw", "cron", "GitHub", "Vibe", "Coding"}


def load_words(path: Path) -> list[dict]:
    j = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for w in (j.get("word_segments") or []):
        if "start" not in w or "end" not in w:
            continue
        tok = (w.get("word") or "").strip().replace(" ", "")
        out.append({
            "start": float(w["start"]),
            "end": float(w["end"]),
            "word": tok,
        })
    return out


def merge(ranges: list[dict]) -> list[dict]:
    if not ranges:
        return []
    ranges.sort(key=lambda x: x["start"])
    merged = [ranges[0].copy()]
    for r in ranges[1:]:
        cur = merged[-1]
        if r["start"] <= cur["end"] + 0.03:
            cur["end"] = max(cur["end"], r["end"])
            cur["reason"] = cur["reason"] + "+" + r["reason"]
        else:
            merged.append(r.copy())
    return merged


def gen(words: list[dict], mode: str, pad: float) -> list[dict]:
    # thresholds tuned for 25fps talking-head; adjust per clip if needed.
    min_dur = 0.65 if mode == "normal" else 0.85

    ranges: list[dict] = []

    def add(s: float, e: float, reason: str):
        if e <= s:
            return
        ranges.append({
            "start": round(max(0.0, s), 3),
            "end": round(max(0.0, e), 3),
            "reason": reason,
        })

    for w in words:
        tok = w["word"]
        if not tok or tok in WHITELIST:
            continue
        dur = w["end"] - w["start"]
        if tok in DRAGGABLE and dur >= min_dur:
            add(w["start"] - pad, w["end"] + pad, f"drag:{tok}:{dur:.2f}s")

    return merge(ranges)


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
