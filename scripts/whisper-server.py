#!/usr/bin/env python3
"""
WhisperX HTTP Server - 本地语音转文字 + 说话人分离
兼容 OpenAI Whisper API 格式: POST /v1/audio/transcriptions
所有 OpenClaw 实例共用这一个服务。

功能:
  - 语音转文字 (whisperX, large-v3)
  - 说话人分离 (pyannote diarization)
  - 时间戳对齐 (whisperX alignment)

启动: .venv-whisperx/bin/python whisper-server.py [--port 9876] [--model large-v3]

需要设置环境变量 HF_TOKEN (HuggingFace token) 来使用 pyannote diarization。
没有 HF_TOKEN 也能跑，只是不做说话人分离。
"""

import argparse
import json
import os
import re
import sys
import tempfile
import traceback
from http.server import HTTPServer, BaseHTTPRequestHandler

DEFAULT_PORT = 9876
DEFAULT_MODEL = "large-v3"

# 全局模型缓存（延迟加载）
_whisperx_model = None
_diarize_model = None
_align_model = None
_align_metadata = None
_device = None
_compute_type = None


def get_device():
    global _device, _compute_type
    if _device is None:
        import torch
        if torch.backends.mps.is_available():
            _device = "cpu"  # whisperX 的 faster-whisper 不支持 MPS，用 CPU
            _compute_type = "int8"
        elif torch.cuda.is_available():
            _device = "cuda"
            _compute_type = "float16"
        else:
            _device = "cpu"
            _compute_type = "int8"
    return _device, _compute_type


def get_whisperx_model(model_name):
    global _whisperx_model
    if _whisperx_model is None:
        import whisperx
        device, compute_type = get_device()
        print(f"   Loading whisperX model '{model_name}' on {device} ({compute_type})...")
        _whisperx_model = whisperx.load_model(model_name, device, compute_type=compute_type)
        print(f"   Model loaded ✅")
    return _whisperx_model


def get_diarize_model():
    global _diarize_model
    if _diarize_model is None:
        hf_token = os.environ.get("HF_TOKEN", "")
        if not hf_token:
            return None
        try:
            import whisperx
            device, _ = get_device()
            print(f"   Loading diarization model...")
            _diarize_model = whisperx.DiarizationPipeline(use_auth_token=hf_token, device=device)
            print(f"   Diarization model loaded ✅")
        except Exception as e:
            print(f"   ⚠️ Diarization model failed to load: {e}")
            return None
    return _diarize_model


def transcribe_with_diarization(audio_path, model_name, language=None):
    """转写 + 对齐 + 说话人分离"""
    import whisperx

    device, _ = get_device()
    model = get_whisperx_model(model_name)

    # 1. 转写
    audio = whisperx.load_audio(audio_path)
    transcribe_opts = {"batch_size": 8}
    if language:
        transcribe_opts["language"] = language
    result = model.transcribe(audio, **transcribe_opts)

    detected_lang = result.get("language", language or "unknown")

    # 2. 时间戳对齐
    try:
        align_model, align_metadata = whisperx.load_align_model(
            language_code=detected_lang, device=device
        )
        result = whisperx.align(
            result["segments"], align_model, align_metadata,
            audio, device, return_char_alignments=False
        )
    except Exception as e:
        print(f"   ⚠️ Alignment skipped: {e}")

    # 3. 说话人分离
    diarize_model = get_diarize_model()
    if diarize_model is not None:
        try:
            diarize_segments = diarize_model(audio_path)
            result = whisperx.assign_word_speakers(diarize_segments, result)
        except Exception as e:
            print(f"   ⚠️ Diarization skipped: {e}")

    return result, detected_lang


def format_plain_text(result):
    """格式化为纯文本（带说话人标注）"""
    segments = result.get("segments", [])
    if not segments:
        return ""

    lines = []
    current_speaker = None
    current_text = []

    for seg in segments:
        speaker = seg.get("speaker", None)
        text = seg.get("text", "").strip()
        if not text:
            continue

        if speaker != current_speaker:
            if current_text:
                prefix = f"[{current_speaker}] " if current_speaker else ""
                lines.append(prefix + " ".join(current_text))
            current_speaker = speaker
            current_text = [text]
        else:
            current_text.append(text)

    if current_text:
        prefix = f"[{current_speaker}] " if current_speaker else ""
        lines.append(prefix + " ".join(current_text))

    return "\n".join(lines)


