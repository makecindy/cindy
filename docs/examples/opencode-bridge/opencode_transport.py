"""OpenAI chat <-> OpenCode sessions with a native MCP tool relay.

Only MCP tools supplied by the caller are enabled. No credential files are read.
The relay suspends an MCP call until Cindy sends the matching tool result; it never
interprets assistant text as a tool invocation. State is transient and bounded.
"""
from __future__ import annotations

import json
import math
import mimetypes
import os
from pathlib import Path
import queue
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field


class BridgeError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def usage_from_messages(messages):
    """Project OpenCode's disjoint token buckets into the OpenAI usage contract."""
    totals = dict(input=0, output=0, reasoning=0, cache_read=0, cache_write=0)
    measured = False
    for message in messages:
        info = message.get("info", {})
        if info.get("role") != "assistant":
            continue
        tokens = info.get("tokens")
        if not isinstance(tokens, dict):
            continue
        # A pending message starts at all zeroes; never call that measured usage.
        completed = info.get("time", {}).get("completed") is not None
        if not completed and not info.get("finish"):
            continue
        if not all(isinstance(tokens.get(key), (int, float)) and not isinstance(tokens[key], bool)
                   and math.isfinite(tokens[key]) and tokens[key] >= 0 for key in ("input", "output")):
            continue
        measured = True
        cache = tokens.get("cache") or {}
        fields = {"input": tokens.get("input"), "output": tokens.get("output"),
                  "reasoning": tokens.get("reasoning"), "cache_read": cache.get("read"),
                  "cache_write": cache.get("write")}
        for key, value in fields.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                totals[key] += int(value)
    if not measured:
        return None
    prompt = totals["input"] + totals["cache_read"] + totals["cache_write"]
    completion = totals["output"] + totals["reasoning"]
    return {"prompt_tokens": prompt, "completion_tokens": completion,
            "total_tokens": prompt + completion,
            "prompt_tokens_details": {"cached_tokens": totals["cache_read"],
                                      "cache_creation_tokens": totals["cache_write"]},
            "completion_tokens_details": {"reasoning_tokens": totals["reasoning"]}}


def sse_events(response):
    data = []
    for raw in response:
        line = raw.decode("utf-8").rstrip("\r\n")
        if not line:
            if data:
                yield json.loads("\n".join(data))
                data = []
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())


@dataclass
class ToolCall:
    name: str
    arguments: dict
    id: str = field(default_factory=lambda: "call_bridge_" + uuid.uuid4().hex)
    reply: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=1))
    resolved: bool = False


@dataclass
class Conversation:
    token: str
    directory: str
    model: str
    tools: dict
    tool_choice: object
    events: queue.Queue = field(default_factory=queue.Queue)
    session_id: str | None = None
    pending: dict = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)
    stream: object = None
    closed: threading.Event = field(default_factory=threading.Event)
    last_used: float = field(default_factory=time.monotonic)
    prefix: str = "cindy"
    max_tokens: int | None = None


