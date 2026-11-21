#!/usr/bin/env python3
"""
Cindy AI <-> Google Antigravity CLI (agy) Native Inherited-Auth Bridge
Reads the live OAuth credential from Windows Credential Manager ("gemini:antigravity"),
auto-refreshes via `agy.exe` when needed, fetches live quotas via
`agy -p /quota --output-format json` (the agy CLI quota command),
and translates OpenAI Chat Completions (/v1/chat/completions, /v1/models, /v1/quota)
to Google Cloud Code Assist v1internal.
"""

import ctypes
from ctypes import wintypes
import datetime
import http.server
import json
import os
import re
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

HOST = "127.0.0.1"
PORT = int(os.environ.get("AGY_BRIDGE_PORT", "11436"))
BRIDGE_SECRET = os.environ.get("AGY_BRIDGE_SECRET")
UPSTREAM_BASE = "https://daily-cloudcode-pa.googleapis.com"
AGY_BIN = os.path.expandvars(r"%LOCALAPPDATA%\agy\bin\agy.exe")
KEYRING_TARGET = "gemini:antigravity"
USER_AGENT = "antigravity/1.0.0 windows/amd64"
PAID_TIER_HEADER = "CAE="

def _get_cache_dir():
    override = os.environ.get("AGY_BRIDGE_CACHE_DIR")
    if override:
        path = override
    elif os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        path = os.path.join(base, "CindyGlobal", "antigravity-bridge")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
        path = os.path.join(base, "cindy", "antigravity-bridge")
    try:
        os.makedirs(path, exist_ok=True)
    except Exception:
        pass
    return path

CACHE_DIR = _get_cache_dir()
QUOTA_CACHE_FILE = os.path.join(CACHE_DIR, "quota_cache.json")
ALLOWED_ORIGIN_REGEX = re.compile(
    r"^(https?://(?:localhost|127\.0\.0\.1)(?::\d+)?|tauri://localhost|vscode-webview://.*)$",
    re.IGNORECASE,
)


# Baseline model catalog (fallback if agy CLI is currently running a busy turn)
MODEL_CATALOG = [
    {
        "id": "gemini-4-argon",
        "name": "Gemini 4 Argon",
        "backend": "gemini-3.8-flash-tiered",
        "thinking_budget": 24576,
        "context_window": 1000000,
        "max_output": 65536,
        "efforts": ["low", "medium", "high"],
        "default_effort": "high",
        "default_enabled": True,
        "supports_image": True,
        "supports_fast": False,
        "description": "Flagship Google Antigravity model for complex coding, research, and agentic reasoning.",
    },
    {
        "id": "gemini-3.8-flash",
        "name": "Gemini 3.8 Flash",
        "backend": "gemini-3.8-flash-tiered",
        "thinking_budget": 16000,
        "context_window": 1000000,
        "max_output": 65536,
        "efforts": ["low", "medium", "high"],
        "default_effort": "high",
        "default_enabled": True,
        "supports_image": True,
        "supports_fast": False,
        "description": "High-speed multimodal reasoning model in Google Antigravity.",
    },
    {
        "id": "claude-opus-5-5",
        "name": "Claude Opus 5.5",
        "backend": "claude-opus-5-5-high",
        "thinking_budget": 24576,
        "context_window": 200000,
        "max_output": 64000,
        "efforts": ["low", "medium", "high", "max"],
        "default_effort": "high",
        "default_enabled": True,
        "supports_image": True,
        "supports_fast": False,
        "description": "Anthropic Claude Opus 5.5 hosted via Google Antigravity subscription.",
    },
    {
        "id": "claude-sonnet-5-5",
        "name": "Claude Sonnet 5.5",
        "backend": "claude-sonnet-5-5-medium",
        "thinking_budget": 16000,
        "context_window": 200000,
        "max_output": 64000,
        "efforts": ["low", "medium", "high"],
        "default_effort": "medium",
        "default_enabled": True,
        "supports_image": True,
        "supports_fast": False,
        "description": "Anthropic Claude Sonnet 5.5 hosted via Google Antigravity subscription.",
    },
    {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "backend": "gemini-2.5-pro",
        "thinking_budget": 16000,
        "context_window": 1000000,
        "max_output": 65536,
        "efforts": ["low", "medium", "high"],
        "default_effort": "high",
        "default_enabled": False,
        "supports_image": True,
        "supports_fast": False,
        "description": "Deep reasoning and long-context coding model.",
    },
    {
        "id": "gemini-3-flash",
        "name": "Gemini 3 Flash",
        "backend": "gemini-3-flash",
        "thinking_budget": 8192,
        "context_window": 1000000,
        "max_output": 65536,
        "efforts": ["low", "medium", "high"],
        "default_effort": "medium",
        "default_enabled": False,
        "supports_image": True,
        "supports_fast": False,
        "description": "Balanced speed and intelligence for everyday coding tasks.",
    },
    {
        "id": "gemini-3.5-flash-lite",
        "name": "Gemini 3.5 Flash Lite",
        "backend": "gemini-3.5-flash-lite",
        "thinking_budget": 0,
        "context_window": 1000000,
        "max_output": 65536,
        "efforts": ["low", "medium"],
        "default_effort": "low",
        "default_enabled": False,
        "supports_image": True,
        "supports_fast": False,
        "description": "Ultra-fast lightweight model for quick edits and completions.",
    },
    {
        "id": "gemini-2.5-flash",
        "name": "Gemini 2.5 Flash",
        "backend": "gemini-2.5-flash",
        "thinking_budget": 8192,
        "context_window": 1000000,
        "max_output": 65536,
        "efforts": ["low", "medium", "high"],
        "default_effort": "medium",
        "default_enabled": False,
        "supports_image": True,
        "supports_fast": False,
        "description": "Fast multimodal Gemini 2.5 model.",
    },
    {
        "id": "gpt-oss-120b",
        "name": "GPT-OSS 120B",
        "backend": "gpt-oss-120b-medium",
        "thinking_budget": 8192,
        "context_window": 128000,
        "max_output": 32768,
        "efforts": ["low", "medium", "high"],
        "default_effort": "medium",
        "default_enabled": False,
        "supports_image": False,
        "supports_fast": False,
        "description": "Open-weights 120B model hosted on Google Antigravity.",
    },
]

