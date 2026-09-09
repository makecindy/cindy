# Tencent Local Harness Integration

Status: ready-for-agent

## Problem Statement

Users who already authenticate through Tencent-provided local agent CLIs cannot
use those Harnesses inside Cindy without separately configuring a Cindy
Gateway, third-party API key, or external subscription. They must switch
between the terminal and Cindy, even though `tclaude`, `tcodex`, and CodeBuddy
already own valid authentication, model availability, and upstream routing.

The three CLIs do not share one implementation shape. Tclaude and tcodex are
runtime distributions of Claude Code and Codex respectively, while CodeBuddy
is an independent Harness with its own Agent Client Protocol. Treating them as
ordinary model providers, or treating CodeBuddy as Claude Code or Codex, would
break the native session, permission, tool, and event boundaries that Cindy
needs to present a reliable task experience.

## Solution

Integrate Tencent local Harnesses while preserving a single ownership boundary:

- Tclaude is a Tencent runtime distribution of the existing Claude Code
  Harness.
- Tcodex is a Tencent runtime distribution of the existing Codex Harness.
- CodeBuddy is a distinct `codebuddy` Harness connected through ACP v1.
- Tencent Harnesses own authentication, token refresh, model availability, and
  upstream routing.
- Cindy owns task lifecycle, workspaces, permissions, MCP, persistence,
  interaction, presentation, and cross-device task continuity.

The first delivery ships tclaude and tcodex together with formal advanced
Settings UI. Settings provide a default runtime distribution, while the model
selector permits a task-specific Tencent source override. CodeBuddy ACP is the
second delivery. A new CodeBuddy agent kind evolves cross-device contracts
append-only, with a safe fallback for older clients.

The feature is tested along four seams:

1. Runtime profile to Agent factory.
2. Harness protocol adapters.
3. Unified Session and Interaction behavior.
4. Cross-device safe fallback.

## User Stories

1. As a user authenticated with tclaude, I want to create a Tencent Claude
   Code task in Cindy, so that I do not need to configure another Anthropic API
   credential.
2. As a user authenticated with tcodex, I want to create a Tencent Codex task
   in Cindy, so that I can use the enterprise model catalog I already have.
3. As a user authenticated with CodeBuddy, I want to create a CodeBuddy task
   in Cindy, so that I can use its Agent Loop through Cindy's task experience.
4. As a user, I want to choose a local Tencent Harness executable in advanced
   Settings, so that Cindy can use the CLI installed on my machine.
5. As a user, I want Settings to show the executable identity, wrapper version,
   upstream version, and capability profile, so that I can diagnose why a
   runtime is unavailable.
6. As a user, I want to set a default Tencent runtime distribution, so that new
   tasks begin with my preferred local Harness.
7. As a user, I want to select a Tencent source for one task, so that I can
   override the global default without changing other tasks.
8. As a user, I want a task to retain its actual Harness-managed route, so that
   later Settings changes do not silently change an existing task.
9. As a user, I want an explicit Tencent route that becomes unavailable to stay
   visible, so that I know which route the task was using.
10. As a user, I want to explicitly switch an unavailable Tencent task to
    another source, so that I retain control over cost and data routing.
11. As a user, I do not want Cindy to automatically fall back from a Tencent
    route to another model source, so that an authentication problem cannot
    create unexpected charges or a different data path.
12. As a user, I want Tencent model choices to reflect the installed Harness's
    actual model catalog, so that I do not select a stale or unsupported model.
13. As a Claude Code user, I want streaming text, thinking, usage, and resume
    in Cindy, so that the GUI retains the useful native workflow.
14. As a Codex user, I want app-server model discovery, streaming events, and
    task history in Cindy, so that I can work without leaving the task.
15. As a CodeBuddy user, I want ACP text, thinking, tools, permissions, model
    selection, and mode selection in Cindy, so that CodeBuddy remains usable as
    a first-class Harness.
16. As a user, I want CodeBuddy to ask Cindy before a write action, so that
    rejecting the request prevents the file change.
17. As a user, I want CodeBuddy tasks to start with isolated local settings, so
    that my unrelated user and project MCP, Skill, plugin, and hook state does
    not silently expand a Cindy task's capabilities.
18. As a user, I want only Cindy-approved MCP servers mounted for a CodeBuddy
    task, so that I understand the tools available to the Harness.
19. As a user, I want a CodeBuddy task to restore its native history where the
    Harness supports it, so that task continuity is preserved.
20. As a user, I want old mobile and device-link clients to keep displaying
    CodeBuddy messages and status, so that a new Harness does not break task
    continuity.
21. As a user on an older control client, I do not want unsupported CodeBuddy
    creation or advanced controls exposed, so that I cannot trigger an action
    the client cannot safely represent.
22. As a Bot user, I do not want CodeBuddy to inherit ambient project or global
    resources by default, so that Bot isolation remains intact.
23. As a Review user, I do not want an unverified CodeBuddy isolation boundary
    presented as read-only review support, so that review safety is not
    overstated.
24. As a security-conscious user, I do not want Cindy to read, copy, persist,
    or display Tencent credentials, so that tokens remain owned by their
    Harness.
25. As a security-conscious user, I do not want a Renderer to choose an
    arbitrary executable at send time, so that local process execution stays
    within Main-owned approval.
26. As a maintainer, I want a capability profile bound to one executable
    identity, so that a wrapper update cannot inherit stale permissions.
27. As a maintainer, I want high-risk tcodex features disabled until their
    capability probes pass, so that basic protocol compatibility does not imply
    Review or fork compatibility.
