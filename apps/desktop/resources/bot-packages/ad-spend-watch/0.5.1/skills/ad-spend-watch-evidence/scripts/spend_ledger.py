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

METRICS = ("spend", "clicks", "conversions", "cpa", "cpc", "roas", "ctr")
RATIO_METRICS = ("cpa", "cpc", "roas", "ctr")
WINDOWS = ("today", "last3", "last7", "month")
SEVERITY_RANK = {"urgent": 0, "watch": 1, "note": 2}
FIELDS = ("spend", "clicks", "impressions", "conversions", "revenue")

def optional_number(value):
    if value is None:
        return None
    number(value)
    require(value >= 0, "non-negative number or null required")
    return value

def in_window(window, as_of, when):
    if when > as_of:
        return False
    if window == "today":
        return when == as_of
    if window == "last3":
        return as_of.toordinal() - when.toordinal() <= 2
    if window == "last7":
        return as_of.toordinal() - when.toordinal() <= 6
    return (when.year, when.month) == (as_of.year, as_of.month)

def totals(rows):
    out = {}
    for field in FIELDS:
        values = [row[field] for row in rows]
        out[field] = None if (not values or any(v is None for v in values)) else sum(values)
    return out

def metric_value(metric, total):
    if metric in ("spend", "clicks", "conversions"):
        return total[metric], None if total[metric] is not None else "UNKNOWN_INPUT"
    numerator, denominator = {"cpa": ("spend", "conversions"), "cpc": ("spend", "clicks"),
                              "roas": ("revenue", "spend"), "ctr": ("clicks", "impressions")}[metric]
    if total[numerator] is None or total[denominator] is None:
        return None, "UNKNOWN_INPUT"
    if total[denominator] == 0:
        return None, "ZERO_DENOMINATOR"
    return round(total[numerator] / total[denominator], 4), None

def compute(data):
    record(data, "asOf thresholds quietFloor rows")
    as_of = day(data["asOf"])
    floor = record(data["quietFloor"], "clicks conversions spend")
    for key in ("clicks", "conversions", "spend"):
        require(number(floor[key]) >= 0, "quietFloor must be non-negative")
    rules = indexed(data["thresholds"])
    for key, rule in rules.items():
        record(rule, "id scope metric direction limit window severity")
        require(rule["scope"] in ("account", "campaign"), "unknown scope: " + key)
        require(rule["metric"] in METRICS, "unknown metric: " + key)
        require(rule["direction"] in ("above", "below"), "unknown direction: " + key)
        require(rule["window"] in WINDOWS, "unknown window: " + key)
        require(rule["severity"] in SEVERITY_RANK, "unknown severity: " + key)
        require(number(rule["limit"]) >= 0, "limit must be non-negative: " + key)
    rows = []
    seen_keys = {}
    for key, row in indexed(data["rows"]).items():
        record(row, "id date campaign spend clicks impressions conversions revenue")
        entry = dict(row, when=day(row["date"]), campaign=text(row["campaign"]))
        for field in FIELDS:
            entry[field] = optional_number(row[field])
        rows.append(entry)
        seen_keys.setdefault((entry["date"], entry["campaign"]), []).append(key)
    warnings = [{"code": "DUPLICATE_DATE_CAMPAIGN", "ids": ids} for _, ids in sorted(seen_keys.items()) if len(ids) > 1]
    evaluations = []
    for key in sorted(rules):
        rule = rules[key]
        scoped = [r for r in rows if in_window(rule["window"], as_of, r["when"])]
        groups = {"ALL": scoped} if rule["scope"] == "account" else {}
        if rule["scope"] == "campaign":
            for r in scoped:
                groups.setdefault(r["campaign"], []).append(r)
        if not scoped:
            evaluations.append({"thresholdId": key, "group": "ALL", "status": "NO_DATA", "reason": "NO_ROWS_IN_WINDOW",
                                "severity": rule["severity"], "window": rule["window"]})
            continue
        for group in sorted(groups):
            total = totals(groups[group])
            value, reason = metric_value(rule["metric"], total)
            status = "OK"
            if value is None:
                status = "NOT_COMPUTABLE"
            elif rule["metric"] in RATIO_METRICS:
                below = [name for name in ("clicks", "conversions", "spend")
                         if total[name] is not None and total[name] < floor[name]]
                if below:
                    status, reason = "SUPPRESSED_LOW_SAMPLE", "BELOW_QUIET_FLOOR:" + ",".join(below)
            if status == "OK":
                over = value > rule["limit"] if rule["direction"] == "above" else value < rule["limit"]
                status = "BREACH" if over else "OK"
            evaluations.append({"thresholdId": key, "group": group, "metric": rule["metric"], "window": rule["window"],
                                "direction": rule["direction"], "limit": rule["limit"], "value": value, "status": status,
                                "reason": reason, "severity": rule["severity"]})
    evaluations.sort(key=lambda e: (SEVERITY_RANK[e["severity"]], e["thresholdId"], e["group"]))
    breaches = [e for e in evaluations if e["status"] == "BREACH"]
    dates = [r["when"] for r in rows]
    latest = max(dates) if dates else None
    month_rows = {}
    for r in rows:
        if in_window("month", as_of, r["when"]):
            month_rows.setdefault(r["campaign"], []).append(r)
    zero_conversion = sorted(c for c, rs in month_rows.items() if totals(rs)["spend"] and totals(rs)["conversions"] == 0)
    return {"asOf": data["asOf"], "latestRowDate": latest.isoformat() if latest else None,
            "daysBehindAsOf": (as_of.toordinal() - latest.toordinal()) if latest else None,
            "evaluations": evaluations, "breaches": breaches, "warnings": warnings,
            "zeroConversionSpendCampaigns": zero_conversion,
            "estimatedValues": False, "platformChangesMade": False, "mode": "REPORT_ONLY"}

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