MODEL_MAP = {m["id"]: m for m in MODEL_CATALOG}
# Backwards-compatible aliases
MODEL_ALIASES = {
    "gemini-4-argon-high": ("gemini-4-argon", "high"),
    "gemini-4-argon-medium": ("gemini-4-argon", "medium"),
    "gemini-4-argon-low": ("gemini-4-argon", "low"),
    "gemini-3.8-flash-high": ("gemini-3.8-flash", "high"),
    "gemini-3.8-flash-medium": ("gemini-3.8-flash", "medium"),
    "gemini-3.8-flash-low": ("gemini-3.8-flash", "low"),
    "claude-opus-5-5-high": ("claude-opus-5-5", "high"),
    "claude-sonnet-5-5-medium": ("claude-sonnet-5-5", "medium"),
    "gpt-oss-120b-medium": ("gpt-oss-120b", "medium"),
}

EFFORT_TO_BUDGET = {
    "minimal": 0,
    "low": 8192,
    "medium": 16000,
    "high": 24576,
    "xhigh": 32768,
    "max": 32768,
    "ultra": 32768,
}

AGY_MODELS_CACHE = {"ts": 0.0, "data": []}
AGY_CACHE_LOCK = threading.Lock()

def fetch_dynamic_agy_models():
    """Dynamically queries `agy models` to discover active models and reasoning efforts."""
    try:
        res = subprocess.run(
            "agy models",
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            timeout=15
        )
        if res.returncode == 0 and res.stdout:
            families = {}
            for line in res.stdout.splitlines():
                line = line.strip()
                if not line or "Fetching" in line:
                    continue
                parts = line.split("\t")
                if len(parts) >= 2:
                    vid, name_full = parts[0].strip(), parts[1].strip()
                    m = re.match(r"^(.*?)-(low|medium|high|xhigh|max|minimal)$", vid)
                    if m:
                        base_id, effort = m.group(1), m.group(2)
                    else:
                        base_id, effort = vid, None
                    clean_name = re.sub(r"\s*\((Low|Medium|High|Max|Minimal)\)\s*$", "", name_full)
                    static_meta = MODEL_MAP.get(base_id)
                    if base_id not in families:
                        families[base_id] = {
                            "id": base_id,
                            "name": static_meta["name"] if static_meta else clean_name,
                            "backend": static_meta["backend"] if static_meta else vid,
                            "efforts": list(static_meta.get("efforts", [])) if static_meta else [],
                            "default_effort": static_meta.get("default_effort") if static_meta else None,
                            "default_enabled": static_meta.get("default_enabled", True) if static_meta else True,
                            "supports_image": static_meta["supports_image"] if static_meta else ("gemini" in base_id or "claude" in base_id),
                            "supports_fast": False,
                            "description": static_meta["description"] if static_meta else f"Live dynamic Google Antigravity model ({clean_name}).",
                        }
                        if static_meta and "context_window" in static_meta:
                            families[base_id]["context_window"] = static_meta["context_window"]
                        if static_meta and "max_output" in static_meta:
                            families[base_id]["max_output"] = static_meta["max_output"]
                    if effort and effort not in families[base_id]["efforts"]:
                        families[base_id]["efforts"].append(effort)

            if families:
                return list(families.values())
    except Exception as e:
        print(f"[WARN] Error in fetch_dynamic_agy_models: {e}", file=sys.stderr)
    return []

def get_dynamic_agy_models(force=False):
    now = time.time()
    with AGY_CACHE_LOCK:
        if not force and AGY_MODELS_CACHE["data"] and (now - AGY_MODELS_CACHE["ts"] < 1800): # 30 min cache
            return AGY_MODELS_CACHE["data"]

    new_models = fetch_dynamic_agy_models()
    if new_models:
        with AGY_CACHE_LOCK:
            AGY_MODELS_CACHE["data"] = new_models
            AGY_MODELS_CACHE["ts"] = now
        return new_models

    return AGY_MODELS_CACHE.get("data") or MODEL_CATALOG


THOUGHT_SIG_CACHE = {}
CACHE_LOCK = threading.Lock()
PROJECT_ID_CACHE = {"project": "aicode-consumers"}
QUOTA_MEM_CACHE = {"ts": 0.0, "data": None}
QUOTA_LOCK = threading.Lock()

# Win32 CredReadW setup
advapi32 = ctypes.WinDLL("Advapi32.dll")


