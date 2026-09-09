# 04: Project Tencent Claude and Codex routes into task selection

**What to build:** Cindy presents Tencent Claude and Tencent Codex as
Harness-managed sources in task selection, using the local runtime's actual
model catalog. A task can explicitly override the global default source, and
the task persists its actual route without changing when Settings defaults
later change.

**Blocked by:** 02: Integrate tclaude as a Harness-managed Claude Code runtime; 03: Integrate tcodex as a capability-profiled Codex runtime.

**Status:** ready-for-agent

- [ ] Tencent Claude and Tencent Codex model projections expose only models
      available to their corresponding runtime distribution.
- [ ] Model metadata includes the available model identity and supported
      user-visible capabilities needed for selection.
- [ ] A task-specific source selection overrides the global runtime default and
      persists the actual Harness-managed route.
- [ ] An unavailable explicit Tencent route remains visible with repair and
      explicit-switch actions; it never automatically falls back.
- [ ] New-task defaults and existing-task route display remain correct across
      Settings changes and runtime identity invalidation.
- [ ] Provider and task-selection tests cover route persistence, model
      visibility, explicit override, and failure behavior.
