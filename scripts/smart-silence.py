#!/usr/bin/env python3
"""
smart-silence.py — 智能静音处理
- 长静音 (>= 0.5s): 完全跳过
- 短静音 (0.25s - 0.5s): 压缩到 0.12s（保留呼吸感但紧凑）
- 微停顿 (< 0.25s): 保留

输入: ffmpeg silencedetect 日志 + 音频时长
输出: keep 区间列表（可直接用于 filter_complex trim+concat）
"""

import sys
import re

LONG_THRESHOLD = 0.5    # 完全跳过
SHORT_THRESHOLD = 0.25  # 压缩
COMPRESSED_DUR = 0.12   # 短静音压缩到这个时长


def parse_silence_log(log_path: str):
    """从 ffmpeg silencedetect 日志解析静音区间"""
    starts = []
    ends = []
    with open(log_path) as f:
        for line in f:
            m = re.search(r'silence_start: ([\d.]+)', line)
            if m:
                starts.append(float(m.group(1)))
            m = re.search(r'silence_end: ([\d.]+)', line)
            if m:
                ends.append(float(m.group(1)))
    return list(zip(starts, ends))


def process_silences(silences, duration, stutter_skips=None):
    """
    处理静音区间:
    - 长静音: 完全跳过
    - 短静音: 保留 COMPRESSED_DUR
    - 口吃区间: 完全跳过
    
    返回: [(keep_start, keep_end), ...]
    """
    if stutter_skips is None:
        stutter_skips = []
    
    # 合并所有需要处理的区间
    all_events = []
    for s, e in silences:
        dur = e - s
        if dur >= LONG_THRESHOLD:
            # 长静音两端多删 50ms，消除边缘的微弱残留发音
            all_events.append((s - 0.05, e + 0.05, 'remove'))
        elif dur >= SHORT_THRESHOLD:
            # 压缩: 保留中间一小段
            mid = (s + e) / 2
            keep_s = mid - COMPRESSED_DUR / 2
            keep_e = mid + COMPRESSED_DUR / 2
            all_events.append((s, keep_s, 'remove'))
            all_events.append((keep_e, e, 'remove'))
    
    for s, e in stutter_skips:
        all_events.append((s, e, 'remove'))
    
    # 合并所有 remove 区间
    removes = [(s, e) for s, e, t in all_events if t == 'remove']
    if not removes:
        return [(0, duration)]
    
    removes.sort()
    merged = [removes[0]]
    for s, e in removes[1:]:
        ps, pe = merged[-1]
        if s <= pe + 0.02:
            merged[-1] = (ps, max(pe, e))
        else:
            merged.append((s, e))
    
    # 生成 keep 区间
    keeps = []
    prev = 0.0
    for s, e in merged:
        if s > prev + 0.02:
            keeps.append((prev, s))
        prev = e
    if prev < duration - 0.02:
        keeps.append((prev, duration))
    
    return keeps


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: smart-silence.py <silence_log> <duration> [stutter_skip_file]")
        sys.exit(1)
    
    log_path = sys.argv[1]
    duration = float(sys.argv[2])
    
    silences = parse_silence_log(log_path)
    
    stutter_skips = []
    if len(sys.argv) > 3:
        with open(sys.argv[3]) as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 2:
                    try:
                        stutter_skips.append((float(parts[0]), float(parts[1])))
                    except:
                        pass
    
    keeps = process_silences(silences, duration, stutter_skips)
    
    total_keep = sum(e - s for s, e in keeps)
    print(f"# Original: {duration:.1f}s, Keep: {total_keep:.1f}s, Removed: {duration - total_keep:.1f}s", file=sys.stderr)
    
    for s, e in keeps:
        print(f"{s:.3f} {e:.3f}")
