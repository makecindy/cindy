#!/usr/bin/env python3
"""
Cindy AI <-> OpenCode CLI (Local Engine & Dynamic Model Discovery Bridge)
Exposes OpenAI-compatible endpoints (/v1/models, /v1/chat/completions, /v1/quota, /quota)
for Cindy AI. Discovers model capabilities and declared USD/1M-token prices via
OpenCode. Relays native MCP tools to Cindy and measured per-response token usage.
SQLite telemetry is explicitly global OpenCode activity, not an account quota.
"""

import atexit
import http.server
import json
import math
from pathlib import Path
import shutil
import signal
import os
import re
import socketserver
import sqlite3
from contextlib import closing
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from opencode_transport import BridgeError, OpenCodeTransport

# Handle pythonw.exe without console
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

HOST = "127.0.0.1"
PORT = int(os.environ.get("OPENCODE_BRIDGE_PORT", "11437"))
OPENCODE_SERVER_PORT = int(os.environ.get("OPENCODE_SERVER_PORT", "14782"))

OPENCODE_CONFIG_PATH = os.environ.get("OPENCODE_BRIDGE_CONFIG", str(Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "opencode/opencode.json"))
OPENCODE_DB_PATH = os.environ.get("OPENCODE_BRIDGE_DB", str(Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "opencode/opencode.db"))

MODELS_CACHE = {"ts": 0.0, "data": []}
CACHE_LOCK = threading.Lock()
DISCOVERY_LOCK = threading.Lock()
DISCOVERY_TIMEOUT = int(os.environ.get("OPENCODE_DISCOVERY_TIMEOUT", "8"))
CACHE_TTL = int(os.environ.get("OPENCODE_CACHE_TTL", "900"))
EMPTY_CACHE_TTL = int(os.environ.get("OPENCODE_EMPTY_CACHE_TTL", "60"))
MAX_BODY_BYTES = int(os.environ.get("OPENCODE_BRIDGE_MAX_BODY_BYTES", str(64 * 1024 * 1024)))

def load_opencode_config():
    try:
        if os.path.exists(OPENCODE_CONFIG_PATH):
            with open(OPENCODE_CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"[WARN] Failed reading opencode.json: {e}", file=sys.stderr)
    return {}

def opencode_command():
    executable = shutil.which("opencode.exe") or shutil.which("opencode")
    if not executable:
        raise BridgeError(503, "opencode_not_installed", "Install OpenCode and add it to PATH.")
    return [executable]


def model_cost(raw):
    """OpenCode prices are USD per million tokens. Missing does not mean free."""
    if not isinstance(raw, dict):
        return {}
    cache = raw.get("cache") if isinstance(raw.get("cache"), dict) else {}
    fields = {"input": raw.get("input"), "output": raw.get("output"),
              "cacheRead": raw.get("cacheRead", cache.get("read")),
              "cacheWrite": raw.get("cacheWrite", cache.get("write"))}
    return {key: value for key, value in fields.items()
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0}


def is_model_free(cost):
    """A model is free only when input and output prices are declared and zero,
    and all other declared chargeable dimensions (cacheRead, cacheWrite) are zero."""
    if not isinstance(cost, dict) or not cost:
        return False
    return (
        cost.get("input") == 0
        and cost.get("output") == 0
        and all(val == 0 for val in cost.values())
    )


