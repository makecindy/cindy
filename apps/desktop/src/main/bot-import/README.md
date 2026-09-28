# Import one local agent as a teammate

`host.ts` is the single owner-scoped service for Desktop IPC, Mobile's existing
Remote Resource transport, and the `companion_import.import_agent` command.
Desktop IPC encodes stable import errors through `throwIpcError`; the form uses
the shared decoder to distinguish editable rejections from uncertain outcomes.
Mobile retains the existing Remote Resource error codes and retry behavior.
The command has `sources`, `preview`, `start`, and `status` operations. Callers
retain one `requestId` across reconnects and retries. Previews expose selectable
metadata, never source paths, environment values or credential contents.
Preview names and descriptions mask known credentials from the entire snapshot,
including unselected or conflicting accounts. Only the public projection changes;
private originals, stable selection IDs and dependency links remain intact.
Source discovery masks names from configuration, environment, connection and native
auth metadata, including skill credential settings. Discovery and name masking share
one 4 MiB metadata budget and request-local file/config cache across sources and
includes; neither reads cron databases, memory, portraits or skill resources.
Discovery config overflow reports the existing source-size error. Unreadable or
over-budget name metadata uses an opaque numbered label for an already discovered source. The selected
preview retains its full snapshot and normal error path. Discovery performs no writes.
Retained previews are limited to one per controller, four total and 128 MiB of
snapshot data combined. Oldest previews are evicted through the existing expired
preview flow. Recovery reads its durable checkpoint without caching another preview.
All command operations use the existing per-call approval policy. Discovery never
persists a native tool/server grant that could authorize a later `start` operation.
Auto still reviews the actual invocation; Full Access retains its normal behavior.

The creation UI reuses the existing teammate dialog/sheet and portrait picker.
Without source artwork, Desktop import follows normal creation: one random pick
from the existing 17 portraits per form, with subsequent user choices preserved.
After creation, personality, memory, skills and model management use the existing
teammate screens; routine management follows the desktop-only product contract.
Mobile can select automations during import and request host-owned takeover.
Reopening creation after dismissing import starts with the normal creation form;
reconnecting an open import preserves its current selection and request.
Import adds category/item selection, including
unselecting defaults; unused skills start unselected. Both platforms use semantic
theme tokens. No new native Mobile dependencies or fingerprint inputs are added.
Every supplied avatar uses the existing companion image validation before any
receipt or credential checkpoint is written. An empty supplied image is invalid;
omitting it retains normal companion defaults, and a rejected request can be corrected.

## Data and execution

- Hermes default/profile homes and OpenClaw's selected agent workspace are read
  independently. OpenClaw's current SQLite cron store takes precedence over the
  legacy JSON store; a database failure never substitutes a stale backup.
- Selected identity/user/instruction documents and memories retain their original
  text in the encrypted environment. Profile prompt fields and the native memory
  store receive copies with known selected env/MCP/auth credentials masked, while
  ordinary text stays unchanged. Env references and original credentials remain
  available to host execution; no model call or extra confirmation is added.
  Selected skill folders retain their
  real scripts, templates, executable bits and `SKILL.md`.
  Automation references match both the source directory slug and skill display
  name; referenced skill scripts contribute their environment dependencies.
  Hermes entry and monitor scripts select their entire directory subtrees,
  preserving sibling modules and resource paths in the encrypted snapshot.
  These files remain individually deselectable; deselecting a subtree dependency
  prevents that automation's takeover, leaving its source running. Helper code
  contributes environment dependencies and bounded verification planning text.
  A shared 128 MiB / 4096-file read budget bounds each source snapshot, including
  config includes, documents, credentials, scripts and all referenced skill trees.
  Additional selected skill resources use the same cumulative limit before any
  import writes. Exceeding it fails explicitly without truncation; the existing
  form unlocks on a definitive pre-import limit rejection. Fingerprints hash raw
  file bytes, and encrypted checkpoints use base64 while still reading legacy
  numeric-array checkpoints.
  Before the first receipt/checkpoint/profile write, selected skills also use the
  existing store validation: at most 100 skills and a 64 KiB SKILL.md entrypoint,
  measured after any publication guidance is appended. Invalid selections return
  the existing editable-form error without leaving a partial companion.
