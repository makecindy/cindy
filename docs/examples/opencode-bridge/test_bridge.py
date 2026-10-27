"""Regression tests for the public bridge entry points.

Protects the reviewed bugs: unknown/paid prices becoming zero, incompatible SQLite
queries, missing/wrong usage buckets, and false-success errors. No existing Cindy
suite executes this external Python bridge. Unit fixtures use no real home/config.
Run: python -m unittest discover -s docs/examples/opencode-bridge -p test_bridge.py
"""
import importlib.util
import io
import json
import os
import pathlib
import sqlite3
from contextlib import closing
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import opencode_cindy_bridge as bridge
from opencode_transport import BridgeError, Conversation, OpenCodeTransport, usage_from_messages
import start_bridge


class Handler:
    def __init__(self):
        self.wfile = io.BytesIO()
        self.status = None
        self.json = None
        self.headers = {}
    def send_response(self, status): self.status = status
    def send_header(self, key, value): self.headers[key] = value
    def end_headers(self): pass
    def _verify_origin(self): return bridge.OpenCodeBridgeHandler._verify_origin(self)
    def _send_json(self, status, obj):
        self.status, self.json = status, obj
        bridge.OpenCodeBridgeHandler._send_json(self, status, obj)


class BridgeTests(unittest.TestCase):
    def test_cost_boundaries_preserve_zero_without_manufacturing_prices(self):
        self.assertEqual(bridge.model_cost({'input': 12, 'output': 30, 'cache': {'read': 0, 'write': 2}}),
                         {'input': 12, 'output': 30, 'cacheRead': 0, 'cacheWrite': 2})
        for value in [None, [], {}, {'input': True, 'output': '2', 'cacheRead': -1, 'cacheWrite': float('inf')}]:
            self.assertEqual(bridge.model_cost(value), {})

    def test_configured_prices_and_namespaced_duplicates(self):
        config = {'provider': {'one': {'models': {'same': {'cost': {'input': 12, 'output': 30}}}},
                               'two': {'models': {'same': {}}}}}
        with patch.object(bridge, 'opencode_command', return_value=['fixture']), \
             patch.object(bridge, 'load_opencode_config', return_value=config), \
             patch.object(bridge.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = ''
            models = bridge.discover_dynamic_models()
        by_id = {m['id']: m for m in models}
        self.assertEqual(by_id['one/same']['cost'], {'input': 12, 'output': 30})
        self.assertEqual(by_id['two/same']['cost'], {})

    def test_modern_sqlite_readonly_and_honest_windows(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'fixture.db'
            with closing(sqlite3.connect(path)) as conn:
                conn.execute('CREATE TABLE session(cost REAL, tokens_input INT, tokens_output INT, '
                             'tokens_cache_read INT, tokens_cache_write INT, tokens_reasoning INT, time_updated INT)')
                conn.execute('INSERT INTO session VALUES (1.5, 100, 20, 30, 40, 5, 50000)')
                conn.commit()
            before = path.read_bytes()
            stats = bridge.get_opencode_stats(path, now_ms=50000)
            self.assertTrue(stats['available'])
            self.assertEqual(stats['tokens_input'], 100)
            self.assertEqual(stats['tokens_cache_write'], 40)
            self.assertEqual(stats['total_cost'], 1.5)
            self.assertEqual(stats['recently_updated_sessions'], {'5h': 1, '7d': 1})
            self.assertEqual(path.read_bytes(), before)
            with patch.object(bridge, 'get_opencode_stats', return_value=stats):
                quota = bridge.build_quota_payload()
            self.assertEqual(quota['windows'], [])
            self.assertFalse(quota['quota_available'])

    def test_unsupported_schema_is_unavailable_not_measured_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'fixture.db'
            with closing(sqlite3.connect(path)) as conn:
                conn.execute('CREATE TABLE session(id TEXT)')
            self.assertEqual(bridge.get_opencode_stats(path)['reason'], 'unsupported_schema')

    def test_usage_sums_steps_cache_and_reasoning(self):
        messages = [{'info': {'role': 'assistant', 'time': {'completed': 1}, 'tokens': {
            'input': 100, 'output': 20, 'reasoning': 5, 'cache': {'read': 30, 'write': 40}}}},
            {'info': {'role': 'assistant', 'finish': 'stop', 'tokens': {'input': 1, 'output': 2}}},
            {'info': {'role': 'user', 'tokens': {'input': 999}}}]
        result = usage_from_messages(messages)
        self.assertEqual(result['prompt_tokens'], 171)
        self.assertEqual(result['completion_tokens'], 27)
        self.assertEqual(result['total_tokens'], 198)
        self.assertEqual(result['prompt_tokens_details']['cached_tokens'], 30)
        self.assertIsNone(usage_from_messages([{'info': {'role': 'assistant', 'tokens': {'input': 0}}}]))
        self.assertIsNone(usage_from_messages([{'info': {'role': 'assistant', 'finish': 'stop', 'tokens': {}}}]))

    def test_completed_stream_contains_measured_usage(self):
        transport = OpenCodeTransport('http://unused', request_json=lambda *args: None)
        conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'auto')
        conversation.events.put(('delta', {'reasoning_content': 'Think'}))
        conversation.events.put(('delta', {'content': 'Hel'}))
        usage = {'prompt_tokens': 123, 'completion_tokens': 45, 'total_tokens': 168}
        conversation.events.put(('done', ({'info': {'finish': 'stop'}, 'parts': [
            {'type': 'text', 'text': 'Hello'}, {'type': 'reasoning', 'text': 'Think'}]}, usage)))
        handler = Handler()
        with patch.object(transport, '_new', return_value=conversation):
            transport.chat({'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Hi'}], 'stream': True}, handler, [])
        chunks = [json.loads(line[6:]) for line in handler.wfile.getvalue().decode().splitlines()
                  if line.startswith('data: ') and line != 'data: [DONE]']
        self.assertEqual([c['usage'] for c in chunks if 'usage' in c], [usage])
        self.assertEqual(''.join(c['choices'][0]['delta'].get('content', '') for c in chunks if c['choices']), 'Hello')
        self.assertEqual(chunks[-2]['choices'][0]['finish_reason'], 'stop')

    def test_errors_before_and_after_stream_start_are_not_success(self):
        for after_start in (False, True):
            with self.subTest(after_start=after_start):
                transport = OpenCodeTransport('http://unused', request_json=lambda *args: None)
                conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'auto')
                if after_start:
                    conversation.events.put(('delta', {'content': 'Partial'}))
                conversation.events.put(('error', BridgeError(502, 'upstream_failure', 'Failed')))
                handler = Handler()
                with patch.object(transport, '_new', return_value=conversation):
                    if after_start:
                        transport.chat({'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Hi'}], 'stream': True}, handler, [])
                        self.assertIn('"error"', handler.wfile.getvalue().decode())
                        self.assertNotIn('"finish_reason": "stop"', handler.wfile.getvalue().decode())
                    else:
                        with self.assertRaises(BridgeError) as raised:
                            transport.chat({'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Hi'}]}, handler, [])
                        self.assertEqual(raised.exception.status, 502)
                        self.assertIsNone(handler.json)

    def test_inference_error_keeps_provider_reason_and_client_status(self):
        cases = [({'name': 'APIError', 'data': {'message': 'insufficient_credits', 'statusCode': 402}}, 402, 'insufficient_credits'),
                 ({'name': 'APIError', 'data': {'message': 'overloaded', 'statusCode': 503}}, 502, 'overloaded'),
                 ({'name': 'ProviderModelNotFoundError'}, 502, 'ProviderModelNotFoundError')]
        for error, status, detail in cases:
            with self.subTest(status=status):
                transport = OpenCodeTransport('http://unused', request_json=lambda *args, **kw: {'info': {'error': error}})
                conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'auto')
                transport._run(conversation, {})
                kind, raised = conversation.events.get_nowait()
                self.assertEqual(kind, 'error')
                self.assertEqual(raised.status, status)
                self.assertIn(detail, str(raised))

    def test_client_disconnect_aborts_opencode_before_first_delta(self):
        aborted = False
        def mock_request(path, conversation, body=None, method=None, timeout=None):
            nonlocal aborted
            if "/abort" in path:
                aborted = True
            return {}

        transport = OpenCodeTransport('http://unused', request_json=mock_request)
        conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'auto', session_id='ses_123')
        handler = Handler()
        handler.disconnected = True
        with patch.object(transport, '_new', return_value=conversation):
            transport.chat({'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Hi'}], 'stream': True}, handler, [])
        self.assertTrue(aborted)
        self.assertTrue(conversation.closed.is_set())

    def test_client_disconnect_aborts_nonstreaming_call(self):
        aborted = False
        def mock_request(path, conversation, body=None, method=None, timeout=None):
            nonlocal aborted
            if "/abort" in path:
                aborted = True
            return {}

        transport = OpenCodeTransport('http://unused', request_json=mock_request)
        conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'auto', session_id='ses_123')
        handler = Handler()
        handler.disconnected = True
        with patch.object(transport, '_new', return_value=conversation):
            transport.chat({'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Hi'}], 'stream': False}, handler, [])
        self.assertTrue(aborted)
        self.assertTrue(conversation.closed.is_set())

    def test_socket_disconnect_detection_aborts_active_turn(self):
        import socket
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.bind(('127.0.0.1', 0))
        server.listen(1)
        port = server.getsockname()[1]

        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.connect(('127.0.0.1', port))
        conn, _ = server.accept()
        server.close()

        handler = Handler()
        handler.connection = conn

        aborted = False
        def mock_request(path, conversation, body=None, method=None, timeout=None):
            nonlocal aborted
            if "/abort" in path:
                aborted = True
            return {}

        transport = OpenCodeTransport('http://unused', request_json=mock_request)
        conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'auto', session_id='ses_123')

        client.close()

        with patch.object(transport, '_new', return_value=conversation):
            transport.chat({'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Hi'}], 'stream': True}, handler, [])

        conn.close()
        self.assertTrue(aborted)
        self.assertTrue(conversation.closed.is_set())

    def test_completed_tool_history_does_not_prevent_new_user_turn(self):
        transport = OpenCodeTransport('http://unused')
        self.assertIsNone(transport._resume({'model': 'fixture', 'messages': [
            {'role': 'tool', 'tool_call_id': 'call_bridge_old', 'content': 'Result'},
            {'role': 'assistant', 'content': 'Done'}, {'role': 'user', 'content': 'Next'}]}))
        with self.assertRaises(BridgeError):
            transport._resume({'model': 'fixture', 'messages': [
                {'role': 'tool', 'tool_call_id': 'call_bridge_old', 'content': 'Result'}]})

    def test_native_mcp_result_returns_only_to_its_own_conversation(self):
        transport = OpenCodeTransport('http://unused', request_json=lambda *args: None)
        conversations = [Conversation(token, '/fixture', 'fixture', {
            'echo': {'name': 'echo', 'inputSchema': {'type': 'object'}}}, 'auto')
            for token in ('one', 'two')]
        replies = {}
        workers = []
        calls = []
        for conversation in conversations:
            transport.conversations[conversation.token] = conversation
            worker = threading.Thread(target=lambda c=conversation: replies.update({c.token: transport.mcp(c.token,
                {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'echo', 'arguments': {'value': c.token}}})}))
            worker.start()
            workers.append(worker)
            kind, call = conversation.events.get(timeout=1)
            self.assertEqual(kind, 'tool')
            calls.append(call)
        self.assertNotEqual(calls[0].id, calls[1].id)
        try:
            with self.assertRaises(BridgeError):
                transport._resume({'model': 'fixture', 'messages': [
                    {'role': 'tool', 'tool_call_id': call.id, 'content': 'mixed'} for call in calls]})
            self.assertFalse(any(call.resolved for call in calls))
            for conversation, call in zip(conversations, calls):
                conversation.events.put(('done', ({'info': {'finish': 'stop'}, 'parts': [
                    {'type': 'text', 'text': conversation.token}]}, None)))
                handler = Handler()
                transport.chat({'model': 'fixture', 'messages': [
                    {'role': 'tool', 'tool_call_id': call.id, 'content': conversation.token}]}, handler, [])
                self.assertEqual(handler.json['choices'][0]['message']['content'], conversation.token)
        finally:
            for conversation in conversations:
                transport._close(conversation)
            for worker in workers:
                worker.join(timeout=1)
        self.assertEqual(replies['one']['result']['content'][0]['text'], 'one')
        self.assertEqual(replies['two']['result']['content'][0]['text'], 'two')

    def test_text_json_never_becomes_an_executed_tool_call(self):
        transport = OpenCodeTransport('http://unused', request_json=lambda *args: None)
        conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'required')
        conversation.events.put(('done', ({'info': {'finish': 'stop'}, 'parts': [
            {'type': 'text', 'text': '{"name":"echo","arguments":{"value":"fake"}}'}]}, None)))
        with patch.object(transport, '_new', return_value=conversation):
            with self.assertRaises(BridgeError) as raised:
                transport.chat({'model': 'fixture', 'messages': [{'role': 'user', 'content': 'Use echo'}]}, Handler(), [])
        self.assertEqual(raised.exception.code, 'tool_choice_not_honored')
        self.assertEqual(conversation.pending, {})

    def test_capacity_rejection_leaves_no_temp_directories(self):
        transport = OpenCodeTransport('http://unused', request_json=lambda *args: None)
        for i in range(32):
            transport.conversations[f'slot_{i}'] = Conversation(f'slot_{i}', f'/tmp/{i}', 'model', {}, 'auto')
        before = set(pathlib.Path(tempfile.gettempdir()).glob('cindy-opencode-*'))
        with self.assertRaises(BridgeError) as raised:
            transport._new({'model': 'fixture', 'messages': [{'role': 'user', 'content': 'hi'}]}, [])
        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(raised.exception.code, 'bridge_busy')
        after = set(pathlib.Path(tempfile.gettempdir()).glob('cindy-opencode-*'))
        self.assertEqual(after - before, set())

    def test_usage_fetch_failure_still_returns_completed_reply(self):
        call_count = 0
        def mock_request(path, conversation, body=None):
            nonlocal call_count
            call_count += 1
            if body is not None:
                return {'info': {'finish': 'stop'}, 'parts': [{'type': 'text', 'text': 'Completed successfully'}]}
            raise BridgeError(502, 'opencode_http_error', 'Transient network glitch during usage fetch')

        transport = OpenCodeTransport('http://unused', request_json=mock_request)
        conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'auto', session_id='ses_123')
        transport._run(conversation, {'model': {'providerID': 'opencode', 'modelID': 'fixture'}, 'parts': []})
        kind, (result, usage) = conversation.events.get_nowait()
        self.assertEqual(kind, 'done')
        self.assertEqual(result['parts'][0]['text'], 'Completed successfully')
        self.assertIsNone(usage)

    def test_telemetry_fetch_bounds_timeout_and_does_not_stall(self):
        recorded_timeouts = []
        def mock_request(path, conversation, body=None, timeout=None):
            recorded_timeouts.append(timeout)
            if body is not None:
                return {'info': {'finish': 'stop'}, 'parts': [{'type': 'text', 'text': 'Done'}]}
            raise TimeoutError("Simulated upstream telemetry stall")

        transport = OpenCodeTransport('http://unused', timeout=300, request_json=mock_request)
        conversation = Conversation('fixture', '/fixture', 'fixture', {}, 'auto', session_id='ses_123')
        transport._run(conversation, {'model': {'providerID': 'opencode', 'modelID': 'fixture'}, 'parts': []})
        kind, (result, usage) = conversation.events.get_nowait()
        self.assertEqual(kind, 'done')
        self.assertEqual(result['parts'][0]['text'], 'Done')
        self.assertIsNone(usage)
        self.assertEqual(recorded_timeouts, [None, 5.0])

        # Test custom OPENCODE_TELEMETRY_TIMEOUT override
        recorded_timeouts.clear()
        with patch.dict(os.environ, {'OPENCODE_TELEMETRY_TIMEOUT': '1.5'}):
            transport._run(conversation, {'model': {'providerID': 'opencode', 'modelID': 'fixture'}, 'parts': []})
            self.assertEqual(recorded_timeouts, [None, 1.5])

    def test_concurrent_model_discovery_is_single_flight(self):
        discover_calls = 0
        def slow_discover():
            nonlocal discover_calls
            discover_calls += 1
            import time
            time.sleep(0.05)
            return [{"id": "fixture-model", "name": "Fixture", "cost": {"input": 0, "output": 0}}]

        with patch.object(bridge, "discover_dynamic_models", side_effect=slow_discover):
            with bridge.CACHE_LOCK:
                bridge.MODELS_CACHE["data"] = []
                bridge.MODELS_CACHE["ts"] = 0.0

            results = []
            threads = [threading.Thread(target=lambda: results.append(bridge.get_cached_models())) for _ in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(len(results), 5)
            self.assertEqual(discover_calls, 1)
            self.assertEqual(results[0][0]["id"], "fixture-model")

    def test_relay_tool_enablement_restricted_to_declared_tools(self):
        recorded_requests = []
        def mock_request(path, conversation, body=None, method=None):
            recorded_requests.append((path, body))
            if path == "/experimental/tool/ids":
                return ["builtin_bash", "cindy_extra_other", "cindy_my_tool"]
            if path == "/mcp":
                return {"cindy": {"status": "connected"}}
            if path == "/session":
                return {"id": "ses_456"}
            return {}

        transport = OpenCodeTransport("http://127.0.0.1:9999", request_json=mock_request, stream_open=lambda conv: io.BytesIO(b""))
        transport.callback_base = "http://127.0.0.1:9999"
        conv = transport._new(
            {
                "model": "test-model",
                "messages": [{"role": "user", "content": "hi"}],
                "tools": [{"type": "function", "function": {"name": "my_tool"}}],
            },
            [{"id": "test-model", "provider": "opencode"}],
        )
        try:
            session_call = next(body for path, body in recorded_requests if path == "/session")
            permissions = session_call["permission"]
            self.assertIn({"permission": "*", "pattern": "*", "action": "deny"}, permissions)
            self.assertIn({"permission": "cindy_my_tool", "pattern": "*", "action": "allow"}, permissions)
            allowed_perms = [p["permission"] for p in permissions if p.get("action") == "allow"]
            self.assertEqual(allowed_perms, ["cindy_my_tool"])
        finally:
            transport._close(conv, abort=False)

    def test_relay_tool_flags_disable_unrelated_mcp_namespaces(self):
        recorded_requests = []
        def mock_request(path, conversation, body=None, method=None):
            recorded_requests.append((path, body))
            if path == "/experimental/tool/ids":
                return ["builtin_bash", "cindy_extra_other", "cindy_my_tool"]
            if path == "/mcp":
                return {"cindy": {"status": "connected"}}
            if path == "/session":
                return {"id": "ses_456"}
            return {}

        transport = OpenCodeTransport("http://127.0.0.1:9999", request_json=mock_request, stream_open=lambda conv: io.BytesIO(b""))
        transport.callback_base = "http://127.0.0.1:9999"
        with patch("threading.Thread") as mock_thread:
            conv = transport._new(
                {
                    "model": "test-model",
                    "messages": [{"role": "user", "content": "hi"}],
                    "tools": [{"type": "function", "function": {"name": "my_tool"}}],
                },
                [{"id": "test-model", "provider": "opencode"}],
            )
            try:
                # Find the _run thread invocation
                run_call = next(call for call in mock_thread.call_args_list if call.kwargs.get("args") and len(call.kwargs["args"]) == 2)
                payload = run_call.kwargs["args"][1]
                self.assertFalse(payload["tools"]["builtin_bash"])
                self.assertFalse(payload["tools"]["cindy_extra_other"])
                self.assertTrue(payload["tools"]["cindy_my_tool"])
            finally:
                transport._close(conv, abort=False)

    def test_environment_resolves_relative_config_path(self):
        import os
        from pathlib import Path
        with patch.dict(os.environ, {"OPENCODE_BRIDGE_CONFIG": "relative/opencode.json"}):
            with tempfile.TemporaryDirectory() as tmp_state:
                env = start_bridge.environment(Path(tmp_state))
                expected = str(Path("relative/opencode.json").resolve())
                self.assertEqual(env["OPENCODE_BRIDGE_CONFIG"], expected)
                self.assertTrue(Path(env["OPENCODE_BRIDGE_CONFIG"]).is_absolute())

    def test_environment_resolves_relative_db_path(self):
        import os
        from pathlib import Path
        with patch.dict(os.environ, {"OPENCODE_BRIDGE_DB": "relative/telemetry.db"}):
            with tempfile.TemporaryDirectory() as tmp_state:
                env = start_bridge.environment(Path(tmp_state))
                expected = str(Path("relative/telemetry.db").resolve())
                self.assertEqual(env["OPENCODE_BRIDGE_DB"], expected)
                self.assertTrue(Path(env["OPENCODE_BRIDGE_DB"]).is_absolute())

    def test_close_deletes_bridge_owned_session(self):
        recorded_calls = []
        def mock_request(path, conversation, body=None, method=None):
            recorded_calls.append((path, body, method))
            return {}

        with tempfile.TemporaryDirectory() as tmpdir:
            transport = OpenCodeTransport("http://127.0.0.1:9999", request_json=mock_request)
            conv = Conversation("tok_del", tmpdir, "model", {}, "auto", session_id="ses_to_delete")
            transport.conversations["tok_del"] = conv
            transport._close(conv, abort=False)
            delete_calls = [(p, m) for p, b, m in recorded_calls if p == "/session/ses_to_delete" and m == "DELETE"]
            self.assertEqual(len(delete_calls), 1)

    def test_mcp_ping_returns_empty_json_object(self):
        transport = OpenCodeTransport("http://unused")
        conv = Conversation("tok_ping", "/tmp", "model", {}, "auto")
        transport.conversations["tok_ping"] = conv
        res = transport.mcp("tok_ping", {"jsonrpc": "2.0", "id": 99, "method": "ping"})
        self.assertEqual(res["result"], {})
        self.assertIsInstance(res["result"], dict)
        raw = json.dumps(res)
        self.assertIn('"result": {}', raw)
        self.assertNotIn('"result": "{}"', raw)

    def test_new_forces_sharing_disabled_in_opencode_config(self):
        transport = OpenCodeTransport("http://127.0.0.1:9999", request_json=lambda *a, **kw: {"id": "ses_1"}, stream_open=lambda conv: io.BytesIO(b""))
        transport.callback_base = "http://127.0.0.1:9999"
        conv = transport._new(
            {"model": "test-model", "messages": [{"role": "user", "content": "hi"}]},
            [{"id": "test-model", "provider": "opencode"}],
        )
        try:
            cfg = json.loads(pathlib.Path(conv.directory, "opencode.json").read_text(encoding="utf-8"))
            self.assertEqual(cfg.get("share"), "disabled")
            self.assertFalse(cfg.get("compaction", {}).get("auto"))
        finally:
            transport._close(conv, abort=False)

    def test_max_tokens_and_max_completion_tokens_mapped_to_opencode_config(self):
        transport = OpenCodeTransport("http://127.0.0.1:9999", request_json=lambda *a, **kw: {"id": "ses_1"}, stream_open=lambda conv: io.BytesIO(b""))
        transport.callback_base = "http://127.0.0.1:9999"

        # 1. Using max_tokens
        conv = transport._new(
            {"model": "test-model", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 128},
            [{"id": "test-model", "provider": "opencode", "context_window": 64000}],
        )
        try:
            cfg = json.loads(pathlib.Path(conv.directory, "opencode.json").read_text(encoding="utf-8"))
            self.assertEqual(conv.max_tokens, 128)
            self.assertNotIn("options", cfg["agent"]["cindy-bridge"])
            self.assertNotIn("options", cfg["provider"]["opencode"]["models"]["test-model"])
            self.assertEqual(cfg["provider"]["opencode"]["models"]["test-model"]["limit"]["output"], 128)
            self.assertEqual(cfg["provider"]["opencode"]["models"]["test-model"]["limit"]["context"], 64000)
        finally:
            transport._close(conv, abort=False)

        # 2. Using max_completion_tokens
        conv2 = transport._new(
            {"model": "custom_provider/custom_model", "messages": [{"role": "user", "content": "hi"}], "max_completion_tokens": 256},
            [{"id": "custom_provider/custom_model", "provider": "custom_provider", "context_window": 32000}],
        )
        try:
            cfg2 = json.loads(pathlib.Path(conv2.directory, "opencode.json").read_text(encoding="utf-8"))
            self.assertEqual(conv2.max_tokens, 256)
            self.assertNotIn("options", cfg2["agent"]["cindy-bridge"])
            self.assertEqual(cfg2["provider"]["custom_provider"]["models"]["custom_model"]["limit"]["output"], 256)
            self.assertEqual(cfg2["provider"]["custom_provider"]["models"]["custom_model"]["limit"]["context"], 32000)
        finally:
            transport._close(conv2, abort=False)

    def test_invalid_max_tokens_rejected_with_400(self):
        transport = OpenCodeTransport("http://127.0.0.1:9999", request_json=lambda *a, **kw: {"id": "ses_1"}, stream_open=lambda conv: io.BytesIO(b""))
        handler = Handler()
        for invalid in [-1, 0, "100", True, 3.14]:
            with self.subTest(invalid=invalid):
                with self.assertRaises(BridgeError) as raised:
                    transport.chat({"model": "test-model", "messages": [{"role": "user", "content": "hi"}], "max_tokens": invalid}, handler, [])
                self.assertEqual(raised.exception.status, 400)
                self.assertEqual(raised.exception.code, "invalid_request")

    def test_transport_shutdown_closes_all_active_conversations(self):
        closed = []
        transport = OpenCodeTransport("http://unused")
        with patch.object(transport, "_close", side_effect=lambda conv, abort=True: closed.append(conv.token)):
            transport.conversations["tok_1"] = Conversation("tok_1", "/tmp/1", "model", {}, "auto")
            transport.conversations["tok_2"] = Conversation("tok_2", "/tmp/2", "model", {}, "auto")
            transport.shutdown()
            self.assertEqual(set(closed), {"tok_1", "tok_2"})

    def test_stream_open_normalizes_connection_failures(self):
        transport = OpenCodeTransport("http://127.0.0.1:9999")
        conv = Conversation("tok_stream", "/tmp", "model", {}, "auto")
        with patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError("http://127.0.0.1:9999/event", 503, "Service Unavailable", {}, None)):
            with self.assertRaises(BridgeError) as raised:
                transport._stream_open(conv)
            self.assertEqual(raised.exception.status, 502)
            self.assertEqual(raised.exception.code, "opencode_http_error")

        with patch("urllib.request.urlopen", side_effect=OSError("Connection refused")):
            with self.assertRaises(BridgeError) as raised:
                transport._stream_open(conv)
            self.assertEqual(raised.exception.status, 502)
            self.assertEqual(raised.exception.code, "opencode_unavailable")

    def test_post_payload_size_boundaries(self):
        handler = Handler()
        handler.path = "/v1/chat/completions"
        handler.rfile = io.BytesIO(b"{}")
        # Oversized payload returns HTTP 413
        handler.headers = {"Content-Length": str(100 * 1024 * 1024)}
        bridge.OpenCodeBridgeHandler.do_POST(handler)
        self.assertEqual(handler.status, 413)
        self.assertEqual(handler.json["error"]["code"], "payload_too_large")

        # Zero length returns HTTP 400
        handler.headers = {"Content-Length": "0"}
        bridge.OpenCodeBridgeHandler.do_POST(handler)
        self.assertEqual(handler.status, 400)
        self.assertEqual(handler.json["error"]["code"], "invalid_request")

    def test_cors_blocks_untrusted_origins_and_permits_local_and_extension(self):
        handler = Handler()
        handler.headers = {"Origin": "https://malicious.website.com"}

        # Untrusted origin blocked on GET, POST, OPTIONS
        handler.path = "/v1/models"
        bridge.OpenCodeBridgeHandler.do_GET(handler)
        self.assertEqual(handler.status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", handler.headers)

        handler.path = "/v1/chat/completions"
        bridge.OpenCodeBridgeHandler.do_POST(handler)
        self.assertEqual(handler.status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", handler.headers)

        bridge.OpenCodeBridgeHandler.do_OPTIONS(handler)
        self.assertEqual(handler.status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", handler.headers)

        # Trusted origins allowed
        for trusted in ["http://localhost:3000", "http://127.0.0.1:8080", "vscode-webview://my-panel", "chrome-extension://abcdef"]:
            with self.subTest(trusted=trusted):
                h = Handler()
                h.headers = {"Origin": trusted}
                h.path = "/health"
                bridge.OpenCodeBridgeHandler.do_GET(h)
                self.assertEqual(h.status, 200)
                self.assertEqual(h.headers.get("Access-Control-Allow-Origin"), trusted)

                h2 = Handler()
                h2.headers = {"Origin": trusted}
                bridge.OpenCodeBridgeHandler.do_OPTIONS(h2)
                self.assertEqual(h2.status, 204)
                self.assertEqual(h2.headers.get("Access-Control-Allow-Origin"), trusted)

    def test_is_model_free_requires_all_chargeable_dimensions_to_be_zero(self):
        # Truly free models
        self.assertTrue(bridge.is_model_free({"input": 0, "output": 0}))
        self.assertTrue(bridge.is_model_free({"input": 0.0, "output": 0.0, "cacheRead": 0, "cacheWrite": 0}))

        # Cache pricing incurs charges: must not be treated as free
        self.assertFalse(bridge.is_model_free({"input": 0, "output": 0, "cacheRead": 0.5}))
        self.assertFalse(bridge.is_model_free({"input": 0, "output": 0, "cacheWrite": 1.2}))

        # Non-zero input/output or missing dimensions
        self.assertFalse(bridge.is_model_free({"input": 1.0, "output": 2.0}))
        self.assertFalse(bridge.is_model_free({"input": 0}))
        self.assertFalse(bridge.is_model_free({}))
        self.assertFalse(bridge.is_model_free(None))

    def test_cors_headers_emitted_on_streaming_responses(self):
        handler = Handler()
        trusted_origin = "http://localhost:3000"
        handler.headers = {"Origin": trusted_origin}

        transport = OpenCodeTransport("http://127.0.0.1:9999")
        conv = Conversation("tok1", "dir1", "m1", {}, None)
        conv.events.put(("delta", {"content": "hello"}))
        conv.events.put(("done", ({}, None)))

        with patch.object(transport, "_resume", return_value=conv), \
             patch.object(transport, "_client_disconnected", return_value=False), \
             patch.object(transport, "_close"):
            req = {"model": "m1", "messages": [{"role": "user", "content": "hi"}], "stream": True}
            transport.chat(req, handler, [{"id": "m1", "provider": "opencode"}])

        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.headers.get("Content-Type"), "text/event-stream; charset=utf-8")
        self.assertEqual(handler.headers.get("Access-Control-Allow-Origin"), trusted_origin)
        self.assertEqual(handler.headers.get("Vary"), "Origin")

    def test_image_data_url_attached_as_file_part_and_stripped_from_text_envelope(self):
        captured_payload = None
        def fake_run(conv, payload):
            nonlocal captured_payload
            captured_payload = payload

        transport = OpenCodeTransport("http://127.0.0.1:9999", request_json=lambda *a, **kw: {"id": "ses_1"}, stream_open=lambda conv: io.BytesIO(b""))
        img_data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        messages = [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image:"},
                {"type": "image_url", "image_url": {"url": img_data}}
            ]
        }]
        with patch.object(transport, "_run", side_effect=fake_run):
            conv = transport._new({"model": "test-model", "messages": messages}, [{"id": "test-model", "provider": "opencode"}])
            try:
                self.assertIsNotNone(captured_payload)
                parts = captured_payload["parts"]
                self.assertEqual(len(parts), 2)
                # Part 0 is text envelope: must contain the placeholder, NOT the raw base64 string
                self.assertEqual(parts[0]["type"], "text")
                self.assertIn("[attached image (image/png)]", parts[0]["text"])
                self.assertNotIn("iVBORw0KGgo", parts[0]["text"])

                # Part 1 is the actual file attachment with the data URL
                self.assertEqual(parts[1]["type"], "file")
                self.assertEqual(parts[1]["mime"], "image/png")
                self.assertEqual(parts[1]["url"], img_data)
            finally:
                transport._close(conv, abort=False)

        with self.assertRaises(BridgeError) as raised:
            transport._new({"model": "test-model", "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "ftp://example.com/bad.png"}}]
            }]}, [{"id": "test-model", "provider": "opencode"}])
        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.code, "unsupported_image")

    def test_concurrent_empty_model_discovery_shares_cached_result(self):
        discover_calls = 0
        def slow_empty_discover():
            nonlocal discover_calls
            discover_calls += 1
            import time
            time.sleep(0.05)
            return []

        with patch.object(bridge, "discover_dynamic_models", side_effect=slow_empty_discover):
            with bridge.CACHE_LOCK:
                bridge.MODELS_CACHE["data"] = []
                bridge.MODELS_CACHE["ts"] = 0.0

            results = []
            threads = [threading.Thread(target=lambda: results.append(bridge.get_cached_models())) for _ in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(len(results), 5)
            self.assertEqual(discover_calls, 1)
            self.assertEqual(results[0], [])

    def test_shutdown_endpoint_returns_200(self):
        handler = Handler()
        handler.path = "/shutdown"
        handler.headers = {"Content-Length": "2"}
        handler.rfile = io.BytesIO(b"{}")
        with patch.object(bridge.threading, "Thread"):
            bridge.OpenCodeBridgeHandler.do_POST(handler)
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.json, {"status": "shutting_down"})

    def test_stop_child_graceful_ipc_attempt(self):
        mock_child = unittest.mock.Mock()
        mock_child.poll.return_value = None
        with patch("urllib.request.urlopen") as mock_open:
            start_bridge.stop_child(mock_child, bridge_port=11437, timeout=1)
            self.assertTrue(mock_open.called)
            mock_child.wait.assert_called_with(timeout=1)


if __name__ == '__main__':
    unittest.main()
