#!/usr/bin/env python3
"""
stutter-detect.py — 检测转录文本中的口吃/重复片段
输入: whisperX word-level JSON
输出: 每个指定时间区间内需要跳过的口吃时间段

口吃模式:
1. 连续重复同一个字/词 ≥2次（如 "对对对"、"就就就是"）
2. 连续语气词堆叠（如 "嗯嗯嗯"、"啊啊啊"）
3. 开头假启动（说了几个字又重新说）

对于口吃，保留第一次（或最后一次），跳过中间重复。
"""

import json
import sys
from typing import List, Tuple

PUNCT = set('，。？！,?!.、；：""''…——  \n\t')
# 单字母英文往往是 ASR 拆词，不算口吃
IGNORE_SINGLE = set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')
# 语气词/填充词
FILLERS = {'嗯', '啊', '呃', '哦', '噢', '哎', '呢', '吧', '嘛', '哈'}

# 合法叠词（AA 结构），这些重复不是口吃
VALID_REDUP = {
    '试试', '看看', '想想', '说说', '聊聊', '谢谢', '听听', '走走',
    '笑笑', '等等', '玩玩', '学学', '问问', '找找', '帮帮', '用用',
    '算算', '猜猜', '练练', '查查', '摸摸', '碰碰', '搞搞', '弄弄',
    '讲讲', '干干', '逛逛', '转转', '歇歇', '坐坐', '站站', '躺躺',
    '拍拍', '摇摇', '点点', '动动', '写写', '读读', '画画', '唱唱',
    '跳跳', '跑跑', '抱抱', '亲亲', '拉拉', '推推', '打打', '踢踢',
    '盘盘', '品品', '尝尝', '闻闻', '瞧瞧', '瞅瞅', '翻翻', '刷刷',
    '哈哈', '呵呵', '嘻嘻', '嘿嘿', '吼吼',
    '爸爸', '妈妈', '哥哥', '姐姐', '弟弟', '妹妹', '叔叔', '婶婶',
    '奶奶', '爷爷', '姥姥', '姑姑', '舅舅', '宝宝', '娃娃',
    '慢慢', '常常', '刚刚', '仅仅', '渐渐', '稍稍', '偷偷', '悄悄',
    '多多', '少少', '大大', '小小', '长长', '短短', '高高', '矮矮',
    '拜拜', '乖乖', '乐乐', '甜甜', '圆圆',
    '天天', '年年', '月月', '日日', '夜夜', '人人', '处处', '样样',
}


def load_words(json_path: str) -> list:
    with open(json_path) as f:
        data = json.load(f)
    return data.get('word_segments', [])


def _get_clean_words(region: list) -> list:
    """从 region 中提取非标点、非单字母英文的 word 列表，保留原始索引"""
    clean = []
    for idx, w in enumerate(region):
        word = w['word']
        if word in PUNCT or (len(word) == 1 and word in IGNORE_SINGLE):
            continue
        clean.append((idx, word, w.get('start', 0), w.get('end', 0)))
    return clean