- Selected variables, MCP env/headers, source credentials and automation assets
  use the existing account encrypted credential store. The teammate folder has
  a non-secret `environment.json` binding. Variable/connection names in that file
  are opaque hashes; original names remain private. The entire `bot_environment_`
  namespace is Main-only: generic Renderer safeStorage read/store/remove reject it
  before resolving a path or touching the vault, including case variants and future
  suffixes. Normal provider/MCP credential settings keep their existing bridge.
  Large environments use
  atomically replaced, owner-scoped ciphertext files with bounded safeStorage
  chunks (64 Ki characters each), yielding between crypto calls and asynchronous
  disk operations. Encrypted batch/index/count/context metadata rejects mixed,
  reordered or truncated chunks. Large JSON encode/decode/hash work runs in a
  short-lived Node worker; checkpoint conversion yields between resource files
  and reuses already captured bytes when publishing the environment.
  Legacy single-value ciphertext and numeric-array snapshots remain readable;
  normal writes automatically use the chunked format. Legacy decryption itself
  remains synchronous until that first rewrite. This changes only the private
  companion namespace, not provider/renderer credential storage. Cancellation of a variable does not
  secretly copy its expanded value into another selected connection.
  Public profile/memory/Skill text and routine names/prompts redact all known
  source credentials, including unchecked accounts; memory titles use the same
  mask. Routine publication happens before createOnce persists the definition,
  and activation compares that same projection so masking does not block takeover.
  The encrypted checkpoint retains only masks actually matching selected source
  content, with stable labels for restart. These values were already embedded in
  selected originals; unrelated unchecked credentials/configurations are not
  retained. The private environment keeps these masks for later output redaction,
  never for subprocess env or connection authentication. Only selected credential
  entries are activated; selected original documents/automation definitions stay
  private and unmodified.
  Profiles supplying different values for one variable are alternatives in the
  existing checkboxes; none is guessed by file order. Picking one clears its
  conflicting choices, and group selection keeps an existing account choice.
  The host also rejects conflicting selections before creating a receipt. Variable
  dependencies resolve to the selected provider, so unchecking another account does
  not block takeover. Identical duplicate values remain compatible.
  Selected environment references use case-insensitive names on Windows and
  case-sensitive names on macOS/Linux, including nested MCP and delivery settings.
  Connection references resolve only from selected source entries, never from
  Cindy's process environment. Values absent from the source remain missing
  dependencies; a host-only variable is not offered as an importable credential.
  Ordinary companions without a binding or vault-only checkpoint need no cleanup
  writes or vault decryption. Deleting an imported companion stages a non-secret
  owner-scoped cleanup record before the
  database deletion, then removes credentials only after the deletion succeeds.
  If SQLite fails, the surviving profile retains its environment. If vault cleanup
  fails or the app exits after commit, the record survives outside the deleted
  companion folder; owner recovery checks that the profile is absent before retrying.
  Import passes and deletion share the existing profile lifecycle lock, including
  final checkpoint cleanup. Deletion joins the active pass and durably cancels its
  receipts before cleanup; old previews and restart reconciliation cannot recreate
  the removed companion or write its credentials back. Progress reads stay available
  during an active pass, and the lock releases between handover retry passes.
