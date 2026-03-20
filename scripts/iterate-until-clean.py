#!/usr/bin/env python3
"""
iterate-until-clean.py — 反复迭代修复 clip 直到 WhisperX 转写零问题
每轮: WhisperX 转写 → 检测问题 → 生成修复 → 替换原文件 → 重新转写验证
最多迭代 MAX_ROUNDS 轮，防止死循环
"""

import sys
import os
import json
import subprocess
import tempfile
import re

MAX_ROUNDS = 5
XFADE_DUR = 0.02

# Valid reduplicated words
VALID_REDUP = {
    '试试','看看','聊聊','谢谢','想想','说说','等等','走走','笑笑','哈哈',
    '吃吃','玩玩','听听','问问','读读','写写','算算','猜猜','找找','学学',
    '练练','改改','帮帮','坐坐','站站','跑跑','跳跳','逛逛','抱抱','亲亲',
    '刚刚','常常','往往','偏偏','仅仅','渐渐','慢慢','快快','悄悄','默默',
    '静静','轻轻','深深','高高','大大','小小','多多','少少','满满','干干',
    '爷爷','奶奶','爸爸','妈妈','哥哥','姐姐','弟弟','妹妹','叔叔','宝宝',
    '嘻嘻','呵呵','嘿嘿','嗯嗯','啧啧','稍稍','略略','淡淡','早早',
    '好好','乖乖','甜甜','暖暖','星星','花花','豆豆','果果',
}

# Technical terms that look like repeats but aren't
TECH_BIGRAMS = {'SS', 'AI', 'II', 'PP', 'CC', 'DD', 'FF', 'GG', 'HH', 'LL', 'MM', 'NN', 'RR', 'TT'}


def transcribe(clip_path):
    """WhisperX transcribe with word-level alignment."""
    import whisperx
    model = whisperx.load_model('large-v3', 'cpu', compute_type='int8', language='zh')
    audio = whisperx.load_audio(clip_path)
    result = model.transcribe(audio, batch_size=4, language='zh')
    model_a, metadata = whisperx.load_align_model(language_code='zh', device='cpu')
    result = whisperx.align(result['segments'], model_a, metadata, audio, 'cpu')
    return result


def detect_issues(words):
    """Comprehensive stutter/issue detection. Returns list of (type, desc, skip_start, skip_end)."""
    issues = []
    n = len(words)
    
    # 1. Single-char repeats
    i = 0
    while i < n - 1:
        w = words[i]['word']
        if len(w) == 1 and i + 1 < n and words[i+1]['word'] == w:
            j = i + 1
            while j < n and words[j]['word'] == w:
                j += 1
            cnt = j - i
            bigram = w + w
            
            # Skip technical terms
            if bigram in TECH_BIGRAMS:
                i = j; continue
            
            # Valid reduplication (exactly 2) — skip
            if cnt == 2 and bigram in VALID_REDUP:
                i = j; continue
            
            # AAA+ with valid redup: keep last 2
            if cnt >= 3 and bigram in VALID_REDUP:
                skip_s = words[i]['start']
                skip_e = words[j-2]['start']
                if skip_e > skip_s + 0.03:
                    issues.append(('char_repeat', f'{w}x{cnt}(keep2)', skip_s, skip_e))
                i = j; continue
            
            # Non-valid repeat: keep last 1
            if cnt >= 2 and bigram not in VALID_REDUP:
                skip_s = words[i]['start']
                skip_e = words[j-1]['start']
                if skip_e > skip_s + 0.03:
                    issues.append(('char_repeat', f'{w}x{cnt}', skip_s, skip_e))
            i = j
        else:
            i += 1
    
    # 2. Phrase repeats (ngram 2-4)
    for ng in [2, 3, 4]:
        i = 0
        while i < n - 2 * ng:
            p1 = ''.join(words[j]['word'] for j in range(i, i + ng))
            p2 = ''.join(words[j]['word'] for j in range(i + ng, i + 2 * ng))
            if p1 == p2 and len(p1) >= 2:
                # Skip if it's a valid redup that just happens to be 2-char
                if p1 in VALID_REDUP:
                    i += 2 * ng; continue
                skip_s = words[i]['start']
                skip_e = words[i + ng]['start']
                if skip_e > skip_s + 0.03:
                    issues.append(('phrase_repeat', f'{p1}x2', skip_s, skip_e))
                i += 2 * ng
            else:
                i += 1
    
    # 3. Low-confidence clusters repeating nearby text
    cluster_start = None
    for i in range(n):
        if words[i].get('score', 1) < 0.05:
            if cluster_start is None:
                cluster_start = i
        else:
            if cluster_start is not None and i - cluster_start >= 3:
                ct = ''.join(words[j]['word'] for j in range(cluster_start, i))
                # Check if cluster text overlaps with text immediately after
                after = ''.join(words[j]['word'] for j in range(i, min(n, i + len(ct) + 3)))
                if len(ct) >= 2 and ct[:2] in after[:8]:
                    skip_s = words[cluster_start]['start']
                    skip_e = words[i]['start']
                    if skip_e > skip_s + 0.02:
                        issues.append(('low_conf_dup', ct, skip_s, skip_e))
            cluster_start = None
    
    # Deduplicate overlapping issues (keep the one that covers more)
    if len(issues) > 1:
        issues.sort(key=lambda x: x[2])
        deduped = [issues[0]]
        for iss in issues[1:]:
            prev = deduped[-1]
            # If this issue overlaps with previous, keep the wider one
            if iss[2] < prev[3]:
                if (iss[3] - iss[2]) > (prev[3] - prev[2]):
                    deduped[-1] = iss
            else:
                deduped.append(iss)
        issues = deduped
    
    return issues


