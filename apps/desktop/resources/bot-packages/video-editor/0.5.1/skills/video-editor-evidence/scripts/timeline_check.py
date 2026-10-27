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
    record(data, "fps sources clips maxDuration")
    fps = number(data["fps"])
    require(0 < fps <= 240, "fps out of range")
    limit = number(data["maxDuration"])
    require(limit > 0, "positive maxDuration required")
    sources = indexed(data["sources"])
    for row in sources.values():
        record(row, "id duration rights")
        require(number(row["duration"]) > 0, "positive source duration required")
        require(row["rights"] in ("CLEARED", "UNKNOWN"), "invalid rights state")
    blockers, timeline, cursor = [], [], 0.0
    for row in items(data["clips"]):
        record(row, "source in out transcript")
        require(row["source"] in sources, "missing source reference")
        source = sources[row["source"]]
        start, end = number(row["in"]), number(row["out"])
        require(0 <= start < end <= source["duration"], "clip outside source duration")
        require(isinstance(row["transcript"], str), "transcript must be supplied text")
        if source["rights"] != "CLEARED": blockers.append("UNCLEARED_SOURCE:" + row["source"])
        duration = end - start
        frame_start, frame_end = round(cursor * fps), round((cursor + duration) * fps)
        require(frame_end > frame_start, "clip shorter than a timeline frame")
        timeline.append({"source": row["source"], "startFrame": frame_start, "endFrame": frame_end,
                         "durationSeconds": duration, "transcript": row["transcript"]})
        cursor += duration
    if not timeline: blockers.append("EMPTY_TIMELINE")
    if cursor > limit: blockers.append("DURATION_EXCEEDS_TARGET")
    return {"timeline": timeline, "durationSeconds": cursor, "blockers": sorted(set(blockers)),
            "render": "NOT_RUN", "syncAndCaptionAccuracy": "NOT_EVALUATED"}

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
