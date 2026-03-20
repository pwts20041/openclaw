#!/usr/bin/env python3
"""
Video/Audio → Text transcription with whisperX.
Supports: speaker diarization, timestamp alignment, multiple output formats.

Usage:
    python3 transcribe.py <input_file> [options]

Options:
    --output-dir DIR    Output directory (default: same as input)
    --output-name NAME  Output filename stem (default: derived from input)
    --language LANG     Language code (default: zh)
    --model MODEL       Whisper model (default: large-v3)
    --diarize           Enable speaker diarization (requires HF_TOKEN env var)
    --device DEVICE     cpu or cuda (default: cpu)
    --batch-size N      Batch size for transcription (default: 8)

Output:
    <name>.txt   - Human-readable transcript with speaker labels and timestamps
    <name>.json  - Full whisperX output with word-level timestamps
    <name>.srt   - Soft subtitles (SRT)
    <name>.ass   - Soft subtitles (ASS, simple style)
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile


def extract_audio(video_path, audio_path):
    """Extract audio from video file.

    - If audio_path endswith .wav → 16kHz mono WAV (pcm)
    - Else → 16kHz mono AAC-in-m4a (smaller; good for HTTP upload)
    """
    print(f"Extracting audio from {video_path}...")

    ext = os.path.splitext(audio_path)[1].lower()
    if ext == ".wav":
        cmd = [
            "ffmpeg", "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-y", audio_path,
        ]
    else:
        cmd = [
            "ffmpeg", "-i", video_path,
            "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "aac", "-b:a", "64k",
            "-y", audio_path,
        ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"ffmpeg error: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    print(f"Audio extracted: {audio_path}")


def _transcribe_local_whisperx(audio_path, model_name, device, compute_type, batch_size, language):
    """Run whisperX transcription locally (python package)."""
    import whisperx

    print(f"Loading model {model_name}...")
    model = whisperx.load_model(model_name, device, compute_type=compute_type)

    print("Transcribing... (this may take a while for long audio)")
    audio = whisperx.load_audio(audio_path)
    result = model.transcribe(audio, batch_size=batch_size, language=language)
    print(f"Detected language: {result['language']}")

    # Alignment
    print("Aligning timestamps...")
    try:
        align_model, metadata = whisperx.load_align_model(
            language_code=result["language"], device=device
        )
        result = whisperx.align(
            result["segments"], align_model, metadata, audio, device,
            return_char_alignments=False
        )
    except Exception as e:
        print(f"Alignment skipped: {e}")

    return result


def _transcribe_via_server(audio_path, model_name, language, server_url="http://127.0.0.1:9876"):
    """Call local WhisperX HTTP server (see workspace/scripts/whisper-server.py).

    Server must support response_format=verbose_json and return word_segments.
    """
    import requests

    url = server_url.rstrip("/") + "/v1/audio/transcriptions"
    with open(audio_path, "rb") as f:
        files = {"file": (os.path.basename(audio_path), f)}
        data = {
            "model": model_name,
            "language": language,
            "response_format": "verbose_json",
        }
        # Use a short connect timeout so we don't hang for an hour if the server is down,
        # but allow long reads for long audio.
        # For long-form audio (multi-hour), the server may take several hours.
        connect_timeout = float(os.environ.get("WHISPERX_SERVER_CONNECT_TIMEOUT", "10"))
        read_timeout = float(os.environ.get("WHISPERX_SERVER_READ_TIMEOUT", str(60 * 60 * 12)))
        r = requests.post(url, files=files, data=data, timeout=(connect_timeout, read_timeout))
        r.raise_for_status()
        return r.json()


def transcribe(audio_path, model_name, device, compute_type, batch_size, language, backend="auto", server_url="http://127.0.0.1:9876"):
    """Transcribe audio.

    backend:
      - auto: try local whisperx, fallback to HTTP server
      - local: local whisperx only
      - server: HTTP server only
    """
    if backend not in {"auto", "local", "server"}:
        raise ValueError(f"invalid backend: {backend}")

    if backend in {"auto", "local"}:
        try:
            result = _transcribe_local_whisperx(audio_path, model_name, device, compute_type, batch_size, language)
            return result, audio_path
        except Exception as e:
            if backend == "local":
                raise
            print(f"Local whisperx failed ({type(e).__name__}: {e}); fallback to server {server_url}", file=sys.stderr)

    result = _transcribe_via_server(audio_path, model_name, language, server_url=server_url)
    # mimic local return shape
    if "language" not in result:
        result["language"] = language
    return result, audio_path


def diarize(result, audio_path, device):
    """Run speaker diarization."""
    import whisperx

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("HF_TOKEN not set, skipping diarization")
        return result

    print("Running speaker diarization...")
    try:
        diarize_model = whisperx.DiarizationPipeline(
            use_auth_token=hf_token, device=device
        )
        diarize_segments = diarize_model(audio_path)
        result = whisperx.assign_word_speakers(diarize_segments, result)
        print("Diarization done!")
    except Exception as e:
        print(f"Diarization failed: {e}")

    return result


def format_transcript(result):
    """Format segments into human-readable transcript with speaker grouping."""
    lines = []
    current_speaker = None
    current_texts = []

    for seg in result.get("segments", []):
        speaker = seg.get("speaker", None)
        text = seg.get("text", "").strip()
        start = seg.get("start", 0)

        ts = f"[{int(start // 60):02d}:{int(start % 60):02d}]"

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

    return "\n\n".join(lines)


def _sec_to_srt_ts(sec: float) -> str:
    if sec < 0:
        sec = 0
    ms = int(round((sec - int(sec)) * 1000))
    t = int(sec)
    h = t // 3600
    m = (t % 3600) // 60
    s = t % 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _sec_to_ass_ts(sec: float) -> str:
    if sec < 0:
        sec = 0
    cs = int(round((sec - int(sec)) * 100))
    t = int(sec)
    h = t // 3600
    m = (t % 3600) // 60
    s = t % 60
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _group_words_to_cues(words, max_chars=18, max_dur=6.0, pause_split=0.7):
    """Group whisperx word_segments into subtitle cues."""
    cues = []
    cur = []
    cur_start = None
    last_end = None

    def norm_word(w: str) -> str:
        return (w or "").replace(" ", "").strip()

    def flush():
        nonlocal cur, cur_start, last_end
        if not cur:
            return
        start = cur_start if cur_start is not None else cur[0]["start"]
        end = last_end if last_end is not None else cur[-1].get("end", cur[-1]["start"])
        text = "".join(norm_word(x.get("word", "")) for x in cur)
        text = re.sub(r"\s+", "", text)
        if text:
            cues.append({"start": float(start), "end": float(end), "text": text})
        cur = []
        cur_start = None
        last_end = None

    for w in words or []:
        ww = norm_word(w.get("word", ""))
        if not ww:
            continue
        s = float(w.get("start", 0.0))
        e = float(w.get("end", s))

        if cur and last_end is not None and s - last_end >= pause_split:
            flush()

        if not cur:
            cur_start = s

        cur.append({"word": ww, "start": s, "end": e})
        last_end = e

        text_now = "".join(x["word"] for x in cur)
        dur_now = (last_end - cur_start) if (cur_start is not None and last_end is not None) else 0

        # soft punctuation split
        if re.search(r"[。！？!?]$", text_now) and len(text_now) >= 8:
            flush()
            continue

        if len(text_now) >= max_chars or dur_now >= max_dur:
            flush()

    flush()
    return cues


def write_srt_from_result(result, out_path: str):
    words = result.get("word_segments") or []
    cues = _group_words_to_cues(words)
    lines = []
    for i, c in enumerate(cues, 1):
        lines.append(str(i))
        lines.append(f"{_sec_to_srt_ts(c['start'])} --> {_sec_to_srt_ts(c['end'])}")
        lines.append(c["text"])
        lines.append("")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines).strip() + "\n")


def write_ass_from_result(result, out_path: str, video_w=1080, video_h=1920):
    words = result.get("word_segments") or []
    cues = _group_words_to_cues(words)

    # simple, neutral style (no highlights). Hard-sub style lives in clip-subtitles.py.
    font = "PingFang SC"
    fs = 46
    primary = "&H00FFFFFF"  # white
    outline = "&H00000000"  # black
    back = "&H80000000"     # semi-transparent black

    header = f"""[Script Info]
