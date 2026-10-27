#!/usr/bin/env python3
"""Original offline helper; Python 3.10+ standard library, stdin/stdout only."""
import sys
import json
import math
import hashlib
from datetime import date
from urllib.parse import urlsplit, urlunsplit

def require(ok, message):
    if not ok:
        raise ValueError(message)

def record(value, fields):
    require(isinstance(value, dict) and set(value) == set(fields.split()), "unexpected or missing fields")
    return value

def text(value):
    require(isinstance(value, str) and bool(value.strip()), "nonempty text required")
    return value.strip()

def items(value):
    require(isinstance(value, list) and len(value) <= 10000, "bounded array required")
    return value

def indexed(value):
    result = {}
    for row in items(value):
        require(isinstance(row, dict), "record required")
        key = text(row.get("id"))
        require(key not in result, "duplicate id: " + key)
        result[key] = row
    return result

def day(value):
    return date.fromisoformat(text(value))

def number(value):
    require(type(value) in (float, int) and math.isfinite(value), "finite number required")
    return value

def unique_object(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, "duplicate JSON key")
        out[key] = value
    return out

import re
import unicodedata

METRICS = ("volume", "difficulty", "position", "clicks")
# Rule-based labels only; checked in this order. They organise a list and do not measure user intent.
INTENT_MARKERS = (
    ("TRANSACTIONAL", ("buy", "price", "cheap", "coupon", "discount", "购买", "价格", "多少钱", "优惠", "折扣", "哪里买", "怎么买")),
    ("COMMERCIAL", ("best", " vs ", "versus", "review", "compare", "top ", "推荐", "对比", "评测", "排行", "哪个好", "哪种好")),
    ("INFORMATIONAL", ("how", "what", "why", "when", "guide", "怎么", "如何", "为什么", "是什么", "什么是", "什么")),
)

def normalize(value):
    folded = unicodedata.normalize("NFKC", text(value)).casefold()
    folded = re.sub(r"[^\w\s]", " ", folded)
    return " ".join(folded.split())

def intent_of(key):
    padded = " " + key + " "
    for label, markers in INTENT_MARKERS:
        if any(marker in padded for marker in markers):
            return label
    return "UNCLASSIFIED"

def metrics_of(value):
    # Every metric is declared; null means unknown. Nothing is ever estimated or filled in.
    if value is None:
        return {name: None for name in METRICS}
    record(value, " ".join(METRICS))
    out = {}
    for name in METRICS:
        raw = value[name]
        if raw is not None:
            require(number(raw) >= 0, name + " must not be negative")
            require(name != "position" or raw >= 1, "position starts at 1")
        out[name] = raw
    return out

def compute(data):
    record(data, "items existingTitles")
    require(len(items(data["existingTitles"])) <= 1000, "too many existing titles")
    titles = sorted({normalize(t) for t in data["existingTitles"]})
    merged = {}
    for row in items(data["items"]):
        record(row, "id text source metrics")
        key = normalize(row["text"])
        require(len(key) <= 300, "text too long")
        text(row["source"])
        entry = merged.setdefault(key, {"ids": [], "texts": [], "metrics": [], "sources": []})
        entry["ids"].append(text(row["id"]))
        entry["texts"].append(text(row["text"]))
        entry["metrics"].append(metrics_of(row["metrics"]))
        entry["sources"].append(row["source"].strip())
    require(len({i for e in merged.values() for i in e["ids"]}) == sum(len(e["ids"]) for e in merged.values()), "duplicate id")
    groups = {}
    for key, entry in merged.items():
        # Duplicate rows keep the first supplied value per metric; conflicting values are reported, never averaged.
        combined, conflicts = {}, []
        for name in METRICS:
            seen = [m[name] for m in entry["metrics"] if m[name] is not None]
            combined[name] = seen[0] if seen else None
            if len(set(seen)) > 1:
                conflicts.append(name)
        overlap = [t for t in titles if key and (key == t or key in t)]
        groups.setdefault(intent_of(key), []).append({
            "key": key, "ids": sorted(entry["ids"]), "texts": entry["texts"][0:1], "sources": sorted(set(entry["sources"])),
            "mergedDuplicates": len(entry["ids"]) - 1, "metrics": combined, "metricConflicts": conflicts,
            "unknownMetrics": [n for n in METRICS if combined[n] is None],
            "possiblyOverlapsExistingTitles": overlap})
    ordered = {}
    for label in ("INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "UNCLASSIFIED"):
        rows = groups.get(label, [])
        basis = "SUPPLIED_VOLUME_DESC_THEN_TEXT" if any(r["metrics"]["volume"] is not None for r in rows) else "TEXT_ASC"
        rows.sort(key=lambda r: (r["metrics"]["volume"] is None, -(r["metrics"]["volume"] or 0), r["key"]))
        ordered[label] = {"orderBasis": basis, "topics": rows}
    return {"groups": ordered, "uniqueTopics": len(merged), "inputRows": sum(len(e["ids"]) for e in merged.values()),
            "intentLabels": "RULE_BASED_NOT_USER_BEHAVIOR", "overlapMatch": "SUBSTRING_ONLY_NOT_COVERAGE_PROOF",
            "estimatedMetrics": False, "ranking": "NOT_COMPUTED",
            "note": "Metrics are echoed exactly as supplied; null stays unknown. No volume, difficulty, position, click or citation is estimated."}

if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(1048577)
        require(len(raw) <= 1048576, "input exceeds 1 MiB")
        data = json.loads(raw, object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))
        print(json.dumps(compute(data), ensure_ascii=False, sort_keys=True, allow_nan=False))
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        print("INVALID_INPUT: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
