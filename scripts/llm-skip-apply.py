#!/usr/bin/env python3
"""llm-skip-apply.py — apply LLM-proposed skip ranges to a clip using trim/atrim+concat.

Why:
- We avoid select/aselect (can cause A/V drift on long clips)
- Keep A/V sync by rebuilding timeline with concat

Input:
- clip mp4
- skip json file (produced by an LLM), format:
  {"skip_ranges":[{"start":..,"end":..,"reason":"..."}, ...]}

Output:
- <clip>-llm.mp4 (default)

IMPORTANT (2026-03-04):
- Do NOT use `acrossfade` to join audio while video is concatenated.
  `acrossfade` overlaps audio segments and shortens the total audio duration,
  which will inevitably cause audio/video desync later in the clip.
- Instead: optional *non-overlapping* fade-in/out per segment + audio concat.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def ffprobe_duration(path: Path) -> float:
    p = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(p.stdout.strip())


def merge_ranges(ranges: list[tuple[float, float]], pad: float = 0.0) -> list[tuple[float, float]]:
    cleaned: list[tuple[float, float]] = []
    for s, e in ranges:
        s = float(s) - pad
        e = float(e) + pad
        if e <= s:
            continue
        if s < 0:
            s = 0.0
        cleaned.append((s, e))
    if not cleaned:
        return []
    cleaned.sort()
    merged = [cleaned[0]]
    for s, e in cleaned[1:]:
        ps, pe = merged[-1]
        if s <= pe + 0.02:
            merged[-1] = (ps, max(pe, e))
        else:
            merged.append((s, e))
    return merged


def invert_to_keeps(skips: list[tuple[float, float]], duration: float) -> list[tuple[float, float]]:
    keeps: list[tuple[float, float]] = []
    prev = 0.0
    for s, e in skips:
        if s > prev + 0.02:
            keeps.append((prev, s))
        prev = max(prev, e)
    if prev < duration - 0.02:
        keeps.append((prev, duration))
    return keeps


def build_filter_complex(keeps: list[tuple[float, float]], afade: float = 0.03) -> str:
    """Build a sync-safe filter graph.

    Video: trim+setpts each keep → concat
    Audio: atrim+asetpts each keep → optional (non-overlapping) fade in/out → concat

    Note: `acrossfade` is intentionally avoided to prevent timeline shrink.
    """

    lines: list[str] = []
    n = len(keeps)

    for i, (s, e) in enumerate(keeps):
        seg_dur = max(0.0, float(e) - float(s))

        # Video
        lines.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}]")

        # Audio
        a_chain = f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS"
        fade = max(0.0, float(afade))
        if fade >= 0.005 and seg_dur >= fade * 2 + 0.02:
            # Non-overlapping fades to reduce clicks while keeping duration unchanged
            out_st = seg_dur - fade
            a_chain += f",afade=t=in:st=0:d={fade:.3f},afade=t=out:st={out_st:.3f}:d={fade:.3f}"
        lines.append(a_chain + f"[a{i}]")

    v_concat = "".join(f"[v{i}]" for i in range(n))
    a_concat = "".join(f"[a{i}]" for i in range(n))
    lines.append(f"{v_concat}concat=n={n}:v=1:a=0[outv]")
    lines.append(f"{a_concat}concat=n={n}:v=0:a=1[outa]")

    return ";".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("skip_json")
    ap.add_argument("--out")
    ap.add_argument("--pad", type=float, default=0.05, help="pad seconds around each skip range")
    ap.add_argument("--afade", type=float, default=0.03, help="audio fade-in/out seconds per segment (non-overlap)")
    args = ap.parse_args()

    clip = Path(args.clip).expanduser().resolve()
    skip_json = Path(args.skip_json).expanduser().resolve()

    j = json.loads(skip_json.read_text(encoding="utf-8"))
    raw = j.get("skip_ranges") or []
    ranges = [(float(x["start"]), float(x["end"])) for x in raw if "start" in x and "end" in x]

    dur = ffprobe_duration(clip)
    skips = merge_ranges(ranges, pad=args.pad)
    keeps = invert_to_keeps(skips, dur)

    if len(keeps) <= 1:
        raise SystemExit("Nothing to do (keeps<=1).")

    fc = build_filter_complex(keeps, afade=args.afade)

    out = Path(args.out).expanduser().resolve() if args.out else clip.with_name(clip.stem + "-llm.mp4")

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(clip),
        "-filter_complex",
        fc,
        "-map",
        "[outv]",
        "-map",
        "[outa]",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        str(out),
    ]

    subprocess.run(cmd, check=True)
    print(str(out))


if __name__ == "__main__":
    main()