- Claude Code, Codex and Pi use the shared `companion_connections` bridge for
  imported skills, commands and data queries. Only those host-owned subprocesses
  and connections receive imported variables; the model harness does not inherit
  them. Values stay encrypted across restarts without changing Cindy's model route.
  Script, command, parser, source CLI and stdio MCP subprocesses inherit only OS execution
  basics plus their explicitly selected imported environment (and connection-local
  env). Unrelated launch tokens, proxy credentials and runtime injection variables
  are not implicitly inherited; selected proxy/runtime settings remain available.
  Codex hosts remain partitioned by companion environment identity.
  Before publishing a selected Skill, UTF-8 and BOM-marked UTF-16 text (including
  SKILL.md, scripts and reference resources) masks all known source credentials.
  Unchanged resources and binary assets retain their bytes. Affected skills keep
  their complete original resource tree in the encrypted environment after the
  restart checkpoint is cleared. Their readable SKILL.md points commands to the
  existing `run_command` bridge and its private `CINDY_IMPORTED_SKILLS/<slug>`
  directory, so embedded literals and sibling resources still work. Only an
  authorized command materializes those originals in a private temporary tree;
  success, failure and owner/cancellation unwinding remove that tree. Command cwd
  and generated outputs stay in the companion workspace; files written into the
  temporary resource tree are temporary too. Command output masks connection and
  native-auth credentials as well as imported environment values. No new tool,
  permission mode or UI is introduced. A hard process/OS crash may leave a private
  OS-temp directory; this is not a filesystem sandbox against authorized code.
  Stdio MCPs retain their configured working directory in the private snapshot
  and encrypted connection. Relative directories use the source Agent workspace;
  an omitted directory also uses that workspace. Environment references resolve
  only after selection, before anchoring relative paths. Discovery, takeover and
  runtime use the same directory, which must exist before launching the process;
  invalid directories never fall back to Cindy's launch directory. External MCP
  installations remain at their configured locations; their trees are not copied.
  `run_command` remains an authorized general command facility, with the existing
  companion workspace as its cwd; relative files and outputs use the same directory
  as the companion session. It retains the existing
  Auto/Ask/Full Access modes: Auto reviews the actual call against user intent,
  Ask confirms each invocation without a reusable server grant, and Full Access
  retains its normal behavior. Imported MCP tools use the same per-call policy:
  approving one connection's tool cannot grant access to another tool or connection
  through the shared bridge. No bridge-wide session grant is offered or persisted.
  Exact-value output masking reduces accidental
  disclosure; it does not sandbox arbitrary code or stop an authorized command
  from encoding, writing or sending credentials. Imported source content is not
  itself authority to disclose credentials. Replacing user scripts with a fixed
  operation allowlist is outside the approved migration behavior.
- Imported MCP discovery isolates unavailable servers and incomplete catalogs;
  healthy connections and independent commands remain available. Owner changes
  and cancellation still terminate discovery. Cached connections retain their
  owner check during idle time; an account change closes their credential-bearing
  subprocess/transport and removes the cache entry.
  After companion deletion commits, its runtime scopes are invalidated and all
  of its transports (idle, initializing and parallel) are closed before vault
  cleanup. A delayed scope cannot reopen them; another companion remains usable.
  A failed database deletion retains the profile's connections and credentials.
  Sequential calls reuse the cached connection. Overlapping calls use independent
  transports, including during initialization; cancellation or failure closes only
  that caller's transport. Temporary parallel connections close after completion.
  Takeover catalog discovery also isolates each unavailable optional connection;
  a plan selecting an absent tool still fails verification, and owner loss propagates.
  Public tool catalogs and takeover planning redact metadata/schema keys and string values
  against imported variables, connection-local env, resolved headers (including
  authorization payloads), and credential-bearing URL components, including
  encoded/decoded path segments. The same values
  are masked in tool responses. JSON Schema keywords and type syntax remain intact
  at schema positions; property/definition names and literal payload keys still
  use the credential mask, even when named like schema keywords. Names
  containing credentials use public aliases and resolve to original names only
  inside the host. The connection configuration itself is not modified.
  Required property names use the same masking as schema keys, and host dispatch
  restores schema-defined argument keys and exact aliases from enum/const/default/examples
  values only at their corresponding argument paths (including nested arrays)
  for runtime calls and verification probes. Names declared only in `required`,
  `dependentRequired` or legacy `dependencies` are restored on that object too,
  without requiring a matching `properties` entry. Conditional subschemas
  (`if`/`then`/`else`, `not`, `dependentSchemas` and legacy schema dependencies)
  contribute aliases at the same argument position, including dependency trigger
  names; upstream schema validation remains unchanged. `propertyNames` enum/const
  names also use the object's key mapping, including local references and composed
  schemas. Sibling free-text placeholders are
  not expanded even when they match an enum alias elsewhere. Business response/meta object keys are
  masked as well. MCP envelope keys (`content`, `structuredContent`, `isError`,
  `_meta`) and SDK-validated content/resource fields keep their protocol spelling;
  content types and audience/theme enums remain valid. Their text and structured
  payloads still use the credential mask, including identically named business keys.
  Bounded ordinary settings such as LANG=en, REGION=us, DEBUG=true, PORT=3000,
  LOG_LEVEL=info and NODE_ENV=production retain their content meaning, including
  when unchecked. Recognized booleans, port ranges and enums are configuration;
  arbitrary unknown variables and explicit auth values remain private. Other short values are masked as whole tokens, not substrings
  inside words such as "status"; explicitly configured header/URL credentials are
  still included even when they equal a locale value. Numeric data and schema
  types remain intact. Discovery, dispatch and verification share paginated tool
  listing with the same 100-page and 1000-tool catalog budgets.