class OpenCodeTransport:
    def __init__(self, base_url, callback_base=None, timeout=300, request_json=None, stream_open=None):
        self.base_url = base_url.rstrip("/")
        self.callback_base = callback_base
        self.timeout = timeout
        self.conversations = {}
        self.calls = {}
        self.lock = threading.Lock()
        if request_json is not None:
            import inspect
            sig = inspect.signature(request_json)
            params = sig.parameters.values()
            accepts_kwargs = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params)
            has_method = accepts_kwargs or any(p.name == "method" for p in params)
            has_timeout = accepts_kwargs or any(p.name == "timeout" for p in params)
            pos_params = [p for p in params if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)]

            def wrapped_request_json(path, conversation, body=None, method=None, timeout=None):
                kwargs = {}
                if has_method and method is not None:
                    kwargs["method"] = method
                if has_timeout and timeout is not None:
                    kwargs["timeout"] = timeout
                if len(pos_params) == 2 and not accepts_kwargs:
                    return request_json(path, conversation, **kwargs)
                return request_json(path, conversation, body, **kwargs)
            self.request_json = wrapped_request_json
        else:
            self.request_json = self._request_json
        self.stream_open = stream_open or self._stream_open

    def _url(self, path, conversation):
        return self.base_url + path + "?" + urllib.parse.urlencode({"directory": conversation.directory})

    def _request(self, path, conversation, body=None, method=None):
        headers = {"Content-Type": "application/json"}
        # Server auth is configured explicitly through env, never extracted from a CLI login.
        password = os.environ.get("OPENCODE_SERVER_PASSWORD")
        if password:
            import base64
            pair = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode") + ":" + password
            headers["Authorization"] = "Basic " + base64.b64encode(pair.encode()).decode()
        return urllib.request.Request(self._url(path, conversation),
            data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)

    def _request_json(self, path, conversation, body=None, method=None, timeout=None):
        try:
            req_timeout = self.timeout if timeout is None else timeout
            with urllib.request.urlopen(self._request(path, conversation, body, method=method), timeout=req_timeout) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            # Upstream response bodies may contain credentials; do not forward them.
            status = error.code if 400 <= error.code < 500 else 502
            raise BridgeError(status, "opencode_http_error", f"OpenCode endpoint {path.split('/')[1]} rejected the request (HTTP {error.code}).") from None
        except (OSError, ValueError) as error:
            raise BridgeError(502, "opencode_unavailable", "OpenCode could not complete the request.") from error

    def _stream_open(self, conversation):
        try:
            return urllib.request.urlopen(self._request("/event", conversation), timeout=self.timeout)
        except urllib.error.HTTPError as error:
            status = error.code if 400 <= error.code < 500 else 502
            raise BridgeError(status, "opencode_http_error", f"OpenCode event stream rejected the request (HTTP {error.code}).") from None
        except (OSError, ValueError) as error:
            raise BridgeError(502, "opencode_unavailable", "OpenCode event stream could not complete the request.") from error

    def _reap(self):
        now = time.monotonic()
        with self.lock:
            expired = [c for c in self.conversations.values() if now - c.last_used > self.timeout]
        for conversation in expired:
            self._close(conversation)

    def shutdown(self):
        """Close all active bridge conversations and remove temporary state."""
        with self.lock:
            active = list(self.conversations.values())
        for conversation in active:
            try:
                self._close(conversation, abort=True)
            except Exception:
                pass

    def _close(self, conversation, abort=True):
        if conversation.closed.is_set():
            return
        conversation.closed.set()
        with self.lock:
            self.conversations.pop(conversation.token, None)
            for call in conversation.pending.values():
                self.calls.pop(call.id, None)
                if not call.resolved:
                    call.resolved = True
                    call.reply.put({"content": [{"type": "text", "text": "Caller disconnected or expired."}], "isError": True})
        if abort and conversation.session_id:
            try:
                self.request_json(f"/session/{conversation.session_id}/abort", conversation, {})
            except BridgeError:
                pass
        # Delete bridge-owned session so OpenCode does not accumulate orphan sessions.
        if conversation.session_id:
            try:
                self.request_json(f"/session/{conversation.session_id}", conversation, method="DELETE")
            except BridgeError:
                pass
        # Dispose only this bridge-created instance, never a user's project instance.
        try:
            self.request_json("/instance/dispose", conversation, {})
        except BridgeError:
            pass
        try:
            Path(conversation.directory, "opencode.json").unlink(missing_ok=True)
            Path(conversation.directory).rmdir()  # Remove only our empty temporary directory.
        except OSError:
            pass

    def _definitions(self, request):
        tools = {}
        for tool in request.get("tools") or []:
            if not isinstance(tool, dict) or tool.get("type") != "function":
                raise BridgeError(400, "unsupported_tool", "Only function tools are supported.")
            function = tool.get("function") or {}
            name = function.get("name")
            if not isinstance(name, str) or not name or name in tools:
                raise BridgeError(400, "invalid_tool", "Tool names must be nonempty and unique.")
            tools[name] = {"name": name, "description": function.get("description", ""),
                           "inputSchema": function.get("parameters", {"type": "object", "properties": {}})}
        choice = request.get("tool_choice", "auto")
        if choice == "none":
            return {}, choice
        if isinstance(choice, dict):
            name = (choice.get("function") or {}).get("name")
            if name not in tools:
                raise BridgeError(400, "invalid_tool_choice", "The selected tool is not declared.")
            tools = {name: tools[name]}
        elif choice not in ("auto", "required"):
            raise BridgeError(400, "invalid_tool_choice", "Unsupported tool_choice.")
        if choice == "required" and not tools:
            raise BridgeError(400, "invalid_tool_choice", "tool_choice required needs tools.")
        return tools, choice

    @staticmethod
    def _client_disconnected(handler):
        if handler is None:
            return False
        if getattr(handler, "disconnected", False):
            return True
        conn = getattr(handler, "connection", None)
        if conn is None:
            return False
        if callable(getattr(conn, "is_disconnected", None)):
            try:
                return conn.is_disconnected()
            except Exception:
                return True
        if not hasattr(conn, "fileno"):
            return False
        try:
            fd = conn.fileno()
            if not isinstance(fd, int) or fd < 0:
                return False
        except Exception:
            return False
        try:
            import select
            r, _, x = select.select([conn], [], [conn], 0)
            if x:
                return True
            if r:
                import socket as _socket
                peek = conn.recv(1, _socket.MSG_PEEK)
                if not peek:
                    return True
        except (ValueError, OSError):
            return True
        return False

    def _new(self, request, models):
        tools, choice = self._definitions(request)
        with self.lock:
            if len(self.conversations) >= 32:
                raise BridgeError(429, "bridge_busy", "Too many active bridge conversations.")
        max_tokens = request.get("max_completion_tokens")
        if max_tokens is None:
            max_tokens = request.get("max_tokens")
        if max_tokens is not None and (not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens <= 0):
            raise BridgeError(400, "invalid_request", "max_tokens must be a positive integer.")
        token = uuid.uuid4().hex
        directory = tempfile.mkdtemp(prefix="cindy-opencode-")
        conversation = Conversation(token, directory, request["model"], tools, choice, max_tokens=max_tokens)
        with self.lock:
            if len(self.conversations) >= 32:
                try:
                    shutil.rmtree(directory, ignore_errors=True)
                except OSError:
                    pass
                raise BridgeError(429, "bridge_busy", "Too many active bridge conversations.")
            self.conversations[token] = conversation
        try:
            provider, model = "opencode", request["model"]
            match = next((m for m in models if m["id"] == request["model"]), None)
            if match:
                provider = match["provider"]
                model = request["model"] if provider == "opencode" else request["model"].removeprefix(provider + "/")
            elif "/" in model:
                provider, model = model.split("/", 1)
            # Cindy's harness owns context management. Native OpenCode compaction can
            # otherwise loop forever for a small local model before returning a reply.
            # Force share: disabled to prevent leaking system instructions, history, or image data.
            # Configure agent and model limits to honor the caller's output token cap.
            config = {
                "compaction": {"auto": False},
                "share": "disabled",
                "agent": {
                    "cindy-bridge": {
                        "description": "Model transport for Cindy",
                        "mode": "primary",
                    }
                }
            }
            if max_tokens is not None:
                context_limit = (match or {}).get("context_window", 128000)
                config["provider"] = {
                    provider: {
                        "models": {
                            model: {
                                # limit.output is OpenCode's output cap; "options" are forwarded
                                # verbatim to the provider API, which rejects unknown maxTokens.
                                "limit": {"context": context_limit, "output": max_tokens},
                            }
                        }
                    }
                }
            Path(directory, "opencode.json").write_text(json.dumps(config), encoding="utf-8")
            # Each request owns an OpenCode instance, MCP namespace, and permission rules.
            # Discover built-in and configured MCP tools, then disable all of them.
            ids = self.request_json("/experimental/tool/ids", conversation)
            tool_flags = {name: False for name in ids}
            declared_relay_ids = set()
            if tools:
                result = self.request_json("/mcp", conversation, {"name": conversation.prefix, "config": {
                    "type": "remote", "url": self.callback_base + "/mcp/" + token,
                    "enabled": True, "oauth": False, "timeout": int(self.timeout * 1000)}})
                if (result or {}).get(conversation.prefix, {}).get("status") != "connected":
                    raise BridgeError(502, "mcp_connection_failed", "OpenCode could not connect to the Cindy tool relay.")
                # MCP definitions are exposed with their native OpenCode namespace.
                # Restrict enablement strictly to declared relay tool IDs so that unrelated
                # MCP namespaces (e.g. cindy_extra_*) remain disabled.
                declared_relay_ids = {conversation.prefix + "_" + name for name in tools}
                ids = self.request_json("/experimental/tool/ids", conversation)
                tool_flags = {name: (name in declared_relay_ids) for name in ids}
                for relay_id in declared_relay_ids:
                    tool_flags[relay_id] = True
            permissions = [{"permission": "*", "pattern": "*", "action": "deny"}]
            if declared_relay_ids:
                for relay_id in sorted(declared_relay_ids):
                    permissions.append({"permission": relay_id, "pattern": "*", "action": "allow"})
            session = self.request_json("/session", conversation,
                {"title": "Cindy Bridge: " + token, "permission": permissions})
            conversation.session_id = session["id"]
            # Preserve roles, tool IDs, and multimodal blocks in a lossless history envelope.
            # System instructions stay in OpenCode's system field, never in a user role.
            # Strip bulky base64 data URLs from the history text envelope to avoid duplicate token consumption.
            system = "\n\n".join(m["content"] for m in request["messages"]
                                  if m.get("role") in ("system", "developer") and isinstance(m.get("content"), str))
            history = [m for m in request["messages"] if m.get("role") not in ("system", "developer")]
            file_parts = []
            sanitized_history = []
            for message in history:
                content = message.get("content")
                if isinstance(content, list):
                    sanitized_blocks = []
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "image_url":
                            url = (block.get("image_url") or {}).get("url", "")
                            parsed = urllib.parse.urlparse(url)
                            if parsed.scheme not in ("http", "https", "data"):
                                raise BridgeError(400, "unsupported_image", "Images require an HTTPS/HTTP or data URL.")
                            mime = url[5:].split(";", 1)[0] if url.startswith("data:") else mimetypes.guess_type(parsed.path)[0]
                            file_parts.append({"type": "file", "mime": mime or "image/png", "url": url})
                            clean_block = dict(block)
                            clean_info = dict(block.get("image_url") or {})
                            clean_info["url"] = f"[attached image ({mime or 'image'})]"
                            clean_block["image_url"] = clean_info
                            sanitized_blocks.append(clean_block)
                        else:
                            sanitized_blocks.append(block)
                    clean_msg = dict(message)
                    clean_msg["content"] = sanitized_blocks
                    sanitized_history.append(clean_msg)
                else:
                    sanitized_history.append(message)

            payload = {"model": {"providerID": provider, "modelID": model}, "agent": "cindy-bridge", "tools": tool_flags,
                       "system": system, "parts": [{"type": "text", "text": json.dumps({"conversation": sanitized_history}, ensure_ascii=False)}]}
            payload["parts"].extend(file_parts)
            effort = request.get("reasoning_effort")
            if effort and effort != "none":
                if not match or effort not in match.get("efforts", []):
                    raise BridgeError(400, "unsupported_effort", "This model does not declare the requested OpenCode variant.")
                payload["variant"] = effort
            # Subscribe before sending, so the first output token cannot be missed.
            conversation.stream = self.stream_open(conversation)
            threading.Thread(target=self._events, args=(conversation,), daemon=True).start()
            threading.Thread(target=self._run, args=(conversation, payload), daemon=True).start()
            return conversation
        except Exception:
            self._close(conversation)
            raise

    def _events(self, conversation):
        part_types = {}
        try:
            with conversation.stream as response:
                for event in sse_events(response):
                    if conversation.closed.is_set():
                        return
                    props = event.get("properties", {})
                    part = props.get("part") or {}
                    info = props.get("info") or {}
                    session_id = props.get("sessionID") or part.get("sessionID") or info.get("sessionID")
                    if session_id != conversation.session_id:
                        continue
                    kind = event.get("type")
                    if kind == "message.part.updated":
                        part_types[part.get("id")] = part.get("type")
                    elif kind == "message.part.delta" and props.get("field") == "text":
                        key = "reasoning_content" if part_types.get(props.get("partID")) == "reasoning" else "content"
                        conversation.events.put(("delta", {key: props.get("delta", "")}))
        except (OSError, ValueError):
            # The blocking prompt request remains authoritative for completion/errors.
            pass

    def _run(self, conversation, payload):
        try:
            result = self.request_json(f"/session/{conversation.session_id}/message", conversation, payload)
            info = (result or {}).get("info", {})
            if info.get("error"):
                error = info["error"]
                data = error.get("data") if isinstance(error.get("data"), dict) else {}
                upstream = data.get("statusCode")
                # Pass the provider's own reason (credits, bad schema, unknown model) so Cindy
                # does not report a client-side failure as "network unreachable"; bounded in size.
                detail = str(data.get("message") or error.get("name") or "unknown error")[:500]
                status = upstream if isinstance(upstream, int) and 400 <= upstream < 500 else 502
                raise BridgeError(status, "opencode_inference_failed", "OpenCode inference failed: " + detail)
            usage = None
            try:
                # Telemetry retrieval is optional; bound it to a short timeout (default 5s)
                # so an upstream delay on GET /session/.../message does not stall response completion.
                telemetry_timeout = min(self.timeout, float(os.environ.get("OPENCODE_TELEMETRY_TIMEOUT", 5.0)))
                messages = self.request_json(f"/session/{conversation.session_id}/message", conversation, timeout=telemetry_timeout)
                usage = usage_from_messages(messages)
            except Exception:
                pass
            # The completed response is authoritative, including output if SSE delivery lagged.
            conversation.events.put(("done", (result, usage)))
        except BridgeError as error:
            conversation.events.put(("error", error))
        except Exception:
            conversation.events.put(("error", BridgeError(502, "invalid_opencode_response", "OpenCode returned an invalid response.")))

    def mcp(self, token, request):
        with self.lock:
            conversation = self.conversations.get(token)
        if conversation is None or conversation.closed.is_set():
            raise BridgeError(404, "expired_relay", "Unknown or expired tool relay.")
        method, request_id = request.get("method"), request.get("id")
        if request_id is None:
            return None
        response = {"jsonrpc": "2.0", "id": request_id}
        if method == "initialize":
            response["result"] = {"protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
                                  "capabilities": {"tools": {}}, "serverInfo": {"name": "cindy-tool-relay", "version": "2.0.0"}}
        elif method == "ping":
            # Conforming MCP JSON-RPC ping requires result to be an empty object {}.
            response["result"] = {}
        elif method == "tools/list":
            response["result"] = {"tools": list(conversation.tools.values())}
        elif method == "tools/call":
            params = request.get("params", {})
            name, arguments = params.get("name"), params.get("arguments", {})
            if name not in conversation.tools or not isinstance(arguments, dict):
                response["error"] = {"code": -32602, "message": "Unknown tool or invalid arguments."}
                return response
            call = ToolCall(name, arguments)
            with self.lock:
                conversation.pending[call.id] = call
                self.calls[call.id] = conversation
            conversation.events.put(("tool", call))
            try:
                response["result"] = call.reply.get(timeout=self.timeout)
            except queue.Empty:
                response["result"] = {"content": [{"type": "text", "text": "Cindy tool result timed out."}], "isError": True}
                self._close(conversation)
        else:
            response["error"] = {"code": -32601, "message": "Method not found."}
        return response

    def _resume(self, request):
        tool_messages = []
        for message in reversed(request["messages"]):
            if message.get("role") != "tool":
                break
            tool_messages.insert(0, message)
        if not tool_messages:
            return None
        with self.lock:
            owners = {self.calls[m.get("tool_call_id")].token for m in tool_messages if m.get("tool_call_id") in self.calls}
            if not owners:
                # A stale relay call cannot be replayed as a new task.
                if any(str(m.get("tool_call_id", "")).startswith("call_bridge_") for m in tool_messages):
                    raise BridgeError(409, "expired_tool_call", "The bridge conversation expired. Start a new conversation.")
                return None
            if len(owners) != 1:
                raise BridgeError(400, "mixed_conversations", "Tool results belong to different conversations.")
            conversation = self.conversations[next(iter(owners))]
        if conversation.model != request["model"]:
            raise BridgeError(409, "model_changed", "A pending tool call must resume with the same model.")
        return conversation

    def chat(self, request, handler, models):
        if not isinstance(request, dict) or not isinstance(request.get("model"), str) or not request["model"]:
            raise BridgeError(400, "invalid_request", "A model ID is required.")
        if not isinstance(request.get("messages"), list) or not request["messages"] or not all(isinstance(m, dict) for m in request["messages"]):
            raise BridgeError(400, "invalid_request", "A nonempty messages array is required.")
        max_tokens = request.get("max_completion_tokens")
        if max_tokens is None:
            max_tokens = request.get("max_tokens")
        if max_tokens is not None and (not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens <= 0):
            raise BridgeError(400, "invalid_request", "max_tokens must be a positive integer.")
        self._reap()
        conversation = self._resume(request)
        if conversation is None:
            conversation = self._new(request, models)
        if not conversation.lock.acquire(blocking=False):
            raise BridgeError(409, "conversation_busy", "This conversation already has an active completion request.")
        for message in request["messages"]:
            call = conversation.pending.get(message.get("tool_call_id")) if message.get("role") == "tool" else None
            if call is not None and not call.resolved:
                content = message.get("content", "")
                text = content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                call.resolved = True
                call.reply.put({"content": [{"type": "text", "text": text}]})
        conversation.last_used = time.monotonic()
        stream = request.get("stream") is True
        started = False
        parts = []
        completion_id = "chatcmpl-" + uuid.uuid4().hex
        created = int(time.time())
        def chunk(delta=None, finish=None, usage=None):
            item = {"id": completion_id, "object": "chat.completion.chunk", "created": created, "model": request["model"],
                    "choices": [] if usage is not None else [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}
            if usage is not None:
                item["usage"] = usage
            handler.wfile.write(("data: " + json.dumps(item) + "\n\n").encode())
            handler.wfile.flush()
        def start():
            nonlocal started
            if stream and not started:
                handler.send_response(200)
                handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
                handler.send_header("Cache-Control", "no-cache")
                handler.send_header("Connection", "close")
                origin_header = handler._verify_origin() if hasattr(handler, "_verify_origin") else None
                if origin_header:
                    handler.send_header("Access-Control-Allow-Origin", origin_header)
                    handler.send_header("Vary", "Origin")
                handler.end_headers()
                handler.close_connection = True
                started = True
                chunk({"role": "assistant", "content": ""})
        try:
            deadline = time.monotonic() + self.timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BridgeError(504, "opencode_timeout", "OpenCode inference timed out.")
                if self._client_disconnected(handler):
                    self._close(conversation, abort=True)
                    return
                try:
                    kind, event = conversation.events.get(timeout=min(remaining, 0.25))
                except queue.Empty:
                    if self._client_disconnected(handler):
                        self._close(conversation, abort=True)
                        return
                    if remaining <= 0.25:
                        raise BridgeError(504, "opencode_timeout", "OpenCode inference timed out.") from None
                    continue
                if kind == "error":
                    raise event
                if kind == "delta":
                    parts.append(event)
                    if stream:
                        start()
                        chunk(event)
                    continue
                usage = None
                message = {"role": "assistant"}
                if kind == "tool":
                    message["content"] = "".join(p.get("content", "") for p in parts) or None
                    message["tool_calls"] = [{"id": event.id, "type": "function", "function": {
                        "name": event.name, "arguments": json.dumps(event.arguments, ensure_ascii=False)}}]
                    finish = "tool_calls"
                else:
                    result, usage = event
                    info = result.get("info", {})
                    if (conversation.tool_choice == "required" or isinstance(conversation.tool_choice, dict)) and not conversation.pending:
                        raise BridgeError(502, "tool_choice_not_honored", "OpenCode answered without the required tool call.")
                    result_parts = result.get("parts", [])
                    message["content"] = "".join(p.get("text", "") for p in result_parts if p.get("type") == "text")
                    reasoning = "".join(p.get("text", "") for p in result_parts if p.get("type") == "reasoning")
                    if reasoning:
                        message["reasoning_content"] = reasoning
                    finish = "length" if info.get("finish") == "length" else "stop"
                if stream:
                    start()
                    if kind == "tool":
                        call = message["tool_calls"][0]
                        chunk({"tool_calls": [{"index": 0, **call}]})
                    else:
                        # Flush only the suffix missed by SSE. Mismatches are protocol failures.
                        for key in ("content", "reasoning_content"):
                            emitted = "".join(p.get(key, "") for p in parts)
                            final = message.get(key, "")
                            if not final.startswith(emitted):
                                raise BridgeError(502, "stream_mismatch", "OpenCode stream disagrees with its completed response.")
                            if final[len(emitted):]:
                                chunk({key: final[len(emitted):]})
                    chunk(finish=finish)
                    if usage is not None:
                        chunk(usage=usage)
                    handler.wfile.write(b"data: [DONE]\n\n")
                    handler.wfile.flush()
                else:
                    result = {"id": completion_id, "object": "chat.completion", "created": created,
                              "model": request["model"], "choices": [{"index": 0, "message": message, "finish_reason": finish}]}
                    if usage is not None:
                        result["usage"] = usage
                    handler._send_json(200, result)
                if kind != "tool":
                    self._close(conversation, abort=False)
                return
        except BridgeError as error:
            self._close(conversation)
            if not started:
                raise
            handler.wfile.write(("data: " + json.dumps({"error": {"type": error.code, "message": str(error)}}) + "\n\n").encode())
            handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            if hasattr(handler, "close_connection"):
                handler.close_connection = True
            self._close(conversation, abort=True)
            return
        finally:
            conversation.last_used = time.monotonic()
            conversation.lock.release()
