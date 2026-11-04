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

MATCH_TYPES = ("exact", "broad", "search-match", "unknown")

def optional_number(value):
    if value is None:
        return None
    number(value)
    require(value >= 0, "non-negative number or null required")
    return value

def normalize(value):
    return " ".join(text(value).lower().split())

def merge_field(rows, field):
    values = [row[field] for row in rows]
    return None if any(v is None for v in values) else sum(values)

def ratio(spend, installs):
    return None if spend is None or not installs else round(spend / installs, 4)

def compute(data):
    record(data, "asOf targets minSpend terms")
    day(data["asOf"])
    targets = record(data["targets"], "default groups")
    require(number(targets["default"]) > 0, "default target must be positive")
    require(isinstance(targets["groups"], dict), "group targets must be an object")
    for group, limit in targets["groups"].items():
        require(number(limit) > 0, "group target must be positive: " + group)
    min_spend = number(data["minSpend"])
    require(min_spend >= 0, "minSpend must be non-negative")
    merged = {}
    for key, row in indexed(data["terms"]).items():
        record(row, "id group term matchType spend taps installs")
        require(row["matchType"] in MATCH_TYPES, "unknown matchType: " + key)
        entry = {"id": key, "group": text(row["group"]), "term": normalize(row["term"]), "matchType": row["matchType"]}
        for field in ("spend", "taps", "installs"):
            entry[field] = optional_number(row[field])
        merged.setdefault((entry["group"], entry["term"], entry["matchType"]), []).append(entry)
    terms = []
    for (group, term, match), rows in sorted(merged.items()):
        terms.append({"group": group, "term": term, "matchType": match, "ids": [r["id"] for r in rows],
                      "mergedDuplicates": len(rows) - 1, "spend": merge_field(rows, "spend"),
                      "taps": merge_field(rows, "taps"), "installs": merge_field(rows, "installs")})
    unreadable = sorted(i for t in terms if t["spend"] is None or t["installs"] is None for i in t["ids"])
    groups = {}
    for t in terms:
        groups.setdefault(t["group"], []).append(t)
    group_rows = []
    for group in sorted(groups):
        rows = groups[group]
        partial = any(r["spend"] is None or r["installs"] is None for r in rows)
        spend = sum(r["spend"] for r in rows if r["spend"] is not None)
        installs = sum(r["installs"] for r in rows if r["installs"] is not None)
        target = targets["groups"].get(group, targets["default"])
        cpi = None if partial else ratio(spend, installs)
        if partial:
            status = "PARTIAL_DATA"
        elif spend == 0:
            status = "NO_SPEND"
        elif installs == 0:
            status = "NO_INSTALLS"
        else:
            status = "OVER_TARGET" if cpi > target else "WITHIN_TARGET"
        group_rows.append({"group": group, "target": target, "spendKnown": round(spend, 4), "installsKnown": installs,
                           "costPerInstall": cpi, "status": status, "terms": len(rows)})
    negatives = [t for t in terms if t["spend"] is not None and t["installs"] == 0 and t["spend"] >= min_spend]
    negatives.sort(key=lambda t: (-t["spend"], t["group"], t["term"]))
    harvest = []
    for t in terms:
        if t["matchType"] in ("broad", "search-match") and t["installs"] and t["spend"] is not None:
            cpi = ratio(t["spend"], t["installs"])
            if cpi <= targets["groups"].get(t["group"], targets["default"]):
                harvest.append({"group": t["group"], "term": t["term"], "installs": t["installs"], "costPerInstall": cpi})
    harvest.sort(key=lambda h: (-h["installs"], h["costPerInstall"], h["group"], h["term"]))
    return {"groups": group_rows,
            "negativeCandidates": [{"group": t["group"], "term": t["term"], "spend": t["spend"], "ids": t["ids"]} for t in negatives],
            "exactKeywordCandidates": harvest, "unreadableRows": unreadable,
            "mergedDuplicateRows": sum(t["mergedDuplicates"] for t in terms),
            "estimatedValues": False, "accountChangesMade": False, "mode": "SUGGESTIONS_ONLY"}

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
