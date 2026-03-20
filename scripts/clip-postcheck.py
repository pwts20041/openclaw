#!/usr/bin/env python3
"""
clip-postcheck.py — 对已编辑的 clip 做 WhisperX 重新转写 + 口吃二次检测
找出编辑后仍残留的口吃/重复，输出需要跳过的时间区间

用法: python3 clip-postcheck.py <clip.mp4> [--fix]
  --fix: 输出 ffmpeg filter_complex 并生成修复后文件
"""

import sys
import os
import json
import re
import subprocess
import tempfile

# Valid reduplicated words that should NOT be flagged as stutters
VALID_REDUP = {
    '试试', '看看', '聊聊', '谢谢', '想想', '说说', '等等', '走走', '笑笑',
    '哈哈', '吃吃', '玩玩', '听听', '问问', '读读', '写写', '算算', '猜猜',
    '摸摸', '闻闻', '尝尝', '碰碰', '拍拍', '拉拉', '推推', '摇摇', '转转',
    '搜搜', '查查', '翻翻', '找找', '数数', '量量', '称称', '比比', '选选',
    '教教', '学学', '练练', '改改', '帮帮', '让让', '坐坐', '站站', '躺躺',
    '跑跑', '跳跳', '飞飞', '游游', '逛逛', '溜溜', '爬爬', '歇歇', '歪歪',
    '抱抱', '亲亲', '夸夸', '骂骂', '喊喊', '叫叫', '唠唠', '叨叨', '念念',
    '讲讲', '谈谈', '议议', '论论', '评评', '品品', '赏赏', '赞赞',
    '刚刚', '常常', '往往', '偏偏', '仅仅', '稍稍', '略略', '渐渐', '慢慢',
    '快快', '早早', '悄悄', '默默', '静静', '轻轻', '重重', '深深', '淡淡',
    '高高', '低低', '大大', '小小', '长长', '短短', '宽宽', '窄窄', '厚厚',
    '薄薄', '粗粗', '细细', '多多', '少少', '满满', '空空', '干干', '净净',
    '爷爷', '奶奶', '爸爸', '妈妈', '哥哥', '姐姐', '弟弟', '妹妹', '叔叔',
    '舅舅', '婶婶', '嫂嫂', '姑姑', '娃娃', '宝宝', '乖乖', '甜甜', '暖暖',
    '星星', '花花', '豆豆', '果果', '蛋蛋', '丑丑', '嘻嘻', '呵呵', '嘿嘿',
    '嗯嗯', '唉唉', '呀呀', '噢噢', '哇哇', '嘘嘘', '啧啧', '啦啦', '吧吧',
}

FILLER_WORDS = {
    '嗯', '啊', '呃', '额', '诶', '欸', '哦', '奥', '唉', '哎', '哈', '呀',
    '这个', '那个', '就是', '然后', '其实', '可能', '反正', '你知道', '就是说', '相当于',
}

EMPHATIC_REPEATS = {
    '没有用', '不行', '真的', '可以', '好好好', '对对对', '行行行', '不是不是', '别别别'
}


def transcribe_clip(clip_path, server_url="http://127.0.0.1:9876"):
    """Transcribe a clip via local WhisperX HTTP server (word-level timestamps)."""
    import requests

    url = server_url.rstrip("/") + "/v1/audio/transcriptions"
    with open(clip_path, "rb") as f:
        r = requests.post(
            url,
            files={"file": (os.path.basename(clip_path), f, "video/mp4")},
            data={
                "model": "large-v3",
                "language": "zh",
                "response_format": "verbose_json",
            },
            timeout=60 * 60,
        )
    r.raise_for_status()
    return r.json()


