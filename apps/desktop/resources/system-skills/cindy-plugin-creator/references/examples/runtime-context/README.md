# Runtime context development fixture

This minimal plugin uses only local synthetic data. It declares four runtime hooks and a static
system prompt fragment. It needs no API key, network access, tools or Agent of its own.

These capabilities are **unreleased**. `minCindyVersion: "0.0.0"` matches the development build
and is a fixture placeholder. Use a development build containing the runtime context controls.
Set the actual first supported release before publishing a plugin.

Pack the folder using `ghost_forge_pack`, inspect the five independent permission rows and
install the resulting `.cindy` package in a test profile. In a test task, open **Task plugins**
and select this plugin for the controls to verify. Installing alone does not select it.

Start normal new turns in the App. Personal IM, official hooks and same-turn steer do not
prepare these runtime controls or collect context. Existing App-started Pi turns keep their
request controls. The shared memory_search tool still uses the task's selected memory providers,
regardless of which entry started the message; changing entries does not erase existing context.

- The static system fragment appears after the native fixed system prefix; another task
  without the selection must have its original prompt bytes.
- The context marker is ordinary user-role reference material, separate from system instructions.
- With existing memory search enabled, `cindy_memory.memory_search` returns the inline memory
  marker with the Host's `sourcePlugin` attribution. Disabling the plugin keeps Cindy's results.
- Before-turn routing keeps the current available route, across Claude Code, Codex and Pi.
- On local Pi, every real model request keeps the current route and sets `max_tokens` to 256.
  Claude Code, Codex and remote Pi do not expose per-request interception.

The [control point reference](../../plugin-control-points.md) describes sizes, failure policies
and the exact engine/location support matrix. Do not use fixture memory as user data.
