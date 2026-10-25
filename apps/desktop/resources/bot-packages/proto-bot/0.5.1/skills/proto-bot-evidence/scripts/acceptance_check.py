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
    record(data, "head criteria checks")
    head = text(data["head"])
    criteria = indexed(data["criteria"])
    checks = indexed(data["checks"])
    for row in checks.values():
        record(row, "id criterion head mode status evidence")
        require(row["criterion"] in criteria, "unknown acceptance criterion")
        require(row["mode"] in ("LIGHT", "DARK", "ANY"), "invalid mode")
        require(row["status"] in ("PASS", "FAIL", "NOT_RUN"), "invalid check status")
        text(row["head"]); text(row["evidence"])
    missing, failed = [], []
    for key, criterion in sorted(criteria.items()):
        record(criterion, "id description modes")
        text(criterion["description"])
        modes = items(criterion["modes"])
        require(modes and len(modes) == len(set(modes)) and all(m in ("LIGHT", "DARK", "ANY") for m in modes), "invalid required modes")
        for mode in modes:
            current = [r for r in checks.values() if r["criterion"] == key and r["mode"] == mode and r["head"] == head]
            if any(r["status"] == "FAIL" for r in current): failed.append(key + ":" + mode)
            elif not any(r["status"] == "PASS" for r in current): missing.append(key + ":" + mode)
    return {"head": head, "missingOrNotRun": missing, "failed": failed,
            "status": "REVIEWABLE" if criteria and not missing and not failed else "INCOMPLETE",
            "published": False, "note": "Evidence references are not executed or visually verified."}

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