def detect_residual_stutters(words):
    """Detect residual disfluencies in word-level transcription.

    目标不是“把一切重复都删掉”，而是抓最常见的可安全跳切的残留：
    - 单字/短语重复（非强调）
    - 填充词串（嗯啊这个那个）
    - 低置信度残留段
    - 短时间 restart / false start
    """
    issues = []
    n = len(words)

    # 1) Single-char repeats: 我我我 / 那那那
    i = 0
    while i < n - 1:
        w1 = words[i]['word']
        w2 = words[i + 1]['word']
        if len(w1) == 1 and w1 == w2:
            j = i + 1
            while j < n and words[j]['word'] == w1:
                j += 1
            count = j - i
            bigram = w1 + w1
            if count == 2 and bigram in VALID_REDUP:
                i = j
                continue
            if count >= 3 or bigram not in VALID_REDUP:
                keep_from = j - 2 if bigram in VALID_REDUP and count >= 3 else j - 1
                skip_start = words[i]['start']
                skip_end = words[keep_from]['start']
                if skip_end > skip_start + 0.05:
                    issues.append({
                        'type': 'char_repeat',
                        'text': w1 * count,
                        'start': skip_start,
                        'end': skip_end,
                        'at': skip_start,
                    })
            i = j
            continue
        i += 1

    # 2) Multi-char phrase repeats: 这个这个 / 我觉得我觉得
    for ngram_len in [1, 2, 3, 4]:
        i = 0
        while i < n - ngram_len:
            phrase = ''.join(words[j]['word'] for j in range(i, i + ngram_len))
            if i + 2 * ngram_len <= n:
                next_phrase = ''.join(words[j]['word'] for j in range(i + ngram_len, i + 2 * ngram_len))
                if phrase == next_phrase and len(phrase) >= 1:
                    # 避免把强调句误删
                    sample = phrase if ngram_len > 1 else phrase * 2
                    if sample in EMPHATIC_REPEATS:
                        i += 2 * ngram_len
                        continue
                    skip_start = words[i]['start']
                    skip_end = words[i + ngram_len]['start']
                    if skip_end > skip_start + 0.05:
                        issues.append({
                            'type': 'phrase_repeat',
                            'text': f'{phrase}x2',
                            'start': skip_start,
                            'end': skip_end,
                            'at': skip_start,
                        })
                    i += 2 * ngram_len
                    continue
            i += 1

    # 3) filler cluster: 嗯 / 啊 / 这个 / 那个 / 就是 / 然后 ...
    i = 0
    while i < n:
        if words[i]['word'] not in FILLER_WORDS:
            i += 1
            continue
        j = i + 1
        while j < n and words[j]['word'] in FILLER_WORDS:
            j += 1
        # 单个短 filler 不一定删；连续 2 个以上或时长明显长才删
        seg_start = words[i]['start']
        seg_end = words[j - 1].get('end', words[j - 1]['start'])
        if (j - i) >= 2 or (seg_end - seg_start) >= 0.35:
            issues.append({
                'type': 'filler_cluster',
                'text': ''.join(words[k]['word'] for k in range(i, j)),
                'start': seg_start,
                'end': seg_end,
                'at': seg_start,
            })
        i = j

    # 4) restart / false start: 我觉 / 我觉得 ... 这种短时间自我重启
    for i in range(n - 3):
        a = words[i]['word']
        b = words[i + 1]['word']
        c = words[i + 2]['word']
        d = words[i + 3]['word']
        ab = a + b
        cd = c + d
        # very conservative: 如果前面 1-2 字是后面 2-4 字的前缀，且间隔很短
        if len(ab) >= 1 and len(cd) >= 2 and cd.startswith(ab):
            gap = words[i + 2]['start'] - words[i]['start']
            if gap <= 0.8:
                skip_start = words[i]['start']
                skip_end = words[i + 2]['start']
                if skip_end > skip_start + 0.08:
                    issues.append({
                        'type': 'restart_prefix',
                        'text': ab,
                        'start': skip_start,
                        'end': skip_end,
                        'at': skip_start,
                    })

    # 5) Low-confidence cluster detection
    cluster_start = None
    for i in range(n):
        score = words[i].get('score', 1.0)
        if score < 0.05:
            if cluster_start is None:
                cluster_start = i
        else:
            if cluster_start is not None and i - cluster_start >= 3:
                cluster_text = ''.join(words[j]['word'] for j in range(cluster_start, i))
                after_text = ''.join(words[j]['word'] for j in range(i, min(n, i + len(cluster_text) + 3)))
                if cluster_text[:2] in after_text[:6]:
                    skip_start = words[cluster_start]['start']
                    skip_end = words[i]['start']
                    if skip_end > skip_start + 0.02:
                        issues.append({
                            'type': 'low_conf_repeat',
                            'text': cluster_text,
                            'start': skip_start,
                            'end': skip_end,
                            'at': skip_start,
                        })
            cluster_start = None

    # merge near-duplicate issues by range overlap
    issues.sort(key=lambda x: (x['start'], x['end']))
    merged = []
    for iss in issues:
        if not merged:
            merged.append(iss)
            continue
        last = merged[-1]
        if iss['start'] <= last['end'] + 0.03:
            last['end'] = max(last['end'], iss['end'])
            last['text'] = last['text'] if len(last['text']) >= len(iss['text']) else iss['text']
            last['type'] = last['type'] + '+' + iss['type'] if iss['type'] not in last['type'] else last['type']
        else:
            merged.append(iss)
    return merged


