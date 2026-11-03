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

def canonical_url(value):
    parsed = urlsplit(text(value))
    require(parsed.scheme in ("https", "http") and parsed.hostname and not parsed.username and not parsed.password, "public HTTP(S) URL required")
    # Keep queries: they may identify different stories. Only normalize safe presentation noise.
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path or "/", parsed.query, ""))

def compute(data):
    record(data, "stories seenUrls")
    seen = {canonical_url(v) for v in items(data["seenUrls"])}
    fresh, prior, duplicates = [], [], []
    local = set()
    for row in items(data["stories"]):
        record(row, "url title publishedOn evidence")
        text(row["title"]); text(row["evidence"])
        if row["publishedOn"] is not None: day(row["publishedOn"])
        url = canonical_url(row["url"])
        if url in local: duplicates.append(url); continue
        local.add(url)
        (prior if url in seen else fresh).append(dict(row, url=url))
    return {"newStories": fresh, "previouslySeen": prior, "duplicateUrls": duplicates,
            "proposedSeenUrls": sorted(seen | local), "acknowledgedSeenUrls": sorted(seen),
            "delivery": "NOT_PERFORMED", "note": "Only commit proposed watermark after actual successful delivery; importance not inferred."}

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
