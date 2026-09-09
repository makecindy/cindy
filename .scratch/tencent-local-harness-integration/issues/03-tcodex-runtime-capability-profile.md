# 03: Integrate tcodex as a capability-profiled Codex runtime

**What to build:** A user who selects Tencent Codex can run ordinary Cindy
Codex tasks through local `tcodex`, with Tencent model routing and
authentication but Cindy-owned task storage, isolated task home, model
projection, and app-server lifecycle. The runtime exposes only capabilities
that have been verified for its executable identity.

**Blocked by:** 01: Establish trusted local Harness runtime profiles.

**Status:** ready-for-agent

- [ ] A Tencent Codex route launches tcodex app-server through the existing
      Codex adapter and retains a Cindy-isolated task home.
- [ ] The route uses Tencent model routing without receiving Cindy Gateway,
      OAuth, custom-provider, or proxy-routing credentials.
- [ ] Ordinary tasks can use verified model discovery, streaming, usage,
      workspace roots, plugin and Skill configuration, and task teardown.
- [ ] Settings-time capability probes create an executable-identity-bound
      capability profile.
- [ ] Review, complex permission profiles, fork, remote compaction, and other
      high-risk features remain disabled unless their specific probes pass.
- [ ] Real app-server smoke coverage verifies the runtime's approved ordinary
      task capability set and confirmed shutdown.
