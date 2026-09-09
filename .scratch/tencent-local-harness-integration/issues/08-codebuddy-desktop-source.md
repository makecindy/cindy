# 08: Expose CodeBuddy as a Desktop Tencent source

**What to build:** Desktop users can select and run the CodeBuddy Harness from
Cindy task selection and advanced Settings. The displayed model and permission
mode choices come from the active ACP session, and the runtime remains
Harness-managed without exposing or importing Tencent credentials.

**Blocked by:** 07: Implement the isolated CodeBuddy ACP session adapter.

**Status:** ready-for-agent

- [ ] Advanced Settings can configure and inspect the trusted CodeBuddy launch
      plan and its non-secret runtime status.
- [ ] CodeBuddy task selection exposes the ACP session's actual model and
      permission-mode choices.
- [ ] A CodeBuddy task persists its own agent kind and Harness-managed source.
- [ ] Explicit CodeBuddy route failures retain the selected route and offer
      repair or explicit source switching without automatic fallback.
- [ ] CodeBuddy Settings and selection UI are localized and complete in Light
      and Dark modes.
- [ ] Desktop integration tests cover new tasks, load, model/mode changes,
      permission rejection, cancellation, and route failure presentation.
