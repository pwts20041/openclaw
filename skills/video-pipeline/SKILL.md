---
name: video-pipeline
description: 视频内容全链路处理。一个视频进去，文字稿+观点摘要+短视频切片+可发布文章全出来。串联 video-to-text → insight-extractor → video-clipper → article-forge 四个 skill 的完整流水线。适用于：直播回放、播客、会议录像的一站式内容加工。
user-invocable: true
metadata: { "openclaw": { "emoji": "🎬" } }
---

# Video Pipeline — 视频内容全链路

## 一句话

丢一个视频进来，出一套完整的内容产品：文字稿 + 观点摘要 + 短视频切片 + 可发布文章。

## 链路总览

```
输入: 视频文件 (直播回放/播客/会议录像)
  │
  ▼
┌─────────────────────────────────────────────┐
│ Stage 1: video-to-text                       │
│ 转写 → 带时间戳的文字稿 + JSON               │
│ (去口吃的基础数据也在这里产生)                │
└──────────────────┬──────────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
┌───────────────┐   ┌─────────────────────┐
│ Stage 2:       │   │ Stage 3:             │
│ insight-       │   │ video-clipper        │
│ extractor      │   │ 按观点切片 →         │
│ 提炼观点/金句  │   │ 去静音/去口吃 →      │
│ /争议点        │   │ 短视频成品           │
└───────┬───────┘   └─────────────────────┘
        │
        ▼
┌───────────────────────────────────────────┐
│ Stage 4: article-forge                     │
│ 观点摘要 + 原始文稿 → 可发布文章            │
│ (博客/知乎/公众号)                          │
└───────────────────────────────────────────┘

输出目录: workspace/pipeline/<project-name>/
  ├── transcript.txt          # 完整文字稿
  ├── transcript.json         # 带时间戳 JSON
  ├── insights.md             # 观点摘要
  ├── clips/                  # 短视频切片
  │   ├── 01-xxx.mp4
  │   ├── 02-xxx.mp4
  │   └── ...
  └── articles/               # 生成的文章
      ├── blog-xxx.md
      └── zhihu-xxx.md
```

## 执行流程

### 输入参数

用户给出：

1. **视频文件路径**（必须）
2. **项目名**（可选，默认从文件名生成）
3. **目标产出**（可选，默认全部）：
   - `transcript` — 只要文字稿
   - `insights` — 文字稿 + 观点
   - `clips` — 文字稿 + 切片
   - `articles` — 文字稿 + 观点 + 文章
   - `all` — 全部（默认）
4. **文章平台**（可选）：blog / zhihu / wechat
5. **切片数量**（可选，默认 5-8 条）

### Stage 1: 转写（video-to-text）

1. 读取 `video-to-text` SKILL.md
2. 创建项目目录：`workspace/pipeline/<project-name>/`

3. **稳定性优先策略（推荐）**：长视频默认用“分段转写”拿到可见进度与可恢复性。
   - WhisperX HTTP server 不是流式接口：单次长请求经常会跑半天 0 产物。
   - 分段转写（30/60min）能让产物逐段落盘，失败只重跑一段。

   ```bash
   bash {video-to-text-skillDir}/scripts/transcribe_segments.sh \
     /path/to/video.mp4 \
     --output-dir workspace/pipeline/<project-name>/ \
     --output-prefix transcript \
     --segment-minutes 30 \
     --backend server \
     --server-url http://127.0.0.1:9878
   ```

   产物：
   - `outputs/transcript_segments_30m/seg_000.txt/json/srt/ass ...`
   - `outputs/transcript_segments_30m/transcript.segments.txt`
   - 进度：`logs/transcribe_segments_30m/status.log`

4. 快速模式（短视频/已确认稳定时）也可以继续用单文件转写：

   ```bash
   nohup python3 {video-to-text-skillDir}/scripts/transcribe.py \
     /path/to/video.mp4 \
     --output-dir workspace/pipeline/<project-name>/ \
     --output-name transcript \
     --diarize \
     > /tmp/pipeline-transcribe.log 2>&1 &
   ```

5. 等待完成（用 process poll 或检查输出文件）
6. 产出：`transcript.txt` + `transcript.json`（或分段产物）

**⚠️ 这是最耗时的阶段**，后续阶段都更快。对长音频/直播回放，优先保证“能持续产出”，而不是追求一次性跑完。

### Stage 2: 观点提炼（insight-extractor）