- Cron/timezone, anchored intervals, one-time triggers, paused state and selected
  Hermes scripts/monitors/repeat counters feed the existing routine engine.
  Scheduler/companion `routine_save` schemas and the Pi direct facade retain
  `once.at` and `interval.anchorMs`, so editing a name or prompt preserves timing.
  Source-wide Hermes models and OpenClaw agent/default models use the existing
  model-mapping issue, just like a model specified on the job itself. Their
  routines remain disabled and the source keeps running until mapped; the import
  never silently substitutes Cindy's model during takeover.
  Finite-repeat routines stop after their last successful execution and delivery:
  disabling, clearing future triggers and cancelling queued followers commit
  with the final successful history entry. Failed result saves retry persistence
  without rerunning; recovery of an already exhausted counter also disables the
  routine. Ordinary unchanged-monitor skips remain eligible for the next trigger.
  Pure-script output appears in the canonical teammate chat. Explicit Telegram
  source destinations use the selected original bot credential; they do not
  change Cindy's official/personal bot implementations.
  Each confirmed target/message chunk advances progress in the same encrypted
  automation binding. A retry or next occurrence resumes the captured output and
  destinations before rerunning the model/script; counters commit only after all
  sends finish. This does not guarantee exactly-once delivery if Telegram accepts
  a message but its response or the subsequent local checkpoint is lost.

