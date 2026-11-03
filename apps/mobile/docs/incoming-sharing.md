# iOS incoming sharing

Cindy's iOS share extension accepts representations exported through `NSItemProvider`.
Sharing opens a destination picker: a new task, an existing active task, or a companion
with a writable conversation. The picker shows a compact content preview (including a local image thumbnail),
companion avatars and recent tasks. Search matches titles and computer names,
with explicit empty results and a clear action. Selection populates the ordinary
composer, preserving its existing draft. The user can add instructions, review uploads, and send normally.
The new-task route carries the same eligible-computer list as Home, so device
selection and the normal model defaults remain usable; without a controllable
computer, the share stays unclaimed and the picker explains why. Directory
refreshes retain already loaded destinations for the same account.
Back cancels the unclaimed share and releases only its owned copies.
It never dispatches a message just because an external app opened Cindy.

## Supported representations

| Source representation | Result |
| --- | --- |
| Plain text, selected text | Composer text |
| Web URL / deep link | Composer text; never automatically fetched or executed |
| Safari preprocessing result | Page title, URL and selection when Safari supplies them |
| Image (including UIImage / raw data) | Attachment; HEIC/HEIF/TIFF/BMP follow the existing JPEG conversion path; vector/source encodings remain original files |
| Movie, audio | File attachment |
| PDF, Office, HTML/RTF, Markdown, JSON, property lists, archives | Original exported file |
| vCard, calendar, models, custom data types | Original exported file through the generic data adapter |
| File URL / security-scoped document | Owned copy, retaining its filename |
| Directory / document package | Coordinated upload snapshot (ZIP) |
| Mixed or multiple items | Text plus attachments, preserving source order within each |

Formats describe transfer support, not a promise that every agent can interpret every
format. The source app must export bytes, a file, text or a URL. Private in-app objects,
protected streams and content the source does not export cannot be recovered from a
share sheet. Live Photos export the representation offered by the source; this does
not claim preservation of their private paired-resource metadata.

One share accepts at most **20 provider items**. Oversized shares remain in the source
app with an explicit instruction to split them. The composer retains its existing
20-attachment limit; when its tray is full the incoming batch stays unclaimed until
space is available. An unreadable provider fails the entire incoming operation rather
than silently forwarding a partial set. Unsupported/offline destinations do not gain
new sending privileges: normal conversation hydration and authorization still apply.

## Implementation and extension points

- `plugins/incoming-share-formats.swift`: ordered representation adapters. File-backed
  media and exported documents take precedence over their text/link previews. Add a
  semantic adapter only when a new representation requires decoding; generic data
  formats need no extension allowlist.
  File-URL classification uses the original file's UTI or image header, never a
  provider-wide thumbnail. Unknown extensionless documents remain original files;
  actual extensionless raster images retain image processing. File URLs exported
  as UTF-8 data are decoded and copied within the provider callback. Unnamed
  abstract image data uses its actual image header for extension and MIME.
- `plugins/with-incoming-share-formats.js`: generated Expo controller integration.
  Checked patch anchors fail prebuild if the upstream template changes.
- `fingerprint.config.cjs`: explicitly hashes the share extension's Swift, strings
  and Safari script resources. Register additional native resources here so format
  changes invalidate cached binaries and require a compatible native release.
- `plugins/incoming-share-feedback.swift`: a standard UIKit receiving indicator
  and cancellation, followed by the existing launch/failure feedback. The extension
  uses `UIViewController`, avoiding the unrelated Social Post editor flashing
  before the containing app opens; it does not send or choose a destination.
- `plugins/with-incoming-share-files.js`: App Group file ownership, activation predicate,
  Safari script packaging and existing native-slot write/launch feedback. Expo Xcode
  mods run in reverse registration order; keep this plugin before `expo-sharing`.
- `src/session/incomingShare.ts`: account-fenced mailbox, explicit destination identity,
  text normalization and attachment conversion selection.
- `src/session/useIncomingShareComposer.ts`: shared handoff into new-task and existing
  task/companion composers. Share batch positions survive concurrent upload completion and durable outbox handoff; successfully staged non-image copies are released, while failed uploads retain retry inputs. Upload, retries and send stay in the established pipeline.
- `app/incoming-share.tsx`: destination discovery; companion identities come from their
  permanent resource IDs, with live canonical-conversation verification before claiming a share. Hosts without a
  conversation link remain visible but unavailable. Tasks use the existing active-list
  API (latest 500 per computer plus pinned tasks); archived/worker/bot sessions are not
  duplicated in the task section.

Provider temporary URLs are copied **inside** the `loadFileRepresentation` or
`loadItem` callback. Concrete image subtypes (PNG/JPEG/HEIC etc.) precede source
URLs; web URLs precede abstract `public.image` previews but follow concrete file exports.
Security-scoped access is balanced; directories use `NSFileCoordinator.forUploading`.
Each input owns a unique App Group directory, so equal filenames cannot overwrite.
Routine foreground reads run on the native module's background queue. Synchronous
acknowledgement and account-boundary operations use a nonblocking lock: contention
fails and retains the share instead of waiting on the JavaScript/UI thread.
Foreground, share-link and account notifications are serialized; a late notification
never resets the destination the user already selected. Destination taps are fenced
until the chooser regains focus, so queued taps cannot replace an in-flight handoff.
Reads still in flight remember batches acknowledged during that read, so a copied
native snapshot cannot requeue a share already consumed or cancelled. This fence
expires with the read; subsequent identical legacy shares remain eligible.

New native snapshots carry a UUID for each system-share invocation. Identical text
or URLs shared twice therefore remain distinct mailbox entries; repeated notifications
for one invocation are still deduplicated. The adapter accepts legacy array snapshots
from an existing installation and acknowledges their original bytes unchanged.
The native slot is acknowledged only by the selected, focused, hydrated composer;
account changes and upload cleanup use the existing ownership fences. Rejection-marker
removal is acknowledged only after a successful durable flush; failures retain the
marker for retry, including when the App Group slot has already been cleared. If an
account transition cannot read the slot, an independent durable unknown-slot fence
rejects its first recovered snapshot, then pins those exact bytes for cleanup retries. The existing
native inbox is a single persistent slot, with an in-process JS queue; this change does
not promise a durable history of multiple shares received before Cindy opens.

## Verification

Run the focused mailbox/native/bridge/composer tests and mobile typecheck. Native changes
require rebuilding the iOS binary, checking that `incoming-share-webpage.js` is inside
`expo-sharing-extension.appex` (not only the main app), then exercising real system share
sheets. Cover Safari, text, image, mixed files, new/existing/companion destinations,
full composer, source read failure, 21-item rejection, and account switching. Native
launch-feedback tests execute the generated Swift methods rather than only matching
source strings. Simulator/source-specific coverage is not a claim that every third-party
app exposes the same providers.

## Apple references

- [Share extensions and Safari preprocessing](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html)
- [NSItemProvider file representation lifetime](https://developer.apple.com/documentation/foundation/nsitemprovider/loadfilerepresentation(fortypeidentifier:completionhandler:))
- [Coordinated upload snapshots](https://developer.apple.com/documentation/foundation/nsfilecoordinator/readingoptions/foruploading)