1. 读取 `insight-extractor` SKILL.md
2. 输入 `transcript.txt`
3. 按 insight-extractor 流程提炼：
   - 话题边界识别
   - 核心论点提取
   - 金句标注（保留时间戳）
   - 争议点标注
4. 产出：`insights.md`

**关键：** 金句和观点的时间戳要精确，Stage 3 切片需要用。

### Stage 3: 视频切片（video-clipper）

可以和 Stage 2 并行（都只依赖 Stage 1 的输出）。

1. 读取 `video-clipper` SKILL.md
2. 基于 `insights.md` 的观点 + `transcript.json` 的时间戳定位切片边界
3. **生成 `clips.list` 文件**（每行: `开始时间|结束时间|名称`）
4. **一键执行 `run-full-clipper.sh`**（Phase 3→3.5→4→4.5→5 全部串联）：
   ```bash
   nohup bash workspace/scripts/run-full-clipper.sh \
     /path/to/video.mp4 \
     clips.list \
     workspace/pipeline/<project>/clips/ \
     http://127.0.0.1:9876 \
     > /tmp/full-clipper.log 2>&1 &
   ```
5. 产出（每条切片）：
   - `<名称>.mp4` — 精修视频（去静音+去口吃+质检）
   - `<名称>.srt` — 软字幕
   - `<名称>.ass` — 样式字幕
   - `<名称>-sub.mp4` — 硬字幕版

**⚠️ 不要手动拆分流程给子 agent。`run-full-clipper.sh` 一条命令搞定。**

**优化：** 优先切 insights 中标记为「金句」和「争议点」的片段——这些做短视频最有传播力。

### Stage 4: 文章生成（article-forge）

1. 读取 `article-forge` SKILL.md
2. 输入 `insights.md` + `transcript.txt`
3. 根据目标平台选择文体和风格
4. 生成文章，严格执行去 AI 味
5. 产出：`articles/blog-xxx.md` 或 `articles/zhihu-xxx.md`

**可选：** 如果用户要求发布，调用 ZhiForge 的发布流程。

## 并行策略

```
时间线:
─────────────────────────────────────────────────>
  Stage 1 (转写)     Stage 2 (观点)     Stage 4 (文章)
  ████████████████    ████████           ████████
                      Stage 3 (切片)
                      ████████████████
```

- Stage 2 和 Stage 3 可以**并行**（用 sessions_spawn 分别跑）
- Stage 4 依赖 Stage 2 的输出，串行
- Stage 1 最慢，占总时间 60-70%

## 子 agent 编排

推荐用 `sessions_spawn` 并行化：

```
主 agent:
  1. 启动 Stage 1（转写，等待完成）
  2. spawn 子 agent A → Stage 2（观点提炼）
  3. spawn 子 agent B → Stage 3（视频切片）
  4. 等 A 完成 → 启动 Stage 4（文章生成）
  5. 等 B 完成 → 汇总输出
```

## 输出汇总模板

全部完成后，向用户汇报：

```
🎬 视频内容处理完成

📹 源文件：xxx.mp4 (时长 XX:XX)
📁 项目目录：workspace/pipeline/<name>/

📝 文字稿：transcript.txt (XXXX 字)
💡 观点提炼：insights.md
   - X 个核心观点
   - X 条金句
   - X 个争议点

🎞️ 短视频切片：X 条
   - 01-xxx.mp4 (XX:XX) — 主题
   - 02-xxx.mp4 (XX:XX) — 主题
   - ...

📄 文章：X 篇
   - blog-xxx.md (XXXX 字) — 标题
   - zhihu-xxx.md (XXXX 字) — 标题
```

## 快速触发

用户说以下任何一种，触发此 skill：

- "处理这个视频"
- "视频全链路"
- "直播回放处理"
- "把这个视频变成内容"
- "video pipeline"

默认执行 `all`（全部产出），除非用户指定只要某个阶段。

## 注意事项

- Stage 1 转写**必须用 nohup 后台**，否则超时
- 文件名含中文要建英文 symlink
- 切片依赖 transcript.json 的 word_segments，不是 transcript.txt
- 文章生成依赖 insights.md，不能跳过 Stage 2 直接到 Stage 4
- **macOS /bin/bash=3.2 没有 `mapfile`**：写批处理脚本读列表时用 `while IFS= read -r line; do ...; done < file`
- 所有产出存 `workspace/pipeline/<project-name>/`，不用 /tmp/
- 用完浏览器后必须 `browser stop`
