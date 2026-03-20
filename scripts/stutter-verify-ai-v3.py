#!/usr/bin/env python3
"""stutter-verify-ai-v3.py — 升级版 LLM 语义复扫。

v2 → v3 关键改进：
1. LLM prompt 升级：逐候选结构化判断，区分口吃 vs 强调
2. 中文口语强调模式白名单（对对对、非常非常、真的真的 etc.）
3. heuristic gate 加入上下文语义检查
4. 支持通过环境变量或 OpenClaw 本地 gateway 调用 LLM
5. ffmpeg 防漂移参数建议输出

输入/输出格式与 v2 兼容。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any


# ──────────────────────────────────────────────────────────────
# 中文口语强调模式白名单
# 这些是 native speaker 常见的有意重复，不是口吃
# ──────────────────────────────────────────────────────────────
EMPHATIC_PATTERNS = {
    # 双字强调
    "对对", "好好", "是是", "行行", "嗯嗯", "哦哦",
    "很很", "太太", "真真", "就就",
    # 三字强调
    "对对对", "好好好", "是是是", "嗯嗯嗯",
    # 强调副词重复
    "非常非常", "特别特别", "真的真的", "确实确实",
    "完全完全", "绝对绝对", "一定一定",
    # 程度副词叠加
    "很多很多", "越来越", "慢慢慢",
}

# 把白名单也做成 regex 匹配（处理 ASR 可能的空格/分词差异）
EMPHATIC_RE = re.compile(
    "|".join(re.escape(p) for p in sorted(EMPHATIC_PATTERNS, key=len, reverse=True))
)

SAFE_SHORT_REASONS = (
    "repeat:", "restart:", "drag:", "char_repeat",
    "phrase_repeat", "low_conf_repeat",
)
SAFE_FILLER_REASONS = (
    "filler:", "filler_cluster",
)
CONNECTORS = {
    "的", "了", "呢", "吗", "啊", "呀", "吧", "嘛", "就", "又", "也", "还", "都", "很", "太",
    "是", "在", "把", "被", "和", "跟", "与", "及", "并", "但", "而", "然后", "就是", "这个", "那个",
}

# ──────────────────────────────────────────────────────────────
# 数据加载（与 v2 兼容）
# ──────────────────────────────────────────────────────────────

def load_skip_ranges(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    ranges = data.get("skip_ranges") or []
    out = []
    for item in ranges:
        try:
            s, e = float(item["start"]), float(item["end"])
        except Exception:
            continue
        if e <= s:
            continue
        out.append({
            "start": round(s, 3), "end": round(e, 3),
            "reason": str(item.get("reason", "")).strip(),
        })
    return out


def load_words(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for w in data.get("word_segments") or []:
        if "start" not in w or "end" not in w:
            continue
        out.append({
            "word": str(w.get("word", "")).replace(" ", ""),
            "start": float(w["start"]),
            "end": float(w["end"]),
            "score": float(w.get("score", 1.0) or 1.0),
        })
    return out


def merge_ranges(ranges: list[dict[str, Any]], gap: float = 0.02) -> list[dict[str, Any]]:
    if not ranges:
        return []
    ranges = sorted(ranges, key=lambda x: (x["start"], x["end"]))
    merged = [dict(ranges[0])]
    for r in ranges[1:]:
        cur = merged[-1]
        if r["start"] <= cur["end"] + gap:
            cur["end"] = max(cur["end"], r["end"])
            rr = r.get("reason", "")
            if rr:
                cur["reason"] = (cur.get("reason", "") + "+" + rr).strip("+")
        else:
            merged.append(dict(r))
    for r in merged:
        r["start"] = round(float(r["start"]), 3)
        r["end"] = round(float(r["end"]), 3)
    return merged


def text_of(words: list[dict[str, Any]]) -> str:
    return "".join((w.get("word") or "") for w in words)


def build_context(words: list[dict[str, Any]], start: float, end: float, ctx_chars: int = 15) -> dict[str, Any]:
    before_words = [w for w in words if w["end"] <= start]
    cut_words = [w for w in words if not (w["end"] <= start or w["start"] >= end)]
    after_words = [w for w in words if w["start"] >= end]

    before_text = text_of(before_words[-ctx_chars:])
    cut_text = text_of(cut_words)
    after_text = text_of(after_words[:ctx_chars])

    return {
        "before_text": before_text,
        "cut_text": cut_text,
        "after_text": after_text,
        "original_text": before_text + cut_text + after_text,
        "trimmed_text": before_text + after_text,
        "left_word": before_words[-1]["word"] if before_words else "",
        "right_word": after_words[0]["word"] if after_words else "",
        "cut_word_count": len(cut_words),
        "avg_score": round(sum(w.get("score", 1.0) for w in cut_words) / len(cut_words), 4) if cut_words else 1.0,
    }


# ──────────────────────────────────────────────────────────────
# v3 强化 heuristic
# ──────────────────────────────────────────────────────────────

def is_emphatic_repeat(ctx: dict[str, Any]) -> bool:
    """检查候选区间是否属于有意强调重复（不应删除）。

    v3 修复点：
    - 只根据 *候选本身*（cut_text 及其紧邻词）判断，
      不能因为上下文里出现了“对对对”就把旁边的口吃候选也当成强调。
    """
    cut_text = (ctx.get("cut_text", "") or "").replace(" ", "")
    left = (ctx.get("left_word", "") or "").replace(" ", "")
    right = (ctx.get("right_word", "") or "").replace(" ", "")

    if not cut_text:
        return False

    span = (left + cut_text + right)

    # 1) 命中白名单（必须与 cut_text/span 重叠）
    if EMPHATIC_RE.search(cut_text) or EMPHATIC_RE.search(span):
        for pat in EMPHATIC_PATTERNS:
            if pat in cut_text or pat in span:
                return True

    # 2) "X X X" 模式（同一个字连续 3 次）→ 语气词常见强调
    if len(cut_text) <= 2 and cut_text == left:
        combo_clean = (left + cut_text + right)
        if len(combo_clean) >= 3 and len(set(combo_clean)) <= 2:
            if combo_clean[0] in "对好是行嗯哦啊呀":
                return True

    return False


def heuristic_review_v3(candidate: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    """v3 heuristic：在 v2 基础上加入强调检测和更细致的语义检查。"""
    start = candidate["start"]
    end = candidate["end"]
    reason = candidate.get("reason", "")
    dur = end - start
    decision = "reject"
    score = 0.35
    why_passed: list[str] = []
    risks: list[str] = []

    left = ctx.get("left_word", "")
    right = ctx.get("right_word", "")
    cut_text = ctx.get("cut_text", "")
    avg_score = float(ctx.get("avg_score", 1.0))

    if not cut_text:
        risks.append("候选区间内没有识别到词")
        return {"decision": "reject", "score": 0.1, "why_passed": [], "risks": risks}

    # ── 强调检测（v3 新增）──
    if is_emphatic_repeat(ctx):
        return {
            "decision": "reject",
            "score": 0.15,
            "why_passed": [],
            "risks": ["命中强调重复白名单，不应删除"],
        }

    # ── 基础规则 ──
    if reason.startswith(SAFE_SHORT_REASONS) and dur <= 0.45:
        decision = "approve"
        score = 0.92
        why_passed += ["命中短重复/拖长/重启模式", "时长短"]
    elif reason.startswith(SAFE_FILLER_REASONS) and dur <= 0.55:
        decision = "approve"
        score = 0.86
        why_passed += ["命中填充词模式"]
    elif avg_score < 0.18 and dur <= 0.4:
        decision = "approve"
        score = 0.84
        why_passed += ["ASR 置信度极低", "短脏片段"]

    # ── 边界保护 ──
    if decision == "approve":
        # 前后词相同 → 明显重复残留
        if left and right and left == right and len(left) <= 2:
            why_passed.append("前后词相同，明显重复残留")
            score = max(score, 0.95)

        # 两侧都是虚词 → 语气可能飘
        if left in CONNECTORS and right in CONNECTORS:
            risks.append("剪切点两侧都是虚词")
            score -= 0.06

        # 被删文本偏长 → 可能误伤语义
        if len(cut_text) >= 5 and dur >= 0.5:
            risks.append("被删文本偏长，可能误伤语义")
            score -= 0.15

        # 剪后形成不自然组合
        trimmed = ctx.get("trimmed_text", "")
        if trimmed and any(bad in trimmed for bad in ["就是就是", "然后然后", "这个这个"]):
            risks.append("剪后形成不自然重复组合")
            score -= 0.12

        # v3: 检查剪后是否破坏句子结构
        if left and right:
            # 动词+宾语被切断
            if len(cut_text) >= 3 and not any(cut_text.startswith(f) for f in ["嗯", "啊", "呃", "哦", "就是"]):
                risks.append("可能切断了实义内容")
                score -= 0.10

        if score < 0.7:
            decision = "reject"

    return {
        "decision": decision,
        "score": round(max(0.0, min(1.0, score)), 3),
        "why_passed": why_passed,
        "risks": risks,
    }


# ──────────────────────────────────────────────────────────────
# v3 LLM 逐候选审核（核心升级）
# ──────────────────────────────────────────────────────────────

LLM_SYSTEM_PROMPT = """你是一个中文口语视频编辑专家，专门审核"候选删除区间"。

