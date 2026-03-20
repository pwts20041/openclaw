---
name: video-clipper
description: 从长视频（直播回放、会议录像、播客）中批量生成短视频切片。基于转写文稿精确定位观点边界，自动去除静音卡顿和口吃，输出音画同步的短视频。适用于：直播切片、会议精华提取、短视频二创、播客精彩片段。
---

# Video Clipper — 长视频智能切片

## 当前推荐架构（先按这个收敛）

把整个流程明确拆成 **5 步**，不要再把“选段”和“执行切片”混成一个黑盒：

1. **转写**：视频 → `transcript.segments.txt` + `seg_XXX.json`
2. **洞察提炼**：转写 → `insights.md`
3. **选段器**：`insights.md` / transcript → `clips.list`
4. **执行器**：`clips.list` → 精切视频 / 字幕 / 成片
5. **验收**：检查“观点是否完整 / 金句是否成立 / 是否能独立成片”

### 双模式输出（必须显式区分）

切片至少支持两种模式，**不能混切**：

- **观点版（opinion）**：要求观点完整，至少要有“铺垫/背景 → 观点 → 解释/例子 → 收束”中的 3 个要素。
- **金句版（punchline）**：强调一句话传播力，允许更短，但必须单句成立，不依赖太多上下文。

如果用户没明确说明，默认先问；如果必须代判：

- 面向短视频传播、封面标题、钩子 → 优先金句版
- 面向讲清观点、课程、复盘、知识表达 → 优先观点版

### AI 验收 gate（必须有）

选段器不是“找一句好话”就结束。**候选片段生成后，必须再过一层 AI 验收，验收通过后才能写入 `clips.list`。**

#### 验收目标

AI 复验的不是“值不值得切”，而是：

> **这段能不能脱离原视频上下文，独立成为一个完整短视频？**

#### AI 验收检查项

对每个候选片段，至少检查：

1. 脱离原视频后，开头 3-5 秒能不能听懂在讲什么
2. 是否有明确观点句，而不是只有情绪/口号
3. 是否有解释、例子、展开，还是只有一句金句
4. 结尾是否收住，还是像“话说一半”
5. 这段更适合：`opinion` / `punchline` / `reject`

#### 观点版验收标准

4 条里至少满足 3 条，否则退回重选：

- 有背景/铺垫
- 有明确观点
- 有解释或例子
- 有结尾收束

#### 金句版验收标准

必须同时满足：

- 一句话本身成立
- 前后不依赖大量上下文
- 时长短，传播感强
- 不会因为切掉上下文而让人听不懂

#### 输出建议

AI 验收后，候选结果建议至少包含：

- `mode`: `opinion` / `punchline`
- `start`, `end`
- `title`
- `why_selected`
- `why_passed`
- `risks`（例如：开头偏弱 / 结尾略硬 / 仍需人工二审）

## 依赖

- **ffmpeg / ffprobe**: 视频切片、静音检测、trim+concat（系统已安装）
- **whisperx venv**: `scripts/.venv-whisperx/`（用于二次质检）
- **转写 JSON**: 需要 `video-to-text` skill 的带时间戳 JSON 输出（用于精确定位和口吃检测）
- **脚本集**（均在 `workspace/scripts/`）：
  - `batch-clip-v4.sh` — 主批量切片脚本（去静音 + 去口吃 + crossfade）
  - `smart-silence.py` — 智能静音处理（长静音删除 / 短静音压缩）
  - `stutter-detect.py` — 口吃检测（legacy，基于重复 token；对“拖长/卡音”不敏感）
  - `stutter-skip-gen.py` — 口吃候选生成（v2：repeat/restart，基于 word_segments）
  - `drag-skip-gen.py` — 拖长字检测（v2：按单字时长异常抓“我——/那——”）
  - `skip-merge.py` — 合并多个 skip_ranges JSON（union + merge overlaps）
  - `llm-skip-apply.py` — 应用 skip_ranges 进行 trim+concat 跳切
  - `fix-av-sync.py` — 修复音画时长差（对齐视频/音频时长）
  - `clip-subtitles.py` — 对 clip 本身重转写并生成字幕（同时产出 word_segments）
  - `clip-postcheck.py` — WhisperX 二次扫描 + 自动修复残留口吃
  - `batch-postcheck.sh` — 批量二次质检脚本
  - `iterate-until-clean.py` — 单条 clip 反复迭代（转写→检测→修复→再转写）直到零问题

