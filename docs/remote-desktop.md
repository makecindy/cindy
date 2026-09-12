# Remote desktop

## Desktop viewer

Desktop can open a same-account computer's remote desktop from its device card
in Remote control settings, or the task-list machine menu's Remote desktop submenu.
When the sidebar is grouped by machine, hovering or keyboard-focusing a remote
machine reveals a desktop shortcut. A debounced, read-only capability check
distinguishes available desktops from offline, disabled, revoked or unsupported
targets; unavailable shortcuts show a crossed-out monitor with an explanation.
Hovering never starts desktop capture or takes over another viewer, and clicking
the shortcut does not expand or collapse the machine group.
It opens a clean, independent window with native mouse/keyboard input and a small
toolbar. Reopening the same target focuses its existing window. Full screen,
view-only/control, display selection, sound, video settings and text
clipboard shortcuts are available. Resolution changes appear only for a capable
host and affect its actual monitor. Ctrl+Alt+Esc releases keyboard focus;
Cmd/Ctrl+W requests closing this viewer, including while it owns keyboard focus.
The toolbar exit, native window close and close shortcut share a confirmation
dialog; cancelling keeps the connection and control lease. Confirmation belongs
to the current window generation and cannot close a later connection.

While controlling, the local cursor is hidden inside the remote picture even
when Windows embeds its cursor in the video rather than sending cursor metadata.
Cursor hiding is scoped to the remote picture, not the system or window focus:
moving outside it immediately restores the local cursor even if the viewer keeps
focus. Local toolbar controls and dialogs retain their cursor. View-only mode
also restores the local cursor inside the picture.
With the picture focused, Cmd+C/V on macOS or Ctrl+C/V on Windows copies selected
remote text to the local clipboard or pastes local text remotely. Transfers use
the existing authorized Main bridge, are ordered and user-triggered, and report
failure without reconnecting. There is no background clipboard monitoring or
automatic context-menu synchronization; images, files and cut are not bridged.

The shared viewer session marks recovery only when a start is attempted, so an
initial capability-query timeout does not turn a retry against a legacy host into
an unsupported resume. Start and stop operations are serialized per viewer,
including cleanup of a late lease; superseded display choices are discarded before
they reach the host. An idle stop still dispatches immediately for Mobile exit
locking. This recovery stays within one viewer's lease and never closes a peer
link or the shared relay; regression tests cover another peer remaining responsive
and preserve explicit confirmation before taking over someone else's desktop.
Main retains the same owner/target cleanup barrier across Renderer replacement;
rebinding to a different owner or target does not wait on that old barrier.

The window reuses the existing resource-usage auxiliary-window controller and
factory for hidden prewarming, two-phase readiness, hide/reuse and bounded crash
recovery. Prewarming loads only the shell and never connects to or captures a
computer. Closing/minimizing retires its lease, clears pixels and stops polling;
ordinary focus loss releases held input while retaining viewing. A crashed or
automatically restored viewer uses `resume`, preserving a host's explicit stop.
An account boundary destroys the viewer windows. The host's single-viewer lease
and explicit takeover rules apply equally to phone and Desktop viewers.

No new server, media protocol or native input helper is introduced. `device-link`
owns the shared viewer lease/signaling adapters; `maker-shared/remote-desktop-viewer`
owns the browser media, input queue and geometry used by both clients. Desktop
imports it as a static module without inline scripts or eval. The Mobile HTML
embeds a generated source literal because Hermes does not preserve function
source. After editing the common browser module, run:

```sh
node scripts/sync-remote-desktop-viewer.mjs
```

The source parity test prevents Mobile from shipping a stale copy. Mobile retains
its touch UI, native keyboard, PiP and optional unlock integration. Desktop does
not add password storage, virtual controls, screen rotation or PiP. Its dedicated
preload exposes only fixed viewer/window operations; Main binds requests to the
actual window, account generation, target and returned lease. Text clipboard
contents stay in Main. `stop` never calls `closeLink` or resets the shared relay,
so other tasks, file views and peers keep their existing connections.

The local real-Chromium harness uses the production Desktop viewer with a
synthetic canvas host, validates video, keyboard and same-lease media recovery,
and saves Light/Dark screenshots in a unique system temporary directory:

