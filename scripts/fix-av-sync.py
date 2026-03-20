#!/usr/bin/env python3
"""fix-av-sync.py — make audio/video durations match (trim longer stream).

Why:
- Some source clips (or some edit pipelines) end up with audio duration != video duration.
- That creates "音画不同步" feelings, especially near the tail.

Strategy:
- Probe stream durations.
- If |a - v| <= epsilon: copy as-is.
- Else trim the longer stream to the shorter duration.
  - If audio longer: atrim to video duration.
  - If video longer: trim video to audio duration (re-encode video for safe cut).

Usage:
  python3 scripts/fix-av-sync.py in.mp4 out.mp4

Modes:
- trim (default): trim longer stream to shorter duration (fast, mostly for tail mismatch)
- reencode: re-encode with stable timestamps (CFR video + async audio) to kill gradual drift

Notes:
- When trimming video we re-encode video with libx264 to avoid keyframe cut issues.
- When trimming audio only, we stream-copy video and re-encode audio to AAC.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def ffprobe_stream_durations(path: Path) -> tuple[float | None, float | None]:
    p = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    j = json.loads(p.stdout)
    a = None
    v = None
    for s in j.get("streams", []):
        d = s.get("duration")
        if d is None:
            continue
        if s.get("codec_type") == "audio":
            a = float(d)
        elif s.get("codec_type") == "video":
            v = float(d)
    return a, v


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("inp")
    ap.add_argument("out")
    ap.add_argument("--epsilon", type=float, default=0.03)
    ap.add_argument("--mode", choices=["trim", "reencode"], default="trim")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--crf", type=int, default=23)
    ap.add_argument("--preset", default="veryfast")
    ap.add_argument("--ab", default="128k")
    args = ap.parse_args()

    inp = Path(args.inp).expanduser().resolve()
    out = Path(args.out).expanduser().resolve()

    a_dur, v_dur = ffprobe_stream_durations(inp)
    if a_dur is None or v_dur is None:
        # fallback: just remux shortest
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(inp),
            "-c",
            "copy",
            "-shortest",
            str(out),
        ])
        return

    if args.mode == "reencode":
        # Root-cure for gradual drift: reset timestamps, force CFR, async audio resample.
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(inp),
            "-vf",
            f"setpts=PTS-STARTPTS,fps={args.fps}",
            "-af",
            "asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0",
            "-c:v",
            "libx264",
            "-preset",
            str(args.preset),
            "-crf",
            str(args.crf),
            "-c:a",
            "aac",
            "-b:a",
            str(args.ab),
            "-movflags",
            "+faststart",
            "-shortest",
            str(out),
        ])
        return

    # default: trim mode
    diff = a_dur - v_dur
    if abs(diff) <= args.epsilon:
        run(["ffmpeg", "-y", "-i", str(inp), "-c", "copy", str(out)])
        return

    if diff > 0:
        # audio longer → trim audio to video duration
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(inp),
            "-filter_complex",
            f"[0:a]atrim=0:{v_dur:.3f},asetpts=PTS-STARTPTS[a]",
            "-map",
            "0:v:0",
            "-map",
            "[a]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            str(args.ab),
            "-movflags",
            "+faststart",
            str(out),
        ])
    else:
        # video longer → trim video to audio duration (safe cut: re-encode video)
        run([
            "ffmpeg",
            "-y",
            "-i",
            str(inp),
            "-t",
            f"{a_dur:.3f}",
            "-c:v",
            "libx264",
            "-preset",
            str(args.preset),
            "-crf",
            str(args.crf),
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            str(out),
        ])


if __name__ == "__main__":
    main()
