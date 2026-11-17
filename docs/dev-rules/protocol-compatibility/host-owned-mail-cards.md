# Host-owned mail cards

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

Manifest v3 adds optional `mail: true`. Cindy serves the versioned `cindyMail` SDK
inside the provider sandbox before its entry point. Providers register mailbox
adapters; they do not need `card` or generate HTML. The local pipe accepts validated
`mail-draft-update` only from enabled mail providers with a live task-owned call.
Cindy renders and persists the existing `ghost_cards` row; no database migration
or relay version change. Old hosts lack the SDK: providers retain read-only tools
and require a Cindy update before draft editing/sending, without a direct-send fallback.

The host-only `data-cindy-mail` marker records account/draft identity, state and
`supersededBy`. Ordinary plugin HTML cannot retain it. Autosave replaces one view;
subsequent tool reads supersede matching provider/account/draft views in that task.
Obsolete or legacy mail actions are rejected on the Host. Historical snapshots remain stored.
The `plugin-card-actions` resource carries optional `mail` / `legacyMail` metadata;
desktop and mobile clients hide superseded mail cards and their plugin labels, leaving
only the latest card per provider/account/draft in that task, including sent/deleted
states. Legacy cards without this metadata retain their read-only fallback.
Old clients keep static fallback text
and receive no obsolete actions. Existing form capability negotiation and task/owner
checks still apply. Sent cards expose only optional task continuation, never send.
Mail receipt continuations use the existing `[UI_ACTION_TRIGGER]` prefix: the
Agent receives the complete receipt, while both clients hide the internal prompt
from chat and session previews. The original mail card remains the visible result.

Optional adapter `deleteDraft` adds a `deleteLabel` and `mail:delete:<key>` action
to active drafts only. It requires no form values because pending edits are
discarded. Deletion shares the per-draft save/send lock and cancels queued saves
and send countdowns. It discards the logical draft even if its content/revision
has changed, verifies the draft identity and refreshes the provider locator;
save/send conflict checks do not apply to explicit discard. Progress is shown
before provider read-back. Failed preparation remains retryable; a deletion
with an unknown provider outcome is never replayed.
Both clients treat `deleting` and terminal `deleted` as
read-only; the Host rejects late edits/sends and cannot restore a deleted card.
Unknown deletes stay locked until the mailbox is checked. Older adapters omit
the button; older clients fall back to inert text for the new states. Existing
remote action ownership/revision checks and the same card row carry this change.

Oversized tool results retain validated top-level `xdt_card_id` and
`xdt_anchor_card_id` in bounded valid JSON during persistence/import and remote
history compaction. The card content remains in the existing card store; no new
wire fields or schema are required. Uncorrelated live cards may only match calls
in the latest visible user turn, so incomplete older history cannot steal them.

Rich mail adapters opt in with `richText: true`; old adapters keep the existing
plain-text contract. Host fields add `mail-html`, `mail-attachments` and `hidden`
kinds, with `bodyHtml` / `quoteHtml` (64k characters) and `attachmentItems` (bounded
JSON metadata). Ordinary text remains 16k. Only Host mail gets the 1 MiB card
budget; arbitrary plugin HTML remains limited to 32 KiB. HTML previews are inert,
sandboxed documents, not markup mounted in Cindy's privileged renderer DOM.
Both clients block remote image sources and CSS fetches in mail previews; CSP
permits only data and managed CID substitutions. Original outgoing HTML remains
unchanged by this preview policy; remote images can be viewed in the mailbox.
HTML supports typing directly into rendered text in both clients and the enlarged
view, without an edit-mode button, formatting toolbar or source editor. Edits patch source text
only, preserving styles, links and CID image references, and synchronize the
plain-text alternative through the existing form autosave path. Sent/history
cards stay read-only. `editor.format: 'text'` retains
the existing compact plain-text input.

