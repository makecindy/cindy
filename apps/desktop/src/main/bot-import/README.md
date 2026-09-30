# Import one local agent as a teammate

`host.ts` is the single owner-scoped service for Desktop IPC, Mobile's existing
Remote Resource transport, and the `companion_import.import_agent` command.
Desktop IPC encodes stable import errors through `throwIpcError`; the form uses
the shared decoder to distinguish editable rejections from uncertain outcomes.
Mobile retains the existing Remote Resource error codes and retry behavior.
Controllers without `companion-import-chunks-v1` keep the complete legacy
projection when its serialized UTF-8 JSON fits 1.5 MiB, leaving envelope space
within the 2 MiB frame. Larger source lists, previews and results return the
existing `UNSUPPORTED_CAPABILITY` error with `IMPORT_CLIENT_UPGRADE_REQUIRED`;
no partial selection/catalog is presented. Older UI may show its generic error,
so upgrading the controller is required for large reads. Chunk-capable clients
and local imports keep the complete data; no import count cap is restored.
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
Preview/retry accounting and source fingerprints stream the existing item graph
without a mapped clone or full metadata JSON string. Strings use 16 Ki-character
chunks (preserving surrogate pairs); each 64 KiB of work yields to Main and retry/
preview accounting rechecks the owner. Binary files are charged directly and the
legacy byte/hash representation remains unchanged. A refreshed cache entry cannot
replace a newer preview while waiting; over-budget reads stop during accounting.
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
unselecting defaults; every discovered skill starts selected. The summary has five flat
category rows; category details use search and 20-row pages. Both platforms use semantic
theme tokens. No new native Mobile dependencies or fingerprint inputs are added.
Every supplied avatar uses the existing companion image validation before any
receipt or credential checkpoint is written. An empty supplied image is invalid;
omitting it retains normal companion defaults, and a rejected request can be corrected.

## Data and execution

- Hermes default/profile homes and OpenClaw's selected agent workspace are read
  independently. OpenClaw's current SQLite cron store takes precedence over the
  legacy JSON store; a database failure never substitutes a stale backup. The worker
  uses the native SQLite binding selected by Main, including isolated Electron dev
  bindings. Driver, size and database failures retain distinct safe reason codes.
- Memory discovery includes UTF-8 text (including JSON, backups and extensionless notes) and attachments under the memory trees,
  including hidden subdirectories. Hermes `memories/` and a user-maintained `memory/`
  archive stay separate; OpenClaw also includes workspace `DREAMS.md`.
  Retry metadata retains each tree's logical prefix; legacy checkpoints infer it
  only when the original entry ID and physical memory root agree. Repaired files
  and subtrees therefore keep distinct archive keys even for identical names.
  Supported media originals enter the shared media ledger with a companion-owned import reference
  and a memory document linking the managed URL. Retry reuses that reference;
  companion deletion releases only its own refs through recoverable cleanup.
  Empty files such as delivery/lock markers do not become attachment failures. Explicit native memory file links into the source-declared document vault retain their logical names and bounded file reads; undeclared external files and external directory links remain rejected. Retry applies the same classification to legacy checkpoints. Unsupported binary attachments remain visible failures, not silently omitted files.
