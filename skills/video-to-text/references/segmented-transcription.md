# 分段转写（Segmented Transcription）

WhisperX HTTP server 的 `/v1/audio/transcriptions` **不是流式接口**：一次提交，算完才返回。

当音频达到 1–6 小时，单次请求很容易因为：

- read timeout（默认 3600 秒）
- 网络波动 / 代理掉线
- 服务端卡死/排队

导致“跑了半天，0 产物”。

## 解决方案：分段转写

把音频切成固定长度（推荐 30min 或 60min），逐段转写。

好处：

- **准实时可见进度**：每段都落盘 `seg_XXX.txt/json/srt/ass`
- **可恢复**：失败只重跑一个 segment
- **便于并行**：未来可多 worker 并行跑不同段

## 推荐命令

使用脚本：`skills/video-to-text/scripts/transcribe_segments.sh`

```bash
bash skills/video-to-text/scripts/transcribe_segments.sh \
  /path/to/video.mp4 \
  --output-dir workspace/pipeline/<project>/ \
  --output-prefix transcript \
  --segment-minutes 30 \
  --backend server \
  --server-url http://127.0.0.1:9878
```

产物：

- `outputs/transcript_segments_30m/seg_000.txt` 等
- `outputs/transcript_segments_30m/transcript.segments.txt`
- 进度：`logs/transcribe_segments_30m/status.log`

## 重要说明

- 段内时间戳会从 00:00 重新开始。要合并成“全局时间轴”，需要在后处理阶段加 offset。
- 如果要做切片，建议使用 `seg_XXX.json`（包含 word-level timestamps）而不是纯 txt。