The Host mail SDK owns outgoing formatting for all rich adapters. Before preview,
autosave and send it extracts document wrappers into fragments, retains body
attributes on a content container, derives absent text alternatives, supplies
missing filename extensions from known MIME types, and reconnects managed preview
URLs to their attachment CIDs. Missing/duplicate inline references stop sending.
The same URL policy covers `src`, `background`, every `srcset` candidate, inline
CSS and stylesheet `url(...)` in both the body and the quoted content.
Normalized content is saved and read back before the existing countdown; adapter
read-back must retain the normalized structure. Adapters honor supplied filenames,
preserve MIME bytes/reply headers and verify the provider result. No new wire fields
or SDK version are required; plain-text-only adapters retain their existing path.
This is structural protection, not a guarantee of identical CSS rendering across
email clients. Ordinary fragments and explicitly authored plain text are retained.

Desktop attachment actions `mail:attach` / `mail:image` are native Host gestures,
not plugin HTML controls. The dispatcher verifies current view, owner, mail
capability and draft state before and after the native picker, and passes one
transient hash/size-bound file descriptor to the provider event. No arbitrary
path comes from form text. Selected desktop bytes are copied into the existing
session-owned temporary attachment store; only the staged descriptor crosses
the plugin boundary, never the user's original path. Source replacement after
selection cannot change the staged bytes. Failed/stale delivery discards the
copy; accepted files retain normal session/orphan cleanup. Pending or sent mail cannot open the picker. Mobile
resource metadata adds optional `mailUpload`; old hosts omit it and new phones
hide the upload button. Supporting hosts accept `mail:attach:<key>` with optional
`input.mailAttachment: {url,name}` and the complete form. Only existing OSS/peer
upload references with size and SHA-256 are accepted (16 MiB/file), never local
paths. The existing task materializer owns downloads and session cleanup; owner,
interaction lease and current draft state are checked before delivery. No new
relay channel, native dependency, database or runtime fingerprint is introduced.
Ordinary attachment removal retains the existing remote form delivery gate.
Optional `mail.images` contains validated managed preview URLs keyed by CID;
these URLs never replace CID references in the saved/sent message. The existing
media-deposit ledger owns these image bytes; no new file store or database exists.
Mobile resolves CID previews with the existing remote-media queue into data URLs
inside a sanitized mail WebView whose CSP blocks all page scripts. Host-injected
editing listeners send only a document revision, known text-run index and plain
text; the native side validates those before applying source patches. Desktop
uses parent-owned listeners in an iframe without script permission. Autosave
echoes do not reload either editing surface. CID substitutions never enter form
edits; missing images leave the rest of the email readable.
Attachment items optionally carry `mimeType` and `previewUrl` (validated managed
image URLs only). Both clients show file identity and size; image clicks use
their existing viewers. Removing a CID image removes its part and image nodes,
preserving the rest of the authored document. "Insert into message" assigns an
available `image-N@cindy.local` CID to an existing image key and inserts an HTML
image before the closing body tag. Adapters validate the actual bytes and write
that existing part as inline without uploading a duplicate. Compare part keys
and normalized Content-IDs, ignoring preview-only metadata when detecting edits.
After sandbox restart, the next card edit/send (including model send) restores
volatile state using the persisted account/draft/locator. It retains incoming
form edits and the same card key. Optional `baseValues` in the existing host card
retains the last synchronized values (not in plugin KV). The SDK's internal
`mail-draft-read` uses the same plugin/call/session ownership as publication.
It compares base, card edits and provider values: identical/one-sided changes and
independent text ranges merge automatically, ignoring preview-only metadata.
Unmergeable overlapping edits retain both versions and name the conflicting fields.
Legacy clean cards supply their own base; legacy errors without a base converge
only when contents agree. Pending/unknown/sent records never become drafts.
Adapters may return `execution:not_executed` with `stale` read-back; the SDK can
merge and retry once. Unknown writes never retry. Changed content discovered at
send time is shown before a fresh countdown; metadata-only drift needs no prompt.
Old clients ignore optional baseline values; existing remote form actions carry
no new required fields. The host SDK, not mailbox plugins, owns recovery/merging.
Recovery never resumes a previous countdown; a new send gets the full grace period.
Reading an unchanged draft in the same task reuses its existing card without
publishing another snapshot. The host verifies task ownership through
`mail-draft-read`; a different task still receives its own card. Fresh provider
fingerprints/locators are adopted even if visible content is unchanged. Desktop
mail cards require an exact tool ID or settled result to anchor them; the generic
same-plugin in-flight heuristic must not show old mail beneath a schema/read call.
Desktop HTML previews retain head styles, class selectors and body presentation
inside their inert sandbox. External CSS resources, scripts and navigation remain
blocked; preview sanitization never mutates the saved HTML.