- Selected identity/user/instruction documents and memories retain their original
  text in the encrypted environment. Profile prompt fields and the native memory
  store receive copies with known selected env/MCP/auth credentials masked, while
  ordinary text stays unchanged. Oversized profile fields retain a UTF-8-safe source
  prefix within the existing profile capacity; the complete documents remain in memory
  and the encrypted archive, without synthesized system instructions. Import summaries/titles obey the storage UTF-16
  length bounds, and document parts preserve source frontmatter and whitespace.
  Each new part is read back before it counts as saved; failures preserve part
  progress accumulated across all documents in a recovered directory, and safe storage
  reasons. Existing edited parts are not overwritten. New exact-body parts compare
  their complete body on retry, including whitespace; `bodyLength` remains present
  through storage reads and subsequent editor/tool writes. A whitespace-only edit
  therefore reports `MEMORY_CHANGED` and keeps the checkpoint pending. Legacy parts
  without that marker retain their historical trimmed-body comparison.
  On a repaired subtree retry, successfully saved role documents update the
  profile and its baseline before a failed sibling is reported. Missing baseline
  values do not contribute synthetic blank lines; earlier saved role text remains
  available even if its memory write temporarily fails on a later retry. Unsaved
  siblings remain in the checkpoint and user profile edits are not overwritten.
  Individually repaired memory USER.md files also recover their user role.
  Env references and original credentials remain
  available to host execution; no model call or extra confirmation is added.
  Selected skill folders retain their
  real scripts, templates, executable bits and `SKILL.md`.
  Automation references match both the source directory slug and skill display
  name; referenced skill scripts contribute their environment dependencies.
  Hermes entry and monitor scripts select their entire directory subtrees,
  preserving sibling modules and resource paths in the encrypted snapshot.
  Script assets retain their captured executable flags through the encrypted
  archive and execution tree, so direct sibling helper calls keep working.
  Legacy archives without those flags retain their non-executable default.
  These files remain individually deselectable; deselecting a subtree dependency
  prevents that automation's takeover, leaving its source running. Helper code
  contributes environment dependencies and bounded verification planning text.
  A shared 128 MiB read budget bounds each source snapshot, including
  config includes, documents, credentials, scripts and all referenced skill trees.
  Additional selected skill resources use the same cumulative limit before any
  import writes. An unreadable/oversized selected resource retains a per-item failure
  for retry; healthy items and the conversation are saved. No item is truncated. Fingerprints hash raw
  file bytes, and encrypted checkpoints use base64 while still reading legacy
  numeric-array checkpoints.
  Skill count, source entry count, resource file count and cron row count have no
  fixed quota. Imported SKILL.md files preserve their full body rather than using
  the interactive skill editor's 64 KiB authoring limit. Individual file and total
  in-memory snapshot byte bounds remain; this is not an unlimited-byte importer.
  Skill-root discovery charges each streamed directory entry before retaining it.
  Native alphabetical precedence uses 256 KiB sort batches, 64 KiB merge I/O and
  a logarithmic set of runs instead of a whole-directory Dirent array. Large
  roots spill only names/types into a private OS temporary directory, removed
  after success, failure or an early consumer return; small roots stay in memory.
  Skill files, duplicate-name precedence, disabled state and link policy are unchanged.
  Skills disabled at the source are saved outside the active native skills folder
  and stay disabled when read or edited.
  Runtime discovery is separately bounded: small shelves mount directly; headers
  or catalogs exceeding the startup metadata/path byte budget use one native
  discovery Skill for Pi, Codex and Claude Code. A streamed, complete JSONL index
  points to original files and body line offsets; names/descriptions are previews
  within the existing 64/280-character limits, never rewrites of source files.
  `list_teammate_skills` searches full original metadata and pages by count and
  response bytes. Relative resources remain rooted at the original Skill folder;
  later saves, deletion and disabling refresh the discovery index on the next turn.
  Repeated runtime hydrations reuse the small per-owner/bot projection and saved
  catalog. Typed writes invalidate it synchronously; filesystem observation plus
  directory identity checks cover hand edits, moves and replacement. Watcher
  errors fall back to rebuilding, and missing generated catalogs, discovery
  Skills or Claude plugin manifests are recreated on the next hydration.
  The cache retains at most 32 runtime/query entries, not a maximum number of stored Skills.
  In-flight catalog writers are serialized per root independently of cache
  eviction, so an evicted snapshot cannot overwrite its newer replacement.
  Failed writers release their successor; idle writer records are removed.
  Initial hydration uses `opendir` and bounded header reads, writing JSONL chunks
  as entries arrive. Only the native-mount byte budget is retained/sorted; a large
  shelf is never collected into a runtime array. Giant metadata lines keep short
  previews while the scanner finds the original body offset; ordinary Skill
  bodies are not loaded/parsed in full for indexing. Existing legacy migration
  remains for small authored files; oversized legacy files retain their original
  bytes and use discovery. Authoring/detail APIs still read the originals.
  Streamed and full-file metadata readers share block-scalar handling: YAML `>`
  folding, `|` literal lines, indentation and chomping use the existing YAML
  parser. Runtime previews retain at most 4 KiB of block source per field;
  query construction retains the complete description for one header at a time.
  Colons inside block content never become metadata keys. Imported source bytes
  and original body offsets remain unchanged, including empty block scalars.
  Full-metadata queries reuse a separate disk index of enabled and disabled
  headers. Construction streams headers (never bodies), sorts byte-bounded runs
  and merges two records at a time; an oversized header occupies its own run.
  Warm search and pagination stream that index and retain only the requested
  response page, without reopening each source file. Full name/description
  matching, stable name/slug ordering and disabled entries remain available.
  Disabled query results retain management/deduplication metadata and `enabled:
  false`, but omit `filePath` and `bodyStartLine`. Original files and the settings
  read remain intact; enabling a Skill restores its body/resource discovery path.
  Mutation invalidation and watcher recovery also cover this query index and
  disabled metadata. A cold cache builds it once; subsequent queries still scan
  index bytes for exact matching/counts, rather than maintaining a search database.
  Failed directory scans leave the last complete catalog intact for retry.