28. As a maintainer, I want CodeBuddy's known resume debug stdout narrowly
    filtered with diagnostics, so that native resume works while unknown
    protocol contamination still fails closed.
29. As a maintainer, I want every local Harness process to stop within a bounded
    lifecycle, so that tasks do not leave orphaned processes or credential
    holders behind.
30. As a maintainer, I want fake protocol tests and real CLI smoke tests, so
    that wrapper upgrades reveal compatibility drift before release.

## Implementation Decisions

- A **Harness** is an Agent Loop, not a model provider. Tclaude and tcodex are
  runtime distributions of existing Harness adapters; CodeBuddy is a new
  Harness.
- A **Harness-managed route** is selected by a Tencent source and gives the
  local CLI exclusive ownership of upstream routing and authentication. Cindy
  must not inject its own provider endpoint, API key, OAuth token, or proxy
  routing into that route.
- Runtime distributions are represented by Main-owned runtime profiles. A
  profile includes a trusted launch plan, executable identity, route owner,
  auth owner, configuration-home policy, and a capability profile.
- Advanced Settings save the default runtime distribution. A task-specific
  Tencent source override is saved with the task's actual route and takes
  precedence over the default.
- The first delivery contains tclaude and tcodex together. It includes their
  formal advanced Settings UI, controlled executable selection, status,
  capability display, repair actions, default selection, and restore-default
  behavior.
- When an explicit Tencent route fails, Cindy retains it and exposes repair and
  explicit source-switch actions. It never selects a fallback route
  automatically.
- Tclaude reuses the existing Claude Code adapter and native session behavior.
  Its Tencent route never receives Cindy Claude provider/authentication
  environment variables.
- Tcodex reuses the existing Codex adapter and app-server protocol. It retains
  Cindy's isolated task home while Tencent owns the model provider and
  authentication.
- Tcodex support is capability-profile driven. The profile is probed from
  Settings, cached against executable identity, and invalidated when the
  identity changes. Unverified high-risk features remain unavailable.
- CodeBuddy is introduced as a new append-only agent kind and uses ACP v1 over
  stdio. Each Cindy session receives its own ACP process until shared-process
  lifecycle behavior is proven.
- CodeBuddy starts only with local settings, a strict MCP configuration, a
  Cindy-created minimal MCP roster, and the task's selected model. It does not
  inherit ambient user, project, or global CodeBuddy resources in the second
  delivery.
- CodeBuddy maps ACP session, prompt, update, permission, model, mode, load,
  and cancel messages into Cindy's existing session and interaction model.
- CodeBuddy permission requests fail closed. Unknown approval choices, resolver
  failures, and timeouts deny execution.
- CodeBuddy resume may filter only the observed
  `convertHistoryItemToAcp` debug stdout prefix and must emit a diagnostic.
  Every other non-JSON stdout line is a protocol error. The preferred long-term
  fix is for Tencent to move that debug output to stderr.
- CodeBuddy does not ship Bot, Review, Scheduler, Auto, fork, rewind,
  background tasks, or full mobile controls in its first delivery.
- The CodeBuddy agent kind evolves persistence and device-link contracts
  append-only. Older control clients use a **safe fallback**: readable task
  content and status without unsupported control.

## Testing Decisions

Tests should assert externally observable behavior at the highest available
seam, not the implementation details of a particular adapter class.

- The runtime profile to Agent factory seam verifies default selection,
  task-specific override, restore default, executable identity invalidation,
  explicit-route failure, and no automatic fallback.
- The tclaude protocol seam reuses existing Claude query tests and verifies
  that Harness-managed execution omits Cindy provider/authentication
  injection.
- The tcodex protocol seam reuses existing app-server transport and session
  tests to verify model discovery, runtime roots, plugin/Skill configuration,
  capability profile gating, and confirmed shutdown.
- The CodeBuddy protocol seam validates ACP envelopes, line limits, stdout
  purity, lifecycle, session creation, streaming updates, permission
  acceptance and rejection, load replay, mode/model changes, and cancel.
- The unified Session and Interaction seam verifies that messages, tools,
  permission UI, stop, error, usage, and native session identity behave like
  other Cindy Harnesses.
- The cross-device seam verifies that older clients safely render CodeBuddy
  content while withholding unsupported control.
- Existing Claude Code stream, Codex app-server, Pi JSONL, interaction
  resolver, provider catalog, local session, and device-link compatibility
  tests are the prior art and preferred test infrastructure.
- Real CLI smoke tests run in temporary workspaces, never read or write
  credentials, and cover only the protocol capabilities exposed by the
  corresponding candidate feature.

## Out of Scope

- Importing, copying, migrating, or sharing Tencent credentials.
- A generic arbitrary-executable integration mechanism.
- SSH remote execution for Tencent local Harnesses.
- Ambient CodeBuddy user/project settings, Skills, plugins, hooks, or MCP
  inheritance.
- CodeBuddy Bot, Review, Scheduler, Auto, fork, rewind, or background task
  support.
- Full CodeBuddy mobile/device-link controls.
- Automatic route fallback from a Tencent source to another model source.
- Lenient handling of unknown non-JSON CodeBuddy stdout.

## Further Notes

The three local CLI primary paths have already been validated against their
real protocols. The remaining work is implementation and regression
validation, not open-ended feasibility exploration. Candidate features must
remain explicitly classified as MVP, probe-gated, upstream dependency,
deferred, or unsupported before they are exposed to users.