## Read-only mail preview

Mail providers may declare `mailReader: { tool, hosts }` alongside `mail: true`.
`mail` accepts only omission or literal `true` in both v2 and v3; both validators
reject a reader without `mail: true` or without its matching tool in `tools`.
Desktop and plugin-protocol validate this known declaration and retain future
extension data; malformed declarations cannot survive as unknown top-level fields.
Install/detail permission projection includes `mail`, the reader tool, individual
reader hosts and optional read-state writes; adding any of them requires the existing
update consent even when the tool was already registered. Reordering/deduplicating
hosts or removing capabilities does not expand permissions.
The tool must be declared and read-only by default. Cindy matches exact HTTPS hosts
and calls it with `{ url }`; the provider resolves the account and message without
marking read or mutating drafts. Providers may opt in with `mailReader.markRead: true`
and accept optional `markRead:true` on that same tool. The declaration permits only
omission or literal `true`; `false`, strings, null and other values are invalid in
both manifest validators. Runtime dispatch also requires literal `true`, including
for declarations retained by older validators. Future unknown metadata remains
preserved by manifest normalization and never grants permission. Only an explicit user opening
passes it; AI reads, probes and neighboring preloads remain read-only.
The dispatcher strips `markRead` from ordinary tool arguments for the declared
reader; only the trusted native-reader request may inject it after literal opt-in.
Other explicitly authorized read-state tools retain their normal Agent path.
Restored inactive tabs and a hidden sidebar must not mark mail read merely by mounting.
Mark only the successfully resolved, visibly opened message, never the whole thread or drafts. A failed
mark must retain the body and return `markReadFailed:true` for a non-blocking notice.
It returns `MailMessage` (maker-shared/mail-message).
Optional `participantPhotos:[{email,url}]` supplies exact normalized-email contact
photos (at most 64, credential-free HTTPS URLs). Invalid photo entries are discarded
without dropping the message. Old providers omit this field; old clients ignore it.
It travels in the existing message response/resource with no new IPC or permission.
Desktop uses it before Gravatar (SHA-256 normalized email), a fixed DuckDuckGo domain
favicon endpoint for non-public mailbox domains, and initials. External avatars use
no referrer and bounded load fallbacks; they do not enable remote images in the body.
Desktop loads avatar sources for at most the first 12 participant positions per
message, shared across from/to/cc/bcc; duplicates also consume a position. Remaining
participants use initials and retain their complete addresses, without photo or hash lookups.
Domain icons are presentation, not authenticated sender identity. Other clients may
continue displaying addresses alone. Provider contact enrichment must remain optional
when new contact scopes are missing; Gmail bounds its lookup budget and account cache.
Desktop activates only HTTP(S) body links through the chat opening policy and keeps
their underline visible despite sender CSS. Unsupported targets, including mailto,
stay inert without an href or explicit link role in the reader, so they are not
keyboard/screen-reader links. Reader paint and authored link attributes are restored
before editing or serializing a draft; the system shell protocol allowlist is unchanged.
Credentials and MIME parsing remain with the provider. Cindy validates the data
and reuses its inert HTML/CID/recipient renderers for delivered mail. Multiple
matching providers/accounts cannot silently select the first. Host setup metadata
selects a sole ready instance without probing mailboxes; several ready instances
return optional `providers:[{id,name,namespace}]` for a user choice. The host-issued
opaque `providerId` returned with a message pins neighboring reads to that instance;
removal/disable never falls back to a different one. Choices are local to the current
owner/device/session/link, with no persisted default or account migration. Unknown providers or
older hosts keep normal browser opening. Attachments use managed image previews;
other file types retain their metadata and the mailbox opening fallback.

