#!/usr/bin/env python3
"""Export the execution ledger as UTC daily counters. No network or account identifiers.

Use: python3 scripts/export-token-usage.py --database /path/to/profile.db
The output is a complete snapshot for this database, not additive events to replay.
"""
import argparse
import collections
import hashlib
import hmac
import json
import re
import sqlite3
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1] / "packages/model-providers/catalog/model-registry.json"
COUNTS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_create_tokens")
PUBLIC_PROVIDERS = {"xd": "Cindy Gateway", "openai": "OpenAI", "anthropic": "Anthropic", "xai": "xAI"}
BILLING = {"cindy-ai": "Gateway", "subscription": "订阅", "provider": "供应商接入", "unknown": "未记录"}
HARNESS = {
    "claude-code": "Claude Code",
    "codex": "Codex",
    "pi": "Pi",
    "auxiliary": "辅助调用",
    "unknown": "未记录",
}


def public_models():
    registry = json.loads(CATALOG.read_text())
    names = collections.defaultdict(set)
    for model in registry["models"]:
        ids = {model["id"], model["id"].split("/", 1)[-1]}
        ids.update(route.get("modelId") for route in model.get("routes", []))
        for alias in ids - {None}:
            names[alias].add(model["name"])
    result = {key: next(iter(labels)) if len(labels) == 1 else key for key, labels in names.items()}
    for model in registry.get("baseModels", []):
        label = model["defaults"].get("name") or model["id"]
        for key in [model["id"], *model.get("aliases", [])]:
            result[key] = label
    providers = json.loads(CATALOG.with_name("provider-models.json").read_text())["providers"]
    for provider, models in providers.items():
        for model in models:
            key = model["id"]
            # An exact public wire ID is safe even when catalogs disagree about display names.
            result.setdefault(key, key)
            result.setdefault(f"{provider}/{key}", result[key])
    providers_catalog = json.loads(CATALOG.with_name("providers.json").read_text())
    for provider in providers_catalog.get("providers", []):
        for rows in (provider.get("models") or {}).values():
            for model in rows:
                result.setdefault(model["id"], model.get("name") or model["id"])
            for model in rows:
                bare = re.sub(r"\[\d+[km]\]$", "", model["id"], flags=re.I)
                if bare != model["id"]:
                    label = re.sub(r"\s*\(\d+[km]\)$", "", model.get("name") or bare, flags=re.I)
                    result.setdefault(bare, label)
    for preset in providers_catalog.get("presets", []):
        preset_models = list(preset.get("models") or [])
        for rt in (preset.get("runtimes") or {}).values():
            if isinstance(rt, dict):
                preset_models.extend(rt.get("models") or [])
        for model in preset_models:
            result.setdefault(model["id"], model.get("name") or model["id"])
        for model in preset_models:
            bare = re.sub(r"\[\d+[km]\]$", "", model["id"], flags=re.I)
            if bare != model["id"]:
                label = re.sub(r"\s*\(\d+[km]\)$", "", model.get("name") or bare, flags=re.I)
                result.setdefault(bare, label)
    for model in registry.get("localModels", {}).get("models", []):
        for variant in model.get("variants", []):
            if variant.get("libraryName"):
                result.setdefault(variant["libraryName"], model["name"])
    return result


def public_model(raw, names):
    if raw in names:
        return names[raw]
    bare = re.sub(r"\[\d+[km]\]$", "", raw, flags=re.I)
    if bare in names:
        return names[bare]
    # These routing namespaces are public. Never reveal user-defined prefixes.
    prefix, slash, model = bare.partition("/")
    if slash and prefix in {"chatgpt", "codex", "x-ai", "x-ai-grok", "anthropic-claude"} and model in names:
        return names[model]
    return "未记录" if raw in {"", "unknown"} else "其他模型"


def private_label(label, kind, value, key):
    if key is None:
        return label
    digest = hmac.new(key, (kind + "\0" + value).encode(), hashlib.sha256).hexdigest()
    return f"{label} · {digest[:24]}"


def export(database, key=None):
    if key is not None and len(key) < 32:
        raise ValueError("Use a random key of at least 32 bytes for this reporting scope")
    names = public_models()
    presets = json.loads(CATALOG.with_name("providers.json").read_text())["presets"]
    providers = {**PUBLIC_PROVIDERS, **{"preset:" + p["id"]: p["name"] for p in presets}}
    groups = collections.defaultdict(lambda: [0, 0, 0, 0])
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.execute("BEGIN")
        # A missing table means this version never recorded execution-day sources.
        # Do not fill it by guessing from the model name or the current account.
        # Auxiliary request IDs are already unique. Their counters are independent
        # of conversation turns and their original billing method may be absent.
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        has_column = lambda table, col: any(
            row[1] == col for row in db.execute(f"PRAGMA table_info({table})")
        )
        queries = []
        if "daily_token_attribution" in tables:
            harness_expr = "harness" if has_column("daily_token_attribution", "harness") else "'unknown'"
            queries.append(f"""
            SELECT day, provider, billing_source, model, {harness_expr},
                   input_tokens, output_tokens, cache_read_tokens, cache_create_tokens
            FROM daily_token_attribution
            """)
        if "auxiliary_usage_receipts" in tables:
            harness_expr = "harness" if has_column("auxiliary_usage_receipts", "harness") else "'unknown'"
            queries.append(f"""
            SELECT date(recorded_at / 1000, 'unixepoch'), provider_id,
                   CASE WHEN provider_id = 'xd' THEN 'cindy-ai' ELSE 'unknown' END, model, {harness_expr},
                   coalesce(input_tokens, 0), coalesce(output_tokens, 0),
                   coalesce(cache_read_tokens, 0), coalesce(cache_create_tokens, 0)
            FROM auxiliary_usage_receipts
            """)
        for day, provider, billing, model, harness, *counts in (db.execute(" UNION ALL ".join(queries)) if queries else []):
            source = providers.get(provider, "未记录" if provider in ("", "unknown") else "自定义接入")
            label = public_model(model, names)
            if source == "自定义接入":
                source = private_label(source, "source", provider, key)
            if label == "其他模型":
                label = private_label(label, "model", model, key)
            bucket = groups[(day, source, BILLING.get(billing, "未记录"), label, HARNESS.get(harness, "未记录"))]
            for i, value in enumerate(counts):
                if type(value) is not int or value < 0:
                    raise ValueError("Invalid token count in the execution ledger")
                bucket[i] += value
    for (day, source, billing, model, harness), values in sorted(groups.items()):
        yield dict(day=day, source=source, billing=billing, model=model, harness=harness,
                   **dict(zip(COUNTS, values)), total_tokens=sum(values))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--private-label-key-file", type=Path,
                        help="Opt in to pseudonymous custom-source/model labels using a local scope-specific key")
    args = parser.parse_args()
    key = args.private_label_key_file.read_bytes() if args.private_label_key_file else None
    for row in export(args.database, key):
        print(json.dumps(row, ensure_ascii=False))