def discover_dynamic_models():
    """Runs `opencode models --verbose` and parses real-time models and live pricing."""
    models = []
    seen_ids = set()

    # 1. Parse from `opencode models --verbose`
    try:
        res = subprocess.run(
            opencode_command() + ["models", "--verbose"],
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="ignore",
            timeout=DISCOVERY_TIMEOUT
        )
        if res.returncode == 0 and res.stdout:
            lines = res.stdout.split("\n")
            cur = []
            for line in lines:
                if line.startswith("{"):
                    cur = [line]
                elif cur:
                    cur.append(line)
                    if line.startswith("}"):
                        try:
                            raw = json.loads("\n".join(cur))
                            raw_id = raw.get("id")
                            provider_id = raw.get("providerID", "opencode")
                            m_id = raw_id if provider_id == "opencode" else f"{provider_id}/{raw_id}"

                            if m_id not in seen_ids:
                                seen_ids.add(m_id)
                                cost = model_cost(raw.get("cost"))
                                limit = raw.get("limit", {})
                                caps = raw.get("capabilities", {})

                                has_image = bool(caps.get("attachment", False))
                                ctx = int(limit.get("context", 128000))
                                max_out = int(limit.get("output", 8192))

                                name = raw.get("name") or m_id
                                is_free = is_model_free(cost)
                                if is_free and "free" not in name.lower() and "free" not in m_id.lower():
                                    display_name = f"{name} (Free)"
                                else:
                                    display_name = name


                                models.append({
                                    "id": m_id,
                                    "name": display_name,
                                    "provider": provider_id,
                                    "context_window": ctx,
                                    "max_output": max_out,
                                    "supports_image": has_image,
                                    "supports_tools": caps.get("toolcall") if isinstance(caps.get("toolcall"), bool) else None,
                                    "supports_fast": False,
                                    "efforts": list(raw.get("variants", {})) if isinstance(raw.get("variants"), dict) else [],
                                    "default_effort": None,
                                    "default_enabled": is_free,
                                    "cost": cost,
                                    "description": f"OpenCode {provider_id} model | Context: {ctx:,} tokens",
                                })
                        except Exception:
                            pass
                        cur = []
    except Exception as e:
        print(f"[WARN] Error invoking opencode models --verbose: {e}", file=sys.stderr)

    # 2. Merge local configured providers from opencode.json (Ollama, Gemini Web, Groq, etc.)
    cfg = load_opencode_config()
    providers = cfg.get("provider", {})
    for p_id, p_conf in providers.items():
        p_models = p_conf.get("models", {})
        for raw_id, m_conf in p_models.items():
            full_id = f"{p_id}/{raw_id}" if p_id != "opencode" else raw_id
            if full_id not in seen_ids:
                seen_ids.add(full_id)
                limit = m_conf.get("limit", {})
                ctx = int(limit.get("context", 128000))
                max_out = int(limit.get("output", 8192))
                name = m_conf.get("name", raw_id)

                models.append({
                    "id": full_id,
                    "name": name,
                    "provider": p_id,
                    "context_window": ctx,
                    "max_output": max_out,
                    "supports_image": False,
                    "supports_tools": m_conf.get("tool_call") if isinstance(m_conf.get("tool_call"), bool) else None,
                    "supports_fast": False,
                    "efforts": list(m_conf.get("variants", {})) if isinstance(m_conf.get("variants"), dict) else [],
                    "default_effort": None,
                    "default_enabled": False,
                    "cost": model_cost(m_conf.get("cost")),
                    "description": f"Configured in opencode.json under provider '{p_id}'",
                })

    def sort_key(model):
        cost = model.get("cost", {})
        explicitly_free = is_model_free(cost)
        model["default_enabled"] = explicitly_free
        return (not explicitly_free, model["name"].casefold(), model["id"])

    models.sort(key=sort_key)

    return models

def _is_cache_valid(now):
    ts = MODELS_CACHE.get("ts", 0.0)
    if ts <= 0:
        return False
    data = MODELS_CACHE.get("data")
    ttl = CACHE_TTL if data else EMPTY_CACHE_TTL
    return (now - ts) < ttl


def get_cached_models(force=False):
    now = time.time()
    with CACHE_LOCK:
        if not force and _is_cache_valid(now):
            return list(MODELS_CACHE.get("data", []))

    # Coalesce concurrent discovery calls into a single-flight execution
    with DISCOVERY_LOCK:
        now = time.time()
        with CACHE_LOCK:
            if not force and _is_cache_valid(now):
                return list(MODELS_CACHE.get("data", []))

        new_models = discover_dynamic_models()
        with CACHE_LOCK:
            MODELS_CACHE["data"] = new_models if isinstance(new_models, list) else []
            MODELS_CACHE["ts"] = now
            return list(MODELS_CACHE["data"])