def find_stutters(words: list, start_time: float, end_time: float) -> List[Tuple[float, float, str]]:
    """
    在 [start_time, end_time] 区间内找口吃片段。
    返回: [(skip_start, skip_end, reason), ...]
    """
    # 过滤到时间范围内的 words
    region = []
    for w in words:
        ws = w.get('start', 0)
        we = w.get('end', 0)
        if we < start_time:
            continue
        if ws > end_time:
            break
        region.append(w)

    skip_ranges = []
    clean = _get_clean_words(region)

    # ========== 模式1: 双字词/多字词组重复 ==========
    # whisperX 把中文拆成单字，所以 "就是就是" = ['就','是','就','是']
    # 检测 N-gram (N=2,3) 连续重复
    used_indices = set()  # 已标记为口吃的 clean 索引

    for ngram_len in [3, 2]:  # 先查长的，再查短的
        ci = 0
        while ci <= len(clean) - ngram_len * 2:
            if any((ci + k) in used_indices for k in range(ngram_len)):
                ci += 1
                continue

            # 提取当前 ngram
            ngram = tuple(clean[ci + k][1] for k in range(ngram_len))

            # 看后面连续出现几次
            repeat_count = 1
            pos = ci + ngram_len
            while pos + ngram_len <= len(clean):
                next_ngram = tuple(clean[pos + k][1] for k in range(ngram_len))
                if next_ngram == ngram:
                    repeat_count += 1
                    pos += ngram_len
                else:
                    break

            if repeat_count >= 2:
                phrase = ''.join(ngram)
                # 保留最后一次完整词组，跳过前面所有重复
                first_start = clean[ci][2]
                # skip 到最后保留词组的 start 前 100ms 安全间隔
                last_kept_start = clean[pos - ngram_len][2]
                skip_end = last_kept_start - 0.10

                if skip_end > first_start + 0.05:
                    skip_ranges.append((first_start, skip_end, f"'{phrase}'x{repeat_count}"))

                # 标记已使用的索引
                for k in range(ci, pos):
                    used_indices.add(k)

                ci = pos
                continue

            ci += 1

    # ========== 模式2: 单字连续重复 ==========
    ci = 0
    while ci < len(clean) - 1:
        if ci in used_indices:
            ci += 1
            continue

        _, w, ws, we = clean[ci]

        j = ci + 1
        while j < len(clean) and clean[j][1] == w:
            j += 1

        repeat_count = j - ci
        if repeat_count >= 2:
            # 检查是否是合法叠词
            if (w + w) in VALID_REDUP:
                if repeat_count == 2:
                    # 正好 AA，合法叠词，跳过
                    ci = j
                    continue
                else:
                    # AAA+, 保留最后两个（叠词），跳过前面的
                    keep_from = j - 2  # 保留最后两个
                    second_last_end = clean[keep_from - 1][3]
                    skip_start = clean[ci][2]
                    if second_last_end > skip_start + 0.05:
                        skip_ranges.append((skip_start, second_last_end, f"'{w}'x{repeat_count}(keep-redup)"))
                    for k in range(ci, j):
                        used_indices.add(k)
                    ci = j
                    continue

            # 保留最后一次，跳过前面的
            # 安全检查: 对于单字x2 (AAB 模式)，如果 B≠A，
            # 说明原文可能是 "AB" 被说成了 "AAB"（口吃在词的第一个字上）
            # 剪掉一个 A 后变成 AB，正好恢复
            # 但如果 ASR 本身转录有误(如"运维"→"运运为")，
            # 剪掉后变"运为"反而不通
            # 策略: 对单字x2，保留第一个（剪第二个），这样 AAB → AB
            should_skip = True
            skip_first = True  # True=删第一个保留第二个, False=反过来

            if repeat_count == 2 and j < len(clean):
                next_char = clean[j][1]
                if next_char != w:
                    # AAB 模式: 删第一个A，保留第二个A+B
                    # 但如果 A+B 组合不自然（如"运为"），应该整体不剪
                    # 用启发式: 如果第二个A的score明显低于第一个，可能是口吃复读
                    # 否则可能是ASR误听
                    # 更简单: 检查原文后面2个字是否跟A能组词
                    # 最简单可靠: 不剪，保留 AAB，让听众自己过滤
                    # 人耳对连续重复不敏感，比缺字强
                    should_skip = False

            if should_skip:
                # skip 到保留词的 start 前 100ms（安全间隔防截断）
                last_kept_start = clean[j - 1][2]  # 最后保留的那个字的 start
                skip_end = last_kept_start - 0.10
                skip_start = clean[ci][2]

                if skip_end > skip_start + 0.05:
                    skip_ranges.append((skip_start, skip_end, f"'{w}'x{repeat_count}"))

            for k in range(ci, j):
                used_indices.add(k)
            ci = j
            continue

        ci += 1

    # ========== 模式3: 连续语气词堆叠 ==========
    ci = 0
    while ci < len(clean):
        if ci in used_indices:
            ci += 1
            continue

        _, w, ws, we = clean[ci]
        if w not in FILLERS:
            ci += 1
            continue

        filler_end = ci + 1
        while filler_end < len(clean) and clean[filler_end][1] in FILLERS:
            filler_end += 1

        filler_count = filler_end - ci
        if filler_count >= 3:
            first_end = clean[ci][3]
            last_end = clean[filler_end - 1][3]
            if last_end > first_end + 0.1:
                skip_ranges.append((first_end, last_end, f"fillers x{filler_count}"))
        ci = filler_end

    # ========== 模式4a: Gap 口吃 ==========
    # 如果两个相同的字之间有 >0.8s 的 gap（中间无其他非标点词），
    # 第一个很可能是犹豫/口吃发出的微弱声音
    # 例: "是...(1.5s gap)...我把我的" → 第一个"我"是口吃
    ci = 0
    while ci < len(clean) - 1:
        if ci in used_indices:
            ci += 1
            continue
        
        _, w_a, ws_a, we_a = clean[ci]
        _, w_b, ws_b, we_b = clean[ci + 1]
        
        # 同一个字，间隔 > 0.8s
        if w_a == w_b and (ws_b - we_a) > 0.8:
            # 第一个可能是犹豫发音，跳过它
            skip_s = ws_a
            skip_e = ws_b - 0.03  # 安全间隔
            if skip_e > skip_s + 0.05:
                skip_ranges.append((skip_s, skip_e, f"gap-stutter:'{w_a}'"))
                used_indices.add(ci)
        
        ci += 1
    
    # ========== 模式4b: 假启动 / 间隔重复 ==========
    # 如 "得在得挂着" → "得在" 是假启动，跳过到第二个"得"
    # 严格条件: A [1个词] A，间隔 < 1s，且 A 不是常见虚词/代词
    # 这种模式就是说话说了一个字又重新说，典型口吃
    SKIP_FALSE_START = {
        # 常见虚词、代词、连词 — 这些 A x A 往往是正常语法
        '的', '了', '是', '在', '和', '与', '也', '都', '就', '又', '还',
        '不', '没', '有', '会', '能', '要', '可', '让', '被', '把', '给',
        '到', '从', '向', '对', '为', '以', '之', '而', '或', '但', '跟',
        '我', '你', '他', '她', '它', '们', '这', '那', '什', '哪',
        # 常见动词（"去做去" 不是口吃）
        '去', '来', '说', '看', '听', '做', '写', '想', '用', '找', '打',
        '吃', '喝', '走', '跑', '买', '卖', '聊', '玩', '学', '教', '问',
        # 数词/量词
        '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
        '百', '千', '万', '个', '条', '点',
        # 其他高频词
        '好', '大', '小', '多', '少', '上', '下', '前', '后', '里', '外',
        '年', '月', '天', '时', '分', '秒', '第', '每',
        '情', '事', '人', '家', '起',
    }
    ci = 0
    while ci < len(clean) - 2:
        if ci in used_indices:
            ci += 1
            continue

        _, w_a, ws_a, we_a = clean[ci]

        if w_a in SKIP_FALSE_START or w_a in FILLERS:
            ci += 1
            continue

        # 只检查间隔 1 个词的 A x A（间隔 2 个词误判率太高）
        target_ci = ci + 2
        if target_ci < len(clean) and target_ci not in used_indices:
            _, w_b, ws_b, we_b = clean[target_ci]
            _, w_mid, _, _ = clean[ci + 1]
            if w_a == w_b and (ws_b - we_a) < 1.0:
                # 排除固定语法: "A了A"、"A一A"、"A来A去" 等
                if w_mid in ('了', '一', '来', '过', '不', '又'):
                    ci += 1
                    continue
                # 排除 "很X很Y"、"越X越Y" 等程度副词搭配
                # 中间词 + 第二次A后面的词 可能构成不同意思
                if w_a in ('很', '越', '更', '最', '太', '真', '挺', '涨', '所'):
                    ci += 1
                    continue
                # 排除 "各种各样"、"改哪改这" 等
                if w_mid in ('种', '哪', '啥', '什'):
                    ci += 1
                    continue

                skip_s = ws_a
                # skip end 在第二个 A 之前留 100ms 安全间隔
                # 确保第二个 A 的起音完全不被截断
                skip_e = ws_b - 0.10
                if skip_e > skip_s + 0.1:
                    skip_ranges.append((skip_s, skip_e, f"false-start:'{w_a}'"))
                    for k in range(ci, target_ci):
                        used_indices.add(k)

        ci += 1

    return merge_ranges(skip_ranges)


