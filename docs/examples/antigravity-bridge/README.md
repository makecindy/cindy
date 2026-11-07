# Antigravity (agy) bridge example

Local OpenAI-compatible bridge (`127.0.0.1:11436`) that reuses the Google
Antigravity CLI login (`agy`, Windows Credential Manager `gemini:antigravity`)
and forwards `/v1/chat/completions`, `/v1/models` and `/v1/quota` to Cloud Code
Assist. Point a Cindy OpenAI-compatible provider at `http://127.0.0.1:11436/v1`.

```
python agy_cindy_bridge.py          # AGY_BRIDGE_PORT, AGY_ACCOUNT_EMAIL optional
python test_bridge.py               # offline unit tests
python e2e_bridge.py gemini-3.8-flash   # live: chat, schema, tool call
```

## Tool schema sanitization

Gemini accepts only its `Schema` subset in `function_declarations`. Any other
field anywhere in a tool's parameters (for example `"encrypted"` emitted by some
MCP tools) fails the whole request with HTTP 400
`Unknown name "encrypted" at 'request.tools[0].function_declarations[N]...'`,
so every turn errors even when no tool is used. `sanitize_schema` therefore
allow-lists Gemini fields (`GEMINI_SCHEMA_PASSTHROUGH_KEYS`) instead of
deny-listing known-bad ones, collapses nullable `anyOf`, maps `const` to `enum`,
and drops `required` names that are not declared properties.