def format_verbose_json(result, detected_lang):
    """格式化为详细 JSON（带时间戳、说话人、word-level 时间戳）。

    说明：我们的视频 pipeline（去口吃/字幕）依赖 word-level 时间戳，
    所以在 verbose_json 里额外输出 word_segments，便于下游复用。
    """
    segments = result.get("segments", [])
    output_segments = []
    for seg in segments:
        out = {
            "start": round(seg.get("start", 0), 2),
            "end": round(seg.get("end", 0), 2),
            "text": seg.get("text", "").strip(),
        }
        if "speaker" in seg:
            out["speaker"] = seg["speaker"]
        output_segments.append(out)

    # word-level segments (whisperX align 输出)
    word_segments = []
    for w in result.get("word_segments", []) or []:
        ww = {
            "word": w.get("word", ""),
            "start": round(float(w.get("start", 0.0)), 3) if w.get("start") is not None else None,
            "end": round(float(w.get("end", 0.0)), 3) if w.get("end") is not None else None,
        }
        if "score" in w:
            try:
                ww["score"] = round(float(w.get("score")), 4)
            except Exception:
                ww["score"] = w.get("score")
        if "speaker" in w:
            ww["speaker"] = w.get("speaker")
        word_segments.append(ww)

    full_text = format_plain_text(result)
    return {
        "text": full_text,
        "language": detected_lang,
        "segments": output_segments,
        "word_segments": word_segments,
    }


def parse_multipart(headers, body):
    """手动解析 multipart/form-data（不依赖 cgi 模块）"""
    content_type = headers.get("Content-Type", "")
    match = re.search(r'boundary=([^\s;]+)', content_type)
    if not match:
        return None, {}, {}
    boundary = match.group(1).encode()

    parts = body.split(b"--" + boundary)
    file_data = None
    filename = "audio.ogg"
    fields = {}

    for part in parts:
        if not part or part.strip() in (b"", b"--"):
            continue
        if b"\r\n\r\n" not in part:
            continue
        header_block, content = part.split(b"\r\n\r\n", 1)
        if content.endswith(b"\r\n"):
            content = content[:-2]

        header_str = header_block.decode("utf-8", errors="replace")
        name_match = re.search(r'name="([^"]+)"', header_str)
        fname_match = re.search(r'filename="([^"]+)"', header_str)

        if not name_match:
            continue
        name = name_match.group(1)

        if fname_match:
            file_data = content
            filename = fname_match.group(1)
        else:
            fields[name] = content.decode("utf-8", errors="replace")

    return file_data, filename, fields


class WhisperHandler(BaseHTTPRequestHandler):
    model = DEFAULT_MODEL

    def do_GET(self):
        if self.path in ("/", "/health", "/healthz"):
            hf_token = os.environ.get("HF_TOKEN", "")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "ok",
                "model": self.model,
                "engine": "whisperX",
                "diarization": bool(hf_token),
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path not in ("/v1/audio/transcriptions", "/transcribe"):
            self.send_response(404)
            self.end_headers()
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            content_type = self.headers.get("Content-Type", "")

            if "multipart/form-data" in content_type:
                audio_data, filename, fields = parse_multipart(self.headers, body)
                language = fields.get("language")
                model = fields.get("model", self.model)
                response_format = fields.get("response_format", "json")
            else:
                audio_data = body
                filename = "audio.ogg"
                language = None
                model = self.model
                response_format = "json"

            if not audio_data:
                raise ValueError("No audio data received")

            suffix = os.path.splitext(filename)[1] or ".ogg"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_data)
                tmp_path = tmp.name

            result, detected_lang = transcribe_with_diarization(
                tmp_path, model, language
            )
            os.unlink(tmp_path)

            if response_format == "verbose_json":
                output = format_verbose_json(result, detected_lang)
            else:
                # 默认 json 格式，兼容 OpenAI API
                output = {"text": format_plain_text(result)}

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(output, ensure_ascii=False).encode())

        except Exception as e:
            traceback.print_exc()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def log_message(self, format, *args):
        sys.stderr.write(f"[whisperx-server] {args[0]}\n")


def main():
    parser = argparse.ArgumentParser(description="WhisperX HTTP Server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    hf_token = os.environ.get("HF_TOKEN", "")

    WhisperHandler.model = args.model
    server = HTTPServer((args.host, args.port), WhisperHandler)
    print(f"🎙️ WhisperX Server: http://{args.host}:{args.port}")
    print(f"   Model: {args.model}")
    print(f"   Engine: whisperX (faster-whisper + pyannote)")
    print(f"   Diarization: {'✅ enabled' if hf_token else '❌ no HF_TOKEN set'}")
    print(f"   API:   POST /v1/audio/transcriptions")
    print(f"   Tip:   Set HF_TOKEN env var for speaker diarization")

    # 预加载模型
    print(f"\n   Pre-loading models...")
    get_whisperx_model(args.model)
    if hf_token:
        get_diarize_model()
    print(f"   Ready! 🚀\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