## 一键执行（推荐）

**大多数情况下，只需准备好 `clips.list` 然后跑一条命令：**

```bash
# 1. 准备 clips.list（每行: 开始时间|结束时间|名称）
cat > clips.list << 'EOF'
30:16|31:58|01-胆子够大
1:50:08|1:52:20|02-AI后背发凉
EOF

# 2. 一键执行（Phase 3 → 3.5 → 4 → 4.5 → 5 全部串联）
nohup bash workspace/scripts/run-full-clipper.sh \
  /path/to/video.mp4 \
  clips.list \
  workspace/pipeline/<project>/clips/ \
  http://127.0.0.1:9876 \
  > /tmp/full-clipper.log 2>&1 &

# 3. 监控进度
tail -f /tmp/full-clipper.log
```

**输出（每条切片）：**

- `<名称>.mp4` — 精修后的视频（去静音+去口吃+质检修复）
- `<名称>.srt` — 软字幕
- `<名称>.ass` — 样式字幕（黄字+重点放大）
- `<名称>-sub.mp4` — 硬字幕版（可直接发平台）

**子 agent 调用时：只需传 clips.list 和参数，跑这一条命令即可，不要手动拆分流程。**

---

## 完整流程（推荐按 5 步理解）

```
Step 1: 素材准备 / 转写校验
Step 2: 洞察提炼（insights）
Step 3: 选段器（生成 clips.list）
Step 3.5: AI 验收 gate（通过后才能进 clips.list）
Step 4: 执行切片（粗切 + 去静音 + 精切 + sync）
Step 5: 质检与包装（重转写检查 + 字幕 + 成片）
```

> **注意：`run-full-clipper.sh` 只负责 Step 4-5 的执行链。** 它不是选段器，也不该替你决定切什么。
> 选段器和 AI 验收必须在执行前完成。

---

### Phase 1: 素材准备

1. **确认输入文件**，获取总时长
2. **CJK 文件名处理**：含中文则建英文 symlink，后台 nohup 命令需用英文路径
   ```bash
   mkdir -p workspace/pipeline/<project-name>/
   ln -sf "/path/to/直播回放.mp4" workspace/pipeline/<project-name>/input.mp4
   ```
3. **确认转写 JSON 存在**：`video-to-text` skill 的输出（含 word_segments 级时间戳）

---

### Step 2-3: 选段器（先分模式，再定位）

**最关键的一步——不能凭直觉猜时间戳，必须先确定模式，再基于转写文字精确定位。**

#### 2.1 先确定输出模式

- **观点版（opinion）**：用于“讲明白一个观点”
- **金句版（punchline）**：用于“一句话传播/标题/钩子”

不要把两者混在一个 `clips.list` 里。建议分别输出：

- `clips-opinion.list`
- `clips-punchline.list`

#### 2.2 候选来源

- 优先用 `insight-extractor` 输出中的核心观点 / 金句 / 争议点 / 行动项
- 或人工给出主题，再用转写 JSON 定位

#### 2.3 用转写 JSON 校准边界

```python
import json

with open("transcript.json") as f:
    data = json.load(f)

for seg in data["segments"]:
    if START <= seg["start"] <= END:
        m, s = divmod(int(seg["start"]), 60)
        h, m = divmod(m, 60)
        ts = f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
        print(f"  [{ts}] {seg['text'].strip()}")
```

#### 2.4 精确边界原则

**观点版（opinion）**：

1. **观点完整**：从引入/铺垫 → 结论/反应，不截断
2. **前不带冗余**：切掉闲聊、过渡、无关内容
3. **后不拖尾**：观点讲完即切，不带下一话题开头
4. **扩展确认**：向前后各扩 2-3 分钟，确认边界无误

**金句版（punchline）**：

1. 允许更短，但单句必须成立
2. 金句前后最多保留少量必要上下文
3. 不要求完整论述链，但要求传播感强
4. 若切完后“听起来像话说一半”，则不合格

