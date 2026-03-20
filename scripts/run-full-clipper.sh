#!/bin/bash
# run-full-clipper.sh — 视频切片全流程：粗切 → 去静音 → 口吃精修 → 质检 → 字幕
#
# 用法:
#   bash scripts/run-full-clipper.sh <视频文件> <clips.list> <输出目录> [whisperx-url]
#
# clips.list 格式（每行一条）:
#   开始时间|结束时间|名称
#   30:16|31:58|01-胆子够大
#   1:50:08|1:52:20|02-AI后背发凉
#
# 时间格式: MM:SS 或 H:MM:SS（超过 59:59 必须用 H:MM:SS）
#
# 输出（每条切片）:
#   <名称>.mp4          精修后的视频
#   <名称>.srt          软字幕
#   <名称>.ass          样式字幕
#   <名称>-sub.mp4      硬字幕版（可直接发平台）
#
# 依赖:
#   - ffmpeg / ffprobe
#   - python3 + requests
#   - WhisperX HTTP server（默认 http://127.0.0.1:9876）
#   - workspace/scripts/ 下的全套脚本

set -euo pipefail

# ============================================================
# 参数
# ============================================================
INPUT="${1:?用法: $0 <视频文件> <clips.list> <输出目录> [whisperx-url]}"
CLIPS_LIST="${2:?缺少 clips.list 文件路径}"
OUTDIR="${3:?缺少输出目录}"
WHISPERX_URL="${4:-http://127.0.0.1:9876}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 检查依赖
for cmd in ffmpeg ffprobe python3; do
  command -v "$cmd" >/dev/null || { echo "❌ 缺少 $cmd"; exit 1; }
done

for script in smart-silence.py stutter-skip-gen.py drag-skip-gen.py skip-merge.py \
              stutter-verify-ai.py llm-skip-apply.py fix-av-sync.py clip-subtitles.py clip-postcheck.py; do
  [ -f "$SCRIPT_DIR/$script" ] || { echo "❌ 缺少 $SCRIPT_DIR/$script"; exit 1; }
done

[ -f "$INPUT" ] || { echo "❌ 视频文件不存在: $INPUT"; exit 1; }
[ -f "$CLIPS_LIST" ] || { echo "❌ clips.list 不存在: $CLIPS_LIST"; exit 1; }

mkdir -p "$OUTDIR"

