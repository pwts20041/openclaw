#!/usr/bin/env python3
"""llm-skip-apply-v3.py — v3 版 skip 应用：segment 独立切割 + concat demuxer 拼接。

v2 → v3 关键改进：
1. 每个 keep 段独立 re-encode 为 .ts 文件（避免 filter_complex 内 concat 漂移）
2. 用 concat demuxer 拼接（最稳定的 ffmpeg 拼接方式）
3. 加 `-fflags +genpts -avoid_negative_ts make_zero` 防负时间戳
4. 加 `aresample=async=1000` 防微小音画漂移
5. 统一音频参数：48kHz, stereo, AAC 192k
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path


def ffprobe_duration(path: Path) -> float:
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
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


def cut_segment(source: Path, start: float, end: float, out_ts: Path) -> None:
    """切割单个 segment 为 .ts 文件，完全 re-encode。"""
    cmd = [
        "ffmpeg", "-y",
        "-fflags", "+genpts",
        "-ss", f"{start:.3f}",
        "-to", f"{end:.3f}",
        "-i", str(source),
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-avoid_negative_ts", "make_zero",
        "-f", "mpegts",
        str(out_ts),
    ]
    subprocess.run(cmd, capture_output=True, check=True)


def concat_segments(ts_files: list[Path], output: Path) -> None:
    """用 concat demuxer 拼接 .ts 文件，加 aresample 防漂移。"""
    # 写 concat list
    list_file = output.with_suffix(".concat.txt")
    with open(list_file, "w") as f:
        for ts in ts_files:
            f.write(f"file '{ts}'\n")

    cmd = [
        "ffmpeg", "-y",
        "-fflags", "+genpts",
        "-f", "concat", "-safe", "0",
        "-i", str(list_file),
        "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-af", "aresample=async=1000",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart",
        str(output),
    ]
    subprocess.run(cmd, capture_output=True, check=True)

    # 清理 concat list
    list_file.unlink(missing_ok=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("skip_json")
    ap.add_argument("--out")
    ap.add_argument("--pad", type=float, default=0.05,
                    help="pad seconds around each skip range")
    ap.add_argument("--keep-ts", action="store_true",
                    help="keep intermediate .ts files for debugging")
    args = ap.parse_args()

    clip = Path(args.clip).expanduser().resolve()
    skip_json = Path(args.skip_json).expanduser().resolve()

    j = json.loads(skip_json.read_text(encoding="utf-8"))
    raw = j.get("skip_ranges") or []
    ranges = [(float(x["start"]), float(x["end"])) for x in raw
              if "start" in x and "end" in x]

    dur = ffprobe_duration(clip)
    skips = merge_ranges(ranges, pad=args.pad)
    keeps = invert_to_keeps(skips, dur)

    if len(keeps) <= 1:
        raise SystemExit("Nothing to do (keeps<=1).")

    out = (Path(args.out).expanduser().resolve() if args.out
           else clip.with_name(clip.stem + "-v3.mp4"))

    # 创建临时目录存放 .ts 文件
    tmpdir = Path(tempfile.mkdtemp(prefix="clipper-v3-"))
    ts_files: list[Path] = []

    print(f"[v3] cutting {len(keeps)} segments from {clip.name}...")

    for i, (s, e) in enumerate(keeps):
        ts_path = tmpdir / f"seg_{i:04d}.ts"
        cut_segment(clip, s, e, ts_path)
        ts_files.append(ts_path)
        seg_dur = e - s
        print(f"  seg {i}: {s:.3f}–{e:.3f} ({seg_dur:.3f}s) → {ts_path.name}")

    print(f"[v3] concatenating {len(ts_files)} segments...")
    concat_segments(ts_files, out)

    # 验证产物
    out_dur = ffprobe_duration(out)
    expected_dur = sum(e - s for s, e in keeps)
    drift = abs(out_dur - expected_dur)

    print(f"[v3] done: {out}")
    print(f"  input:    {dur:.3f}s")
    print(f"  output:   {out_dur:.3f}s")
    print(f"  expected: {expected_dur:.3f}s")
    print(f"  drift:    {drift:.3f}s {'⚠️' if drift > 0.1 else '✅'}")

    # 清理
    if not args.keep_ts:
        for ts in ts_files:
            ts.unlink(missing_ok=True)
        tmpdir.rmdir()
    else:
        print(f"  ts files kept in: {tmpdir}")

    print(str(out))


if __name__ == "__main__":
    main()