#### 2.5 AI 验收（必须）

定位出候选时间段后，不要直接执行切片，先让 AI 输出结构化判断：

```json
{
  "mode": "opinion",
  "start": "00:41:50",
  "end": "00:43:20",
  "title": "你给他一个电脑",
  "why_selected": "这是安全边界主题的核心表达",
  "why_passed": ["开头有场景铺垫", "中间有明确观点", "结尾有收束"],
  "risks": ["前 3 秒钩子较弱，适合封面补强"],
  "decision": "pass"
}
```

如果 `decision != pass`，就回到候选阶段重选，不要硬切。

#### 2.6 时间戳格式

- < 60 分钟：`MM:SS`（如 `41:40`）
- ≥ 60 分钟：`H:MM:SS`（如 `1:50:08`）

---

### Phase 3: 批量切片（主流程）

使用 `scripts/batch-clip-v4.sh`。

#### Phase 3 做什么（基础版）

1. **精确粗切**（`ffmpeg -ss ... -to ...`）：从原视频按时间段切出原始片段
2. **静音处理**（`smart-silence.py`）：
   - 长静音（≥0.5s）：完全跳过
   - 短静音（0.25-0.5s）：压缩到 0.12s（保留呼吸感）
3. **trim+concat + 无重叠音频 fade 拼接**：
   - 视频：plain concat（避免视觉闪烁）
   - 音频：每段做 `afade in/out`（20ms）再 `concat`（**无重叠**，消除"咔哒"感且不改变时间轴）

> 说明：这一步对“拖长/卡音”类口吃不敏感。真正显著提质靠 Phase 3.5（script-v2 + LLM 二次精修）。

#### ⚠️ 关键约束

- **不能用 `select/aselect`**：长视频音视频时间基不同，会产生漂移
- **不要用 `acrossfade` 做音频拼接**：它会让音频在拼接点发生重叠（总时长变短），多次拼接后会出现“越往后越飘”的渐进漂移
- **必须用 `nohup` 后台运行**：14 条 × 每条约 2-3 分钟，总耗时 ~20-30 分钟
- **macOS /bin/bash=3.2 无 `mapfile`**：用 `while IFS= read -r line` 替代（zsh/bash 都适用）
- **时间戳 >59:59 时**：必须用 `H:MM:SS` 格式（`109:30` → `1:49:30`）

#### 运行方式

```bash
# 确认 symlink 存在（不要放 /tmp，放工作目录，方便 pipeline 复用）
mkdir -p workspace/pipeline/<project-name>/
ln -sf "/path/to/原始视频.mp4" workspace/pipeline/<project-name>/input.mp4

# 后台运行
nohup bash workspace/scripts/batch-clip-v4.sh > /tmp/batch-clip-v4.log 2>&1 &

# 监控
tail -f /tmp/batch-clip-v4.log
```

#### 修改切片列表

编辑 `batch-clip-v4.sh` 中的 `clips=()` 数组，格式为 `"start|end|name"`：

```bash
clips=(
  "30:16|31:58|01-胆子够大"
  "1:50:08|1:52:20|02-AI后背发凉"
  ...
)
```

---

### Phase 3.5: 口吃精修 v2（推荐：script-v2 → 重转写 → LLM 精修）

背景：很多“口吃/卡顿”并不会在原始字幕里表现为重复 token（尤其是 **拖长字**：`我——`、`那——`）。
因此我们引入两类规则检测：

- `stutter-skip-gen.py`：repeat/restart（字幕层面的口吃）
- `drag-skip-gen.py`：按单字时长异常抓拖长口吃

并且推荐在规则脚本之后 **重转写** 一次，再用 LLM 做“语义层面精修”（删口头禅/自我修正/无信息过渡），刀会更少、更稳。

#### 单条示例（以 clip02 为例）

