# 02: Integrate tclaude as a Harness-managed Claude Code runtime

**What to build:** A user who selects Tencent Claude Code can run the existing
Claude Code task experience through local `tclaude`, including streaming
messages, thinking, usage, native session resume, Cindy MCP, and Cindy
permission interaction. Tencent owns model authentication and upstream routing;
Cindy retains the task, workspace, interaction, and presentation boundaries.

**Blocked by:** 01: Establish trusted local Harness runtime profiles.

**Status:** ready-for-agent

- [ ] A Tencent Claude route launches the selected tclaude runtime distribution
      through the existing Claude Code adapter.
- [ ] The route does not inject Cindy Claude provider endpoints, API keys,
      OAuth tokens, proxy routing, or provider-managed-host environment flags.
- [ ] Standard Cindy Claude task behavior remains available for streaming,
      usage, native session identity, stop, resume, MCP, and permissions.
- [ ] A task-specific Tencent Claude route remains distinct from a
      Cindy-managed Claude Code route.
- [ ] A failed explicit Tencent Claude route reports repairable state and does
      not silently use another model source.
- [ ] Real CLI smoke coverage verifies the Harness-managed route and the
      absence of Cindy provider/authentication injection.