; Script generated by video-to-text/transcribe.py
ScriptType: v4.00+
PlayResX: {video_w}
PlayResY: {video_h}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{fs},{primary},&H00000000,{outline},{back},0,0,0,0,100,100,0,0,3,2,0,2,120,120,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    def ass_escape(s: str) -> str:
        return (s or "").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")

    events = []
    for c in cues:
        start = _sec_to_ass_ts(c["start"])
        end = _sec_to_ass_ts(c["end"])
        txt = ass_escape(c["text"])
        events.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{txt}")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(header + "\n".join(events) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Video/Audio → Text transcription")
    parser.add_argument("input", help="Input video or audio file")
    parser.add_argument("--output-dir", help="Output directory")
    parser.add_argument("--output-name", help="Output filename stem")
    parser.add_argument("--language", default="zh", help="Language code (default: zh)")
    parser.add_argument("--model", default="large-v3", help="Whisper model")
    parser.add_argument("--diarize", action="store_true", help="Enable speaker diarization")
    parser.add_argument("--device", default="cpu", help="cpu or cuda")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--backend", default="auto", choices=["auto", "local", "server"], help="Transcribe backend (default: auto)")
    parser.add_argument("--server-url", default="http://127.0.0.1:9876", help="WhisperX HTTP server url (default: http://127.0.0.1:9876)")
    args = parser.parse_args()

    input_path = os.path.abspath(args.input)
    if not os.path.exists(input_path):
        print(f"File not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Determine output paths
    if args.output_dir:
        out_dir = args.output_dir
    else:
        out_dir = os.path.dirname(input_path)
    os.makedirs(out_dir, exist_ok=True)

    if args.output_name:
        stem = args.output_name
    else:
        stem = os.path.splitext(os.path.basename(input_path))[0]

    out_json = os.path.join(out_dir, f"{stem}.json")
    out_txt = os.path.join(out_dir, f"{stem}.txt")
    out_srt = os.path.join(out_dir, f"{stem}.srt")
    out_ass = os.path.join(out_dir, f"{stem}.ass")

    # Determine if we need audio extraction
    audio_exts = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
    ext = os.path.splitext(input_path)[1].lower()

    if ext in audio_exts:
        audio_path = input_path
        temp_audio_path = None
    else:
        # Video file — extract audio to workdir (NOT /tmp)
        # - backend=server prefers smaller m4a for HTTP upload
        # - backend=local uses wav
        audio_suffix = ".m4a" if args.backend == "server" else ".wav"
        temp_audio_path = os.path.join(out_dir, f"{stem}.audio{audio_suffix}")
        audio_path = temp_audio_path
        extract_audio(input_path, audio_path)

    compute_type = "int8" if args.device == "cpu" else "float16"

    try:
        result, audio_file = transcribe(
            audio_path, args.model, args.device, compute_type,
            args.batch_size, args.language,
            backend=args.backend,
            server_url=args.server_url,
        )

        if args.diarize:
            result = diarize(result, audio_file, args.device)

        # Save JSON
        with open(out_json, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        # Save TXT
        txt = format_transcript(result)
        with open(out_txt, "w", encoding="utf-8") as f:
            f.write(txt)

        # Save subtitles (soft)
        try:
            write_srt_from_result(result, out_srt)
            write_ass_from_result(result, out_ass)
        except Exception as e:
            print(f"Subtitle export skipped: {e}", file=sys.stderr)

        print(f"\nDone!")
        print(f"  Text:  {out_txt}")
        print(f"  JSON:  {out_json}")
        print(f"  SRT:   {out_srt}")
        print(f"  ASS:   {out_ass}")
        print(f"  Segments: {len(result.get('segments', []))}")

    finally:
        if temp_audio_path and os.path.exists(temp_audio_path):
            try:
                os.unlink(temp_audio_path)
            except Exception:
                pass


if __name__ == "__main__":
    main()