```bash
# 0) 先生成该 clip 的 whisperx json（word_segments）
python3 scripts/clip-subtitles.py "clips/02-AI后背发凉.mp4" >/dev/null

# 1) 规则脚本生成 skip（stutter + drag）
python3 scripts/stutter-skip-gen.py \
  "clips/02-AI后背发凉.whisperx.json" \
  "clips/02-AI后背发凉.script-v2.stutter.normal.json" \
  --mode normal --pad 0.03

python3 scripts/drag-skip-gen.py \
  "clips/02-AI后背发凉.whisperx.json" \
  "clips/02-AI后背发凉.script-v2.drag.normal.json" \
  --mode normal --pad 0.03

python3 scripts/skip-merge.py \
  "clips/02-AI后背发凉.script-v2.merged.normal.json" \
  "clips/02-AI后背发凉.script-v2.stutter.normal.json" \
  "clips/02-AI后背发凉.script-v2.drag.normal.json"

# 2) 应用规则 skip → 得到 script-v2 版
python3 scripts/llm-skip-apply.py \
  "clips/02-AI后背发凉.mp4" \
  "clips/02-AI后背发凉.script-v2.merged.normal.json" \
  --pad 0.02 \
  --out "clips/02-AI后背发凉-scriptv2-v1.mp4"

python3 scripts/fix-av-sync.py \
  "clips/02-AI后背发凉-scriptv2-v1.mp4" \
  "clips/02-AI后背发凉-scriptv2-v1-sync.mp4" \
  --mode trim

# 若遇到“越往后越飘”的渐进漂移，用根治模式（重编码）
python3 scripts/fix-av-sync.py \
  "clips/02-AI后背发凉-scriptv2-v1.mp4" \
  "clips/02-AI后背发凉-scriptv2-v1-sync.mp4" \
  --mode reencode --fps 30 --crf 23 --ab 128k

# 3) 重转写（为 LLM 二次精修准备新时间轴，同时也顺便出字幕）
python3 scripts/clip-subtitles.py "clips/02-AI后背发凉-scriptv2-v1-sync.mp4" --cleanup
```

#### LLM 二次精修（对规则版再做“语义精修”，可选但推荐）

做法：把上一步生成的 `*-scriptv2-v1-sync.whisperx.json` 里的：

- `segments`（全文语义）
- `word_segments`（精确时间戳）

喂给 LLM，让它输出结构化 JSON（conservative/normal 两档）再用 `llm-skip-apply.py` 应用即可。

> 经验：**顺序推荐 script-v2 →（重转写）→ LLM**。反过来容易先被 LLM 大刀剪碎节奏。

---

### Phase 4: 二次质检（WhisperX post-check）

### Phase 4.5: 字幕（软字幕 + 硬字幕）

在 `batch-postcheck.sh` 里已自动接入字幕生成：

- 每条 clip 会生成：`clip.srt`（软字幕）、`clip.ass`（可控样式+重点放大）
- 同时生成：`clip-sub.mp4`（压制硬字幕，适合直接发平台）

字幕样式：白底黄字（半透明白色字幕条 + 黄色字体 + 黑描边），并对数字/金额/关键词做少量放大强调。

如果你只想要软字幕，把 `batch-postcheck.sh` 里的 `--burn` 去掉即可。

**为什么需要二次质检？**

口吃检测基于原始转写 JSON，但原始转写有时会漏掉某些口吃（没有转写出来）。  
编辑后的 clip 可能仍含残留口吃，需要用 WhisperX **重新转写 clip 本身**，再做检测。

```
clip.whisperx.json（word_segments）
   ↓
script-v2（stutter-skip-gen + drag-skip-gen）→ 跳切 → clip-scriptv2
   ↓                                            ↓
（可选）LLM 二次精修（基于重转写的 word_segments）     clip-postcheck.py（WhisperX 重转写质检）
   ↓                                            ↓
clip-final                                 发现残留 → 自动二次修复
```

#### 运行 post-check

```bash
# 激活 whisperx venv
source scripts/.venv-whisperx/bin/activate

# 单条检测（不修复，只报告）
python3 scripts/clip-postcheck.py clips/02-AI后背发凉.mp4

# 单条检测 + 自动修复（-fixed.mp4 会替换原文件）
python3 scripts/clip-postcheck.py clips/02-AI后背发凉.mp4 --fix

# 批量检测 + 自动修复全部 clips/
bash scripts/batch-postcheck.sh
```

#### clip-postcheck.py 检测项