class CREDENTIAL(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


PCREDENTIAL = ctypes.POINTER(CREDENTIAL)
advapi32.CredReadW.argtypes = [
    wintypes.LPCWSTR,
    wintypes.DWORD,
    wintypes.DWORD,
    ctypes.POINTER(PCREDENTIAL),
]
advapi32.CredReadW.restype = wintypes.BOOL
advapi32.CredFree.argtypes = [ctypes.c_void_p]


def read_keyring_token():
    pcred = PCREDENTIAL()
    if not advapi32.CredReadW(KEYRING_TARGET, 1, 0, ctypes.byref(pcred)):
        return None
    try:
        cred = pcred.contents
        raw = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
        data = json.loads(raw.decode("utf-8"))
        return data.get("token", {})
    except Exception:
        return None
    finally:
        advapi32.CredFree(pcred)


def refresh_via_agy_cli():
    if not os.path.exists(AGY_BIN):
        return False
    try:
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        subprocess.run(
            [AGY_BIN, "models"],
            capture_output=True,
            timeout=15,
            startupinfo=startupinfo,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        return True
    except Exception:
        return False


def get_valid_access_token(force_refresh=False):
    if force_refresh:
        refresh_via_agy_cli()
    tok = read_keyring_token()
    if not tok or not tok.get("access_token"):
        refresh_via_agy_cli()
        tok = read_keyring_token()
    if not tok:
        raise RuntimeError("No 'gemini:antigravity' credential found in Windows Credential Manager.")

    expiry_str = tok.get("expiry")
    if expiry_str and not force_refresh:
        try:
            exp = datetime.datetime.fromisoformat(expiry_str)
            now = datetime.datetime.now(exp.tzinfo)
            if (exp - now).total_seconds() < 180:
                refresh_via_agy_cli()
                tok = read_keyring_token() or tok
        except Exception:
            pass
    return tok["access_token"]


def parse_iso_to_epoch(iso_str):
    if not iso_str or not isinstance(iso_str, str):
        return None
    try:
        s = iso_str.replace("Z", "+00:00")
        return int(datetime.datetime.fromisoformat(s).timestamp())
    except Exception:
        return None


def format_bucket_title(group_name, bucket_name, bucket_id):
    if bucket_id == "gemini-5h":
        return "Gemini · 5 hours"
    if bucket_id == "gemini-weekly":
        return "Gemini · Weekly"
    if "argon" in (bucket_id or ""):
        return "Gemini 4 Argon · Weekly"
    if bucket_id == "3p-5h":
        return "Claude & GPT · 5 hours"
    if bucket_id == "3p-weekly":
        return "Claude & GPT · Weekly"
    if group_name and bucket_name:
        return f"{group_name} · {bucket_name}"
    return bucket_name or group_name or bucket_id


WINDOW_SORT_ORDER = {
    "gemini-5h": 0,
    "gemini-weekly": 1,
    "gemini-argon-wtu-weekly": 2,
    "argon-weekly": 2,
    "3p-5h": 3,
    "3p-weekly": 4,
}


def refresh_quota_Via_agy_cli():
    """
    Runs `agy.exe -p /quota --output-format json` (same as D:\\work\\ai-quota-widget)
    to retrieve all 3 quota groups (Gemini Models, Claude and GPT models, Gemini 4 Argon)
    with 5h and weekly reset windows.
    """
    now_s = time.time()
    windows = []
    notices = []
    email = os.environ.get("AGY_ACCOUNT_EMAIL", "")
    plan_label = "Google AI Pro"

    if os.path.exists(AGY_BIN):
        try:
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            res = subprocess.run(
                [AGY_BIN, "-p", "/quota", "--output-format", "json"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                startupinfo=startupinfo,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if res.returncode == 0 and res.stdout.strip():
                payload = json.loads(res.stdout.strip())
                groups = (((payload.get("command") or {}).get("data") or {}).get("groups")) or []
                for group in groups:
                    gname = group.get("name") or ""
                    for bucket in group.get("buckets") or []:
                        bid = bucket.get("id") or ""
                        bname = bucket.get("name") or ""
                        rem = bucket.get("remaining_fraction")
                        if rem is None:
                            rem = 0.0
                        rem_f = max(0.0, min(1.0, float(rem)))
                        utilization = round((1.0 - rem_f) * 100)
                        resets_at = parse_iso_to_epoch(bucket.get("reset_time"))
                        title = format_bucket_title(gname, bname, bid)
                        windows.append({
                            "key": bid or f"{gname}-{bname}",
                            "title": title,
                            "showRemaining": True,
                            "window": {
                                "utilization": utilization,
                                "resetsAt": resets_at,
                            },
                        })
                        if utilization >= 100:
                            notices.append({
                                "tone": "crit",
                                "text": f"Limit reached: {title} (0% remaining)",
                            })
        except Exception:
            pass

    if not windows:
        try:
            tok = get_valid_access_token(force_refresh=False)
            req = urllib.request.Request(
                f"{UPSTREAM_BASE}/v1internal:retrieveUserQuotaSummary",
                data=b"{}",
                headers={
                    "Authorization": f"Bearer {tok}",
                    "Content-Type": "application/json",
                    "User-Agent": USER_AGENT,
                    "X-Goog-Ext-525006001-bin": PAID_TIER_HEADER,
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                raw_quotas = json.loads(resp.read().decode("utf-8"))
            for idx, q in enumerate(raw_quotas.get("quotas") or []):
                bid = q.get("identifier") or f"quota-{idx}"
                rem = q.get("remainingFraction")
                if rem is None:
                    rem = 0.0
                rem_f = max(0.0, min(1.0, float(rem)))
                utilization = round((1.0 - rem_f) * 100)
                resets_at = parse_iso_to_epoch(q.get("resetTime"))
                title = format_bucket_title(q.get("groupName"), q.get("limitName"), bid)
                windows.append({
                    "key": bid,
                    "title": title,
                    "showRemaining": True,
                    "window": {
                        "utilization": utilization,
                        "resetsAt": resets_at,
                    },
                })
                if utilization >= 100:
                    notices.append({
                        "tone": "crit",
                        "text": f"Limit reached: {title} (0% remaining)",
                    })
        except Exception:
            pass

    if windows:
        windows.sort(key=lambda w: WINDOW_SORT_ORDER.get(w["key"], 99))
        result = {
            "title": "Google Antigravity",
            "identity": email,
            "planLabel": plan_label,
            "updatedAt": int(now_s * 1000),
            "windows": windows,
            "notices": notices,
            "details": ["Local Antigravity CLI account · Google AI Pro"],
        }
        with QUOTA_LOCK:
            QUOTA_MEM_CACHE["ts"] = now_s
            QUOTA_MEM_CACHE["data"] = result
        try:
            with open(QUOTA_CACHE_FILE, "w", encoding="utf-8") as cf:
                json.dump(result, cf, indent=2)
        except Exception:
            pass
        return result

    with QUOTA_LOCK:
        if QUOTA_MEM_CACHE["data"]:
            return QUOTA_MEM_CACHE["data"]

    if os.path.exists(QUOTA_CACHE_FILE):
        try:
            with open(QUOTA_CACHE_FILE, "r", encoding="utf-8") as cf:
                cached = json.load(cf)
                with QUOTA_LOCK:
                    QUOTA_MEM_CACHE["data"] = cached
                return cached
        except Exception:
            pass

    return {
        "title": "Google Antigravity",
        "identity": email,
        "planLabel": plan_label,
        "updatedAt": int(now_s * 1000),
        "windows": [],
    }


def fetch_antigravity_quota(force=False):
    now_s = time.time()
    with QUOTA_LOCK:
        cached = QUOTA_MEM_CACHE["data"]
        ts = QUOTA_MEM_CACHE["ts"]
    if not force and cached and (now_s - ts) < 60:
        return cached
    if not force and cached:
        threading.Thread(target=refresh_quota_Via_agy_cli, daemon=True).start()
        return cached
    return refresh_quota_Via_agy_cli()


def quota_poller_loop():
    if os.path.exists(QUOTA_CACHE_FILE):
        try:
            with open(QUOTA_CACHE_FILE, "r", encoding="utf-8") as cf:
                cached = json.load(cf)
                with QUOTA_LOCK:
                    QUOTA_MEM_CACHE["data"] = cached
                    QUOTA_MEM_CACHE["ts"] = time.time() - 30
        except Exception:
            pass
    while True:
        try:
            refresh_quota_Via_agy_cli()
        except Exception:
            pass
        time.sleep(60)


ALLOWED_SCHEMA_TYPES = {"string", "integer", "number", "boolean", "array", "object"}
STRICT_GOOGLE_SCHEMA_KEYS = {"format", "description", "nullable"}


def resolve_ref(ref_str, defs):
    if not isinstance(ref_str, str):
        return None
    m = re.match(r"^#/(?:\$defs|definitions)/(.+)$", ref_str)
    if not m:
        return None
    try:
        key = urllib.parse.unquote(m.group(1).replace("~1", "/").replace("~0", "~"))
        return defs.get(key)
    except Exception:
        return None


def collect_defs(root, defs):
    if not isinstance(root, dict):
        return
    for bag in ("$defs", "definitions"):
        group = root.get(bag)
        if isinstance(group, dict):
            for name, val in group.items():
                if name not in defs:
                    defs[name] = val


def merge_ref_target(target, overlay):
    merged = dict(target)
    for k in ("type", "nullable", "description", "format", "enum", "const", "properties", "items", "required", "anyOf"):
        if k in overlay:
            merged[k] = overlay[k]
    return merged


def sanitize_schema(node, defs=None, depth=0, ref_depth=0, active_refs=None):
    if not isinstance(node, dict):
        return {"type": "OBJECT", "properties": {}} if depth == 0 else {}
    if defs is None:
        defs = {}
        collect_defs(node, defs)
    if active_refs is None:
        active_refs = set()

    if depth >= 24:
        return {}

    # Dereference local $ref before removing definitions
    ref = node.get("$ref")
    if isinstance(ref, str) and ref_depth < 16:
        target = resolve_ref(ref, defs)
        if isinstance(target, dict):
            if ref in active_refs:
                return {}
            active_refs.add(ref)
            try:
                merged = merge_ref_target(target, node)
                return sanitize_schema(merged, defs, depth, ref_depth + 1, active_refs)
            finally:
                active_refs.discard(ref)

    out = {}

    # Handle anyOf unions (such as nullable single-branch types or multi-branch enum unions)
    if "anyOf" in node and isinstance(node["anyOf"], list):
        non_null_branches = [
            b for b in node["anyOf"]
            if isinstance(b, dict) and not (b.get("type") == "null" or b.get("enum") == [None])
        ]
        has_null = len(non_null_branches) != len(node["anyOf"])

        if len(non_null_branches) == 1:
            merged = dict(non_null_branches[0])
            if "description" in node and "description" not in merged:
                merged["description"] = node["description"]
            res = sanitize_schema(merged, defs, depth + 1 if depth == 0 else depth, ref_depth, active_refs)
            if has_null:
                res["nullable"] = True
            return res

        # Multi-branch enum union: collapse same-type enum branches (e.g. string enums across anyOf branches)
        if non_null_branches:
            branch_schemas = [
                sanitize_schema(b, defs, depth + 1 if depth == 0 else depth, ref_depth, active_refs)
                for b in non_null_branches
            ]
            first_type = branch_schemas[0].get("type")
            same_type = all(s.get("type") == first_type for s in branch_schemas)
            all_enum_only = all(
                isinstance(s.get("enum"), list) and set(s.keys()).issubset({"type", "enum", "nullable"})
                for s in branch_schemas
            )
            if same_type and all_enum_only and first_type not in (None, "NULL"):
                merged_enum = []
                seen_enums = set()
                for s in branch_schemas:
                    for val in s.get("enum", []):
                        if val not in seen_enums:
                            seen_enums.add(val)
                            merged_enum.append(val)
                res = {"type": first_type or "STRING", "enum": merged_enum}
                if "description" in node:
                    res["description"] = node["description"]
                if has_null:
                    res["nullable"] = True
                return res

    # Type normalization
    node_type = node.get("type")
    if isinstance(node_type, list):
        non_null = [t for t in node_type if t != "null"]
        if "null" in node_type:
            out["nullable"] = True
        if non_null and isinstance(non_null[0], str) and non_null[0].lower() in ALLOWED_SCHEMA_TYPES:
            out["type"] = non_null[0].upper()
    elif isinstance(node_type, str):
        t_lower = node_type.lower()
        if t_lower == "null":
            out["type"] = "STRING"
            out["nullable"] = True
        elif t_lower in ALLOWED_SCHEMA_TYPES:
            out["type"] = t_lower.upper()

    # Pass through strict Google subset only (excludes title, minItems, minLength, minimum, etc.)
    if isinstance(node.get("nullable"), bool):
        out["nullable"] = node["nullable"]
    if isinstance(node.get("description"), str):
        out["description"] = node["description"]
    if isinstance(node.get("format"), str):
        out["format"] = node["format"]

    # Enum / const: only string values are supported by Google Cloud Code Assist Schema
    if "const" in node and isinstance(node["const"], str):
        out["enum"] = [node["const"]]
        if "type" not in out:
            out["type"] = "STRING"
    elif isinstance(node.get("enum"), list):
        vals = [x for x in node["enum"] if isinstance(x, str)]
        if vals:
            seen = set()
            deduped = []
            for x in vals:
                if x not in seen:
                    seen.add(x)
                    deduped.append(x)
            out["enum"] = deduped
            if "type" not in out:
                out["type"] = "STRING"

    # Properties (recursive)
    if isinstance(node.get("properties"), dict):
        props = {}
        for prop_name, prop_val in node["properties"].items():
            if isinstance(prop_val, dict):
                props[prop_name] = sanitize_schema(prop_val, defs, depth + 1, ref_depth, active_refs)
            else:
                props[prop_name] = {"type": "STRING"}
        out["properties"] = props
        if "type" not in out:
            out["type"] = "OBJECT"

    # Required: only string names that exist in properties
    if "properties" in out and isinstance(node.get("required"), list):
        props = out["properties"]
        req = [r for r in node["required"] if isinstance(r, str) and r in props]
        if req:
            out["required"] = req

    # Items for array
    if isinstance(node.get("items"), dict):
        out["items"] = sanitize_schema(node["items"], defs, depth + 1, ref_depth, active_refs)
        if "type" not in out:
            out["type"] = "ARRAY"

    if depth == 0:
        out["type"] = "OBJECT"
        if "properties" not in out:
            out["properties"] = {}
    elif "type" not in out:
        out["type"] = "STRING"

    return out


def extract_text_from_content(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                t = item.get("type")
                if t in ("text", "input_text", "output_text"):
                    parts.append(item.get("text", ""))
        return "\n".join(p for p in parts if p)
    return str(content)


def build_cca_request(openai_req):
    raw_model = openai_req.get("model") or "gemini-4-argon"
    if "/" in raw_model:
        raw_model = raw_model.split("/", 1)[1]

    alias_effort = None
    lookup_model = raw_model
    if raw_model in MODEL_ALIASES:
        lookup_model, alias_effort = MODEL_ALIASES[raw_model]

    model_info = MODEL_MAP.get(lookup_model, {
        "id": raw_model,
        "backend": "gemini-3.8-flash-tiered" if "argon" in raw_model or "3.8" in raw_model else raw_model,
        "thinking_budget": 16000 if ("argon" in raw_model or "3.8" in raw_model) else 0,
    })
    backend_model = model_info["backend"]

    req_effort = (
        openai_req.get("reasoning_effort")
        or (openai_req.get("reasoning") or {}).get("effort")
        or alias_effort
        or model_info.get("default_effort")
    )

    messages = openai_req.get("messages") or []
    system_texts = []
    contents = []
    tool_id_to_name = {}

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content")

        if role in ("system", "developer"):
            txt = extract_text_from_content(content)
            if txt:
                system_texts.append(txt)
            continue

        if role == "user":
            user_parts = []
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict):
                        itype = item.get("type")
                        if itype in ("text", "input_text"):
                            txt = item.get("text", "")
                            if txt:
                                user_parts.append({"text": txt})
                        elif itype == "image_url":
                            url_obj = item.get("image_url", {})
                            url_str = url_obj.get("url", "") if isinstance(url_obj, dict) else str(url_obj)
                            if url_str.startswith("data:") and ";base64," in url_str:
                                header, b64 = url_str.split(";base64,", 1)
                                mime = header.replace("data:", "") or "image/png"
                                user_parts.append({"inlineData": {"mimeType": mime, "data": b64}})
            else:
                txt = extract_text_from_content(content)
                if txt:
                    user_parts.append({"text": txt})
            if not user_parts:
                user_parts.append({"text": " "})
            if contents and contents[-1]["role"] == "user":
                contents[-1]["parts"].extend(user_parts)
            else:
                contents.append({"role": "user", "parts": user_parts})

        elif role == "assistant":
            model_parts = []
            txt = extract_text_from_content(content)
            if txt:
                model_parts.append({"text": txt})

            tool_calls = msg.get("tool_calls") or []
            for tc in tool_calls:
                tc_id = tc.get("id") or f"call_{uuid.uuid4().hex[:8]}"
                fn = tc.get("function") or {}
                fn_name = fn.get("name") or "tool"
                tool_id_to_name[tc_id] = fn_name
                raw_args = fn.get("arguments") or "{}"
                try:
                    args_obj = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                    if not isinstance(args_obj, dict):
                        args_obj = {"value": args_obj}
                except Exception:
                    args_obj = {"raw": str(raw_args)}

                with CACHE_LOCK:
                    sig = THOUGHT_SIG_CACHE.get(tc_id, "skip_thought_signature_validator")

                fc_part = {
                    "thoughtSignature": sig,
                    "functionCall": {
                        "name": fn_name,
                        "args": args_obj,
                        "id": tc_id,
                    },
                }
                model_parts.append(fc_part)

            if model_parts:
                if contents and contents[-1]["role"] == "model":
                    contents[-1]["parts"].extend(model_parts)
                else:
                    contents.append({"role": "model", "parts": model_parts})

        elif role == "tool":
            tc_id = msg.get("tool_call_id") or ""
            fn_name = msg.get("name") or tool_id_to_name.get(tc_id) or "tool"
            txt = extract_text_from_content(content)
            try:
                resp_obj = json.loads(txt)
                if not isinstance(resp_obj, dict):
                    resp_obj = {"output": resp_obj}
            except Exception:
                resp_obj = {"output": txt}

            fr_part = {
                "functionResponse": {
                    "name": fn_name,
                    "id": tc_id,
                    "response": resp_obj,
                }
            }
            if contents and contents[-1]["role"] == "user":
                contents[-1]["parts"].append(fr_part)
            else:
                contents.append({"role": "user", "parts": [fr_part]})

    if not contents:
        contents.append({"role": "user", "parts": [{"text": "Hello"}]})

    req_inner = {"contents": contents}
    if system_texts:
        req_inner["systemInstruction"] = {
            "role": "user",
            "parts": [{"text": "\n\n".join(system_texts)}],
        }

    openai_tools = openai_req.get("tools") or []
    fn_decls = []
    for t in openai_tools:
        if isinstance(t, dict) and t.get("type") == "function":
            fn = t.get("function") or {}
            name = fn.get("name")
            if name:
                decl = {
                    "name": name,
                    "description": fn.get("description") or "",
                }
                params = fn.get("parameters")
                if isinstance(params, dict):
                    decl["parameters"] = sanitize_schema(params)
                else:
                    decl["parameters"] = {"type": "OBJECT", "properties": {}}
                fn_decls.append(decl)
    if fn_decls:
        req_inner["tools"] = [{"functionDeclarations": fn_decls}]
        tool_choice = openai_req.get("tool_choice")
        if tool_choice:
            fcc = None
            declared_names = {d["name"] for d in fn_decls}
            if isinstance(tool_choice, str):
                tc_lower = tool_choice.lower()
                if tc_lower == "none":
                    fcc = {"mode": "NONE"}
                elif tc_lower == "auto":
                    fcc = {"mode": "AUTO"}
                elif tc_lower == "required":
                    fcc = {"mode": "ANY"}
            elif isinstance(tool_choice, dict):
                fn_obj = tool_choice.get("function") or tool_choice
                target_name = fn_obj.get("name") if isinstance(fn_obj, dict) else None
                if target_name and target_name in declared_names:
                    fcc = {"mode": "ANY", "allowedFunctionNames": [target_name]}
            if fcc:
                req_inner["toolConfig"] = {"functionCallingConfig": fcc}

    gen_cfg = {}
    if "temperature" in openai_req and openai_req["temperature"] is not None:
        gen_cfg["temperature"] = float(openai_req["temperature"])
    max_tok = openai_req.get("max_completion_tokens") or openai_req.get("max_tokens")
    if max_tok and int(max_tok) > 0:
        gen_cfg["maxOutputTokens"] = min(int(max_tok), 65536)

    if req_effort:
        effort_key = str(req_effort).lower()
        if effort_key == "minimal":
            gen_cfg["thinkingConfig"] = {"thinkingBudget": 0}
        else:
            budget = EFFORT_TO_BUDGET.get(effort_key, model_info.get("thinking_budget", 0))
            if budget > 0:
                gen_cfg["thinkingConfig"] = {"thinkingBudget": budget}
    elif model_info.get("thinking_budget", 0) > 0:
        gen_cfg["thinkingConfig"] = {"thinkingBudget": model_info["thinking_budget"]}

    if gen_cfg:
        req_inner["generationConfig"] = gen_cfg

    envelope = {
        "project": PROJECT_ID_CACHE["project"],
        "requestId": str(uuid.uuid4()),
        "model": backend_model,
        "userAgent": "antigravity",
        "request": req_inner,
    }
    return envelope, raw_model, backend_model


def open_upstream_stream(envelope):
    url = f"{UPSTREAM_BASE}/v1internal:streamGenerateContent?alt=sse"
    token = get_valid_access_token(force_refresh=False)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Goog-Ext-525006001-bin": PAID_TIER_HEADER,
    }
    data = json.dumps(envelope).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        return urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            token = get_valid_access_token(force_refresh=True)
            headers["Authorization"] = f"Bearer {token}"
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            return urllib.request.urlopen(req, timeout=120)
        raise


def map_finish_reason(raw_finish, has_tool_calls=False):
    if not raw_finish:
        return "tool_calls" if has_tool_calls else "stop"
    rf = str(raw_finish).upper()
    if rf in ("MAX_TOKENS", "LENGTH"):
        return "length"
    if rf in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"):
        return "content_filter"
    if "SAFETY" in rf or "BLOCK" in rf or "PROHIBIT" in rf:
        return "content_filter"
    if rf in ("MALFORMED_FUNCTION_CALL", "OTHER", "ERROR"):
        return "error"
    if rf in ("STOP", "END_OF_TURN"):
        return "tool_calls" if has_tool_calls else "stop"
    return "tool_calls" if has_tool_calls else "stop"


class BridgeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _set_cors_headers(self):
        origin = self.headers.get("Origin")
        if origin and ALLOWED_ORIGIN_REGEX.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _check_origin_and_auth(self):
        origin = self.headers.get("Origin")
        if origin and not ALLOWED_ORIGIN_REGEX.match(origin):
            self._send_json(403, {
                "error": {
                    "message": f"Forbidden: untrusted origin '{origin}'",
                    "type": "cors_error",
                    "code": 403,
                }
            })
            return False

        if BRIDGE_SECRET:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {BRIDGE_SECRET}":
                self._send_json(401, {
                    "error": {
                        "message": "Unauthorized: missing or invalid bridge secret",
                        "type": "auth_error",
                        "code": 401,
                    }
                })
                return False
        return True

    def log_message(self, fmt, *args):
        try:
            log_path = os.path.join(CACHE_DIR, "bridge.log")
            with open(log_path, "a", encoding="utf-8") as lf:
                lf.write(f"[{datetime.datetime.now().isoformat()}] {fmt % args}\n")
        except Exception:
            pass

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._set_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self._check_origin_and_auth():
            return
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/v1/health"):
            tok = read_keyring_token()
            self._send_json(200, {
                "status": "ok",
                "provider": "google-antigravity",
                "authenticated": bool(tok and tok.get("access_token")),
                "project": PROJECT_ID_CACHE["project"],
            })
            return

        if path in ("/v1/quota", "/quota"):
            try:
                quota_obj = fetch_antigravity_quota()
                self._send_json(200, quota_obj)
            except Exception as e:
                self._send_json(500, {"error": {"message": str(e)}})
            return

        if path in ("/v1/models", "/models"):
            now = int(time.time())
            dynamic_catalog = get_dynamic_agy_models()
            data = []
            for m in dynamic_catalog:
                modalities = {
                    "input": ["text", "image"] if m.get("supports_image") else ["text"],
                    "output": ["text"],
                }
                meta = {
                    "name": m["name"],
                    "description": m.get("description", ""),
                    "supportsImageInput": bool(m.get("supports_image", True)),
                    "supportsFastMode": bool(m.get("supports_fast", False)),
                    "supportsToolCalls": True,
                    "modalities": modalities,
                }
                if m.get("efforts"):
                    meta["efforts"] = m["efforts"]
                if m.get("default_effort"):
                    meta["defaultEffort"] = m["default_effort"]
                if m.get("context_window") is not None:
                    meta["contextWindow"] = m["context_window"]
                    meta["contextWindowMax"] = m["context_window"]
                if m.get("max_output") is not None:
                    meta["maxOutputTokens"] = m["max_output"]

                model_item = {
                    "id": m["id"],
                    "object": "model",
                    "created": now,
                    "owned_by": "google-antigravity",
                    "name": m["name"],
                    **meta,
                    "discoveredMetadata": meta,
                }
                if m.get("context_window") is not None:
                    model_item["context_window"] = m["context_window"]
                if m.get("max_output") is not None:
                    model_item["max_tokens"] = m["max_output"]

                data.append(model_item)
            self._send_json(200, {"object": "list", "data": data})
            return

        self._send_json(404, {"error": {"message": f"Not found: {path}"}})

    def do_POST(self):
        if not self._check_origin_and_auth():
            return
        path = self.path.split("?", 1)[0]
        if path not in ("/v1/chat/completions", "/chat/completions"):
            self._send_json(404, {"error": {"message": f"Not found: {path}"}})
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            openai_req = json.loads(raw_body.decode("utf-8"))
        except Exception as e:
            self._send_json(400, {"error": {"message": f"Invalid JSON: {e}"}})
            return

        stream = bool(openai_req.get("stream", False))
        try:
            envelope, requested_model, _ = build_cca_request(openai_req)
            resp = open_upstream_stream(envelope)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            self._send_json(e.code, {
                "error": {
                    "message": f"Antigravity upstream HTTP {e.code}: {err_body}",
                    "type": "upstream_error",
                    "code": e.code,
                }
            })
            return
        except Exception as e:
            self._send_json(500, {
                "error": {
                    "message": f"Antigravity bridge error: {e}",
                    "type": "bridge_error",
                }
            })
            return

        chat_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        created = int(time.time())

        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self._set_cors_headers()
            self.end_headers()

            def send_sse(obj):
                line = f"data: {json.dumps(obj)}\n\n".encode("utf-8")
                self.wfile.write(line)
                self.wfile.flush()

            send_sse({
                "id": chat_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": requested_model,
                "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
            })

            tool_call_idx = 0
            saw_tool_calls = False
            last_finish_reason = None
            usage_meta = {}

            try:
                for raw_line in resp:
                    line_str = raw_line.decode("utf-8", errors="ignore").strip()
                    if not line_str.startswith("data:"):
                        continue
                    payload_str = line_str[5:].strip()
                    if not payload_str or payload_str == "[DONE]":
                        continue
                    try:
                        event = json.loads(payload_str)
                    except Exception:
                        continue

                    inner = event.get("response") or event
                    if "usageMetadata" in inner:
                        usage_meta = inner["usageMetadata"]
                    if inner.get("promptFeedback") and isinstance(inner["promptFeedback"], dict):
                        pf_block = inner["promptFeedback"].get("blockReason")
                        if pf_block and not last_finish_reason:
                            last_finish_reason = pf_block
                    if inner.get("finishReason"):
                        last_finish_reason = inner["finishReason"]

                    candidates = inner.get("candidates") or []
                    for cand in candidates:
                        if cand.get("finishReason"):
                            last_finish_reason = cand["finishReason"]
                        parts = (cand.get("content") or {}).get("parts") or []
                        for part in parts:
                            sig = part.get("thoughtSignature")
                            if part.get("thought") is True and part.get("text"):
                                send_sse({
                                    "id": chat_id,
                                    "object": "chat.completion.chunk",
                                    "created": created,
                                    "model": requested_model,
                                    "choices": [{
                                        "index": 0,
                                        "delta": {"reasoning_content": part["text"]},
                                        "finish_reason": None,
                                    }],
                                })
                            elif "functionCall" in part:
                                fc = part["functionCall"]
                                tc_id = fc.get("id") or f"call_{uuid.uuid4().hex[:12]}"
                                if sig:
                                    with CACHE_LOCK:
                                        THOUGHT_SIG_CACHE[tc_id] = sig
                                saw_tool_calls = True
                                send_sse({
                                    "id": chat_id,
                                    "object": "chat.completion.chunk",
                                    "created": created,
                                    "model": requested_model,
                                    "choices": [{
                                        "index": 0,
                                        "delta": {
                                            "tool_calls": [{
                                                "index": tool_call_idx,
                                                "id": tc_id,
                                                "type": "function",
                                                "function": {
                                                    "name": fc.get("name", ""),
                                                    "arguments": json.dumps(fc.get("args") or {}),
                                                },
                                            }]
                                        },
                                        "finish_reason": None,
                                    }],
                                })
                                tool_call_idx += 1
                            elif "text" in part and part["text"]:
                                send_sse({
                                    "id": chat_id,
                                    "object": "chat.completion.chunk",
                                    "created": created,
                                    "model": requested_model,
                                    "choices": [{
                                        "index": 0,
                                        "delta": {"content": part["text"]},
                                        "finish_reason": None,
                                    }],
                                })
            finally:
                resp.close()

            finish_reason = map_finish_reason(last_finish_reason, saw_tool_calls)
            prompt_toks = usage_meta.get("promptTokenCount", 0)
            cand_toks = usage_meta.get("candidatesTokenCount", 0)
            thought_toks = usage_meta.get("thoughtsTokenCount", 0)
            completion_toks = cand_toks + thought_toks
            total_toks = usage_meta.get("totalTokenCount", prompt_toks + completion_toks)

            final_usage = {
                "prompt_tokens": prompt_toks,
                "completion_tokens": completion_toks,
                "total_tokens": total_toks,
            }
            if thought_toks:
                final_usage["completion_tokens_details"] = {"reasoning_tokens": thought_toks}

            send_sse({
                "id": chat_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": requested_model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
                "usage": final_usage,
            })
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
        else:
            full_text = []
            reasoning_text = []
            tool_calls = []
            last_finish_reason = None
            usage_meta = {}
            try:
                for raw_line in resp:
                    line_str = raw_line.decode("utf-8", errors="ignore").strip()
                    if not line_str.startswith("data:"):
                        continue
                    payload_str = line_str[5:].strip()
                    if not payload_str or payload_str == "[DONE]":
                        continue
                    try:
                        event = json.loads(payload_str)
                    except Exception:
                        continue
                    inner = event.get("response") or event
                    if "usageMetadata" in inner:
                        usage_meta = inner["usageMetadata"]
                    if inner.get("promptFeedback") and isinstance(inner["promptFeedback"], dict):
                        pf_block = inner["promptFeedback"].get("blockReason")
                        if pf_block and not last_finish_reason:
                            last_finish_reason = pf_block
                    if inner.get("finishReason"):
                        last_finish_reason = inner["finishReason"]
                    for cand in inner.get("candidates") or []:
                        if cand.get("finishReason"):
                            last_finish_reason = cand["finishReason"]
                        for part in (cand.get("content") or {}).get("parts") or []:
                            sig = part.get("thoughtSignature")
                            if part.get("thought") is True and part.get("text"):
                                reasoning_text.append(part["text"])
                            elif "functionCall" in part:
                                fc = part["functionCall"]
                                tc_id = fc.get("id") or f"call_{uuid.uuid4().hex[:12]}"
                                if sig:
                                    with CACHE_LOCK:
                                        THOUGHT_SIG_CACHE[tc_id] = sig
                                tool_calls.append({
                                    "id": tc_id,
                                    "type": "function",
                                    "function": {
                                        "name": fc.get("name", ""),
                                        "arguments": json.dumps(fc.get("args") or {}),
                                    },
                                })
                            elif "text" in part and part["text"]:
                                full_text.append(part["text"])
            finally:
                resp.close()

            msg_obj = {
                "role": "assistant",
                "content": "".join(full_text) if full_text or not tool_calls else None,
            }
            if reasoning_text:
                msg_obj["reasoning_content"] = "".join(reasoning_text)
            if tool_calls:
                msg_obj["tool_calls"] = tool_calls

            finish_reason = map_finish_reason(last_finish_reason, bool(tool_calls))
            prompt_toks = usage_meta.get("promptTokenCount", 0)
            cand_toks = usage_meta.get("candidatesTokenCount", 0)
            thought_toks = usage_meta.get("thoughtsTokenCount", 0)
            completion_toks = cand_toks + thought_toks
            total_toks = usage_meta.get("totalTokenCount", prompt_toks + completion_toks)

            final_usage = {
                "prompt_tokens": prompt_toks,
                "completion_tokens": completion_toks,
                "total_tokens": total_toks,
            }
            if thought_toks:
                final_usage["completion_tokens_details"] = {"reasoning_tokens": thought_toks}

            self._send_json(200, {
                "id": chat_id,
                "object": "chat.completion",
                "created": created,
                "model": requested_model,
                "choices": [{
                    "index": 0,
                    "message": msg_obj,
                    "finish_reason": finish_reason,
                }],
                "usage": final_usage,
            })


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    threading.Thread(target=quota_poller_loop, daemon=True).start()
    server = ThreadedHTTPServer((HOST, PORT), BridgeHandler)
    try:
        log_path = os.path.join(CACHE_DIR, "bridge.log")
        with open(log_path, "a", encoding="utf-8") as lf:
            lf.write(f"[{datetime.datetime.now().isoformat()}] Listening on http://{HOST}:{PORT}/v1\n")
    except Exception:
        pass
    server.serve_forever()


if __name__ == "__main__":
    main()
