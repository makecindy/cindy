"""Opt-in smoke test against a running bridge and a real configured model.

Sends two inference requests, including an echo tool roundtrip. Does not read
credential files or change Cindy data. Choose a local/free model for this test.
"""
import argparse
import json
import urllib.request
import urllib.error


def request(base, path, payload=None):
    req = urllib.request.Request(base.rstrip('/') + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'})
    try:
        response = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as error:
        detail = json.load(error).get("error", {})
        raise RuntimeError(f"Bridge HTTP {error.code}: {detail.get('type')}: {detail.get('message')}") from None
    with response:
        raw = response.read().decode()
        if 'text/event-stream' in response.headers.get('Content-Type', ''):
            rows = [json.loads(line[6:]) for line in raw.splitlines()
                    if line.startswith('data: ') and line != 'data: [DONE]']
            assert not any('error' in row for row in rows), rows
            return rows
        return json.loads(raw)


def run(base, model):
    models = request(base, '/v1/models')['data']
    discovered = next((m for m in models if m['id'] == model), None)
    assert discovered is not None, 'Requested model was not discovered.'
    print('Discovery:', {'id': model, 'discoveredCost': discovered.get('discoveredCost')}, flush=True)
    messages = [{'role': 'user', 'content': 'Reply with the single word LOCAL_OK.'}]
    result = request(base, '/v1/chat/completions', {'model': model, 'messages': messages})
    assert result['choices'][0]['message']['content'].strip(), result
    assert result['usage']['total_tokens'] > 0, result
    print('PASS: real model nonstream; measured usage:', result['usage'], flush=True)
    messages = [{'role': 'user', 'content': 'Call the echo tool exactly once with value local-tool-marker, then answer with its result.'}]
    tools = [{'type': 'function', 'function': {'name': 'echo', 'description': 'Echo the supplied marker.',
        'parameters': {'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value']}}}]
    result = request(base, '/v1/chat/completions', {'model': model, 'messages': messages,
        'tools': tools, 'tool_choice': 'required'})
    assert result['choices'][0]['finish_reason'] == 'tool_calls', result
    assistant = result['choices'][0]['message']
    call = assistant['tool_calls'][0]
    assert call['function']['name'] == 'echo', call
    value = json.loads(call['function']['arguments'])['value']
    assert value == 'local-tool-marker', call
    rows = request(base, '/v1/chat/completions', {'model': model, 'messages': messages + [assistant,
        {'role': 'tool', 'tool_call_id': call['id'], 'content': value}], 'tools': tools, 'stream': True})
    text = ''.join(row['choices'][0]['delta'].get('content', '') for row in rows if row['choices'])
    assert 'local-tool-marker' in text, text
    usage = next(row['usage'] for row in rows if 'usage' in row)
    assert usage['total_tokens'] > 0, usage
    print('PASS: real model native MCP tool roundtrip + SSE; measured usage:', usage, flush=True)
    quota = request(base, '/v1/quota')
    assert quota['quota_available'] is False and quota['windows'] == [], quota
    print('PASS: telemetry is explicitly labeled; quota is not fabricated.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--model', required=True)
    args = parser.parse_args()
    run(args.base_url, args.model)
