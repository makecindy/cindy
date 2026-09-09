# 05: Ship Tencent Claude and Codex advanced Settings together

**What to build:** Users can configure, inspect, repair, and restore the
Tencent Claude Code and Tencent Codex runtime distributions through formal
advanced Settings. The first release opens both runtimes together only after
the end-to-end task behavior, capability profiles, and user-visible repair
paths are ready.

**Blocked by:** 04: Project Tencent Claude and Codex routes into task selection.

**Status:** ready-for-agent

- [ ] Advanced Settings supports controlled executable selection for Tencent
      Claude Code and Tencent Codex.
- [ ] Settings shows wrapper identity, upstream version where available,
      connection state, capability profile state, and repair guidance.
- [ ] Users can set a global default runtime distribution and restore the
      Cindy-managed default by deleting the override.
- [ ] Task selection supports an explicit Tencent source override without
      mutating the global default.
- [ ] The UI is localized and complete in Light and Dark modes.
- [ ] The release gate verifies that tclaude and tcodex are both ready; neither
      runtime is independently opened to users ahead of the other.