def get_opencode_stats(db_path=None, now_ms=None):
    """Read aggregate OpenCode telemetry, not subscription quotas or Cindy's ledger."""
    path = Path(db_path or OPENCODE_DB_PATH).resolve()
    if not path.exists():
        return {"available": False, "scope": "opencode_all_sessions", "reason": "database_missing"}
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(session)")}
            modern = {"tokens_input", "tokens_output", "tokens_cache_read", "tokens_cache_write", "tokens_reasoning", "time_updated"}
            if not modern.issubset(columns) or "cost" not in columns:
                return {"available": False, "scope": "opencode_all_sessions", "reason": "unsupported_schema"}
            row = conn.execute("SELECT COUNT(*), COALESCE(SUM(cost),0), "
                "COALESCE(SUM(tokens_input),0), COALESCE(SUM(tokens_output),0), "
                "COALESCE(SUM(tokens_cache_read),0), COALESCE(SUM(tokens_cache_write),0), "
                "COALESCE(SUM(tokens_reasoning),0) FROM session").fetchone()
            stats = dict(zip(("sessions", "total_cost", "tokens_input", "tokens_output",
                              "tokens_cache_read", "tokens_cache_write", "tokens_reasoning"), row))
            # Session timestamps cannot reconstruct per-message rolling token consumption.
            # Label this as recently updated sessions, never a token quota window.
            stats["recently_updated_sessions"] = {
                label: conn.execute("SELECT COUNT(*) FROM session WHERE time_updated >= ?", (now_ms - duration,)).fetchone()[0]
                for label, duration in (("5h", 5 * 3600000), ("7d", 7 * 86400000))
            }
            return {"available": True, "scope": "opencode_all_sessions", **stats}
    except sqlite3.Error:
        return {"available": False, "scope": "opencode_all_sessions", "reason": "database_unreadable"}


def build_quota_payload():
    return {"provider": "opencode", "description": "Measured OpenCode activity; quota limits are not reported.",
            "usage": get_opencode_stats(), "windows": [], "models": {}, "quota_available": False}


TRANSPORT = OpenCodeTransport(f"http://127.0.0.1:{OPENCODE_SERVER_PORT}")


def _graceful_signal_handler(signum, frame):
    try:
        TRANSPORT.shutdown()
    except Exception:
        pass
    sys.exit(0)


try:
    signal.signal(signal.SIGINT, _graceful_signal_handler)
except (ValueError, AttributeError):
    pass
try:
    signal.signal(signal.SIGTERM, _graceful_signal_handler)
except (ValueError, AttributeError):
    pass
if hasattr(signal, "SIGBREAK"):
    try:
        signal.signal(signal.SIGBREAK, _graceful_signal_handler)
    except (ValueError, AttributeError):
        pass
atexit.register(TRANSPORT.shutdown)


TRUSTED_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")


def is_trusted_origin(origin: str | None) -> bool:
    if not origin:
        return True
    if origin.startswith("chrome-extension://") or origin.startswith("vscode-webview://"):
        return True
    return bool(TRUSTED_ORIGIN_RE.match(origin))


class OpenCodeBridgeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        # Access paths contain short-lived MCP capabilities; never persist them.
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    def _verify_origin(self) -> str | None:
        origin = self.headers.get("Origin") if hasattr(self, "headers") and self.headers else None
        if not origin:
            return None
        if is_trusted_origin(origin):
            return origin
        return False

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin_header = self._verify_origin()
        if origin_header:
            self.send_header("Access-Control-Allow-Origin", origin_header)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin") if hasattr(self, "headers") and self.headers else None
        if origin and not is_trusted_origin(origin):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        if origin and is_trusted_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("Origin") if hasattr(self, "headers") and self.headers else None
        if origin and not is_trusted_origin(origin):
            self._send_json(403, {"error": {"type": "forbidden", "code": "forbidden", "message": "Cross-origin request blocked."}})
            return
        path = self.path.split("?", 1)[0]

        if path.startswith("/mcp/"):
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if path in ("/health", "/v1/health"):
            self._send_json(200, {
                "status": "ok",
                "provider": "opencode",
                "version": "2.0.0",
            })
            return

        if path in ("/v1/quota", "/quota"):
            try:
                quota = build_quota_payload()
                self._send_json(200, quota)
            except Exception as e:
                self._send_json(500, {"error": {"message": str(e)}})
            return

        if path in ("/v1/models", "/models"):
            now = int(time.time())
            models = get_cached_models()
            data = []
            for m in models:
                modalities = {
                    "input": ["text", "image"] if m.get("supports_image") else ["text"],
                    "output": ["text"],
                }
                efforts = m.get("efforts", [])
                meta = {
                    "name": m["name"],
                    "description": m.get("description", ""),
                    "contextWindow": m["context_window"],
                    "contextWindowMax": m["context_window"],
                    "maxOutputTokens": m["max_output"],
                    **({"efforts": efforts} if efforts else {}),
                    "supportsImageInput": bool(m.get("supports_image", False)),
                    "supportsFastMode": bool(m.get("supports_fast", True)),
                    **({"supportsToolCalls": m["supports_tools"]} if isinstance(m.get("supports_tools"), bool) else {}),
                    "modalities": modalities,
                }
                cost_info = model_cost(m.get("cost"))
                data.append({
                    "id": m["id"],
                    "object": "model",
                    "created": now,
                    "owned_by": "opencode",
                    "name": m["name"],
                    "context_window": m["context_window"],
                    "max_tokens": m["max_output"],
                    **({"discoveredCost": cost_info} if cost_info else {}),
                    **meta,
                    "discoveredMetadata": meta,
                })
            self._send_json(200, {"object": "list", "data": data})
            return

        self._send_json(404, {"error": {"message": f"Not found: {path}"}})

    def do_POST(self):
        origin = self.headers.get("Origin") if hasattr(self, "headers") and self.headers else None
        if origin and not is_trusted_origin(origin):
            self._send_json(403, {"error": {"type": "forbidden", "code": "forbidden", "message": "Cross-origin request blocked."}})
            return
        path = self.path.split("?", 1)[0]
        if path in ("/shutdown", "/v1/shutdown"):
            def _delayed_exit():
                time.sleep(0.1)
                try:
                    TRANSPORT.shutdown()
                except Exception:
                    pass
                os._exit(0)
            self._send_json(200, {"status": "shutting_down"})
            threading.Thread(target=_delayed_exit, daemon=True).start()
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                raise BridgeError(400, "invalid_request", "Expected a non-empty JSON body.")
            if length > MAX_BODY_BYTES:
                raise BridgeError(413, "payload_too_large", f"Request payload exceeds {MAX_BODY_BYTES // (1024 * 1024)} MiB limit.")
            req = json.loads(self.rfile.read(length))
            if not isinstance(req, dict):
                raise BridgeError(400, "invalid_request", "Expected a JSON object.")
            if path.startswith("/mcp/"):
                result = TRANSPORT.mcp(path.removeprefix("/mcp/"), req)
                if result is None:
                    self.send_response(202)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self._send_json(200, result)
                return
            if path not in ("/v1/chat/completions", "/chat/completions"):
                raise BridgeError(404, "not_found", "Unknown endpoint.")
            TRANSPORT.chat(req, self, get_cached_models())
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": {"type": "invalid_request", "code": "invalid_request", "message": "Invalid JSON request."}})
        except BridgeError as error:
            self._send_json(error.status, {"error": {"type": error.code, "code": error.code, "message": str(error)}})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def main():
    # Pre-populate cache and ensure OpenCode server in background on startup
    threading.Thread(target=get_cached_models, kwargs={"force": True}, daemon=True).start()

    server = ThreadedHTTPServer((HOST, PORT), OpenCodeBridgeHandler)
    TRANSPORT.callback_base = f"http://{HOST}:{server.server_port}"
    print(f"[INFO] Dynamic OpenCode Cindy Bridge running on http://{HOST}:{PORT}/v1")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[INFO] Shutting down OpenCode bridge.")
    finally:
        try:
            TRANSPORT.shutdown()
        except Exception:
            pass
        server.server_close()

if __name__ == "__main__":
    main()