def generate_fix(clip_path, skip_ranges, output_path=None):
    """Generate fixed clip by removing skip ranges."""
    if not skip_ranges:
        return None
    
    # Get clip duration
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip_path],
        capture_output=True, text=True
    )
    duration = float(result.stdout.strip())
    
    # Merge overlapping skip ranges
    skips = sorted(skip_ranges, key=lambda x: x[0])
    merged = [skips[0]]
    for s, e in skips[1:]:
        if s <= merged[-1][1] + 0.02:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    
    # Generate keep ranges
    keeps = []
    prev = 0.0
    for s, e in merged:
        if s > prev + 0.02:
            keeps.append((prev, s))
        prev = e
    if prev < duration - 0.02:
        keeps.append((prev, duration))
    
    if len(keeps) <= 1:
        return None
    
    # Generate filter_complex (sync-safe: no audio overlap)
    fc_lines = []
    n = len(keeps)
    fade = 0.02  # non-overlapping fade-in/out per segment to reduce clicks

    for i, (s, e) in enumerate(keeps):
        seg_dur = max(0.0, e - s)

        fc_lines.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}];")

        a_chain = f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS"
        if seg_dur >= fade * 2 + 0.02:
            out_st = seg_dur - fade
            a_chain += f",afade=t=in:st=0:d={fade:.3f},afade=t=out:st={out_st:.3f}:d={fade:.3f}"
        fc_lines.append(a_chain + f"[a{i}];")

    # Video: plain concat
    v_concat = "".join(f"[v{i}]" for i in range(n))
    fc_lines.append(f"{v_concat}concat=n={n}:v=1:a=0[outv];")

    # Audio: concat (no overlap, keeps A/V timeline consistent)
    a_concat = "".join(f"[a{i}]" for i in range(n))
    fc_lines.append(f"{a_concat}concat=n={n}:v=0:a=1[outa];")
    
    if fc_lines[-1].endswith(';'):
        fc_lines[-1] = fc_lines[-1][:-1]
    
    # Write filter complex
    fc_path = tempfile.mktemp(suffix='.txt')
    with open(fc_path, 'w') as f:
        f.write('\n'.join(fc_lines))
    
    if output_path is None:
        base, ext = os.path.splitext(clip_path)
        output_path = f"{base}-fixed{ext}"
    
    cmd = [
        'ffmpeg', '-i', clip_path,
        '-filter_complex_script', fc_path,
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', output_path
    ]
    
    subprocess.run(cmd, capture_output=True)
    os.unlink(fc_path)
    
    return output_path


def main():
    if len(sys.argv) < 2:
        print("Usage: clip-postcheck.py <clip.mp4> [--fix]")
        sys.exit(1)
    
    clip_path = sys.argv[1]
    do_fix = '--fix' in sys.argv
    
    print(f"Transcribing {clip_path}...", file=sys.stderr)
    result = transcribe_clip(clip_path)
    
    words = result.get('word_segments', [])
    print(f"Got {len(words)} words, {len(result['segments'])} segments", file=sys.stderr)
    
    # Print full text
    text = ''.join(w['word'] for w in words)
    print(f"\nText: {text}", file=sys.stderr)
    
    # Detect issues
    issues = detect_residual_stutters(words)
    
    if not issues:
        print("\n✅ No residual stutters detected", file=sys.stderr)
        return
    
    print(f"\n⚠️ Found {len(issues)} residual issue(s):", file=sys.stderr)
    skip_ranges = []
    for iss in issues:
        print(f"  [{iss['at']:.1f}s] {iss['type']}: \"{iss['text']}\" → skip {iss['start']:.3f}-{iss['end']:.3f}", file=sys.stderr)
        skip_ranges.append((iss['start'], iss['end']))
        # Output machine-readable skip ranges to stdout
        print(f"{iss['start']:.3f} {iss['end']:.3f}")
    
    if do_fix:
        print(f"\nApplying fix...", file=sys.stderr)
        fixed = generate_fix(clip_path, skip_ranges)
        if fixed:
            # Get durations
            orig_dur = subprocess.run(
                ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip_path],
                capture_output=True, text=True
            ).stdout.strip()
            new_dur = subprocess.run(
                ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', fixed],
                capture_output=True, text=True
            ).stdout.strip()
            print(f"✅ Fixed: {fixed} ({orig_dur}s → {new_dur}s)", file=sys.stderr)
        else:
            print("No fix needed", file=sys.stderr)


if __name__ == '__main__':
    main()
