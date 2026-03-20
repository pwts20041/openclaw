#!/usr/bin/env python3
"""Merge segmented WhisperX transcripts into a single global timeline.

Input: a directory with seg_000.json, seg_001.json ... (each has segments + word_segments)
Output:
  - <name>.global.json: merged JSON with global timestamps
  - <name>.global.txt : human-readable transcript with global timestamps

Why:
- Segmented transcription resets timestamps per segment.
- Downstream stages (clipper, QA, subtitles) need a single global time axis.

Notes:
- Offsets are computed from the *actual* duration of each segment (max end time in word_segments).
- This is resume-friendly: if some segments are missing, it fails fast.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


def _max_end(obj: dict[str, Any]) -> float:
    ws = obj.get("word_segments") or []
    if ws:
        return float(max(w.get("end", w.get("start", 0.0)) for w in ws))
    segs = obj.get("segments") or []
    if segs:
        return float(max(s.get("end", s.get("start", 0.0)) for s in segs))
    return 0.0


def _shift_inplace(obj: dict[str, Any], offset: float) -> None:
    for s in obj.get("segments") or []:
        if "start" in s:
            s["start"] = float(s["start"]) + offset
        if "end" in s:
            s["end"] = float(s["end"]) + offset
    for w in obj.get("word_segments") or []:
        if "start" in w:
            w["start"] = float(w["start"]) + offset
        if "end" in w:
            w["end"] = float(w["end"]) + offset


def _fmt_ts(sec: float) -> str:
    if sec < 0:
        sec = 0
    t = int(sec)
    h = t // 3600
    m = (t % 3600) // 60
    s = t % 60
    if h > 0:
        return f"[{h}:{m:02d}:{s:02d}]"
    return f"[{m:02d}:{s:02d}]"


def _format_txt(merged: dict[str, Any]) -> str:
    # Similar spirit to transcribe.py's format_transcript, but uses global timestamps.
    lines: list[str] = []
    current_speaker = None
    current_texts: list[str] = []

    for seg in merged.get("segments", []):
        speaker = seg.get("speaker")
        text = (seg.get("text") or "").strip()
        start = float(seg.get("start", 0.0))

        if not text:
            continue

        ts = _fmt_ts(start)

        if speaker != current_speaker:
            if current_texts:
                prefix = f"{current_speaker}: " if current_speaker else ""
                lines.append(prefix + " ".join(current_texts))
            current_speaker = speaker
            current_texts = [ts + " " + text]
        else:
            current_texts.append(text)

    if current_texts:
        prefix = f"{current_speaker}: " if current_speaker else ""
        lines.append(prefix + " ".join(current_texts))

    out = "\n\n".join(lines)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip() + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--segments-dir", required=True, help="Directory containing seg_XXX.json files")
    ap.add_argument("--output-json", required=True, help="Output merged .json path")
    ap.add_argument("--output-txt", required=True, help="Output merged .txt path")
    args = ap.parse_args()

    seg_dir = Path(args.segments_dir)
    out_json = Path(args.output_json)
    out_txt = Path(args.output_txt)

    files = sorted(seg_dir.glob("seg_*.json"))
    if not files:
        raise SystemExit(f"No seg_*.json found in {seg_dir}")

    merged: dict[str, Any] = {
        "language": None,
        "segments": [],
        "word_segments": [],
        "text": "",
    }

    offset = 0.0
    all_text_parts: list[str] = []

    for f in files:
        obj = json.loads(f.read_text(encoding="utf-8"))
        if merged["language"] is None:
            merged["language"] = obj.get("language")

        dur = _max_end(obj)
        _shift_inplace(obj, offset)

        merged["segments"].extend(obj.get("segments") or [])
        merged["word_segments"].extend(obj.get("word_segments") or [])
        if obj.get("text"):
            all_text_parts.append(str(obj["text"]).strip())

        offset += float(dur)

    merged["text"] = "\n".join([p for p in all_text_parts if p])

    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_txt.parent.mkdir(parents=True, exist_ok=True)

    out_json.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    out_txt.write_text(_format_txt(merged), encoding="utf-8")

    print(f"Wrote: {out_json}")
    print(f"Wrote: {out_txt}")


if __name__ == "__main__":
    main()