Copying and field conversion do not call a model. The optional takeover check
uses the teammate's current model to plan bounded read-only probes, then the
host executes real MCP/HTTP reads and validates response data. The planner sees
variable names and redacted task/script text and Skill/file identifiers, not credential values. HTTP checks
reject redirects; Telegram checks read identity/destination without test sends.
The MCP server's `readOnlyHint` only filters planning candidates; it does not
authorize execution. Each planned MCP/HTTP call and literal monitor GET uses the companion's existing
Auto/Ask/Full Access policy with its exact connection, tool and arguments. Auto
uses the shared permission reviewer with the host-owned takeover intent; Ask and
unavailable Auto review use the existing Desktop/Mobile confirmation route.
Neither remembered grants nor edited arguments are accepted for these probes.
The host checks evidence against all discovered read dependencies, including
transitive skill/MCP references. A successful MCP probe covers that connection
and its declared environment dependencies; a successful HTTP probe covers its
actual base variable and credential headers. Planner coverage claims and another
healthy source cannot substitute for an omitted or unavailable required source.
Only successful responses with the planned data shape count. Unreferenced optional
connections remain optional; already verified delivery-only dependencies stay separate.
Recognised ordinary locale/region settings do not need a separate read, unless
the source explicitly binds them as connection credentials.
Fresh companions can confirm before launching a harness. Account, task or
permission changes cancel pending approval and execution. A denied probe leaves
the source automation running and the imported routine disabled. This preserves
normal third-party connection trust; it does not prove a server implements its
advertised operation honestly or replace imported tools with a fixed allowlist.
Authenticated HTTP probes bind variables to origins in host code before planning:
explicit source MCP headers establish their configured origin, and conventional
service groups (DATA_URL/DATA_TOKEN, OPENAI_BASE_URL/OPENAI_API_KEY, or a single
BASE_URL/API_KEY group) bind only when the selected group has one origin. Merely
mentioning a credential and a URL in the same skill does not pair them. Ambiguous
or unknown bindings cannot send a private header; their selected values remain
stored and the existing result reports an unverified read. The planner receives
only the bound variable names and cannot move the credential to another origin.
HTTP base paths are opaque aliases in the plan. The host restores only the chosen
base's path prefix; using the alias unchanged preserves the configured URL and
query, while appended resources and ordinary relative paths remain supported.
Approval metadata masks encoded/decoded URL path and query credentials too.
Literal monitor_url dependencies always receive a separate host-owned GET of the
exact source URL before planning, with the runtime's 30-second / 2 MiB bounds and
no redirects. Text/HTML monitors are valid; unrelated reads cannot substitute for
a failed monitor. Only its verification status, not its raw URL, enters planning.
At runtime, monitor output masks the source URL, its path components, userinfo and
query values in encoded/decoded forms, even when they are absent from `.env`.
The same known-credential mask applies to prior output, legacy prepared retries,
script output, planning text and the final imported delivery boundary. Requests
still use the private original URL; redacted output retains normal change detection.
Verified delivery-only credentials are excluded from data-read dependencies, so
local reminders can retain their Telegram destination. Variables also referenced
by the task or its skills still require data verification.
Telegram destinations without an explicit source account bind only when exactly
one source account is available. Multiple candidates or a missing explicit account
use the existing `DELIVERY_NEEDS_ADAPTER` state and keep the source task running;
being able to reach a chat does not identify the intended sending bot.
For scripts classified as local-only with no data/connection dependency, the same
runtime interpreter parses the selected script without executing business actions.
This checks availability and syntax, not a full business execution; scripts with
external data still require actual read evidence.

## Handover and compatibility