def merge_ranges(ranges: List[Tuple[float, float, str]]) -> List[Tuple[float, float, str]]:
    """合并重叠/相邻的跳过区间 (gap < 0.1s 合并)"""
    if not ranges:
        return []
    sorted_r = sorted(ranges, key=lambda x: x[0])
    merged = [sorted_r[0]]
    for s, e, reason in sorted_r[1:]:
        prev_s, prev_e, prev_r = merged[-1]
        if s <= prev_e + 0.1:
            merged[-1] = (prev_s, max(prev_e, e), f"{prev_r}+{reason}")
        else:
            merged.append((s, e, reason))
    return merged


def main():
    if len(sys.argv) < 4:
        print("Usage: stutter-detect.py <json> <start_sec> <end_sec>")
        print("  Outputs skip ranges for ffmpeg")
        sys.exit(1)

    json_path = sys.argv[1]
    start_time = float(sys.argv[2])
    end_time = float(sys.argv[3])

    words = load_words(json_path)
    stutters = find_stutters(words, start_time, end_time)

    if not stutters:
        # No stutters found
        sys.exit(0)

    # Output format: one line per skip range
    # start_sec end_sec reason
    for s, e, r in stutters:
        # Adjust to be relative to clip start (since ffmpeg cuts from start)
        rel_s = s - start_time
        rel_e = e - start_time
        if rel_s < 0:
            rel_s = 0
        if rel_e <= rel_s:
            continue
        print(f"{rel_s:.3f} {rel_e:.3f} {r}")


if __name__ == '__main__':
    main()
