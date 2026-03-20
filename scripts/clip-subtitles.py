#!/usr/bin/env python3
"""clip-subtitles.py — 为单条 clip 生成软字幕(SRT/ASS)并可选压制硬字幕。

设计目标：适配我们的视频剪辑流（会去静音/去口吃/跳切），所以字幕时间轴必须基于“最终 clip 本身”。
做法：优先复用 clip-postcheck 生成的 WhisperX word-level 时间戳 JSON；如果没有或过期则重新转写。

用法：
  python3 clip-subtitles.py clips/01-xxx.mp4
  python3 clip-subtitles.py clips/01-xxx.mp4 --cleanup   # 去除常见赘词/口吃（文本层面）
  python3 clip-subtitles.py clips/01-xxx.mp4 --burn

输出（默认同目录）：
  - 01-xxx.whisperx.json   WhisperX word-level 转写
  - 01-xxx.srt             软字幕（平台兼容）
  - 01-xxx.ass             软字幕（可控样式 + 重点放大）
  - 01-xxx-sub.mp4         硬字幕（--burn 时生成）

样式：
  - 白底黄字（半透明白色字幕条 + 黄色字体 + 黑描边）
  - 自动提炼重点：数字/金额/英文缩写 + 少量关键词 → 放大
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


HOTWORDS = [
    "翻车", "赚钱", "变现", "咨询", "上线", "交付", "自动化", "复盘", "监控", "回滚", "运维",
    "增长", "成交", "付费", "用户", "产品", "脚本", "定价", "训练", "陪跑",
    "OpenClaw", "Vibe", "Coding", "cron", "GitHub", "AI",
]

TERM_FIXES = {
    'opencloud': 'OpenClaw',
    'open claw': 'OpenClaw',
    'openclaw': 'OpenClaw',
    'open club': 'OpenClaw',
    'open clone': 'OpenClaw',
    '龙瞎': '龙虾',
    'toke': 'token',
}


def sec_to_srt_ts(sec: float) -> str:
    if sec < 0:
        sec = 0
    ms = int(round((sec - int(sec)) * 1000))
    t = int(sec)
    h = t // 3600
    m = (t % 3600) // 60
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def sec_to_ass_ts(sec: float) -> str:
    if sec < 0:
        sec = 0
    cs = int(round((sec - int(sec)) * 100))
    t = int(sec)
    h = t // 3600
    m = (t % 3600) // 60
    s = t % 60
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def transcribe_whisperx(clip_path: Path, server_url: str = "http://127.0.0.1:9876") -> dict[str, Any]:
    """Transcribe via local WhisperX HTTP server.

    We intentionally avoid importing whisperx here to keep the toolchain stable.
    Server must support response_format=verbose_json and return word_segments.
    """
    import requests

    url = server_url.rstrip("/") + "/v1/audio/transcriptions"
    with clip_path.open("rb") as f:
        r = requests.post(
            url,
            files={"file": (clip_path.name, f, "video/mp4")},
            data={
                "model": "large-v3",
                "language": "zh",
                "response_format": "verbose_json",
            },
            timeout=60 * 60,
        )
    r.raise_for_status()
    return r.json()


def load_or_make_whisperx_json(clip_path: Path, json_path: Path) -> dict[str, Any]:
    # 复用：json 存在且比 clip 新 → 直接用
    if json_path.exists() and json_path.stat().st_mtime >= clip_path.stat().st_mtime:
        return json.loads(json_path.read_text(encoding="utf-8"))

    result = transcribe_whisperx(clip_path)
    json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def normalize_word(w: str) -> str:
    # WhisperX word 里可能含空格
    return w.replace(" ", "").strip()


def group_words_to_cues(words: list[dict[str, Any]], max_chars=16, max_dur=5.5, pause_split=0.65):
    cues = []
    cur = []
    cur_start = None
    last_end = None

    def flush():
        nonlocal cur, cur_start, last_end
        if not cur:
            return
        start = cur_start if cur_start is not None else cur[0]["start"]
        end = last_end if last_end is not None else cur[-1].get("end", cur[-1]["start"])
        text = "".join(normalize_word(x["word"]) for x in cur)
        text = re.sub(r"\s+", "", text)
        if text:
            cues.append({"start": float(start), "end": float(end), "text": text})
        cur = []
        cur_start = None
        last_end = None

    for w in words:
        ww = normalize_word(w.get("word", ""))
        if not ww:
            continue
        s = float(w.get("start", 0.0))
        e = float(w.get("end", s))

        if cur and last_end is not None:
            if s - last_end >= pause_split:
                flush()

        # If adding this word would exceed limits, flush BEFORE adding.
        # This avoids splitting a short token (e.g. a single Chinese char) away from the next token.
        if cur and cur_start is not None and last_end is not None:
            text_len = sum(len(x["word"]) for x in cur)
            dur_pred = e - cur_start
            if text_len + len(ww) > max_chars or dur_pred > max_dur:
                flush()

        if not cur:
            cur_start = s

        cur.append({"word": ww, "start": s, "end": e})
        last_end = e

        text_now = "".join(x["word"] for x in cur)

        # punctuation split (soft)
        if re.search(r"[。！？!?]$", text_now) and len(text_now) >= 8:
            flush()
            continue

        # Hard cut if we still exceed (extreme cases)
        dur_now = (last_end - cur_start) if (cur_start is not None and last_end is not None) else 0
        if len(text_now) >= max_chars or dur_now >= max_dur:
            flush()

    flush()
    return cues


def pick_highlights(text: str) -> list[str]:
    # 1) numbers / money
    hl = []
    for m in re.findall(r"\d+(?:\.\d+)?(?:万|w|k|块|元|%)?", text, flags=re.I):
        if m and m not in hl:
            hl.append(m)

    # 2) english tokens
    for token in ["OpenClaw", "GitHub", "cron", "AI", "Vibe", "Coding"]:
        if token.lower() in text.lower() and token not in hl:
            hl.append(token)

    # 3) hotwords
    for w in HOTWORDS:
        if w in text and w not in hl:
            hl.append(w)

    # keep a few
    return hl[:3]


def ass_escape(s: str) -> str:
    # ASS: escape line breaks and braces
    return s.replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def apply_ass_emphasis(text: str, highlights: list[str]) -> str:
    # 默认样式黄字；重点词放大 + 略微加粗
    out = text
    for h in sorted(highlights, key=len, reverse=True):
        if not h:
            continue
        # 防止重复替换导致嵌套
        if h not in out:
            continue
        # 放大字号：48 → 60（可调）
        out = out.replace(h, f"{{\\fs60\\b1}}{h}{{\\fs48\\b0}}")
    return out


def cleanup_disfluency(text: str) -> str:
    # 发布版字幕清洗：保守，不改原意，只去掉明显噪声、赘词和术语误识别。
    t = text.strip()
    t = re.sub(r"\s+", "", t)

    # 常见 filler / 口头禅：只清明显冗余，不追求口语完全消灭
    t = re.sub(r"^(嗯+|啊+|呃+|额+|诶+|欸+|哦+|奥+)+", "", t)
    t = re.sub(r"(嗯+|啊+|呃+|额+|诶+|欸+)(?=$)", "", t)

    # collapse duplicated single-char stutter: 我我我 -> 我
    t = re.sub(r"([\u4e00-\u9fff])\1{1,}", r"\1", t)
    # collapse duplicated 2-char token: 但是但是 -> 但是
    t = re.sub(r"([\u4e00-\u9fff]{2})\1{1,}", r"\1", t)

    # 很短的 filler 簇 / 起句口头禅
    t = re.sub(r"^(这个|那个|就是|然后|其实|反正|你知道|就是说|相当于)+", "", t)

    # 明显 ASR 脏组合（只做很少量）
    t = t.replace('攻击这', '工作这')
    t = t.replace('量好它', '养好它')
    t = t.replace('更的当个', '更得当个')
    t = t.replace('成了三波', '分成了三拨')

    # 术语修正（大小写前先统一 lower 做一遍）
    lower = t.lower()
    for bad, good in TERM_FIXES.items():
        if bad in lower:
            lower = lower.replace(bad, good)
    t = lower

    # 恢复部分常见大小写术语
    t = t.replace('github', 'GitHub').replace('token', 'token').replace('openclaw', 'OpenClaw')

    # 去掉首尾孤立残片（太短且明显断裂）
    t = re.sub(r'^(户|呢|吧|呀|哈)(?=太|我|这)', '', t)
    t = re.sub(r'(的|了|吧|呢|呀|哈)$', lambda m: m.group(0), t)

    return t.strip()


def write_srt(cues, out_path: Path, cleanup: bool = False):
    lines = []
    for i, c in enumerate(cues, 1):
        lines.append(str(i))
        lines.append(f"{sec_to_srt_ts(c['start'])} --> {sec_to_srt_ts(c['end'])}")
        txt = c["text"]
        if cleanup:
            txt = cleanup_disfluency(txt)
        lines.append(txt)
        lines.append("")
    out_path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_ass(cues, out_path: Path, video_w=1080, video_h=1920, cleanup: bool = False):
    # 白底黄字：半透明白色字幕条 + 黄字 + 黑描边
    # 说明：ASS 颜色格式 &HAABBGGRR
    primary_yellow = "&H0000FFFF"   # yellow
    outline_black = "&H00000000"    # black
    back_white = "&H80FFFFFF"       # 50% alpha white box

    font = "PingFang SC"
    fs = 48

    header = f"""[Script Info]
