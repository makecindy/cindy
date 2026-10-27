"""Explicit integration tier: real OpenCode + real HTTP/SSE/MCP, fixture model.

Protects the native tool-result roundtrip, per-response token propagation, and
upstream failure semantics. The Python unit tier cannot exercise the SDK/MCP
handshake. Minimal failure: one echo tool call followed by its tool result.
No credentials or real home/config/database are used. All model calls are local.
Run: python docs/examples/opencode-bridge/integration_bridge.py --opencode PATH
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import opencode_cindy_bridge as bridge
from opencode_transport import OpenCodeTransport


class ModelFixture(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    requests = []
    def log_message(self, *_): pass
    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            self.close_connection = True
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.requests.append(req)
        tools = [t['function']['name'] for t in req.get('tools', [])]
        relay = next((name for name in tools if name.endswith('_echo')), None)
        results = [m for m in req['messages'] if m.get('role') == 'tool']
        if req['model'] == 'fixture-error':
            body = json.dumps({'error': {'message': 'fixture-upstream-failed'}}).encode()
            self.send_response(400); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
            return
        delta = {'role': 'assistant', 'content': 'fixture final: ' + ('echo-marker' if results else 'hello')}
        finish = 'stop'
        if req['model'] == 'fixture-tools' and not results:
            if not relay:
                raise AssertionError('OpenCode did not expose the native MCP echo tool: ' + repr(tools))
            delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'fixture-call', 'type': 'function',
                     'function': {'name': relay, 'arguments': '{"value":"echo-marker"}'}}]}
            finish = 'tool_calls'
        if req.get('stream'):
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close'); self.end_headers(); self.close_connection = True
            for item in [
                {'id': 'fixture', 'object': 'chat.completion.chunk', 'model': req['model'], 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                {'id': 'fixture', 'object': 'chat.completion.chunk', 'model': req['model'], 'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
                 'usage': {'prompt_tokens': 11, 'completion_tokens': 7, 'total_tokens': 18, 'prompt_tokens_details': {'cached_tokens': 3}}},
            ]:
                self.wfile.write(('data: ' + json.dumps(item) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
        else:
            body = json.dumps({'id': 'fixture', 'object': 'chat.completion', 'model': req['model'],
                 'choices': [{'index': 0, 'message': delta, 'finish_reason': finish}],
                 'usage': {'prompt_tokens': 11, 'completion_tokens': 7, 'total_tokens': 18}}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)


def post(url, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as response:
        body = response.read().decode()
        if 'text/event-stream' in response.headers.get('Content-Type', ''):
            return [json.loads(line[6:]) for line in body.splitlines() if line.startswith('data: ') and line != 'data: [DONE]']
        return json.loads(body)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def run(executable, local_model=None):
    fixture = ThreadingHTTPServer(('127.0.0.1', 0), ModelFixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    port = free_port()
    with tempfile.TemporaryDirectory(prefix='cindy-bridge-integration-', ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        env = dict(os.environ)
        for key, subdir in [('HOME', 'home'), ('USERPROFILE', 'home'), ('XDG_CONFIG_HOME', 'config'),
                            ('XDG_DATA_HOME', 'data'), ('XDG_CACHE_HOME', 'cache'),
                            ('APPDATA', 'appdata'), ('LOCALAPPDATA', 'localappdata')]:
            path = root / subdir; path.mkdir(exist_ok=True); env[key] = str(path)
        env.pop('OPENCODE_SERVER_PASSWORD', None)
        env['OPENCODE_DISABLE_CLAUDE_CODE'] = '1'
        env['OPENCODE_DISABLE_EXTERNAL_SKILLS'] = '1'
        env['OPENCODE_DISABLE_AUTOCOMPACT'] = '1'
        model_names = [local_model] if local_model else ['fixture', 'fixture-tools', 'fixture-error']
        model_base = 'http://127.0.0.1:11434/v1' if local_model else f'http://127.0.0.1:{fixture.server_port}/v1'
        env['OPENCODE_CONFIG_CONTENT'] = json.dumps({'provider': {'bridge-fixture': {
            'npm': '@ai-sdk/openai-compatible', 'name': 'Bridge Fixture',
            'options': {'baseURL': model_base, 'apiKey': 'fixture-not-a-key'},
            'models': {name: {'name': name, 'limit': {'context': 16000, 'output': 4096}}
                       for name in model_names}}}, 'enabled_providers': ['bridge-fixture'], 'share': 'disabled'})
        process = subprocess.Popen([executable, 'serve', '--pure', '--hostname', '127.0.0.1', '--port', str(port)],
            cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        server = None
        try:
            for _ in range(200):
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/global/health', timeout=1) as response:
                        if response.status == 200: break
                except OSError:
                    if process.poll() is not None: raise RuntimeError('Isolated OpenCode exited during startup.')
                    time.sleep(0.1)
            else: raise RuntimeError('OpenCode did not become healthy.')
            bridge.TRANSPORT = OpenCodeTransport(f'http://127.0.0.1:{port}', timeout=180 if local_model else 40)
            bridge.OPENCODE_DB_PATH = str(root / 'data/opencode/opencode.db')
            # Fixture models never invoke discovery against the user's CLI home.
            bridge.get_cached_models = lambda: [{'id': 'bridge-fixture/' + name, 'provider': 'bridge-fixture',
                'name': name, 'context_window': 16000, 'max_output': 4096, 'supports_tools': True,
                'cost': {'input': 0, 'output': 0}} for name in model_names]
            server = bridge.ThreadedHTTPServer(('127.0.0.1', 0), bridge.OpenCodeBridgeHandler)
            bridge.TRANSPORT.callback_base = f'http://127.0.0.1:{server.server_port}'
            threading.Thread(target=server.serve_forever, daemon=True).start()
            if local_model:
                from smoke_bridge import run as smoke
                smoke(bridge.TRANSPORT.callback_base, 'bridge-fixture/' + local_model)
                return
            url = bridge.TRANSPORT.callback_base + '/v1/chat/completions'
            request = {'model': 'bridge-fixture/fixture', 'messages': [{'role': 'user', 'content': 'Say hello'}]}
            result = post(url, request)
            assert result['choices'][0]['message']['content'] == 'fixture final: hello', result
            assert result['usage']['prompt_tokens'] == 11, result
            assert result['usage']['prompt_tokens_details']['cached_tokens'] == 3, result
            print('PASS: real OpenCode nonstream usage + cached tokens', flush=True)
            result = post(url, {**request, 'stream': True})
            assert any(row.get('usage', {}).get('prompt_tokens') == 11 for row in result), result
            print('PASS: real OpenCode SSE usage', flush=True)
            request = {'model': 'bridge-fixture/fixture-tools', 'messages': [{'role': 'user', 'content': 'Use echo'}],
                       'tools': [{'type': 'function', 'function': {'name': 'echo', 'description': 'Echo a marker',
                          'parameters': {'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value']}}}]}
            result = post(url, request)
            assert result['choices'][0]['finish_reason'] == 'tool_calls', result
            message = result['choices'][0]['message']; call = message['tool_calls'][0]
            assert call['function']['name'] == 'echo', call
            assert json.loads(call['function']['arguments']) == {'value': 'echo-marker'}, call
            result = post(url, {**request, 'messages': request['messages'] + [message,
                {'role': 'tool', 'tool_call_id': call['id'], 'content': 'echo-marker'}], 'stream': True})
            assert not any('error' in item for item in result), result
            text = ''.join(row['choices'][0]['delta'].get('content', '') for row in result if row['choices'])
            assert text == 'fixture final: echo-marker', result
            assert any(row.get('usage', {}).get('prompt_tokens') == 22 for row in result), result
            print('PASS: native MCP tool call -> Cindy result -> final SSE + aggregate measured usage', flush=True)
            try:
                post(url, {'model': 'bridge-fixture/fixture-error', 'messages': [{'role': 'user', 'content': 'Fail'}]})
            except urllib.error.HTTPError as error:
                assert error.code >= 400, error.code
                body = json.load(error)
                assert 'error' in body, body
            else: raise AssertionError('Upstream failure was reported as success.')
            print('PASS: upstream inference error propagates as HTTP failure', flush=True)
        finally:
            if server:
                for conversation in list(bridge.TRANSPORT.conversations.values()):
                    bridge.TRANSPORT._close(conversation)
                server.shutdown(); server.server_close()
            process.terminate()
            process.wait(timeout=10)
            fixture.shutdown(); fixture.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--opencode', default=shutil.which('opencode.exe') or shutil.which('opencode'))
    parser.add_argument('--local-model', help='Opt-in real Ollama model on 127.0.0.1:11434; keeps OpenCode home isolated.')
    args = parser.parse_args()
    if not args.opencode: parser.error('Pass the OpenCode executable path.')
    run(args.opencode, args.local_model)