## 你的任务
对每个候选，判断标注的部分是真正的口吃/填充词（应该删除），还是有意的强调/重复/语气词（应该保留）。

## 关键判断标准
1. **口吃/卡顿（DELETE）**：说话人无意识的重复、false start、改口、拖长音
   - 例：「我我我觉得」→ 前两个"我"是口吃
   - 例：「就是说那个呃」→ "那个呃"是填充词
   - 例：「然后后面」→ 第二个"后"是口吃残留

2. **有意强调（KEEP）**：说话人故意重复来强调语气
   - 例：「对对对，就是这样」→ "对对对"是强调认同
   - 例：「非常非常重要」→ 重复"非常"是强调程度
   - 例：「真的真的不行」→ 强调语气

3. **语境依赖（需要看上下文）**：
   - 「后后面」→ 口吃（"后"重复了）
   - 「好好好」→ 强调（连续附和）
   - 「刚刚说」→ 取决于语境，"刚刚"可能是正常用法

## 输出格式
对每个候选，返回 JSON：
```json
{
  "reviews": [
    {
      "id": "cand-001",
      "verdict": "DELETE" 或 "KEEP",
      "confidence": 0.0-1.0,
      "reason": "一句话解释判断依据"
    }
  ]
}
```

## 重要约束
- 宁可保守（KEEP）也不要误删实义内容
- 对"对对对""好好好""是是是"这类，几乎总是 KEEP
- 对单字重复（如"后后""刚刚"），需要看上下文判断是口吃还是叠词
- confidence < 0.7 的建议 KEEP"""


def build_llm_candidates(prepared_reviews: list[dict[str, Any]]) -> list[dict[str, str]]:
    """构建给 LLM 的逐候选审核输入。"""
    items = []
    for r in prepared_reviews:
        items.append({
            "id": r["id"],
            "context": f"「{r['before_text']} [【{r['cut_text']}】] {r['after_text']}」",
            "cut_text": r["cut_text"],
            "reason": r["reason"],
            "original": r["original_text"],
            "after_delete": r["trimmed_text"],
        })
    return items


def llm_review_v3(prepared_reviews: list[dict[str, Any]]) -> dict[str, Any] | None:
    """v3 LLM 审核：逐候选结构化判断。"""
    api_key = os.environ.get("OPENAI_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

    if not api_key:
        return None

    candidates = build_llm_candidates(prepared_reviews)
    user_msg = json.dumps({"candidates": candidates}, ensure_ascii=False, indent=2)

    body = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": LLM_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
    }

    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    parsed["_engine"] = {"mode": "llm-v3", "model": model, "base_url": base_url}
    return parsed


# ──────────────────────────────────────────────────────────────
# 主流程
# ──────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("whisperx_json")
    ap.add_argument("out_review_json")
    ap.add_argument("out_approved_json")
    ap.add_argument("skip_json", nargs="+")
    ap.add_argument("--clip")
    args = ap.parse_args()

    whisperx_json = Path(args.whisperx_json).expanduser().resolve()
    out_review = Path(args.out_review_json).expanduser().resolve()
    out_approved = Path(args.out_approved_json).expanduser().resolve()
    skip_paths = [Path(p).expanduser().resolve() for p in args.skip_json]

    words = load_words(whisperx_json)
    if not words:
        raise SystemExit("whisperx json has no word_segments")

    all_ranges: list[dict[str, Any]] = []
    for p in skip_paths:
        if p.exists():
            all_ranges.extend(load_skip_ranges(p))
    candidates = merge_ranges(all_ranges)

    # 构建每个候选的上下文
    prepared_reviews = []
    for i, cand in enumerate(candidates, 1):
        ctx = build_context(words, cand["start"], cand["end"])
        prepared_reviews.append({
            "id": f"cand-{i:03d}",
            "start": cand["start"],
            "end": cand["end"],
            "reason": cand.get("reason", ""),
            **ctx,
        })

    # 尝试 LLM 审核
    llm_result = None
    try:
        llm_result = llm_review_v3(prepared_reviews)
    except Exception as e:
        print(f"[stutter-verify-ai-v3] LLM review failed, fallback to heuristic: {e}", file=sys.stderr)

    reviews = []
    engine = {"mode": "heuristic-v3", "model": None, "base_url": None}

    if llm_result and isinstance(llm_result.get("reviews"), list):
        engine = llm_result.get("_engine") or engine
        llm_by_id = {str(x.get("id")): x for x in llm_result["reviews"]}

        for item in prepared_reviews:
            llm = llm_by_id.get(item["id"], {})
            heur = heuristic_review_v3(item, item)

            # v3: LLM verdict 映射
            llm_verdict = llm.get("verdict", "").upper()
            llm_confidence = float(llm.get("confidence", 0.5))

            if llm_verdict == "DELETE" and llm_confidence >= 0.7:
                decision = "approve"
                score = llm_confidence
                why_passed = [llm.get("reason", "LLM approved")]
                risks = heur["risks"]  # 保留 heuristic 发现的风险
            elif llm_verdict == "KEEP":
                decision = "reject"
                score = 1.0 - llm_confidence
                why_passed = []
                risks = [llm.get("reason", "LLM rejected")]
            else:
                # LLM 不确定或没给出 → 用 heuristic
                decision = heur["decision"]
                score = heur["score"]
                why_passed = heur["why_passed"]
                risks = heur["risks"]

            reviews.append({
                **item,
                "decision": decision,
                "score": round(score, 3),
                "why_passed": why_passed,
                "risks": risks,
                "llm_verdict": llm_verdict,
                "llm_confidence": llm_confidence,
                "llm_reason": llm.get("reason", ""),
            })
    else:
        # 纯 heuristic
        for item in prepared_reviews:
            heur = heuristic_review_v3(item, item)
            reviews.append({**item, **heur})

    approved = [
        {
            "start": r["start"],
            "end": r["end"],
            "reason": r["reason"],
            "decision": r["decision"],
            "score": r["score"],
        }
        for r in reviews if r["decision"] == "approve"
    ]

    review_doc = {
        "clip": args.clip or whisperx_json.with_suffix(".mp4").name,
        "engine": engine,
        "summary": {
            "candidates": len(reviews),
            "approved": len(approved),
            "rejected": len(reviews) - len(approved),
            "total_skip_seconds": round(sum(x["end"] - x["start"] for x in approved), 3),
        },
        "reviews": reviews,
    }

    approved_doc = {
        "skip_ranges": approved,
        "meta": {
            "source": "stutter-verify-ai-v3.py",
            "engine": engine,
            "review_json": str(out_review),
        },
    }

    out_review.write_text(json.dumps(review_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out_approved.write_text(json.dumps(approved_doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # 输出摘要
    s = review_doc["summary"]
    print(f"[v3] candidates={s['candidates']} approved={s['approved']} "
          f"rejected={s['rejected']} skip={s['total_skip_seconds']}s engine={engine['mode']}")
    print(str(out_approved))


if __name__ == "__main__":
    main()
