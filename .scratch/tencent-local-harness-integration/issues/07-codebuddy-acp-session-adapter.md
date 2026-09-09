# 07: Implement the isolated CodeBuddy ACP session adapter

**What to build:** Cindy can create a CodeBuddy task through ACP v1 with an
isolated local Harness environment. Users receive stream updates, thinking,
tool cards, permissions, model and mode changes, cancellation, and native
session load through the same Cindy session and interaction surfaces used by
other Harnesses.

**Blocked by:** 06: Expand contracts for the CodeBuddy Harness kind.

**Status:** ready-for-agent

- [ ] Each CodeBuddy task launches an isolated ACP stdio process with local
      settings, strict MCP configuration, a Cindy-provided minimal MCP roster,
      and the selected model.
- [ ] ACP session creation, prompt, load, model change, mode change, cancel,
      update, permission, and terminal response behavior is translated into
      Cindy's session contract.
- [ ] Tool calls preserve stable identifiers, status, user-visible details,
      and terminal results.
- [ ] Permission requests fail closed on timeout, unknown option, malformed
      request, or resolver failure.
- [ ] CodeBuddy load replays native history into Cindy messages.
- [ ] The known resume debug stdout prefix is narrowly filtered with a
      diagnostic; any other non-JSON stdout is a protocol error.
- [ ] Process lifecycle tests prove bounded close and error settlement.