1. **单字重复**（AA 型）：运运、对对对 → 保留最后一个
2. **短语重复**（ngram 2-4 字）：就是就是、当时的当时 → 保留后一个
3. **低置信度簇**：3 个以上 score<0.05 的连续字，且与后文重叠 → 标记为跳切残留

**有效叠词白名单（不误判）**：试试、看看、谢谢、刚刚、常常、爷爷、妈妈 等 100+ 词

#### 单条反复迭代（最严格模式）

对质量要求极高的 clip，用 `iterate-until-clean.py`：

```bash
source scripts/.venv-whisperx/bin/activate
python3 scripts/iterate-until-clean.py clips/02-AI后背发凉.mp4
```

每轮：WhisperX 转写 → 检测 → 修复 → 替换 → 再转写验证。  
最多 5 轮，通常 1-2 轮收敛。

#### 每条耗时

WhisperX 转写 1 分钟 clip ≈ 60-90 秒（CPU）。  
14 条全部 post-check ≈ 15-20 分钟。**务必后台运行**。

---

### Phase 5: 最终检查

```bash
for f in clips/*.mp4; do
  [ -f "$f" ] || continue
  sz=$(du -h "$f" | cut -f1)
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null | cut -d. -f1)
  min=$((dur/60)); sec=$((dur%60))
  printf "%-35s %5s  %d:%02d\n" "$(basename "$f")" "$sz" "$min" "$sec"
done
```

---

## 输出规格

- **位置**：`workspace/clips/<编号>-<名称>.mp4`
- **命名**：`01-胆子够大.mp4`、`02-AI后背发凉.mp4`
- **编码**：H.264 CRF23 + AAC 128kbps + faststart
- **大小**：3-25MB/条（取决于时长）
- **压缩率**：比原始切片平均短 20-30%（静音 + 口吃 + crossfade）

---

## 与其他 Skill 的衔接

```
video-to-text       →  转写 JSON（时间戳 + 口吃检测来源）
    ↓
insight-extractor   →  观点摘要（切片候选来源）
    ↓
video-clipper       →  短视频切片（本 skill）
    ├── Phase 3: batch-clip-v4.sh（去静音 + 去口吃 + crossfade）
    └── Phase 4: batch-postcheck.sh（WhisperX 二次质检）
    ↓
（人工 / 剪映加字幕）→  发布短视频平台
```

---

## 踩坑记录

| 问题                  | 原因                                                    | 解决                                                                                       |
| --------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 音画不同步            | `select/aselect` 滤镜音视频时间基不同                   | 改用 `trim/atrim + concat`                                                                 |
| 时间戳不认            | `109:30` 格式超过 59:59                                 | 改为 `H:MM:SS`（`1:49:30`）                                                                |
| macOS zsh 报错        | `mapfile` 不存在                                        | 用 `while IFS= read -r line`                                                               |
| 中文文件名乱码        | nohup 后台 + CJK 路径                                   | 建英文 symlink                                                                             |
| exec session 超时     | 15-30 分钟任务被 SIGTERM                                | 所有批量任务必须 `nohup`                                                                   |
| 残留口吃（拖长/卡音） | 原始字幕不体现重复，repeat 检测抓不到                   | Phase 3.5 script-v2（drag-skip-gen） + Phase 4 post-check                                  |
| 跳切"咔哒"声          | trim+concat 拼接点音频突变                              | 每段加 20ms `afade in/out`（无重叠）                                                       |
| 音画“越往后越飘”      | `acrossfade` 造成音频拼接点重叠（总时长变短，累积漂移） | 禁用 acrossfade，改用无重叠 `afade + concat`；必要时 `fix-av-sync.py --mode reencode` 根治 |
| 口吃误判叠词          | 试试/看看/谢谢 被当作重复                               | `VALID_REDUP` 白名单过滤                                                                   |

---

## 性能参考

| 切片数 | 总原始时长 | Phase 3 耗时 | Phase 4 耗时 |
| ------ | ---------- | ------------ | ------------ |
| 6 条   | ~15 min    | ~8 min       | ~10 min      |
| 14 条  | ~35 min    | ~20 min      | ~20 min      |
| 20 条  | ~50 min    | ~30 min      | ~28 min      |
