# TrueForge integration (experimental)

Cindy Desktop can use a user-managed TrueForge 0.1.x service as an experimental fourth agent
harness. Cindy does not download, launch, or update the service.

## Configure

Run TrueForge separately (TrueForge currently requires Node.js 22 or newer), then start Cindy with
both required environment variables:

```text
CINDY_TRUEFORGE_BASE_URL=http://127.0.0.1:8787
CINDY_TRUEFORGE_MODEL=openai/gpt-5
```

Optional variables:

```text
CINDY_TRUEFORGE_MODEL_DISPLAY_NAME=Team model
CINDY_TRUEFORGE_CONTEXT_WINDOW=128000
CINDY_TRUEFORGE_ID_TOKEN=<OIDC ID token>
```

The base URL must be an origin without `/api/v1`, credentials, query parameters, or a fragment.
Non-loopback endpoints must use HTTPS. Endpoint and model must be supplied together; partial
configuration fails closed instead of silently hiding the agent.

The optional ID token remains in the Electron main process and is passed only to the TrueForge SDK.
It is not returned through IPC or exposed to the renderer. Avoid putting credentials in the URL.

## First-release scope

- Desktop-local, ordinary chat sessions only.
- Text input, streamed text output, tool results, approvals, user questions, stop, and usage totals.
- One configured `provider/model` per Cindy process. Change the environment and restart Cindy to
  select a different model.
- TrueForge owns its agent instructions, tools, MCP configuration, sandbox, and approval policy.
  Cindy does not inject its Claude/Codex product prompt into the service.
- Dynamic TrueForge subagents are disabled for Cindy-created sessions so child-thread output cannot
  be confused with the main conversation.

Not supported in this first release: SSH or device-link sessions, mobile-created sessions,
worktrees, Goals, scheduling, collaboration/Orca, Cindy plan or effort controls, session fork/rewind,
extra directories, images/files, or local HTTP MCP bridging. TrueForge 0.1.3 streaming is not
resumable; an SSE disconnect ends the current Cindy turn with an error even if the remote service is
still finishing it.

This integration pins `@truefoundry/trueforge-sdk` to `0.1.3`; review the event and request contract
before upgrading it.