Only the disposable test browser disables mDNS host-address masking. The fixture
records both data-channel input and the preload-bridge fallback. Recovery uses an
explicit closed-peer event and checks decoded frames on the replacement peer;
it does not measure how quickly a real network outage is detected.

```sh
node apps/desktop/scripts/remote-desktop-viewer-smoke.mjs http://localhost:<vite-port> /path/to/chrome
```

This harness does not establish physical Desktop-to-Desktop, cross-NAT, macOS
keyboard/permission or packaged-build support. Those retain the platform and
network verification requirements below.

## Mobile viewer

The device detail page opens the real desktop of the selected computer. On the
computer, enable **Settings → Remote control → Allow remote desktop**, as well
as device control. Screen recording and accessibility permissions are granted
in the operating system. The phone automatically requests control on connection
when the host supports input, using the existing permission and ownership checks.
**Controls → View only** releases control and preserves that choice when reconnecting
within this page. The computer always has a **Disconnect**
button while being viewed or controlled.

The host allows one active remote-desktop viewer at a time. Starting a new
viewer checks and reserves that lease atomically; if another viewer is still
connected, the controller shows a takeover confirmation. Confirming takeover
ends the previous viewer's lease before creating the new one. The host status
banner also expires abandoned viewers after the lease heartbeat timeout, so a
phone that has already gone away does not keep the computer marked as viewed
indefinitely.

## Interaction

- The fullscreen viewport has four tools: All windows, Desktop, Keyboard, and
  Controls. Portrait places them at the bottom; landscape uses a narrow side rail.
  Controls opens an overlay without resizing the picture. Titles, connection
  details and gesture help stay in this panel. Rotation changes only the phone
  viewport, never the computer's resolution. Portrait fits the full desktop;
  landscape fills the viewport height without top/bottom bars. Any horizontal
  overflow remains accessible by panning.
- Controls groups rotation, audio, view-only and system picture in picture into
  quick actions. Display settings contain frame rate, quality, actual computer
  resolution and monitor selection. Touch and Trackpad use a segmented
  selector, with a saved Show mouse buttons option. Disconnect stays visible in
  a separate footer while settings scroll.
- Trackpad mode moves the pointer relatively. Touch mode taps at an absolute
  location. Hold then move to drag, including selections and window dragging.
- Pinch zoom preserves the point under the two fingers. Two-finger gestures pan and zoom the picture; trackpad scrolling is also available through the virtual wheel. The normalized view
  focus survives rotation and keyboard resizing.
- The keyboard offers native text composition, modifier combinations, navigation
  keys, and a full key strip. Desktop / All windows use operating system shortcuts.
- Switching displays creates a new lease and retains the control/view-only choice.
  Backgrounding normally releases the lease; explicit system picture in picture
  retains viewing only. Returning to the foreground automatically reconnects. Network failures and viewer process loss also recover automatically,
  with the last picture retained, a prominent connecting indicator and capped backoff on the existing heartbeat timer.
  Portrait always has an icon-only Back button (a native SwiftUI glass button on
  iOS 26+), which cancels recovery immediately. Landscape hides Back; Controls
  still offers Disconnect. Explicit host
  disconnect, revoked access and missing permissions stop automatic recovery.
  Recovery only opens the selected peer and replaces this desktop lease; it never
  restarts the shared relay or other peers' connections.

## Transport and compatibility

`device-link:remote-desktop:v1` is an additive business invoke channel inside the
existing authenticated same-account protocol. The server protocol is unchanged.
The optional `automaticReconnect` capability and `start.resume` flag let
the host reject automatic recovery after an explicit local disconnect, including
when the phone was offline. Older phones still use ordinary starts; newer phones
retain manual connection when an older host cannot enforce this recovery boundary.
Computers without this channel reject it and the phone asks for an upgrade. Screen
data and signaling are never added to the generic broadcast allowlist.