def apply_fix(clip_path, skip_ranges):
    """Remove skip ranges from clip using trim+concat+crossfade."""
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip_path],
        capture_output=True, text=True
    )
    duration = float(result.stdout.strip())
    
    # Merge overlapping skip ranges
    skips = sorted(skip_ranges, key=lambda x: x[0])
    merged = [list(skips[0])]
    for s, e in skips[1:]:
        if s <= merged[-1][1] + 0.02:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    
    # Generate keep ranges
    keeps = []
    prev = 0.0
    for s, e in merged:
        if s > prev + 0.02:
            keeps.append((max(0, prev), s))
        prev = e
    if prev < duration - 0.02:
        keeps.append((prev, duration))
    
    if len(keeps) <= 1:
        return None
    
    n = len(keeps)
    fc_lines = []
    for i, (s, e) in enumerate(keeps):
        fc_lines.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}];")
        fc_lines.append(f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}];")
    
    # Video: plain concat
    v_concat = "".join(f"[v{i}]" for i in range(n))
    fc_lines.append(f"{v_concat}concat=n={n}:v=1:a=0[outv];")
    
    # Audio: chain acrossfade
    prev_label = "a0"
    for i in range(1, n):
        dur_curr = keeps[i][1] - keeps[i][0]
        xf = min(XFADE_DUR, dur_curr * 0.4)
        out_label = "outa" if i == n - 1 else f"ax{i}"
        if xf >= 0.005:
            fc_lines.append(f"[{prev_label}][a{i}]acrossfade=d={xf:.3f}:c1=tri:c2=tri[{out_label}];")
        else:
            fc_lines.append(f"[{prev_label}][a{i}]concat=n=2:v=0:a=1[{out_label}];")
        prev_label = out_label
    
    if fc_lines[-1].endswith(';'):
        fc_lines[-1] = fc_lines[-1][:-1]
    
    fc_path = tempfile.mktemp(suffix='.txt')
    with open(fc_path, 'w') as f:
        f.write('\n'.join(fc_lines))
    
    output = clip_path.replace('.mp4', '-iter.mp4')
    cmd = [
        'ffmpeg', '-i', clip_path,
        '-filter_complex_script', fc_path,
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', output
    ]
    subprocess.run(cmd, capture_output=True)
    os.unlink(fc_path)
    
    if os.path.exists(output) and os.path.getsize(output) > 0:
        return output
    return None


def get_duration(path):
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        capture_output=True, text=True
    )
    return float(r.stdout.strip())


def main():
    if len(sys.argv) < 2:
        print("Usage: iterate-until-clean.py <clip.mp4>")
        sys.exit(1)
    
    clip_path = os.path.abspath(sys.argv[1])
    
    for round_num in range(1, MAX_ROUNDS + 1):
        dur = get_duration(clip_path)
        print(f"\n{'='*60}")
        print(f"Round {round_num}/{MAX_ROUNDS} — {os.path.basename(clip_path)} ({dur:.1f}s)")
        print(f"{'='*60}")
        
        # Transcribe
        print("Transcribing with WhisperX...", flush=True)
        result = transcribe(clip_path)
        words = result.get('word_segments', [])
        text = ''.join(w['word'] for w in words)
        print(f"  {len(words)} words, {len(text)} chars")
        print(f"  Text: {text[:100]}...")
        
        # Detect
        issues = detect_issues(words)
        
        if not issues:
            print(f"\n✅ CLEAN after {round_num} round(s). No issues detected.")
            print(f"Final: {os.path.basename(clip_path)}, {dur:.1f}s, {len(words)} words")
            print(f"Text: {text}")
            return
        
        print(f"\n⚠️ {len(issues)} issue(s) found:")
        skip_ranges = []
        for typ, desc, s, e in issues:
            print(f"  [{s:.1f}s] {typ}: \"{desc}\" → skip {s:.3f}-{e:.3f}")
            skip_ranges.append((s, e))
        
        # Fix
        print("Applying fix...", flush=True)
        fixed = apply_fix(clip_path, skip_ranges)
        if fixed:
            # Replace original
            os.replace(fixed, clip_path)
            new_dur = get_duration(clip_path)
            print(f"  Replaced: {dur:.1f}s → {new_dur:.1f}s")
        else:
            print("  Fix produced no output, stopping.")
            break
    
    # If we got here, max rounds reached
    print(f"\n⚠️ Max {MAX_ROUNDS} rounds reached. Running final check...")
    result = transcribe(clip_path)
    words = result.get('word_segments', [])
    text = ''.join(w['word'] for w in words)
    issues = detect_issues(words)
    if issues:
        print(f"Still {len(issues)} issue(s) remaining:")
        for typ, desc, s, e in issues:
            print(f"  [{s:.1f}s] {typ}: \"{desc}\"")
    else:
        print("✅ CLEAN after final check.")
    print(f"Final text: {text}")


if __name__ == '__main__':
    main()
