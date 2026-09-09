# 09: Deliver CodeBuddy cross-device safe fallback

**What to build:** A CodeBuddy task remains readable and safely controllable
across device-link and Mobile clients even when a control client does not yet
implement the full CodeBuddy interaction surface. Older clients can read task
content, status, and terminal outcomes but cannot invoke unsupported
CodeBuddy-specific operations.

**Blocked by:** 06: Expand contracts for the CodeBuddy Harness kind; 07: Implement the isolated CodeBuddy ACP session adapter.

**Status:** ready-for-agent

- [ ] Device-link transports CodeBuddy task identity, messages, and state
      without breaking older clients.
- [ ] Older clients receive a safe fallback with readable content and status.
- [ ] Unsupported CodeBuddy creation, model selection, Skill, fork, and
      advanced controls are withheld from clients that lack capability support.
- [ ] Stop behavior remains available where the existing remote session control
      contract supports it.
- [ ] Cross-device compatibility tests cover new and old control-client
      behavior.
