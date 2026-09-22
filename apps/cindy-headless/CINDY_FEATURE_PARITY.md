# Cindy to Headless feature parity

This inventory applies to Cindy Headless `0.4.2`, based on Cindy upstream commit
`e2089e1e0d9f6f5aceed73b1d3550656d5f72359`. A feature is considered available
only when the Headless CLI or Harbor adapter can exercise it; vendored source
alone is not sufficient.

## Upstream sync audit: 2026-09-20

Range: `14a7eea52703bc211f10d43b4b5af1658382899c..e2089e1e0d9f6f5aceed73b1d3550656d5f72359`.

| Classification | Upstream files / symbols | Headless impact and verification |
|---|---|---|
| COMPATIBLE | `agents/codex/index.ts`: host-operation leases, MCP refresh admission, reconnect/compaction settlement | Shared Core fixes apply directly; existing headless host, terminal, timeout and Codex tests cover the unchanged caller contract. |
| COMPATIBLE | `agents/pi/transport.ts`, `rpc-client.ts`, `session-jsonl-scan.ts`, `translator.ts` | Oversized JSONL recovery, local history scanning and event projection are inherited; verify Pi transport, RPC, translator and history tests alongside Headless regression tests. |
| COMPATIBLE | `base-agent.ts`, `session.ts`, three agent implementations: optional `toolsDisabled`, pinned Skill invocation, structured auto-review intent, Library read context | These are optional host-owned inputs. Headless retains its frozen Profile, container Full Access and approved Pi Skill path; it does not expose new switches or pretend to supply a Desktop policy proxy. |
| COMPATIBLE | `memory/manager.ts`: independent Bot scopes and legacy reset ownership | Headless uses isolated runtime state and project Memory; no Bot scope or global Desktop reset is exposed. Existing Headless Memory regression tests cover the current contract. |
| COMPATIBLE | `agents/pi/cindy-bridge-source.ts`: control-plane writes require explicit decisions | Inherited runtime policy remains in force; unattended profiles do not grant interactive changes to runtime control files. This is not a new capability. |
| UNSUPPORTED | Desktop `built-in-skills.ts`, account/catalog refresh, oversized-attachment continuation, remote transport, Library host integration | Desktop installation, interactive authorization, account/remote host lifecycle and recovery orchestration are not exposed by the Headless CLI. Core Skill discovery does not imply built-in Skill installation parity. |
| COMPATIBLE | `packages/model-providers`: Kimi K2.8 metadata/default effort, official Vertex/Azure endpoint matching and preset binding | Core catalog fixes are inherited; Headless keeps explicit profile model, effort, context and endpoint values. Verify model-provider tests; no new model choice is added to the benchmark registry. |
| COMPATIBLE | Shared prompt sources, `tools/{claude,codex,pi}/latest.json`, dependency lock | Shared production prompt templates and runtime version pins are unchanged. Dependencies use the merged frozen lock; prompt parity and formal bundle/distribution verification remain required. |
| UNSUPPORTED | Remaining Desktop/Mobile, device-link, UI, updater and packaging changes | Host-specific changes are retained in the checkout but do not become Headless benchmark capabilities. |

No Profile, capability catalog, artifact schema or Adapter contract change is
introduced by this patch release. Targeted validation uses `cindy-headless verify`
and the directly affected Maker Core agent/Memory tests. Formal archive and Linux
binary checks run through `package:release`; no live model benchmark is implied.

## Available in Headless

| Cindy capability | Claude Code | Codex | Pi | Headless evidence |
|---|---:|---:|---:|---|
| Multi-turn Maker session | Yes | Yes | Yes | `run --turns-file`, structured terminal events |
| Cindy production system prompt | Yes | Yes | Yes | Prompt parity tests against Desktop sources |
| Project context injection | Yes | Yes | Yes | Profile-controlled TOC injection |
| Cindy Maker Memory | Yes | Yes | Yes | In-process MCP for Claude; authenticated loopback MCP bridge for Codex and Pi |
| Model identity pinning | Yes | Yes | Yes | Frozen profile and identity artifacts |
| Explicit context-window pinning | Yes | Yes | Yes | Profile model metadata is passed to each harness context resolver |
| Explicit effort pinning | Yes | Yes | Yes | Production and generated profiles pin `high`; Pi rejects unsupported `ultra` |
| Abort, deadline, and bounded cleanup | Yes | Yes | Yes | Signal/deadline handling and result classification |
| Structured text, thinking, tool, status, and terminal events | Yes | Yes | Yes | Raw and normalized trace artifacts |
| Token, cache, context, and cost evidence | Yes | Yes | Yes | Backend-specific usage normalization |
| Container-sandboxed unattended execution | Yes | Yes | Yes | Formal profiles require `containerSandbox=true` |
| Pinned runtime supply chain | Yes | Yes | Yes | SHA-256 download pins and bundle validation; Pi validates its complete runtime tree |
| Workspace file/image attachments | Yes | Yes | Yes | Structured `--turns-file`; canonical workspace containment and size/count limits |
| Frozen remote HTTP MCP | Yes | Yes | Yes | Profile-pinned HTTPS/loopback endpoints; secret values supplied only through named environment variables |
| BYOM/native provider routing | No | No | Yes | Pi `models.json` native-provider route; exact provider/model/API metadata in the profile and artifacts |
| Approved project Skills | No | No | Yes | Profile allowlisted roots, Git-root/canonical-path checks, immutable per-session Pi snapshot, per-session denial of every unapproved in-repo Skill, revision/paths and the effective in-repo resource set in artifacts |