- Skill discovery follows grouped Hermes directories, configured external roots,
  native directory links and disabled lists. OpenClaw discovery covers workspace,
  workspace `.agents`, personal/managed/workshop, installed bundled, extra and
  enabled plugin manifest roots, with native precedence and symlink trust rules.
  Hermes personal/external roots and OpenClaw managed/personal roots intentionally
  accept directory links outside their lexical root, as their native loaders do.
  Selecting such a source trusts that source's Skill catalog and link targets;
  this importer does not sandbox a compromised source home. Other OpenClaw roots
  retain canonical containment / configured target checks. Once a Skill is found,
  only its canonical subtree is captured (including ordinary hidden resources);
  unrelated resource-link escapes remain rejected. Adding a new folder-grant flow
  or disallowing native personal links would change the full-import contract and
  is not part of this fix.
  Nested archive/environment/support directories are excluded. Names and skillKey
  overrides are resolved before deduplication; skill-owned credential alternatives
  are selected separately so credential ambiguity cannot deselect a skill.
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
  Tool discovery and harness session initialization read a separate encrypted
  projection containing only connection inputs, a credential identity hash and
  the pending-setup flag. Source files and the retry snapshot stay in the original
  archive. Writes invalidate/rebuild the projection under a per-companion lock;
  legacy or missing projections rebuild once, with large archive parsing and
  projection in a worker. Both encrypted records participate in deletion recovery.
  Legacy single-value ciphertext and numeric-array snapshots remain readable;
  normal writes automatically use the chunked format. Legacy decryption itself
  remains synchronous until that first rewrite. This changes only the private
  companion namespace, not provider/renderer credential storage. Cancellation of a variable does not
  secretly copy its expanded value into another selected connection.
  Public profile/memory/Skill text and routine names/prompts redact all known
  source credentials, including unchecked accounts; memory titles use the same
  mask. Preview, entry-caption and selected-content traversals compile a local
  matcher once and reuse it for their strings; nested structured-data redaction
  likewise compiles once per traversal. No global credential matcher is retained.
  Repaired manifests adding new credentials refresh the import's matcher before
  publishing recovered content.
  Matching still prefers longer values, bounds short tokens, and never rescans
  replacement labels. URL paths use an explicit transport-route allowlist; unknown segments are
  private regardless of length or case, including encoded forms and subsequent
  route-looking values. Named local endpoints are exempt only as single loopback
  paths; explicit credential fields always take precedence. Routine publication happens before createOnce persists the definition,
  and activation compares that same projection so masking does not block takeover.
  The encrypted checkpoint retains only masks actually matching selected source
  content, with stable labels for restart. These values were already embedded in
  selected originals; unrelated unchecked credentials/configurations are not
  retained. The private environment keeps these masks for later output redaction,
  never for subprocess env or connection authentication. Only selected credential
  entries are activated; selected original documents/automation definitions stay
  private and unmodified.
  Structured private-key fields also recognize PEM/Base64 format suffixes and
  redact their string descendants in published content and command output;
  ordinary public-key, format-name and key-path fields retain their values.
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
  Recognizable boolean/numeric settings and ordinary MCP endpoint names are not
  treated as credentials. Explicit credentials (including short values) and unknown
  private settings remain masked. Unchanged resources and binary assets retain their bytes. Affected skills keep
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
  All newly imported output goes to the canonical teammate chat. Source delivery
  channels and failure delivery destinations do not gate selection or verification.
  Existing imported bindings that already carry Telegram destinations retain their
  legacy delivery behavior; no existing routine is silently rerouted.
  Each confirmed target/message chunk advances progress in the same encrypted
  automation binding. A retry or next occurrence resumes the captured output and
  destinations before rerunning the model/script; counters commit only after all
  sends finish. This does not guarantee exactly-once delivery if Telegram accepts
  a message but its response or the subsequent local checkpoint is lost.

