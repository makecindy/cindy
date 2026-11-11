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

def compute(data):
    record(data, "head checks evidence")
    head = text(data["head"])
    checks = indexed(data["checks"])
    evidence = indexed(data["evidence"])
    blockers = []
    if not checks:
        blockers.append("NO_CHECKS")
    for key, row in sorted(checks.items()):
        record(row, "id head status")
        require(row["status"] in ("PASS", "FAIL", "NOT_RUN"), "invalid check status")
        if text(row["head"]) != head:
            blockers.append("STALE_CHECK:" + key)
        if row["status"] != "PASS":
            blockers.append(row["status"] + ":" + key)
    if not evidence:
        blockers.append("NO_EVIDENCE")
    for key, row in sorted(evidence.items()):
        record(row, "id head location")
        text(row["location"])
        if text(row["head"]) != head:
            blockers.append("STALE_EVIDENCE:" + key)
    return {"head": head, "status": "BLOCKED" if blockers else "REVIEWABLE",
            "blockers": blockers, "mergeAuthorized": False,
            "note": "Supplied evidence only; no CI or repository queried."}

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
