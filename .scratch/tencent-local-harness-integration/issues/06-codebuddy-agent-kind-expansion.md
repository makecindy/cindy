# 06: Expand contracts for the CodeBuddy Harness kind

**What to build:** Cindy recognizes `codebuddy` as an append-only Harness kind
across task persistence, shared contracts, model selection, and cross-device
transport. Existing Claude Code, Codex, and Pi task behavior remains unchanged,
while older control clients receive a safe fallback instead of misclassifying
CodeBuddy as another Harness.

**Blocked by:** 01: Establish trusted local Harness runtime profiles.

**Status:** ready-for-agent

- [ ] Shared agent-kind contracts accept CodeBuddy without changing existing
      Claude Code, Codex, or Pi meanings.
- [ ] Persistence, usage, task input, and model-selection contracts can
      represent a CodeBuddy task without storing it as another Harness kind.
- [ ] Existing exhaustive branches handle CodeBuddy explicitly instead of
      falling through to Pi or a generic default.
- [ ] Older device-link and mobile clients can render readable CodeBuddy task
      content and status without exposing unsupported controls.
- [ ] Contract and migration tests prove append-only behavior for existing
      stored tasks and older control clients.
