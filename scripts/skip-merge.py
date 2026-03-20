#!/usr/bin/env python3
"""skip-merge.py — merge multiple skip_ranges JSON files.

Input files format (compatible with llm-skip-apply.py):
  {"skip_ranges": [{"start":..,"end":..,"reason":"..."}, ...]}

We simply union all ranges, sort by start, and merge overlaps/nearby ranges.

Usage:
  python3 scripts/skip-merge.py out.json in1.json in2.json [in3.json ...] --gap 0.03
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_ranges(p: Path) -> list[dict[str, Any]]:
    j = json.loads(p.read_text(encoding="utf-8"))
    rs = j.get("skip_ranges") or []
    out: list[dict[str, Any]] = []
    for r in rs:
        try:
            s = float(r["start"])
            e = float(r["end"])
        except Exception:
            continue
        if e <= s:
            continue
        out.append({
            "start": s,
            "end": e,
            "reason": str(r.get("reason", "")).strip(),
        })
    return out


def merge_ranges(ranges: list[dict[str, Any]], gap: float) -> list[dict[str, Any]]:
    if not ranges:
        return []
    ranges.sort(key=lambda x: (x["start"], x["end"]))
    merged: list[dict[str, Any]] = [dict(ranges[0])]
    for r in ranges[1:]:
        cur = merged[-1]
        if r["start"] <= cur["end"] + gap:
            cur["end"] = max(cur["end"], r["end"])
            if r.get("reason"):
                cur_reason = cur.get("reason", "")
                cur["reason"] = (cur_reason + ("+" if cur_reason else "") + r["reason"]).strip("+")
        else:
            merged.append(dict(r))

    for r in merged:
        r["start"] = round(float(r["start"]), 3)
        r["end"] = round(float(r["end"]), 3)
    return merged


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out_json")
    ap.add_argument("in_json", nargs="+")
    ap.add_argument("--gap", type=float, default=0.03, help="merge if next.start <= cur.end + gap")
    args = ap.parse_args()

    out = Path(args.out_json).expanduser().resolve()
    ins = [Path(p).expanduser().resolve() for p in args.in_json]

    ranges: list[dict[str, Any]] = []
    for p in ins:
        ranges.extend(load_ranges(p))

    merged = merge_ranges(ranges, gap=args.gap)
    out.write_text(json.dumps({"skip_ranges": merged}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(out))


def _self_test() -> None:
    # lightweight sanity check
    rs = [
        {"start": 1.0, "end": 2.0, "reason": "a"},
        {"start": 1.9, "end": 2.2, "reason": "b"},
        {"start": 5.0, "end": 6.0, "reason": "c"},
    ]
    assert len(merge_ranges(rs, gap=0.0)) == 2


if __name__ == "__main__":
    main()