WebRTC carries a video track and an ordered input DataChannel. Capture runs in
a dedicated sandboxed renderer with a narrow preload and exact Main-side host
identity checks. The main application renderer does not receive capture frames
or the capture bridge. Main destroys the capture host when its authority ends.
The phone runs a dedicated trusted inline WebView document; the untrusted HTML
preview's restrictions are unchanged. The mobile presentation module requests scene rotation and a playback audio session
for system picture in picture. This requires a new native mobile build. Voice
recording and ordinary audio retain their foreground-only runtime policy. Direct
connections use independent Cloudflare and Google STUN endpoints; there is no
bundled TURN service. Neither public endpoint guarantees reachability in mainland
China or across every carrier.

When WebRTC is unavailable or cannot connect, the phone uses an explicitly
labeled compatibility mode: JPEG at at most 1280 pixels per dimension, at most
180 KB before base64, one frame in flight, and no more than four capture requests
per second. Images are transient and pass through the authenticated TLS relay.
This mode trades frame rate and clarity for reachability. It is suitable for
ordinary desktop work, not game streaming. A production TURN service is the
follow-up needed for consistently smooth video across restrictive networks.

### Incremental ICE and media recovery

New desktops advertise optional `trickleIce`. When both endpoints support it,
the phone sends its offer without waiting for candidate gathering, and the
desktop answers after capture is ready. Candidates discovered later travel via
the existing authenticated `device-link:remote-desktop:v1` invoke channel's
`ice` operation. No new server message kind, listening port or credential store
is introduced. Older endpoints retain the full-SDP path, with a five-second
gathering deadline.

Three identifiers have different lifetimes:

- The peer-bound lease owns viewing/control. Media recovery never obtains a new
  lease, takes over another viewer or renews authorization on its own.
- `attemptId` owns one offer/answer and its peer connection. Replacing an attempt
  invalidates asynchronous capture, answers and candidate responses from its
  predecessor. The host rechecks the lease after asynchronous work.
- A viewer-local `exchangeId` owns one candidate request/reply. A late response
  cannot acknowledge candidates from a later request. The host's `after`/`next`
  cursor reads a retained candidate buffer, so retrying a lost reply is safe.

Candidate batches contain at most 16 entries, with at most 128 candidates per
attempt and 2,048 characters per candidate. Fields and cursors are validated on
both sides. Duplicate candidates are applied once. A timed-out exchange does
not tear down healthy video; polling is bounded to 30 seconds. SDP, candidate
addresses, credentials and desktop content are not added to logs.

| Phase | Bound |
| --- | --- |
| Desktop source enumeration | 2 seconds with native capture, 5 seconds otherwise |
| Desktop offer command | 18 seconds |
| Remote-desktop invoke | 30 seconds; other invoke channels are unchanged |
| Viewer waiting for answer | 25 seconds |
| ICE checks after answer | 15 seconds |
| Temporary media disconnect | 5-second grace period |
| Automatic media retries | 1, 3 and 8 seconds; restored after 30 seconds connected |

On a transient disconnect the viewer keeps the picture, releases held input and
shows the existing reconnecting badge. Input uses the existing authorized invoke
path while the data channel is disconnected. Recovery changes only this remote
desktop's media connection; shared device-link sessions and other peers are never
reset. Exhausted retries leave the existing JPEG compatibility transport
available. Explicit stop, lease replacement and leaving the page cancel timers
and invalidate late work. Permission/capture errors that require user action do
not repeatedly start media attempts.

For mainland-China deployment, restrictive NAT and UDP-blocked networks still
need authenticated regional TURN with short-lived credentials and UDP plus
TCP/TLS fallback, tested across carriers. This change does not provision that
infrastructure or add an unconfigured TURN option. Native ICE retains available
LAN, IPv6 and overlay-network candidates; being on Tailscale does not itself
prove that the media path is direct.

Deterministic tests exercise candidate replay, stale generations, bounded retry,
lease takeover isolation and old-version signaling. The loopback smoke harness
uses real Chromium WebRTC and synthetic video, delays candidate delivery, loses
an exchange response, verifies input and recovers after closing the host peer:

```sh
node --import tsx apps/mobile/scripts/remote-desktop-network-smoke.mjs [chromium-executable]
```