Copying and field conversion do not call a model. The optional takeover check
uses the teammate's current model to plan bounded read-only probes, then the
host executes real MCP/HTTP reads and validates response data. The planner sees
variable names and redacted task/script text and Skill/file identifiers, not credential values. HTTP checks
reject redirects. Legacy Telegram bindings still check identity/destination without test sends.
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
Legacy delivery-only credentials are excluded from data-read dependencies. New
imports have no source delivery dependency and local reminders use teammate chat. Variables also referenced
by the task or its skills still require data verification.
For legacy bindings, Telegram destinations without an explicit source account bind only when exactly
one source account is available. Multiple candidates or a missing explicit account
use the existing `DELIVERY_NEEDS_ADAPTER` state and keep the source task running;
being able to reach a chat does not identify the intended sending bot.
For scripts classified as local-only with no data/connection dependency, the same
runtime interpreter parses the selected script without executing business actions.
This checks availability and syntax, not a full business execution; scripts with
external data still require actual read evidence.

## Save first, finish setup in chat

GUI imports send the additive `deferSetup` flag (the command defaults it to true).
Saving personality/memory/skills, private connections and disabled routine definitions
finishes before any data probe, source pause or target activation. `savedEntryIds`
counts saved definitions independently of activation status. `saved: true` means
that the save pass finished, not that every selected item succeeded. After all
selected content is saved, both clients open the teammate chat once,
including when sign-in or mapping remains. Partial-save results
show saved/selected counts and distinguish partial imports from setup-only checks.
An expandable, paginated detail list shows filenames, safe reasons and partial
progress. Chat remains available alongside retry. Idempotent chat notices distinguish
partial saves, pending setup and eventual completion without exposing raw exceptions.
Every source automation is preserved, including native Heartbeat and unsupported definitions.
Unconvertible schedules become disabled drafts with no trigger; unresolved issues
block both activation and manual execution. Full original definitions remain encrypted.
Empty memory markers and Heartbeat instructions are retained as well. Completeness
is audited against the source inventory, not just the converted selection count.

The owner-scoped `companion_connections.import_setup` tool lists remaining checks
in pages, retries from the encrypted checkpoint, and permits explicit adoption of
Cindy model/tool settings for selected entries with `use_cindy_settings`. That
operation does not activate anything or waive context/workdir/data checks. Login
uses the real existing account/plugin connection UI; credentials are never requested
in chat. Ordinary conversation remains available while setup is deferred.

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
before freezing its request. New hosts advertise `selectionRanges`; new clients can
encode exact selections as inclusive immutable preview-index ranges. Selected-only
checkpoints retain the original indexes. Old hosts receive the existing ID arrays;
old clients can continue using ID arrays on a new host. The 64 KiB wire action
budget is unchanged; 10,000 selected entries need one range, not 10,000 IDs.
Previously released controllers retain their own 2,000-entry preview/result limits;
large catalogs require an updated controller as well as host. A new controller with
an old host retains the old ID-array/inline-check behavior and retry/open actions;
it does not claim deferred setup when the host has not saved it. Existing receipts
without range indexes, deferred-setup flags or saved counts remain resumable, and
their existing delivery bindings are retained rather than rewritten on upgrade.
Unexpected/ambiguous failures still
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
per-job model/context/workspace overrides and staggered schedules. Their selected source values
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

Native OpenClaw `payload.kind=command` jobs retain argv, cwd, stdin, environment,
wall-clock/idle timeouts and output limits in the encrypted definition. They are
saved disabled and execute as literal subprocess argv only after the existing
verification and handover gates. They never start a model turn or inherit model/tool
policy requirements. Read-only verification must verify their actual dependencies;
it cannot accept a command as a simple local reminder. Native `heartbeat` payloads
are preserved disabled with their schedule and original definition; native context
semantics remain explicitly pending, rather than being silently reduced to a reminder.

Ordinary content/routine progress uses indexed checks and batches by serialized
UTF-8 bytes. Each changed record is charged against the last complete receipt's
size (including the display-name index), with a 64 KiB floor. Growing receipts
therefore save progressively less often instead of rewriting every name/check
roughly 100 times; measuring a change never scans the accumulated receipt. The
host returns the byte count from its single serialization. Phase boundaries and
terminal results still save complete, backward-compatible atomic receipts.
An interrupted batch replays idempotent writes and `createOnce` under the same
IDs; a large name index can mean replaying a larger unsaved batch. Handover intent,
source pause, target enable and rollback milestones still persist immediately.

New hosts also advertise `selectionChunks` on previews. The shared remote client
uploads large selections (including sparse ranges and portraits) in 8 Ki UTF-16
pieces through the existing import action, below its unchanged 64 KiB input limit.
The host bounds retained uploads by owner/controller, expiry and the snapshot byte
budget. Repeated identical pieces are accepted; changed or out-of-order pieces
are rejected. Only a complete upload reaches the existing selection validation
and durable import transaction. A disconnected client can replay from zero using
the same request ID. This recovery affects only that import, never reconnects the
peer or replays other actions. Old hosts keep their original single-action path;
old clients continue sending plain selections to new hosts. No relay or server
change is required.

