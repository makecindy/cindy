# Tencent local Harness boundaries

> Status: accepted

Cindy will integrate `tclaude` and `tcodex` as runtime distributions of the
existing Claude Code and Codex adapters, while CodeBuddy remains a distinct
`codebuddy` Harness connected through ACP. The first delivery must ship
`tclaude` and `tcodex` together with their formal advanced Settings UI;
CodeBuddy ACP follows as a second delivery. Settings provide a global default,
while a task can explicitly select a Tencent source as an override. All
Tencent routes are Harness-managed: Tencent CLIs own authentication and
upstream routing, while Cindy owns task lifecycle, permissions, MCP,
persistence, and presentation. An explicit Tencent route never automatically
falls back; it remains visible and offers an explicit switch to another
available source. Older device-link and mobile clients must use a safe
read-only fallback for the new CodeBuddy agent kind.

The first CodeBuddy delivery always uses isolated local settings and Cindy's
minimal MCP configuration. CodeBuddy resume may narrowly filter the currently
observed `convertHistoryItemToAcp` debug stdout lines, with diagnostics, until
Tencent moves those lines to stderr; all other non-JSON stdout remains a
protocol error. Tcodex capabilities are cached by executable identity after a
Settings-time probe and invalidated when the identity changes.