This harness does not validate WKWebView, Android WebView, carrier NAT, regional
STUN availability, TURN relay performance or Windows native capture. Those need
device/network verification before claiming a measured connection-success gain.

## Input failure releases control (2026-09-11)

Control is a lease-scoped capability, not the session itself. When the host can
no longer inject input — the native helper died, it reported a failed injection,
or its write path failed — it releases control and keeps everything else: the
lease, the capture owner, the video track and the last picture. It does not call
`stop()`, so an input fault can never surface as an ended desktop session.

The host also releases control when its own input path refuses a batch before
injecting anything, so the two sides cannot disagree about who controls: a later
take-control genuinely restarts the helper instead of being skipped as "already
controlling".

The viewer follows the host's control bit instead of rebuilding the session. A
rejected input batch, a failed control request or a heartbeat that reports
`controlling: false` all drop the phone to view only with the existing view-only
hint and take-control action; media and lease identity are untouched. A dropped
stalled batch (WebView overflow) also asks the host to drop control: posting
`control:false` to the WebView clears its queued release without flushing it, so
only an explicit host `control enabled:false` (which stops the input helper and
injects a native release) can let go of a held key or button. If that host
request times out, the viewer keeps the intended control bit and the next
heartbeat retries the release (or restores local control after a lost
take-control reply) instead of ignoring a host-`true` while the phone stays
view-only. A heartbeat that still reports view-only while `startInput()` is
settling does not consume that pending take-control: only a later beat, after
the transition, may reconcile. An unconfirmed overflow release stays
authoritative until the host is view-only: taking control finishes that
release (`stopInput`) before asking to enable, so the helper restarts. Errors whose outcome is unknown — a lost reply (`INVOKE_TIMEOUT`) or
a control request that collides with one still settling — do not rebuild the
session: a batch that may have been injected must not be answered with a
release that discards its key-up, and the heartbeat still owns liveness. Errors
that do mean the lease is gone (`DESKTOP_LEASE_EXPIRED`, `DESKTOP_STOPPED`,
revocation, an unsupported channel) still recover the session as before.

This matters most on Windows, where the SendInput helper reports a failed
injection as a helper failure whereas the macOS helper posts events without a
result path. On Windows the helper now costs control only; whether a specific
machine can inject at all (elevated foreground window, secure desktop, a session
worker outside the interactive window station) is a separate, still unverified
question, and the helper's `error` line does not yet carry a reason.

Deterministic tests cover the controller release (lease, media and single-viewer
arbitration retained; later input refused as view-only; control can be taken
again), the desktop wiring that turns a refused or failed input batch into a
release rather than a stop, the failure classification (release, unknown outcome,
rebuild), and the viewer paths that drop to view only without reconnecting.

## Authority and lifetime

On macOS, enabling remote desktop automatically checks screen recording in the
capturing Cindy process and accessibility in the actual input helper. It opens
an in-app guide if either permission is missing or unconfirmed. The guide reuses
Computer Use's interactive permission rows and fixed System Settings targets;
it never treats CuaDriver's permissions as remote desktop permissions. The
settings page and guide recheck automatically, including when focus returns.
Closing the guide cancels any pending follow-up that would open System Settings.

The phone shows separate permission states and can request this Cindy guide on
the computer. This is a documented, narrow exception to the no-UI invoke rule:
only the remote-desktop business handler accepts `permissions/check|guide`,
after both local opt-ins and controller revocation checks. It accepts no URL,
never changes the opt-ins, and never opens OS settings or grants OS permission
from a remote request. Those actions require a button in the trusted local UI.
The added capabilities field is optional for older desktops; without it the
phone retains the text guidance and reconnect action. Permission recovery stays
within remote desktop and never restarts shared device-link connections.

Desktop authorization is a separate local default-off preference. The lease is
bound to the relay-verified source peer and a random lease ID, and renewed every
three seconds with a twelve-second expiry. Every input and completed capture is
checked against current authorization. Local stop, revocation, relay loss, peer
offline, display changes, and capture-host loss stop the lease. Stale operations
cannot resurrect a stopped lease. Input sequence numbers prevent replay.

### Local UI authority versus compromised application code

