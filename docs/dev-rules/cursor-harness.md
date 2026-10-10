# Cursor Agent ACP integration

Cursor is an additional native harness alongside Claude Code, Codex, and Pi. It is
not a Claude/Codex subprocess tool or a one-shot command wrapper.

## Setup and execution location

Install the official [Cursor CLI](https://cursor.com/docs/cli/installation), run
`agent login` on the computer that will execute the task, and restart Cindy after
installing the executable. Credentials remain in Cursor's native credential store.
Cindy never copies credentials, directly rewrites Cursor's global configuration,
installs Cursor automatically, or changes the native sandbox. Model/mode choices
use the advertised ACP APIs; native persistence remains owned by Cursor.

Desktop Settings → Model Providers offers Cursor in the add-provider wizard even
before native model discovery succeeds. Its setup step shows CLI installation and
terminal login instructions, then uses the existing native model-refresh API;
it does not start an OAuth flow or create a second connection. An installed Cursor
CLI stays visible in the settings rail while models are unavailable, with setup
instructions and a retryable refresh. The installation/login scan asks the CLI
for status and returns booleans only. The detail header identifies the Cursor
engine and shows a connected state only when its discovered source is ready.
Regression coverage: `addProviderWizardCursorEntry.test.tsx`,
`providersSectionDeepLink.test.tsx`, and `localCliDetect.test.ts`.

The desktop host discovers supported native executables and starts the exact
absolute executable with `acp`, in the task working directory. Mobile and another
desktop control that host through the existing device-link APIs. SSH execution,
device-hosted execution on a different work computer, and native transcript
export/import are not implemented and must fail explicitly rather than route to
another harness.

## Protocol and lifecycle

The implementation follows the [official Cursor ACP documentation](https://cursor.com/docs/cli/acp)
and [ACP v1](https://agentclientprotocol.com/protocol/v1/schema): UTF-8
newline-delimited JSON-RPC, initialize, native authentication, new/load, prompt,
streaming updates, request_permission, cancel. One live session owns one process.
A native session ID is persisted through the existing Cindy session_id event.
Loading suppresses native transcript replay because Cindy already has those
messages. Missing/unsupported session loading fails explicitly without replacing
or deleting saved history.

Control calls are bounded. Stop cancels pending interactions and sends the native
cancel notification. If the prompt does not settle, Cindy closes the process;
failed exit confirmation keeps the handle fenced and cleanup retryable. It must
not release MCP context or working-directory ownership before exit is confirmed.
Process frames and queued bytes are bounded; native stderr and RPC payloads are
not logged by the transport.

## Models and input

Models come from the actual ACP session's model config options (or advertised
legacy model state). `cursor-default` is only Cindy's route sentinel: it omits an
explicit model override and is never sent as a model ID. It remains accepted for
old saved tasks, but is absent from public catalogs and model pickers. After a
successful handshake, the handle exposes the actual native current model ID;
the admission-only alias still requires a connected, discovered Cursor source.
Shared source lookup resolves an old saved alias only for the built-in Cursor
provider with an advertised native default. It retains the saved route and
uses that default's label without inserting a picker row or guessing the saved
native session's effort/Fast state before the native handle is opened.
Model mutations use the advertised config ID and exact value. Native AUTO is
listed only when the CLI lists it. Unknown context windows remain unknown.
Cindy negotiates Cursor's native `_meta.parameterizedModelPicker` capability and
reads `cursor/list_available_models` to discover each offered model's parameter
options without selecting models or sending prompts. Older CLIs that do not
implement this optional extension retain their advertised model catalog.

Native grouped choices, descriptions, and offered order survive catalog
projection to desktop and mobile. Cursor's All view keeps Auto separate and
shows `Cursor Models` / `Other Models` within the Cursor source, instead of
flattening that source into generic recommendations. Native group names take
precedence. When ACP omits headings, `cursorModelGroups.ts` classifies only
offered IDs verified against Cursor's official usage-limits documentation
(2026-10-09); unknown first-party versions stay unclassified. This display
metadata never changes model membership, execution source, or routing. Auto may
consume either pool according to the selected model; headings do not promise
the eventual pool of Auto or subagent requests. Pool balances are not invented
from model-list data.

The existing desktop/mobile effort slider and Fast toggle use those native
per-model options. Standard effort values map only from advertised
`thought_level` choices; Fast uses the advertised `fast` config in `model_config`
(or its legacy `_model_config` category). Mutations retain the exact config ID
and offered value and consume the complete returned `configOptions`. Model
changes can replace the available controls. Unsupported values fail explicitly;
Auto and other fixed models do not receive simulated controls. Persisted settings
are reapplied before prompting on new/load and are not stripped by remote creation
or task recovery. Generic thinking switches and arbitrary extra parameters are
not synthesized. No model IDs with guessed bracket parameters are constructed.

Existing user context and a frozen Maker Memory index are included once with the
first user prompt, because ACP has no system-message API. Cursor's native system
instructions are unchanged. Cindy's Memory/tool bridge uses the existing
session-scoped HTTP MCP infrastructure. Cursor native subagents inherit the same MCP tools,
and ACP does not attest individual callers, so root/descendant provenance stays
unknown rather than claiming an attested root. Existing privileged collaboration
guards remain in force. Cindy-owned lead/worker creation, messaging and final-output
auto-reporting retain their existing host ownership checks. Direct native
`send_to_lead` is intentionally rejected without root-call attestation; the host
terminal-output bridge remains available. Failure to support required HTTP MCP is
reported, not silently dropped. Images are enabled only when advertised by the
CLI. The client does not advertise filesystem or terminal RPC implementations.

## Approval and extensions

Ask/Default, Auto-review, and Full access are implemented for native approval
requests. Ask/Default forwards them to Cindy's existing interaction resolver.
Auto-review uses the shared deterministic classifier and host reviewer against the
accepted user authorization; an unavailable reviewer produces the existing notice
and a marked confirmation card. Full access allows these requests directly. All
three return the exact advertised `allow_once`/`reject_once` option ID; native
persistent `allow_always` grants are never synthesized. A permission-mode change
re-evaluates pending tool approvals and invalidates stale automated decisions.
Stop/close cancels approvals even while review is running. Plan approval and
questions remain explicit in every permission mode.

Creation, task recovery, engine switching, device-link control, mobile preferences,
and Orca worker creation preserve supported selected permission modes. An
unsupported legacy mode is tightened to Ask on engine switching; existing Ask
choices and the interactive Cursor seed default are unchanged. No native global
configuration, sandbox, or persistent allowlist is rewritten.
Remote worker forms use the execution host's advertised permission subset, so
older Cursor hosts remain usable with Ask/Default.
Independent schedules use the same existing Full access default as other
harnesses so native approvals do not strand unattended work. Bound task heartbeats
retain the task's saved permission and plan mode.

Cursor's pre-existing native grants and policies remain authoritative, so this is
not an interception guarantee for every native tool. Cindy per-turn policies
requiring interception of every tool are explicitly unsupported. Restricted Reviewer and Bot runtime profiles are rejected
before native startup because their read-only/tool/Skill policy cannot be enforced
through the currently implemented ACP interface. Nonempty additional directory grants,
read-only Library roots, and pinned Skill invocations are likewise rejected rather
than silently ignored. Ordinary working-directory-only tasks remain supported.

Blocking `cursor/create_plan` and `cursor/ask_question` requests always receive a
response. Plan approval stays explicit and cannot be auto-resolved by a mode
change. Edited plans are rejected with the proposed edit because ACP cannot
represent acceptance of modified text. Desktop/mobile JSON multi-select answers
map to opaque native IDs; ambiguous labels, duplicate question prompts, and free
text are explicitly skipped rather than fabricated.

Partial tool updates merge by tool-call ID. Text/thinking, tool results and file
diff content use existing Cindy events. The native `cursor/task` extension is a
completion notification; it does not establish a controllable durable child, so
Cindy must not invent resume/stop handles from it. Reported context occupancy is
not converted into billable token usage or estimated subscription cost.

## Verification

Deterministic mock-process and transport fixtures cover framing, startup,
new/load, multi-turn streams, models, permissions, plan/question responses,
cancellation, failed cleanup retry, MCP identity/context, and protocol errors.
A real authenticated Cursor run on Windows/macOS/Linux and desktop/mobile visual
verification remain separate integration checks; mocks must not be described as
live CLI or UI verification. Existing Claude/Codex/Pi prompts and runtime pins are
not changed.

The transport interface/process-shutdown approach references the earlier closed
[PR #2386](https://github.com/makecindy/cindy/pull/2386); the integration is authored
against current main rather than cherry-picking that stale branch.

## Opt-in native smoke

With an officially installed CLI already authenticated by the user, run
`CINDY_CURSOR_TEST_BINARY=/absolute/path/to/agent node --import tsx scripts/smoke-cursor-acp.mts`.
Use the intended native `HOME` and XDG directories. The script never reads credentials.
It creates an isolated Git fixture, exercises short multi-turn/file/cancel/load requests,
and checks a synthetic authenticated loopback MCP handshake and bridge cleanup.
This consumes the selected account's model quota and is not part of CI. Workspace
file edits may be allowed natively without a permission callback; a successful edit
alone does not validate the approval UI. The synthetic MCP server does not validate
Memory semantics. The fixture is removed only after native process closure.

For execution environments that interrupt long jobs, an operator may resume a known
synthetic fixture using `CINDY_CURSOR_SMOKE_STATE` (a private JSON checkpoint with
`kind: "cindy-cursor-smoke-v1"`, `cwd`, and native `sessionId`) together with
`CINDY_CURSOR_SMOKE_STAGE=context|file|cancel`. Run only one process against a
checkpoint at a time. Segmented runs preserve the fixture and update only stage
results; remove it after all processes have closed. Never use an ordinary user
project or a real credential as a smoke fixture.