; Script generated by clip-subtitles.py
ScriptType: v4.00+
PlayResX: {video_w}
PlayResY: {video_h}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{fs},{primary_yellow},&H00000000,{outline_black},{back_white},1,0,0,0,100,100,0,0,3,2,0,2,120,120,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events = []
    for c in cues:
        start = sec_to_ass_ts(c["start"])
        end = sec_to_ass_ts(c["end"])
        hl = pick_highlights(c["text"])
        txt = apply_ass_emphasis(c["text"], hl)
        txt = ass_escape(txt)
        events.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{txt}")

    out_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")


def burn_ass(clip_path: Path, ass_path: Path, out_path: Path):
    # 使用 libass 压制字幕
    # ffmpeg subtitles 滤镜不支持中文路径，用临时 symlink 绕过
    import tempfile
    tmp_dir = Path(tempfile.mkdtemp())
    tmp_clip = tmp_dir / "input.mp4"
    tmp_ass = tmp_dir / "subtitle.ass"
    tmp_out = tmp_dir / "output.mp4"

    try:
        tmp_clip.symlink_to(clip_path)
        tmp_ass.symlink_to(ass_path)

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(tmp_clip),
            "-vf",
            f"subtitles={tmp_ass}",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            str(tmp_out),
        ]
        subprocess.run(cmd, check=True, capture_output=True)

        # 移动到最终路径
        import shutil
        shutil.move(str(tmp_out), str(out_path))
    finally:
        # 清理临时目录
        import shutil
        shutil.rmtree(str(tmp_dir), ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", help="Path to clip mp4")
    ap.add_argument("--burn", action="store_true", help="Generate hard-subtitled mp4")
    ap.add_argument("--cleanup", action="store_true", help="Cleanup fillers/stutter in subtitle text (safe, no timing changes)")
    ap.add_argument("--res", default="1080x1920", help="Target resolution for ASS PlayRes (default 1080x1920)")
    args = ap.parse_args()

    clip_path = Path(args.clip).expanduser().resolve()
    if not clip_path.exists():
        raise SystemExit(f"clip not found: {clip_path}")

    w, h = args.res.lower().split("x")
    video_w, video_h = int(w), int(h)

    stem = clip_path.with_suffix("")
    json_path = Path(str(stem) + ".whisperx.json")
    srt_path = Path(str(stem) + ".srt")
    ass_path = Path(str(stem) + ".ass")
    sub_mp4 = Path(str(stem) + "-sub.mp4")

    result = load_or_make_whisperx_json(clip_path, json_path)
    words = result.get("word_segments") or []
    if not words:
        raise SystemExit("whisperx result has no word_segments")

    cues = group_words_to_cues(words)

    write_srt(cues, srt_path, cleanup=args.cleanup)
    write_ass(cues, ass_path, video_w=video_w, video_h=video_h, cleanup=args.cleanup)

    if args.burn:
        burn_ass(clip_path, ass_path, sub_mp4)

    print(f"ok: {clip_path.name} -> {srt_path.name}, {ass_path.name}" + (f", {sub_mp4.name}" if args.burn else ""))


if __name__ == "__main__":
    main()