Local control switches, controller restoration and revocation require a
registered Cindy application top-level frame. Account capability alone does not
authorize these IPC calls. None of the local remote-desktop or control-grant
channels is available through the remote invoke allowlist. This source check
does not add another confirmation to ordinary settings changes.

These checks authenticate the calling surface, not the person behind each
JavaScript call. They cannot distinguish the legitimate application from
arbitrary JavaScript executing in the same main application frame. That frame
also has existing terminal, file-editing and Agent-control bridges. Capture
isolation and a native confirmation on one switch do not isolate those other
capabilities or protect same-user settings against arbitrary local execution.
The compromised-main-renderer opt-in path remains a security review concern;
the source checks must not be presented as resolving it. Addressing that threat
requires a coordinated application capability boundary, rather than treating
one extra dialog as proof of local human consent.

The native helper holds actual down/up state and releases it on EOF/stop, with a
watchdog for an unresponsive parent. Input batches and queues are bounded; a
backpressure failure stops control rather than silently dropping key-up events.
CUA Agent actions and human input share a process-local ownership guard. Other
applications and separate Cindy processes are outside that guard.

## Platform and verification limits

macOS uses a signed Swift helper; Windows uses a Rust helper with Win32 SendInput.
Forge builds and packages both through the existing tools signing paths. Linux
currently offers viewing only. Neither helper bypasses OS security boundaries:
Windows secure desktop/UAC and elevated applications can reject input, and
macOS lock/login screens and protected surfaces are not guaranteed controllable.
System audio and explicit clipboard transfers are supported when advertised by the host. Virtual displays and remote power-on are not included. The phone keyboard sends committed text directly; the computer keyboard supplies modifiers and special keys.

