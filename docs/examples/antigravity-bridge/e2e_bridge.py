"""Live end-to-end check against a running bridge: plain chat, tool schema with
fields Gemini rejects (the "encrypted" regression), and a forced tool call.
Usage: python e2e_bridge.py [model ...]   (needs agy login; AGY_BRIDGE_PORT optional)"""
import json
import os
import sys
import urllib.request

URL = f"http://127.0.0.1:{os.environ.get('AGY_BRIDGE_PORT', '11436')}/v1/chat/completions"
TOOLS = [{"type": "function", "function": {
    "name": "get_weather", "description": "Get weather for a city",
    "parameters": {"$schema": "http://json-schema.org/draft-07/schema#", "type": "object",
                   "additionalProperties": False,
                   "properties": {"city": {"type": "string", "encrypted": True},
                                  "unit": {"anyOf": [{"enum": ["c", "f"]}, {"type": "null"}], "default": "c"}},
                   "required": ["city"]}}}]


def call(model, prompt, tools=None):
    body = {"model": model, "stream": False, "messages": [{"role": "user", "content": prompt}]}
    if tools:
        body["tools"] = tools
    req = urllib.request.Request(URL, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.load(r)["choices"][0]["message"]
    except urllib.error.HTTPError as e:
        raise AssertionError(f"HTTP {e.code}: {e.read().decode()[:300]}")


def main(models):
    failed = 0
    for m in models:
        for name, fn in [
            ("chat", lambda: "OK" in (call(m, "Reply with exactly OK")["content"] or "").upper()),
            ("schema", lambda: call(m, "Reply with exactly OK", TOOLS) is not None),
            ("tool_call", lambda: any(t["function"]["name"] == "get_weather" for t in
                                      call(m, "Use get_weather for Paris. Call the tool now.", TOOLS).get("tool_calls") or [])),
        ]:
            try:
                ok = fn()
                print(f"{'PASS' if ok else 'FAIL'} {m} {name}")
            except Exception as e:
                ok = False
                print(f"FAIL {m} {name}: {e}")
            failed += not ok
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main(sys.argv[1:] or ["gemini-3.8-flash"])