Pi is connected through its native RPC and `models.json` compatibility layer.
Headless does not translate Pi traffic through Claude Code. The bundled Pi
version is `0.85.1`; its complete runtime directory is required because the
standalone executable depends on sibling themes and native assets.

## Present in Maker Core but not exposed by the Headless CLI

These capabilities are available to Cindy Desktop through the same current
`maker-core`, but need a stable Headless command/artifact contract before they
can be claimed for benchmark runs:

- model and permission changes during a running task;
- fork, rewind, Pi session-tree navigation, and HTML export;
- manual compact and runtime extension/command discovery;
- managed Pi packages and runtime extensions;
- vision-bridge routing;
- Orca worker creation and subagent control APIs.

The `a28f9762..b91b78c5` audit identified two runtime candidates that still need
a separate Headless contract before parity can be claimed: Cindy-provider
Codex remote compaction/encrypted-context recovery, and the dynamic Pi gateway
model-catalog metadata surface (`thinkingLevelMap`, compatibility flags, and
sampling parameters). Codex native compaction remains available, but Headless
does not falsely advertise the Cindy proxy as active, so the Cindy-provider
recovery path is not configured. The current Pi gateway baseline is an explicit
Anthropic-Messages-compatible route; Pi BYOM uses exact API metadata from its
profile.

The `b91b78c5..abcf92c2b` audit classified the new Maker startup-cleanup
barriers, Git-normalized Memory scope resolution, per-session disabled-Skill
snapshots, Pi native package command handling, and Codex/Pi lifecycle fixes as
compatible internal runtime updates. Existing Headless profiles already pass
the required working directory, Memory, MCP, permission, and runtime inputs, so
no new profile field, capability switch, artifact field, or Adapter contract is
claimed for this release. Desktop account routing, routine triggers, worktree
recycling, and interactive approval presentation remain host-owned behavior.

The `abcf92c2b..14a7eea52` audit moved Pi project-resource handling into the
runtime itself: local root tasks now collect `<workspace>/.pi/skills`,
ancestor `.agents/skills` up to the Git root, `.pi/prompts/*.md`, and
`.pi/extensions` in place instead of a staged copy, and Pi reports a runtime
capability manifest. Headless therefore inspects the workspace itself before
every Pi run: Skills the profile did not approve are denied per session through
the runtime's disabled-Skill hook, the effective in-repo resource set
(`piProjectResources` in `identity.json` and `config.json`) is recorded, and the
Pi binary pin moves to `0.85.1`. The remaining upstream deltas are compatible:
Pi bot runtime profiles, Pi extension-UI capability export, Codex control-plane
external auth, and Claude provider-id plumbing are host-owned or unused by
Headless, and the Desktop/mobile commits since the previous baseline are not
runtime surface. Prompt templates and extensions have no Headless profile
field, so they are evidence-only: a frozen profile cannot forbid them, and the
artifact tells the reviewer exactly which ones the run received.

They remain fail-closed. Headless does not read a user's Desktop configuration,
Pi home, plugins, extensions, credentials, or approval state. In-repo Pi
project resources are loaded in place by the runtime, so Headless inspects them
first, denies unapproved project Skills, and records the exact set the run
received instead of leaving it implicit.

## Host-specific and intentionally excluded

The following require an Electron, mobile, account, device, or interactive UI
host and are not Headless runtime features:

- windows, renderer panels, tray, menus, notifications, voice input, and OS
  permission guides;
- login/account lifecycle, updater UI, analytics, and desktop settings stores;
- mobile UI, device-link control, IM presentation, and conversation sharing;
- plugin panels, OAuth/setup dialogs, media galleries, and user confirmation UI;
- browser/computer/phone UI control and local app integrations;
- SSH workspace management and Desktop-owned remote daemon lifecycle.

Headless Pi therefore supports only container-sandboxed
`bypassPermissions`. `ask` and `auto` are rejected because Harbor has no
interactive approval channel; accepting them would either hang or weaken the
Pi permission contract.

## Frozen production profiles

`cindy-production-pi` is the canonical Pi production baseline. It pins Pi
`0.85.1`, the production prompt digest, attachment policy, project Skill roots,
and an empty custom-MCP set. BYOM and custom MCP are supported profile fields,
but remain empty in this baseline so endpoint/tool changes cannot silently alter
scores. Create a separately named derived profile and freeze its profile digest
when evaluating either dimension.

`cindy-production-claude` is the Claude Code production baseline and is the
canonical meaning of “cindy-production-cc”. A second `cindy-production-cc`
profile is intentionally not created because two names for the same executable,
prompt, and policy would create ambiguous benchmark identity.

## Update rule

For each Cindy update, inspect `maker-core`, prompt sources, runtime pins,
Agent translators, usage events, and MCP contracts. Update this inventory and
add a contract test whenever a capability moves between categories. Historical
benchmark results remain immutable.