The Windows input helper reports a failed call on the single output line its host
already treats as "input failed": `error send_input <status>` when Win32 rejects
an injection, and `error input_desktop <status>` when the desktop binding fails,
with the Win32 status of the failing call. The line carries no coordinates and no
typed text, and both consumers (Main's output watch and the SYSTEM service
worker's failure watch) still classify it by the same rules as before.

Unit tests cover peer/lease isolation, expiry, revocation during asynchronous
capture, start/stop races, input replay, human/Agent exclusion, portrait/landscape
geometry, keyboard resize, inline viewer parsing, two-finger gestures, and reconnect.
The related desktop, mobile, and device-link test suites pass. A disposable
Chromium receiver verified live WebRTC video, ordered input, portrait/landscape
resizing, and capture cleanup. The macOS helper was exercised against an isolated
development window with Chinese/Emoji text, Command+A, and release on exit; the
Windows helper passes a Windows-target compilation check.

These checks do not replace end-to-end validation on an actual phone. First-run
OS permission flows, real-device WebView RTC behavior, Windows input, packaged
signing, light/dark phone rendering, and different network topologies still need
device validation before release.

## Display controls (2026-09-07)

Operations provides Rotate, Sound, View only and system Picture in picture, with
Display settings in a separate panel. Video settings are optional additions to
`offer`: 30/60 fps, automatic bitrate or 2/8/20 Mbps ceilings, and desktop audio.
These are encoder/capture targets, not guaranteed measured rates or lossless
quality. Compatibility JPEG transport does not apply them; the UI reports that
fallback. Old viewers keep the original 1920-pixel/30-fps capture bounds. New
viewers only send settings when the host advertises `videoSettings`.

System audio defaults on with the viewer preference saved locally, supported on Windows and macOS 14.2+, and selected by a
single-use display capture grant tied to the current offer, lease and trusted
main renderer. No microphone is captured. macOS packaging declares
NSAudioCaptureUsageDescription; development launchers must also have the OS
permission. Linux audio is not advertised.

`displayModes` and `resolution` operate on the lease's display. macOS uses
CoreGraphics mode enumeration and applies only an available mode ID for the
current login session. The operation requires control and rechecks lease and
authorization after native preparation. It changes the actual computer display,
not just the encoded image. Geometry changes release capture/input; only this
remote desktop reconnects with fresh dimensions. The shared relay and other
peer links remain untouched. Windows/Linux display mode changes are currently
unavailable and are not advertised.

System PiP is offered only when WebKit reports support for this video and the
native presentation module and host backgroundViewing capability are present.
Entering releases control. A capture-renderer challenge/pong heartbeat renews
only a view-only lease while the viewer reports actual system PiP presentation.
Closing PiP, closing WebRTC, local disconnect, revocation and the ordinary finite
lease timeout all terminate background viewing. This does not grant indefinite
background control or extend the lifetime of unrelated device links.

Validation for these additions: static compilation only; no interaction tests,
network multi-peer tests or Light/Dark visual inspection, per the user's request.
PiP/WebRTC background playback and audio permission behavior need device testing.

## Locked-session capture (2026-09-07)

The installed UU 4.35.0 bundle imports both ScreenCaptureKit and the legacy
CoreGraphics display-stream API. Its launch agent declares LoginWindow and Aqua
session types and it has a separate root daemon. This demonstrates that capture
and session lifecycle are separate concerns; imports do not prove which backend
UU selects while locked.

Cindy now has a macOS native compatibility capture child for a logged-in user.
If Chromium capture fails, times out, ends or mutes, its bounded JPEG frames feed
a canvas video track on the existing WebRTC connection. Lock/unlock notifications
discard cached pixels and release held input. Main validates the exact renderer,
active lease and current generation before returning pixels. Stop, expiry and
revocation kill capture; EOF and a five-second native watchdog also terminate it.
No frame or typed password is saved and no public listening port is added.
The fallback targets 15 fps and at most 1280 pixels on the longest edge; existing
audio tracks may survive, but starting directly in fallback has no system audio.

The legacy public API is runtime-resolved because SDK 15+ marks it unavailable.
It may be absent or denied by macOS/TCC. A live probe on this macOS 27 machine
found the missing condition: a sleeping display accepted stream creation/start
but delivered no frames. Waking the display with IOPMAssertionDeclareUserActivity
immediately delivered the actual password/lock screen while IOConsoleLocked
remained true. The helper now performs that wake after checking capture access.
The authenticated viewer lease holds Electron's prevent-display-sleep assertion
and releases it on stop/expiry/revocation on all supported Electron platforms.
The macOS JPEG compatibility transport uses the same native path.

An explicit display-sleep → fixed-helper probe returned its first frame in
874 ms with the OS still locked, and EOF terminated the helper with exit 0.
This verifies capture on this Mac, not Windows/Linux or pre-login/FileVault
support. System authentication is unchanged; no password is stored or supplied.

A second failure was the unconditional display-metrics-changed teardown: display
wake emitted that notification and ended a valid lease. Only bounds, scale or
rotation changes on the selected monitor now end the lease; work-area changes
and changes to other monitors do not invalidate whole-display input coordinates.

End-to-end checks through two authenticated Cindy clients on this machine passed:
JPEG capture followed by WebRTC decoded 160 frames in six seconds. A separate
display-sleep → direct WebRTC connection (without a preliminary JPEG request)
decoded 74 frames in six seconds; its received-video snapshot showed the actual
system password/lock screen. Heartbeats remained successful. After disconnect,
active lease was null, no capture child remained and PreventUserIdleDisplaySleep
was zero. Desktop typecheck and native arm64/x86_64 compilation passed. These
checks cover the current Mac's locked, already logged-in session, not the phone's
cellular route or other operating systems. Display wake does not power on a
shutdown computer or provide pre-boot FileVault access.

Remaining platform adapters are explicitly separate:

- macOS pre-login: a signed LoginWindow agent and authenticated system-service
  lifecycle are still required; never run the whole Electron application as root.
  An OS-approved install/uninstall flow must precede enabling that service.
- Windows secure desktop: the SYSTEM broker and session worker are implemented
  below; runtime validation on Windows is still required. [Microsoft documents LOCAL_SYSTEM access requirements](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_2/nf-dxgi1_2-idxgioutput1-duplicateoutput).
- Linux: keep X11 and Wayland/compositor capabilities distinct. GNOME remote
  assistance closes on lock, while GDM remote login is a separate service and
  session type; it must not be presented as restoring the user's same desktop.
  [GNOME's modes](https://github.com/GNOME/gnome-remote-desktop/blob/main/README.md).

The macOS pre-login and Linux service adapters remain unimplemented. The remote business protocol and shared relay are unchanged. Recovery
affects only this desktop lease/video track, not other connected peers.


### Windows system service (implementation awaiting Windows runtime validation)

Packaged Windows builds include a native SCM service, a Main-only Node-API pipe
transport, a session-scoped SYSTEM GDI capture worker and the SendInput helper.
The settings page installs/removes the service through Windows administrator
consent. Only a protected all-users Program Files installation is eligible;
per-user/development installations retain the ordinary desktop path.

Authorization records a live process handle for the Cindy process explicitly
approved through the elevated setup helper. Executable path alone is insufficient:
plugin utility processes share Cindy.exe. The service starts on demand and exits when its approved Cindy process exits.
Restarting Cindy or the service requires fresh administrator approval. This is a current limitation, not unattended
post-reboot support. No authorization secrets or screenshots are persisted.

The broker validates file/directory ownership, writable ACLs, reparse points,
SCM identity, peer PIDs and active console session. It retains installation
handles for its lifetime. Workers are fixed-purpose children in kill-on-close jobs
with local-only, bounded, timed pipes. Uninstall/upgrade waits for the service to
stop before removing binaries. Upgrade clears the authorization.

Desktop transitions terminate the old input helper, including pending batches
and long text input; Main then recovers only the remote desktop lease. Ctrl+Alt+Del
is routed through service-side SendSAS impersonating the approved user's session.
Windows policy decides whether software SAS is allowed; Cindy never changes it.
Capture follows the input desktop and validates the selected monitor's geometry.
The GDI compatibility stream is capped at a 1280-pixel long edge and 180 KB JPEG.

Validation available on macOS: Windows-target Rust compilation checks and Desktop
TypeScript checking. Still required on Windows 10/11: signed package linking and
installation, administrator consent/cancellation, lock/unlock, UAC, policy-enabled
SAS, mixed-DPI displays, worker cleanup, upgrade/uninstall, and plugin rejection.
Windows display-mode changes and pre-login/unattended post-reboot control are not
implemented. Linux remains deferred. Do not present this as fully validated
Windows support or advertise high-frame-rate secure capture.


### Keyboard clipboard actions

The keyboard's leading clipboard button opens two actions in both phone and
computer keyboard modes: **Copy to phone** reads the focused desktop application's
selected text, or existing computer clipboard text when the selection is empty; **Paste from phone** writes phone clipboard text to the computer
and sends its platform paste shortcut. Transfers are explicit, text-only and
limited to 16,384 UTF-16 code units; oversized content is rejected, not truncated.

Copy uses macOS Accessibility selected text or Windows UI Automation TextPattern
selection. If an application does not expose its selection, copy fails explicitly.
A confirmed empty selection falls back to the computer clipboard, as explicitly
requested by the user. Permission failures, unsupported selection APIs, protected
fields and oversized selections do not trigger fallback. Clipboard fallback reads
check the change counter before and after reading; concurrent changes fail rather
than returning an inconsistent value. Secure/locked desktop selection
and password fields are not advertised as clipboard sources. Native selection
output stays in memory; helper/JSON errors are sanitized before returning across
the device link. Paste uses Command+V on macOS and Control+V on Windows.

The optional `clipboardText` capability and `clipboard` operation are additive on
the existing remote-desktop business channel. Old desktops show an upgrade hint;
no relay/server protocol changes are required. Both operations require the current
peer-bound controlling lease, reject concurrent transfers, and check revocation
again after asynchronous native work. The phone also discards results after its
lease changes or it leaves the foreground. No clipboard listeners, background
synchronization, history, logs containing text, or disk persistence are added.

TypeScript and native compilation checks cover this implementation. Keyboard/menu
interaction, application-specific selection support, and physical-phone transfer
have not been exercised; manual verification remains with the user.


### Portable clipboard content

New peers advertise optional `clipboardContent`; legacy `clipboardText` and its
16,384-character limit remain unchanged. New iOS native builds read and write a
single pasteboard item atomically, preserving available plain text, HTML, RTF,
HTTP(S) URL and a PNG image representation. JPEG/HEIC still images are converted
to PNG without a lossy transport compression step. Electron writes all supported
representations together before Command/Control+V. Selected computer text still
takes precedence over the computer clipboard; confirmed non-text controls may
fall back to clipboard content, but protected/failed/stale selection reads do not.

Clipboard JSON is transferred sequentially in 64 Ki-character chunks, at most
32 Mi-characters total (native iOS additionally bounds UTF-8 bytes). Images are
limited to 64 million pixels. Each transfer is peer/lease/control-generation
bound, lives only in memory, expires after 60 seconds, and is discarded on
control changes or disconnect. Commit consumes its transfer before pasting and
is never automatically retried. No transport/global frame limits are changed.
Mobile builds lacking the new native API retain the original text route and
request an upgrade for images.

This is **not arbitrary-format or file synchronization**. File references,
multiple iOS pasteboard items, multiple macOS pasteboard items, unsupported-only
content and animated UIKit image representations are rejected. App-private
formats accompanying a portable representation are not transmitted. HTML/RTF
references to external assets are not downloaded or inlined. Files need a
separate byte-transfer and owned-file lifetime implementation; remote paths must
never be pasted as if they were local files.

Validation: mobile/desktop TypeScript checks, iOS device compilation, macOS
helper typecheck and Windows cross-compilation check. No actual clipboard content
was read and no physical-device or Windows application paste was exercised.

### macOS local cursor overlay

Optional `cursorOverlay` on capabilities, offer and compatibility-frame requests
negotiates cursor-free capture; omitted flags retain the original protocol.
The macOS helper reads the global NSCursor image/hotspot and the public legacy
CGCursorIsVisible symbol, with normalized position within the selected display.
No cursor-hiding call is applied to the user's physical desktop.

Current Electron does not advertise the cursor media constraint. The negotiated
path therefore uses native cursor-free video (up to 4096 pixels on the long edge,
selected 30/60 fps as capture caps). It retains Chromium system audio when requested.
A bounded JPEG intermediate is encoded into the existing WebRTC stream; unusually
detailed frames reduce quality/size to fit the 1 MB native-frame limit. Actual
frame rate depends on capture, decode and network costs; 30/60 is not a measured
delivery-rate guarantee.

Cursor PNG/dimensions/hotspot/visibility are validated and travel on the existing
lease-bound frame response and input-v1 data channel. Only the latest cursor is
retained; congested cursor updates are skipped. On the phone the cursor keeps
its source colors, moves immediately with touchpad input, and accepts host
position corrections only outside active touchpad movement. Late messages from
old RTC generations are discarded. Hidden cursors are not drawn. Unsupported
cursor images fall back to the existing position indicator without killing video.
Both Light and Dark use the source raster rather than tinting it.

Checked: desktop/mobile types, native compilation, a bounded read-only native
capture returning cursor geometry/raster metadata. Real phone gestures,
application-by-application cursor transitions and sustained frame rate remain
for manual verification.


## Clipboard and connection handoff

The keyboard clipboard menu offers Copy to phone and Paste from phone. Copy
requests the selected content first, falling back to the existing computer
clipboard. Transfers support text, HTML, RTF, URLs and PNG images through bounded,
sequential chunks, with a blocking progress overlay. Arbitrary files and private
application clipboard formats are not supported. Transfer buffers are discarded
on completion, cancellation and lease termination; uncertain paste responses are
never automatically retried. Native clipboard access requires a new iOS build.

Only one viewer lease is active. A second viewer sees a busy state and can
explicitly take over when the host advertises `connectionTakeover`. Ordinary
starts never evict an existing viewer. Takeover stops the old lease and input;
the former viewer cannot automatically reconnect with `resume` to evict the new
viewer. Older hosts retain the busy message without a takeover action.

Brief iOS inactive transitions (such as an interrupted Home gesture) retain the
connection. Actual backgrounding releases control unless system PiP is active.
Reconnection retains the last picture but disables input until a fresh lease is
ready. Touch/trackpad, mouse-button visibility and audio preferences are saved
locally. Landscape hides the network status overlay to preserve picture space.
