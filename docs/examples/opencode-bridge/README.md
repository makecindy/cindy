# OpenCode CLI bridge

This companion exposes OpenAI-compatible model discovery and chat endpoints for
the `opencode-cli` preset. It is separate from the OpenCode Zen cloud preset.
Requires Python 3.10+ and OpenCode on PATH; tested with OpenCode 1.19.4.

## Install and start

1. Install [OpenCode](https://opencode.ai/docs/) and configure the providers you
   want to use in OpenCode first. Verify `opencode models --verbose` works.
2. Download this entire directory. Keep `opencode_cindy_bridge.py`,
   `opencode_transport.py`, and `start_bridge.py` together.
3. In that directory run:

   ```sh
   python start_bridge.py
   ```

4. In Cindy, select **OpenCode CLI**, leave authentication empty, and use
   `http://127.0.0.1:11437/v1`. Refresh the model list and select a model that your
   OpenCode provider can actually call. Discovery does not prove account access.
5. Stop the launcher with Ctrl+C. It stops only the two processes it created.

The launcher starts a dedicated loopback OpenCode server on port 14782 and the
bridge on 11437. It refuses occupied ports instead of reusing or stopping another
process. It uses an isolated configuration/instruction profile, references the
existing provider configuration directly, and leaves native OpenCode credentials
and user configuration files in place. External plugins/skills and Claude prompt
imports are disabled for this server. Cindy supplies the instructions and tools.

Advanced environment variables, set **before** starting the launcher:

| Variable | Purpose |
| --- | --- |
| `OPENCODE_BRIDGE_PORT` | Bridge listener, default `11437` |
| `OPENCODE_SERVER_PORT` | Owned OpenCode listener, default `14782` |
| `OPENCODE_BRIDGE_CONFIG` | Existing OpenCode provider config JSON path |
| `OPENCODE_BRIDGE_DB` | Optional OpenCode telemetry database path, read-only |
| `OPENCODE_BRIDGE_STATE` | Dedicated server profile/work directory |
| `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` | Optional explicit server basic authentication |

The bridge understands standard JSON configuration, not JSONC-only local model
overrides. OpenCode's CLI remains authoritative for resolved model discovery.
For a manually managed server, start it in a dedicated empty directory with
`--pure`; use the launcher's isolation settings. Do not use a server attached to
an active coding project.

## Tools and context

Tools are relayed through native OpenCode MCP calls. The bridge returns OpenAI
`tool_calls`, suspends that MCP call, and resumes it only when Cindy supplies the
matching `tool_call_id` result. OpenCode's built-in tools are disabled for these
sessions; Cindy executes its own tools under its own permissions.

Conversation roles and tool IDs are retained in a JSON history envelope, system
instructions use OpenCode's system field, and image blocks use native file parts.
This is an adapter to the OpenCode session API, not a raw model-provider proxy.
Cindy owns context compaction; native automatic compaction is disabled here.

Pending calls are transient and expire after five minutes. Restarting the bridge
cannot resume them; the caller receives a conflict rather than a replayed task.
Use the same model when returning a tool result. A model that emits a JSON-looking
tool request as ordinary text has **not** called a tool. Required tool calls fail
explicitly in that case. Only declared OpenCode reasoning variants are accepted.

## Pricing and usage history

- `GET /v1/models` exports only declared finite, nonnegative USD-per-million-token
  prices in `discoveredCost`. Explicit zero is preserved; missing pricing is
  omitted. Configured paid models are not silently made free. Cindy needs the
  shared `discoveredCost` parsing support from PR #7164 to import these prices.
- Chat replies export actual OpenCode input/output/cache/reasoning counters.
  Streaming includes a final usage frame. Counts are not estimated from words.
  A completed tool roundtrip exports the session's aggregate usage once, avoiding
  double counting earlier pending tool responses. Unknown usage is omitted.
- Cindy's existing pricing/history pipeline uses those response counters and the
  connection's discovered prices. Prices are reference estimates, not invoices.
- `GET /v1/quota` exposes **global OpenCode telemetry**, explicitly labeled
  `opencode_all_sessions`. It is not Cindy-only history or a subscription quota.
  No token limits, reset dates, or remaining percentages are invented. Unsupported
  database schemas return an unavailable state. Database access is read-only.
- HTTP/upstream errors remain errors. Failures after streaming starts emit an SSE
  error and close the stream without a successful `stop` completion.

## Verify locally

Fast unit regressions (no network, credentials, or real user database):

```sh
python -m unittest discover -s . -p test_bridge.py -v
```

Protocol integration with a **real isolated OpenCode process** and a local fixture
model endpoint (HTTP, SSE, MCP, usage, and upstream errors):

```sh
python integration_bridge.py --opencode /absolute/path/to/opencode
```

Opt-in inference against an existing local Ollama model; requires Ollama already
running on `127.0.0.1:11434`. OpenCode config/auth/database remain isolated:

```sh
python integration_bridge.py --opencode /absolute/path/to/opencode --local-model qwen2.5:1.5b
```

For an already running bridge, this sends real prompts and a tool roundtrip:

```sh
python smoke_bridge.py --base-url http://127.0.0.1:11437 --model provider/model-id
```

Use a local/free model for smoke tests. Qwen 2.5 1.5B passed the native MCP
roundtrip locally; the tested custom Qwen 14B model emitted text JSON instead of
native tool calls and was rejected for a required-tool request. Provider metadata
does not guarantee that every configured model will honor tool requests.

## Update and rollback

Stop the launcher before updating. Back up the three runtime Python files and
any launch shortcuts, then replace them together. Roll back by restoring that
backup and restarting. No Cindy or OpenCode database migration is needed.