Native memory file links are restricted to canonical document vault roots named
by `OBSIDIAN_VAULT_PATH` in the selected source's own config/.env. Memory files
cannot add roots, and Cindy's process environment is not a grant. Other external
files and all external directory traversal remain rejected, including retries of
old checkpoints that only contained a boolean link exception. Native command
argv, cwd and stdin are now opaque to the read planner, even when a literal secret
is absent from every configured credential map; the original payload remains in
local encrypted storage for authorized execution.

Readable import copies collect credentials from structured argv/stdin as well as
command env. The same literal/JSON/URL/form traversal is shared with output masking;
publication treats stdin and credential-named options as private literals and
examines other arguments for structured credential fields and capability URLs.
Credential-named header literals (including X-API-Key and X-Auth-Token) mask
their payload; Authorization/Proxy-Authorization additionally mask the credential
after the scheme. For Basic authentication, canonical standard Base64 (padded or
unpadded) also supplies the decoded userinfo and the entire password after its
first colon; UTF-8 and legacy single-byte text are preserved. Invalid encoding
or userinfo without a colon adds no decoded guesses; usernames alone and the
empty `:` pair do not become masks. Original headers are never rewritten.
MCP and commands share Cookie decomposition: every nonempty
cookie value, including quoted and percent-decoded forms, stays private because
cookie names are application-defined. This does not make scheme names or ordinary
Accept/Content-Type values global masks. This covers
separate `-H`/`--header` arguments, `--header=value`, and joined `-Hvalue` forms
in both publication and execution-output paths; original argv remains intact.
Form-encoded stdin, argv and command environment values collect credential-named
fields in both wire and decoded form, including repeated fields, percent-encoded
names and `+` spaces. Ordinary form values such as city/day-count/token type stay
readable. Execution retries and final chat publication apply the same masks;
the original form bytes remain in the encrypted command archive.
For curl/curl.exe, `-u`/`--user` and `-U`/`--proxy-user` also contribute the password
after the first userinfo colon, including joined short and assigned long forms.
Preview/public copies and runtime/retry output share this extraction. Usernames,
ordinary colon-containing values, other executables and arguments after `--` do
not gain userinfo masks; original argv bytes are unchanged.
It does not blanket-mask ordinary positional arguments or command settings:
doing so corrupts day counts, output formats and subcommands in imported text.
Unlabelled opaque positional values are not newly classified as credentials by
this publication pass. Raw commands, source documents and Skill resources remain
in the encrypted archive; the existing execution-output mask stays conservative.

Full preservation also includes unused Hermes scripts, disabled MCP definitions,
empty marker bytes and UTF-8 text documents containing terminal control characters.
Initial profile projection and its retry baseline include only role documents
whose memory import completed in full. Healthy role children of partial items
still apply; failed/partial role originals remain in the encrypted checkpoint
until retry succeeds. A durable copied receipt restores this eligibility if the
profile/environment save was interrupted, and retries still preserve user edits.
Native Python virtualenv interpreter aliases retain their original runtime targets only when `pyvenv.cfg`
declares their exact runtime home and the resolved target is a native executable.
Their captured bytes remain in the import checkpoint; native links preserve dynamic
library resolution when the skill is saved or temporarily materialized.
This grants no access to neighboring credentials or external directories. The
original virtualenv configuration and resource files stay intact; cross-machine
runtime availability is not implied by saving their definitions.

### Setup status metadata and raw command URLs (2026-09-29)

Setup status resolves the active Main-owned session/owner and reads the opaque
import request ID from the existing environment manifest. The receipt retains
already-redacted entry captions (at most 200 characters for status display).
Paging never opens the vault or reconstructs Skill/attachment buffers. Existing
manifests/receipts upgrade once under the import lock; normal recovery and explicit
retry still load the checkpoint when required. Caption clipping does not alter
source names, files, automation definitions, or encrypted originals. Repaired
capture metadata replaces the captions on the next checkpoint save.

Raw command environment capability URLs use the same URL component masks as JSON
command environments, before Remote Resource previews and public Skill/memory/
routine/receipt publication. Encoded and decoded path, query and fragment values
are covered even when the command is deselected but its token occurs in selected
content. This remains scoped to command environment values; ordinary provider
base URLs do not create global path-word masks. Encrypted originals are retained.