An initial non-secret receipt indexes the request before any encrypted checkpoint
write. Recovery uses that index to clean a first vault write whose readback or
manifest publication failed, but only after confirming the binding and profile
are absent under the profile lock. Cleanup failures retain the same recovery
index; a committed binding/profile or an uncertain lookup is never discarded.
The encrypted selected snapshot, including full skill resources, is written
before the request is acknowledged or an item is copied. If the process stops after
the checkpoint but before its acknowledgement, startup scanning and same-request
retry discover it through that index. The durable receipt records item copies and
each automation's handover phase.
Acceptance also waits for profile creation. A definite creation-name conflict is
rechecked against the target ID before discarding its encrypted checkpoint and
manifest. A non-secret terminal receipt preserves the stable error across lost
acknowledgements; cleanup failures remain recoverable at startup or on retry.
Desktop and Mobile clear their immutable request/result on that rejection so the
existing name field can submit a corrected new request. A committed profile or
an uncertain database outcome never triggers this cleanup.
The target routine starts disabled. Actual target reads must pass before the
source's native CLI pauses its task; only then is the target enabled. Source
configuration changes invalidate handover. In-flight source execution is allowed
to finish before enabling the target. Lost acknowledgements are reconciled from
actual state; an ambiguous target enable never resumes the source as well.
Pause/resume first resolves the native CLI from absolute host PATH entries and
existing host installation locations; Windows batch launch resolves its interpreter
from host COMSPEC/SystemRoot. Selected PATH/COMSPEC cannot choose either executable.
The chosen child still receives OS basics, selected source variables and the
captured source directory/configuration. The shared child runner checks ownership
throughout execution and terminates the process tree on owner loss. An interrupted
pause retains its durable phase for reconciliation when the original owner returns;
it cannot enable the target under a different account.
An encrypted handover marker is installed before the target routine is published.
For active source tasks it becomes ready only after verification, source pause and
confirmed target activation. Ordinary editors and manual runs cannot bypass a
pending handover; already queued work defers without executing. Explicit enable
or run through the existing routine controls retries a transient failed takeover
from its saved selection, verifies again and reconciles the updated revision.
Changed definitions, missing dependencies and adapter requirements remain explicit
failures; an originally unrequested takeover is not silently authorized. Lost marker writes
keep the source paused for recovery. Already-paused source tasks remain disabled
but retain normal later management. Earlier completed receipts can restore missing
markers; failed checks or a skipped takeover of an active source cannot.
Retries preserve edits, reuse the same teammate/routines, and do not recopy
unselected items. Pending selected checkpoints are encrypted and recover after
restart; handover reconciliation continues if the dialog/device link closes.
A reconciliation batch makes at most three passes. Definitive failed verification
is not retried by background passes, status polling or startup; after the bound,
the result needs attention and requires an explicit retry. Current receipts avoid
decrypting full environments on status/startup reads; legacy marker upgrades run
once. This bounds repeated model calls and Ask prompts.
Deletion first pauses target routines, then uses the original native CLI to restore
only source tasks this import paused, persisting each acknowledgement. Failed
restoration or cleanup staging aborts deletion before routines, run history or the
profile/vault are removed, so retry retains the necessary data and credentials.
Target routines and run history are purged only after profile deletion commits;
a failed database write retains them paused for retry. If post-commit cleanup is
interrupted, existing startup reconciliation purges the deleted companion's
routines and backing schedules. Originally paused or non-taken-over source tasks
stay as-is.
Definitive host input rejections keep their stable error through the Mobile
Remote Resource boundary so the existing form can be edited and resubmitted.
Expired or changed previews clear the frozen intent and refresh the existing
source step on Desktop and Mobile; a new preview gets a fresh request.
Mobile validates the complete action through the existing Remote Resource parser
before freezing its request. A payload exceeding the 64 KiB input budget stays
editable so the user can adjust the portrait/selection; no oversized write is sent.
The wire format and limits are unchanged. Unexpected/ambiguous failures still
retain the original request for reconciliation.
The optional public credential-alternative IDs are additive: older clients may
ignore them, but the host still rejects a conflicting selection before writing.

An imported definition is not automatically equivalent to every source runtime.
Selected source OAuth profiles remain private encrypted migration data under this
import's explicit retain-selected-data requirement; they are not promoted to API
key variables or used to implement Cindy's subscription login/refresh. Import
does not read the Claude CLI credential store or change Cindy's normal
subscription authentication path. Preserving a source profile does not mean its
OAuth refresh is supported or its subscription can be used by another harness.
The preview/result explicitly retains and identifies configurations requiring
an adapter: native subscription OAuth refresh, source-specific tool policies,
per-job model/context/workspace overrides, staggered schedules, and delivery
channels other than explicit Telegram/local chat. Their selected source values
are retained privately, the affected automation stays at the source, and its
imported routine cannot execute with silently weakened semantics. Missing
selected dependencies and failed data probes behave the same way.

## Validation

Tests use isolated temporary homes and fake credentials. They cover selection,
source-agent filtering, SQLite WAL reads, a real credential-bearing child
process, a real stdio MCP exchange, authenticated HTTP response validation,
source CLI pause/resume, paused-state preservation, duplicate requests and lost
acknowledgements. Desktop/Mobile component tests exercise deselection and the
existing portrait picker. No test migrates the user's installed agents or sends
real messages. Device visual checks and live provider OAuth refresh are separate
from these fixture results.

Large-data tests exercise multi-megabyte fixtures, bounded crypto calls, event-loop
progress, worker conversion, legacy read/upgrade, interrupted atomic writes and
owner loss. They use a test cipher, not the user's OS keychain. Discovery tests
verify shared metadata is read once during name masking and SQLite/resource reads
are absent even for multiple agents with an unavailable database. Native CLI tests
exercise fake imported PATH entries and host-only Windows interpreter resolution.
Large real-source latency and peak memory are not claimed as benchmarked.
Downgrading to a build predating chunked companion storage cannot read the new
private format; hand automations back before downgrade and retain the current
build/data for recovery.