# ============================================================
# 工具函数
# ============================================================
to_seconds() {
  local t="$1"
  if [[ "$t" == *:*:* ]]; then
    IFS=':' read -r h m s <<< "$t"
    echo $(( 10#$h * 3600 + 10#$m * 60 + 10#$s ))
  else
    IFS=':' read -r m s <<< "$t"
    echo $(( 10#$m * 60 + 10#$s ))
  fi
}

to_hms() {
  local t="$1"
  if [[ "$t" == *:*:* ]]; then echo "$t"; return; fi
  local mm="${t%%:*}"; local ss="${t##*:}"
  local hh=$((mm / 60)); local rm=$((mm % 60))
  printf "%d:%02d:%s" "$hh" "$rm" "$ss"
}

get_duration() {
  ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null
}

log() {
  echo "[$(date +%H:%M:%S)] $*"
}

# ============================================================
# 读取 clips.list
# ============================================================
clips=()
while IFS= read -r line || [[ -n "$line" ]]; do
  # 跳过空行和注释
  [[ -z "$line" || "$line" == \#* ]] && continue
  clips+=("$line")
done < "$CLIPS_LIST"

total=${#clips[@]}
if [ "$total" -eq 0 ]; then
  echo "❌ clips.list 中没有有效条目"
  exit 1
fi

log "🎬 开始处理 $total 条切片"
log "   源视频: $INPUT"
log "   输出目录: $OUTDIR"
log "   WhisperX: $WHISPERX_URL"
echo ""

FADE_DUR=0.02
STUTTER_SCRIPT="$SCRIPT_DIR/stutter-detect.py"
SMART_SCRIPT="$SCRIPT_DIR/smart-silence.py"

# ============================================================
# Phase 3: 批量粗切 + 去静音
# ============================================================
count=0
for clip_entry in "${clips[@]}"; do
  IFS='|' read -r start end name <<< "$clip_entry"
  count=$((count + 1))

  hms_start=$(to_hms "$start")
  hms_end=$(to_hms "$end")

  log "[$count/$total] Phase 3: 粗切+去静音 — $name ($hms_start → $hms_end)"

  RAW="$OUTDIR/.raw-${name}.mp4"
  FINAL="$OUTDIR/${name}.mp4"

  # Step 1: 精确切片
  ffmpeg -ss "$hms_start" -to "$hms_end" -i "$INPUT" \
    -c:v libx264 -preset fast -crf 23 \
    -c:a aac -b:a 128k \
    -y "$RAW" 2>/dev/null

  if [ ! -f "$RAW" ] || [ ! -s "$RAW" ]; then
    log "  ❌ 粗切失败，跳过"
    rm -f "$RAW"
    continue
  fi

  DURATION=$(get_duration "$RAW")

  # Step 2: 静音检测
  SILENCE_LOG="$OUTDIR/.silence-${name}.txt"
  ffmpeg -i "$RAW" -af "silencedetect=noise=-28dB:d=0.25" -f null - 2>"$SILENCE_LOG"

  # Step 3: 口吃检测（legacy，基于原始转写）
  STUTTER_FILE="$OUTDIR/.stutter-${name}.txt"
  > "$STUTTER_FILE"
  if [ -f "$STUTTER_SCRIPT" ]; then
    abs_start=$(to_seconds "$hms_start")
    abs_end=$(to_seconds "$hms_end")
    python3 "$STUTTER_SCRIPT" /dev/null "$abs_start" "$abs_end" 2>/dev/null > "$STUTTER_FILE" || true
  fi

  # Step 4: 生成 keep 区间 + trim+concat
  KEEP_FILE="$OUTDIR/.keep-${name}.txt"
  python3 "$SMART_SCRIPT" "$SILENCE_LOG" "$DURATION" "$STUTTER_FILE" > "$KEEP_FILE" 2>/dev/null

  NUM_KEEPS=$(wc -l < "$KEEP_FILE" | tr -d ' ')

  if [ "$NUM_KEEPS" -le 1 ]; then
    mv "$RAW" "$FINAL"
    log "  ✅ 无需去静音"
  else
    # 生成 filter_complex
    FC_FILE="$OUTDIR/.fc-${name}.txt"
    python3 << PYEOF > "$FC_FILE"
FADE_DUR = ${FADE_DUR}
keeps = []
with open("${KEEP_FILE}") as f:
    for line in f:
        if line.startswith('#'): continue
        parts = line.strip().split()
        if len(parts) >= 2:
            keeps.append((float(parts[0]), float(parts[1])))
n = len(keeps)
if n <= 1:
    import sys; sys.exit(0)
lines = []
for i, (s, e) in enumerate(keeps):
    seg_dur = max(0.0, e - s)
    lines.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}];")
    a = f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS"
    if seg_dur >= FADE_DUR * 2 + 0.02:
        out_st = seg_dur - FADE_DUR
        a += f",afade=t=in:st=0:d={FADE_DUR:.3f},afade=t=out:st={out_st:.3f}:d={FADE_DUR:.3f}"
    lines.append(a + f"[a{i}];")
v_concat = "".join(f"[v{i}]" for i in range(n))
lines.append(f"{v_concat}concat=n={n}:v=1:a=0[outv];")
a_concat = "".join(f"[a{i}]" for i in range(n))
lines.append(f"{a_concat}concat=n={n}:v=0:a=1[outa]")
print("\n".join(lines))
PYEOF

    if [ ! -s "$FC_FILE" ]; then
      mv "$RAW" "$FINAL"
    else
      ffmpeg -i "$RAW" \
        -filter_complex_script "$FC_FILE" \
        -map '[outv]' -map '[outa]' \
        -c:v libx264 -preset fast -crf 23 \
        -c:a aac -b:a 128k \
        -movflags +faststart \
        -y "$FINAL" 2>/dev/null

      if [ $? -ne 0 ]; then
        log "  ⚠️ filter 失败，使用粗切版本"
        mv "$RAW" "$FINAL"
      else
        rm -f "$RAW"
      fi
    fi
    rm -f "$FC_FILE"
  fi

  rm -f "$SILENCE_LOG" "$STUTTER_FILE" "$KEEP_FILE"

  if [ -f "$FINAL" ]; then
    dur=$(get_duration "$FINAL" | cut -d. -f1)
    orig_dur=$(echo "$DURATION" | cut -d. -f1)
    log "  ✅ Phase 3 完成: ${dur}s ← ${orig_dur}s"
  fi
done

echo ""
log "=========================================="
log "Phase 3 全部完成，开始 Phase 3.5（口吃精修）"
log "=========================================="
echo ""

# ============================================================
# Phase 3.5: 口吃精修 v2
# 对每条切片: 转写 → stutter-skip-gen → drag-skip-gen → skip-merge → llm-skip-apply → fix-av-sync
# ============================================================
count=0
for clip_entry in "${clips[@]}"; do
  IFS='|' read -r start end name <<< "$clip_entry"
  count=$((count + 1))

  CLIP="$OUTDIR/${name}.mp4"
  [ -f "$CLIP" ] || { log "[$count/$total] ⚠️ $name.mp4 不存在，跳过"; continue; }

  log "[$count/$total] Phase 3.5: 口吃精修 — $name"

  # 备份原始版本
  BAK="$OUTDIR/${name}.phase3.bak.mp4"
  [ -f "$BAK" ] || cp "$CLIP" "$BAK"

  # Step 1: WhisperX 转写（生成 word_segments）
  log "  转写中..."
  WX_JSON="$OUTDIR/${name}.whisperx.json"
  python3 "$SCRIPT_DIR/clip-subtitles.py" "$CLIP" >/dev/null 2>&1 || true

  if [ ! -f "$WX_JSON" ]; then
    log "  ⚠️ 转写失败，跳过精修"
    continue
  fi

  # Step 2: stutter-skip-gen（重复/重启型口吃）
  STUTTER_SKIP="$OUTDIR/.${name}.stutter.json"
  python3 "$SCRIPT_DIR/stutter-skip-gen.py" "$WX_JSON" "$STUTTER_SKIP" --mode normal --pad 0.03 2>/dev/null || true

  # Step 3: drag-skip-gen（拖长字型口吃）
  DRAG_SKIP="$OUTDIR/.${name}.drag.json"
  python3 "$SCRIPT_DIR/drag-skip-gen.py" "$WX_JSON" "$DRAG_SKIP" --mode normal --pad 0.03 2>/dev/null || true

  # Step 4: skip-merge（合并所有 skip 区间）
  MERGED_SKIP="$OUTDIR/.${name}.merged.json"
  AI_REVIEW="$OUTDIR/${name}.ai-review.json"
  AI_APPROVED="$OUTDIR/.${name}.ai-approved.json"
  skip_inputs=()
  [ -f "$STUTTER_SKIP" ] && [ -s "$STUTTER_SKIP" ] && skip_inputs+=("$STUTTER_SKIP")
  [ -f "$DRAG_SKIP" ] && [ -s "$DRAG_SKIP" ] && skip_inputs+=("$DRAG_SKIP")

  if [ ${#skip_inputs[@]} -eq 0 ]; then
    log "  ✅ 无口吃检出"
    rm -f "$STUTTER_SKIP" "$DRAG_SKIP"
    continue
  fi

  python3 "$SCRIPT_DIR/skip-merge.py" "$MERGED_SKIP" "${skip_inputs[@]}" 2>/dev/null || true

  merged_count=$(python3 -c "
import json
try:
    d=json.load(open('$MERGED_SKIP'))
    print(len(d.get('skip_ranges', [])))
except Exception:
    print(0)
" 2>/dev/null)

  if [ "$merged_count" = "0" ]; then
    log "  ✅ 合并后无有效 skip"
    rm -f "$STUTTER_SKIP" "$DRAG_SKIP" "$MERGED_SKIP"
    continue
  fi

  # Step 4.5: AI/启发式复扫 v3（强调白名单 + 精准边界）
  python3 "$SCRIPT_DIR/stutter-verify-ai-v3.py" \
    "$WX_JSON" "$AI_REVIEW" "$AI_APPROVED" "$MERGED_SKIP" --clip "$name.mp4" \
    >/dev/null 2>&1 || true

  approved_count=$(python3 -c "
import json
try:
    d=json.load(open('$AI_APPROVED'))
    print(len(d.get('skip_ranges', [])))
except Exception:
    print(0)
" 2>/dev/null)

  review_engine=$(python3 -c "
import json
try:
    d=json.load(open('$AI_REVIEW'))
    print((d.get('engine') or {}).get('mode','unknown'))
except Exception:
    print('unknown')
" 2>/dev/null)

  if [ "$approved_count" = "0" ]; then
    log "  ✅ 复扫后全部驳回（engine=$review_engine, candidates=$merged_count）"
    rm -f "$STUTTER_SKIP" "$DRAG_SKIP" "$MERGED_SKIP" "$AI_APPROVED"
    continue
  fi

  log "  检出 $merged_count 个候选，复扫通过 $approved_count 个（engine=$review_engine），应用跳切..."

  # Step 5: llm-skip-apply-v3（segment+concat 跳切，防漂移）
  REFINED="$OUTDIR/.${name}.refined.mp4"
  python3 "$SCRIPT_DIR/llm-skip-apply-v3.py" "$CLIP" "$AI_APPROVED" --pad 0.02 --out "$REFINED" 2>/dev/null

  if [ ! -f "$REFINED" ] || [ ! -s "$REFINED" ]; then
    log "  ⚠️ 跳切失败，保留原版"
    rm -f "$REFINED"
  else
    mv "$REFINED" "$CLIP"

    dur_before=$(get_duration "$BAK" | cut -d. -f1)
    dur_after=$(get_duration "$CLIP" | cut -d. -f1)
    log "  ✅ 精修完成: ${dur_after}s ← ${dur_before}s (去除 $skip_count 处口吃)"
  fi

  # 清理中间文件（保留 ai-review.json 供验收回看）
  rm -f "$STUTTER_SKIP" "$DRAG_SKIP" "$MERGED_SKIP" "$AI_APPROVED" "$WX_JSON"
done

echo ""
log "=========================================="
log "Phase 3.5 完成，开始 Phase 4（二次质检）"
log "=========================================="
echo ""

# ============================================================
# Phase 4: 二次质检（WhisperX postcheck + 自动修复）
# ============================================================
pc_total=0
pc_fixed=0
pc_clean=0
pc_failed=0

for clip_entry in "${clips[@]}"; do
  IFS='|' read -r start end name <<< "$clip_entry"
  CLIP="$OUTDIR/${name}.mp4"
  [ -f "$CLIP" ] || continue

  pc_total=$((pc_total + 1))
  log "[postcheck $pc_total/$total] $name"

  POSTCHECK_JSON="$OUTDIR/${name}.postcheck.json"
  OUTPUT=$(python3 "$SCRIPT_DIR/clip-postcheck.py" "$CLIP" --fix --json-out "$POSTCHECK_JSON" 2>&1) || true

  if echo "$OUTPUT" | grep -q "No residual stutters"; then
    log "  ✅ Clean"
    pc_clean=$((pc_clean + 1))
  elif echo "$OUTPUT" | grep -q "Fixed:"; then
    fixed_file="${CLIP%.mp4}-fixed.mp4"
    if [ -f "$fixed_file" ]; then
      mv "$fixed_file" "$CLIP"
      log "  🔧 Fixed"
      pc_fixed=$((pc_fixed + 1))
    else
      log "  ⚠️ Fix 报告但文件不存在"
      pc_failed=$((pc_failed + 1))
    fi
  else
    log "  ❌ 质检异常"
    pc_failed=$((pc_failed + 1))
  fi

  # A/V sync guard
  tmp_sync="${CLIP%.mp4}-.syncguard.mp4"
  python3 "$SCRIPT_DIR/fix-av-sync.py" "$CLIP" "$tmp_sync" --mode trim >/dev/null 2>&1 && mv "$tmp_sync" "$CLIP" || rm -f "$tmp_sync"
done

log "质检结果: $pc_total 条, clean=$pc_clean, fixed=$pc_fixed, failed=$pc_failed"

echo ""
log "=========================================="
log "Phase 4 完成，开始 Phase 4.5（字幕生成）"
log "=========================================="
echo ""

# ============================================================
# Phase 4.5: 字幕生成（SRT + ASS + 硬字幕 MP4）
# ============================================================
for clip_entry in "${clips[@]}"; do
  IFS='|' read -r start end name <<< "$clip_entry"
  CLIP="$OUTDIR/${name}.mp4"
  [ -f "$CLIP" ] || continue

  log "[字幕] $name"

  # 删除旧的 whisperx json（强制重转写，因为视频已经变了）
  rm -f "$OUTDIR/${name}.whisperx.json"

  # 先生成 SRT + ASS（不带 --burn，确保字幕文件一定产出）
  python3 "$SCRIPT_DIR/clip-subtitles.py" "$CLIP" --cleanup 2>/dev/null || true

  if [ -f "$OUTDIR/${name}.srt" ]; then
    log "  ✅ SRT + ASS 字幕生成成功"
    # 再尝试压制硬字幕（失败不阻塞）
    python3 "$SCRIPT_DIR/clip-subtitles.py" "$CLIP" --burn --cleanup 2>/dev/null || true
    if [ -f "$OUTDIR/${name}-sub.mp4" ]; then
      log "  ✅ 硬字幕压制成功"
    else
      log "  ⚠️ 硬字幕压制失败（SRT/ASS 已生成，可手动压制）"
    fi
  else
    log "  ⚠️ 字幕生成失败"
  fi
done

echo ""
log "=========================================="
log "Phase 5: 最终检查"
log "=========================================="
echo ""

# ============================================================
# Phase 5: 最终检查
# ============================================================
echo "切片                                    大小   时长"
echo "---------------------------------------- ----- -----"
for clip_entry in "${clips[@]}"; do
  IFS='|' read -r start end name <<< "$clip_entry"
  CLIP="$OUTDIR/${name}.mp4"
  [ -f "$CLIP" ] || continue
  sz=$(du -h "$CLIP" | cut -f1)
  dur=$(get_duration "$CLIP" | cut -d. -f1)
  min=$((dur/60)); sec=$((dur%60))
  
  # 检查字幕文件
  srt_ok=""; ass_ok=""; sub_ok=""
  [ -f "$OUTDIR/${name}.srt" ] && srt_ok="SRT"
  [ -f "$OUTDIR/${name}.ass" ] && ass_ok="ASS"
  [ -f "$OUTDIR/${name}-sub.mp4" ] && sub_ok="硬字幕"
  extras="$srt_ok $ass_ok $sub_ok"
  
  printf "  %-35s %5s  %d:%02d  %s\n" "$name.mp4" "$sz" "$min" "$sec" "$extras"
done

echo ""
# 清理中间文件
rm -f "$OUTDIR"/.raw-* "$OUTDIR"/.silence-* "$OUTDIR"/.stutter-* "$OUTDIR"/.fc-* \
      "$OUTDIR"/.keep-* "$OUTDIR"/.*.stutter.json "$OUTDIR"/.*.drag.json \
      "$OUTDIR"/.*.merged.json "$OUTDIR"/.*.refined.mp4 "$OUTDIR"/.*.synced.mp4

log "🎬 全部完成！"
log "   输出目录: $OUTDIR"
log "   每条切片包含: .mp4（精修版）+ .srt + .ass + -sub.mp4（硬字幕版）"