Desktop uses a session-scoped sidebar tab. Mobile/same-account remote clients use
the existing `mail-messages/message` remote resource, ID `[sessionId,url,read]`,
primitive `mail-message`.
Explicit opening adds optional `query:"open"` to resource get, or optional fourth
`opened:true` to `ghosts:mail-preview`; resource IDs and default read behavior stay
unchanged. Old hosts ignore the new optional values; old providers still receive
only `{url}`. No new channel, storage or native changes. Plugins adding an OAuth
scope must keep existing granted operations usable; missing new scopes may fail
marking read, not prevent viewing or composing.
Explicit provider selection adds optional fifth `providerId` to `ghosts:mail-preview`,
or JSON `query:{opened,providerId}` (serialized as a string) on the same remote resource;
the three-element resource ID is unchanged. Main revalidates the selected instance
against enabled approved matching readers after session authorization. Old clients
ignore the extra response fields; old hosts do not expose choices, so new clients
retain their normal legacy read request until a current host returns a choice.
Existing 256-character resource ID bounds still apply; overlong remote links fall back to browser opening. Shared-task access does not
grant mailbox access. Scope checks run before and after reads; clients bind display
to account/device/session/URL and ignore stale responses. No mail content is stored
in sidebar state. Delivered-mail links do not publish cards.

For an explicit visible opening the dispatcher also injects Host-only `openDraft:true`;
ordinary tool arguments cannot supply that intent. A draft-aware provider resolves the
stable provider draft ID and reuses its existing compose read/presentation flow, returning
optional `draftId`. Main registers the native call in the existing card service and returns
optional `draftCallId` only after matching a current card's task, plugin, account and draft.
This reference is never accepted from provider result data. Background reads cannot publish
or return editor bindings. Desktop's local sidebar and Mobile use their existing card editors,
autosave and send/undo actions. The Mobile editor reuses `plugin-results/card` subscriptions;
no new transport, persistence, credential transfer or send path is introduced.
The Mobile editor follows `supersededBy` through the same task-scoped resource reads only
while installation, account and draft identity still match; its actions and invalidations
use the resolved card ID. Ordinary chat rows continue hiding superseded cards.
Remote Desktop retains the read-only message and original mailbox link because its
existing card editor dispatches local actions only. Native reader calls are finalized
even after owner/installation invalidation. Owner scope still guards result delivery;
an invalid installation cannot acquire editor bindings or extend the call-bound Host capability window.
Old hosts do not inject `openDraft` and remain read-only; old providers ignore it, and old clients ignore
`draftCallId`. Source package compatibility remains 0.1.112; editable link support requires
both the updated provider and the corresponding Host/client changes.
Desktop link opening and card enlargement both await the existing card-form delivery
barrier before changing tabs; explicit reads also await it before calling the provider.
Failed delivery keeps the current editor intact. Probes and background reads do not
wait for or flush editor changes.
Link probes return `supported:false` when no enabled matching reader is ready, retaining
normal browser opening on Desktop and Mobile. Explicit reads of restored tabs distinguish
no matching reader (`supported:false`) from an unconfigured one (`MAIL_PROVIDER_NOT_READY`)
without calling provider tools. Both show a labelled mailbox-opening action instead of
an ineffective retry; restored tabs never launch an external page automatically.

Desktop native mail cards also open this tab through `open-mail-card` with
`sessionId` and `callId`. The tab stores only the card ID and uses the existing
card editor/actions; session-scoped lookup and supersession select the current
view. This is a local desktop trial, not a new plugin or device-link capability.
Older URL-based reader tabs remain valid. Draft edits, deletion and delayed send
still use the same host-owned mail workflow as the chat card.
