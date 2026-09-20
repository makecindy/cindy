# Remote desktop

## Desktop viewer

The desktop interaction hierarchy follows a canvas-first approach: device and
connection status at the left, grouped zoom/fit/actual-size actions, then grouped
icon-only Display & Sound, Clipboard and Security popovers. These are
separate, short task panels rather than one scrolling checklist. Local fit never
changes the host resolution; received audio and host mute have separate controls.
Unavailable safety options remain visible with an explanation. Confirmed privacy
and actionable failures remain visible outside the popovers.

Popovers release held remote input, support Escape and outside dismissal, and
return keyboard focus to their trigger. Switching panels does not restore focus
to the previous trigger. Clicking the remote canvas while a panel is open only
dismisses it; it does not send that click to the remote computer. Fullscreen keeps
the toolbar visible while a panel is open, including its portalled controls.

Desktop can open a same-account computer's remote desktop from its device card
in Remote control settings, or the task-list machine menu's Remote desktop submenu.
When the sidebar is grouped by machine, hovering or keyboard-focusing a remote
machine reveals a desktop shortcut. A read-only capability check runs when an
eligible device first appears, and is reused until presence, permission, platform
or version changes. Unavailable shortcuts remain clickable and explain how to
enable the required permission. Online devices remain listed without tasks.
Hovering never starts desktop capture or takes over another viewer, and clicking
the shortcut does not expand or collapse the machine group.
It opens a clean, independent window with native mouse/keyboard input and a small
toolbar. Reopening the same target focuses its existing window. Full screen,
display selection, sound, video settings and portable
clipboard shortcuts are available. Resolution changes appear only for a capable
host and affect its actual monitor. Ctrl+Alt+Esc releases keyboard focus;
Cmd/Ctrl+W requests closing this viewer, including while it owns keyboard focus.
Native window close and the close shortcut share a confirmation
dialog only after a connection is established; cancelling keeps the connection and control lease. Confirmation belongs
to the current window generation and cannot close a later connection.

Desktop uses the local system cursor inside the remote picture, with standard
shape hints from the host. Pointer size is independent of remote resolution and zoom.
With the picture focused, Cmd+C/V on macOS or Ctrl+C/V on Windows copies selected
remote content to the local clipboard or pastes local content remotely. Transfers use
the existing authorized Main bridge, are ordered and user-triggered, and report
failure without reconnecting. Capable hosts support text, HTML, RTF, URLs and PNG;
older hosts retain text-only behavior. Arbitrary files and cut are not bridged.
Manual actions and progress are also available in the settings panel. Optional
clipboard synchronization reuses Mobile's version, conflict and bounded-transfer
logic, only while this viewer is focused and holds confirmed control. Contents
stay in Main/native code and do not cross the viewer Renderer bridge.

The settings panel also supports host privacy screen, host mute, lock-on-exit and
macOS-to-macOS automatic unlock. Non-secret preferences are scoped to the local
account and target computer; only explicit overrides are stored. Host effects
are capability-gated and applied after control is confirmed. Privacy failures
remain visible ahead of mute or clipboard notices, with explicit retry. Explicit
exit waits for the requested lock; reconnect and display changes do not lock.
See [native credential behavior](remote-desktop-credentials.md) for password storage.
Video quality changes are coalesced while negotiation is pending. The toolbar
shows receive rate and clears stale network samples, while resolution discovery
shows loading/failure and offers retry and native-resolution labels.

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
ordinary desktop work, not game streaming. Clients also support authenticated,
short-lived TURN configuration as described in
[connectivity](dev-rules/remote-desktop-connectivity.md); actual relay availability
depends on the service deployment.

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

| Phase                      | Bound                                                   |
| -------------------------- | ------------------------------------------------------- |
| Desktop source enumeration | 2 seconds with native capture, 5 seconds otherwise      |
| Desktop offer command      | 18 seconds                                              |
| Remote-desktop invoke      | 30 seconds; other invoke channels are unchanged         |
| Viewer waiting for answer  | 25 seconds                                              |
| ICE checks after answer    | 15 seconds                                              |
| Temporary media disconnect | 5-second grace period                                   |
| Automatic media retries    | 1, 3 and 8 seconds; restored after 30 seconds connected |

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
TCP/TLS fallback, tested across carriers. Clients fetch deployed TURN configuration
through the authenticated ICE endpoint; this does not itself provision relay
infrastructure. Native ICE retains available
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
CUA Agent actions yield to actual remote input, rather than to an open control
connection. Queued native batches, held mouse buttons/keys, and a 300 ms quiet
interval after native completion exclude new Agent actions. An already-dispatched
Agent primitive finishes before remote input is delivered; further Agent text
chunks yield. Agent actions are never automatically replayed. After remote input,
the Agent must successfully observe the target window again with input idle at
both the start and end of the read and no input revision change during the read
before acting on it, including the first action of a new or cleaned-up driver
session. Actions without a window ID accept an observation of the same process;
an explicit window ID still requires that exact window. Automatic recovery reads
are text-only evidence, do not capture screenshots, and do not restore input permission. Failed or cancelled explicit
reads revoke prior permission, and older concurrent reads cannot restore it.
Empty connection
heartbeats do not claim input ownership.

The native macOS/Windows helper acknowledges a batch only after posting all its
events; the Windows service forwards that acknowledgement. Main retains ownership
through native shutdown when stopping held input. The guard coordinates only
remote input and CUA calls in this Cindy process: physical keyboard/mouse input,
other applications, and separate Cindy processes are outside it. Native event
posting is not proof that an application has finished handling those events.

## Wayland capture lifetime

On Hyprland with the system `/usr/bin/grim` executable, Cindy uses native screencopy
for unattended viewing. Existing remote-control and remote-desktop opt-ins, peer
revocation checks and expiring leases authorize each connection. No portal picker,
restore token, system permission override or persistent image is involved. The
compositor's own capture permission still applies; a refusal produces no frame.
Hyprland outputs have stable `hyprland:<output-name>` IDs and logical geometry.
The legacy whole-desktop ID remains accepted for old viewers. The JPEG backing layer and
WebRTC video share the actual desktop aspect ratio, including 16:10 displays. Each
bounded JPEG pull is serialized, kept in memory and cancelled on disconnect.
The existing canvas/WebRTC and JPEG relay transports consume these frames.
For a selected unrotated output, a persistent Wayland screencopy child reuses its
connection and shared-memory pixel buffer. JPEG encoding uses libjpeg-turbo;
frames stay in memory, capped at a 1920-pixel long edge and 1 MB each, with serial pulls targeting the
negotiated 30/60 fps (not a guaranteed delivered rate). Capture/decode time counts
toward the frame interval instead of adding another full interval afterward.
Unsupported layouts or unavailable helpers use grim for the remainder of the
lease. Disconnect kills the child; EOF, a three-second capture/write deadline,
and a ten-second idle watchdog bound orphaned processes. No new peer protocol or
permission grant is introduced. This requires a running user desktop session; capture while locked, after logout or
before login is not promised. PipeWire audio support is described below.

Hyprland control is advertised only when the bundled input helper can find the
Wayland virtual-pointer and virtual-keyboard protocols. Taking control creates
user-session virtual devices; no root service, uinput permission change or shell
command injection is involved. Selected-output mouse coordinates are mapped into
the full logical layout, including negative origins and mixed scales. Layout
changes release input before its coordinate mapping can become stale.
The existing native-helper handshake, serialized acknowledgements,
input ownership and disconnect teardown apply. EOF releases held buttons/keys;
a six-second watchdog releases input if its parent stops responding (with a
one-second hard shutdown bound if the compositor is also stalled).
Text uses a temporary virtual keyboard and in-memory Unicode keymap, never the
clipboard or process arguments. Text is paced and sent in acknowledged chunks
of at most 256 code points so long pastes stay within the helper deadline. Physical key events use a US virtual keyboard layout. English and
Chinese text are validated; supplementary-plane symbols (including emoji) can
be truncated by Chromium’s Wayland text handling even with a correct keysym. Other Wayland
compositors keep their existing view-only portal path.

Linux native builds require `cc`, `pkg-config`, `wayland-scanner`, and development
headers for `wayland-client`, `xkbcommon`, `json-c`, `libturbojpeg`, and `libpng`; packaged builds include
the helpers and require the corresponding shared libraries. In development it is
compiled into the existing userData native cache. Missing support keeps viewing
available and does not advertise control. Native parser checks (no compositor or
input injection): `node --test apps/desktop/native/remote-desktop/linux-input/test.mjs`.
Capture buffer/stride/scaling checks use synthetic pixels with ASan/UBSan:
`node --test apps/desktop/native/remote-desktop/linux-capture/test.mjs`.

On this 2560×1600 Hyprland machine, the final persistent helper averaged 36.9 ms
per frame (including scaling/JPEG), compared with 317.2 ms for per-frame grim.
A local Chromium/WebRTC loop decoded 60 frames in five seconds, retained the
16:10 aspect ratio, and used the persistent helper throughout. That loop includes
the test driver's bridge and automatic WebRTC resolution adaptation; it is not a
phone/network latency benchmark or a guarantee of 30/60 fps. Desktop types,
related unit tests and native memory/bounds checks pass. Phone-side smoothness
and packaged Linux startup still require validation.

Other Linux Wayland environments (including XWayland applications) expose
one portal-selected surface. Electron's PipeWire source is not a physical monitor
enumeration and may have an empty `display_id`; see the
[Electron Linux caveat](https://www.electronjs.org/docs/latest/api/desktop-capturer#linux)
and [source contract](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source).
The host advertises one view-only display slot. Its initial 1280×720 geometry is a
viewport placeholder; video/JPEG dimensions describe the selected surface. The
existing viewer fallback supplies its localized display name.

A lease creates one isolated capture window and starts one system picker. Local
consent may take up to two minutes, independently of each bounded video RPC.
Offers first check the existing frame operation for a ready surface; while it is
empty, `DESKTOP_CAPTURE_PENDING` keeps the browser viewer's existing retry timer
active without consuming network retry attempts. Native iOS receivers use their
existing finite retry configuration with fifteen eight-second consent slots before
the normal network retry slots; this does not require changing the native binary.
Mobile allows an additional two minutes only for the `wayland-portal` display.
A video attempt timing out stops
only its peer; it does not reopen the picker.
Subsequent offers clone the same authorized stream, and the existing JPEG frame
operation snapshots that stream, without enumerating sources again. Frames while
permission is pending or the video track is muted are empty. Denial stays terminal
for that lease; polling does not ask again. There is no persistent capture token or
new unattended access grant.

Explicit stop, lease expiry, host disable/revocation, capture-process failure and
system sharing termination dispose the capture owner. Every late portal callback
rechecks both the owner generation and lease. Since Electron does not expose
cancellation for an in-flight `getSources`, picker exclusivity is scoped to the
capture generation. A retired picker neither blocks the new owner nor authorizes
it, and its completion cannot clear the replacement owner's selection state.

The existing capabilities, lease, offer, ICE and frame protocol remains intact.
Older viewers treat pending consent as a video failure and retain their original
bounded retries; the extended consent window requires the updated viewer.
On the portal fallback, Linux input/audio support is
unchanged. X11, macOS and Windows retain their capture paths. No relay reconnect,
server change, mobile native dependency or runtime fingerprint change is needed.

Regression coverage includes delayed consent, one-shot selection, video timeout
with JPEG fallback, revocation before selection, stale replies, ended/muted tracks,
clone ownership and bounded JPEG size. Real compositor/phone validation still needs
the running build: select a screen locally, check video and JPEG fallback, retry
video without another picker, then stop sharing and verify capture terminates.

## Platform and verification limits

macOS uses a signed Swift helper; Windows uses a Rust helper with Win32 SendInput.
Forge builds and packages them through the existing tools signing paths. Linux
Hyprland uses the Wayland virtual input helper described above; other Linux
paths remain view-only. No helper bypasses OS security boundaries:
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
permission. Hyprland hosts with `pw-record` capture the default PipeWire output
monitor as 48 kHz stereo float PCM. The trusted capture renderer schedules at most
150 ms into an AudioContext destination and adds its track to the existing WebRTC
stream; it never connects to local speakers. Main retains at most 100 ms of PCM,
checks the exact capture window and opted-in video lease on every read, and stops
the child on disconnect, capture failure, a stalled producer or absent consumer.
Native audio launch/read failures clean up only audio resources: the video answer,
connected video/control channel and lease remain valid. A later offer starts a new
audio capture; callbacks from a retired capture cannot affect its replacement.
Lock transitions stop the producer and clear the renderer audio track. A confirmed
unlock of the still-current lease restarts the producer and replaces the existing
WebRTC audio sender's track without renegotiating the video connection. A repeated
lock or ended lease invalidates pending recovery; a failed audio recovery leaves
video and control available. Locked or unknown compositor state denies audio reads.
This does not add audio to the compatibility JPEG transport.

Linux host mute uses PipeWire `softMute` on the playback branch, retaining the
monitor signal for the phone. While the generic remote-session `hostMute` lease is
active, it follows default-output changes and tracks every exact output object
(id plus serial), so newly selected outputs are muted too. On release it restores
each saved `softMute` value; an unplugged output is discarded and cannot cause
restoration to modify a reused node ID. Transient PipeWire failures use bounded
backoff retries while the snapshots remain owned by the lease. Requires `pactl`,
`pw-dump` and `pw-cli`. A null-output integration test verifies that playback mute
leaves the captured tone nonzero; Chromium/WebRTC tests verify remote decoding.

`displayModes` and `resolution` operate on the lease's display. macOS uses
CoreGraphics mode enumeration and applies only an available mode ID for the
current login session. The operation requires control and rechecks lease and
authorization after native preparation. It changes the actual computer display,
not just the encoded image. Geometry changes release capture/input; only this
remote desktop reconnects with fresh dimensions. The shared relay and other
peer links remain untouched. Hyprland enumerates the selected output's native
modes and accepts only an ID from that enumeration. Both legacy and Lua config
interfaces are supported; no configuration files are written. Windows display
mode changes remain unavailable.

Hyprland phone-fit uses a uniquely named headless display and temporarily mirrors
it to the original output. A Python standard-library helper owns the mirror and
workspace moves. EOF, missed heartbeats and termination restore the source and
its numbered and named workspaces through the same migration path. Special
workspaces and workspaces on other outputs are excluded. The legacy dispatcher
cannot represent workspace names containing whitespace and rejects those names;
the Lua interface supports them. Cleanup will
remove only its own output; restoration retries keep the in-memory snapshot alive
through temporary compositor errors. A missing source is treated as unplugged.
The helper requires a running user compositor, Python 3 and the native Hyprland
capture prerequisites (including `grim`). Capability advertisement and creation
share this check: portal capture cannot target its Hyprland-only display IDs.
It does not provide
pre-login access or a physical privacy screen. Explicit mirror/special-workspace
configurations are rejected rather than being silently replaced. Live scratch
output tests cover resize, EOF, heartbeat timeout and SIGTERM cleanup.

Linux clipboard transfer uses the existing bounded portable-format path and an
opaque content generation. Native reads and writes refuse a locked or unknown
compositor session; logind's advisory `LockedHint` does not prove it is unlocked.
Clipboard reads recheck after each subprocess result. Window lists and actions
use the same compositor probe, including after asynchronous dispatch preparation
and before returning titles. These checks also apply to Quickshell, independently
of whether its locker supports automatic password unlock.
Hyprland reads use bounded `wl-paste` calls, so an unfocused Cindy window can
read the actual system clipboard. A bundled data-control writer offers text,
HTML, RTF and PNG together, without subprocess arguments or temporary files
containing clipboard data. It owns only the explicitly copied value until
replacement or app exit; it does not observe later clipboard changes. Native
parser checks run with ASan/UBSan via
`node --test apps/desktop/native/remote-desktop/linux-clipboard/test.mjs`.
Live tests verify simultaneous text/HTML/RTF offers and native text/HTML reads.
`loginctl lock-session` implements lock-on-exit; success requires `LockedHint=yes`,
not merely successful delivery of the lock request. An installed session locker
is required. Real phone clipboard, lock and sound playback still need end-to-end
validation with the running development build.

Foreground mobile viewers release their lease immediately when signaling goes
offline or heartbeat reports `DEVICE_OFFLINE`, matching the host's teardown.
Returning online starts a fresh lease instead of retaining a dead RTC peer.
Authorized background presentations retain their existing signaling-loss policy;
heartbeat timeouts alone do not prove lease revocation. Recovery is scoped to
this viewer; it never resets a shared relay or another peer's pending requests.

Hyprland cursor overlay uses `ext-image-copy-capture-v1` on the video helper's
Wayland connection. Bounded PNG cursor images and hotspots reuse the existing
cursor protocol. Hyprland 0.56 can return a transparent compositor-owned cursor;
in that case capture includes the OS pointer in the video and clears independent
cursor metadata. This preserves the actual pointer without a duplicate overlay.
Linux physical privacy uses the version-bound compositor integration below.
Persistent capture handles all eight Wayland output
rotations/reflections, including inverted and padded buffers, after bounded
scaling. Transformed outputs embed the compositor cursor into video; they do not
advertise a separately transformed cursor image. Layout changes during a frame
discard that frame and require fresh geometry. Synthetic native tests cover all
eight transforms with both buffer row directions under ASan/UBSan.

### macOS / Linux host parity audit (2026-09-18)

The comparison is against Cindy's implemented macOS host, not generic OS features.
Linux entries below refer to the Hyprland adapter; the generic portal fallback
remains view-only. An advertised capability and passing unit tests are not evidence
of physical phone end-to-end parity.

| Capability                           | macOS implementation                                                                  | Hyprland implementation / remaining gap                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Video and reconnect                  | Native capture, WebRTC, JPEG fallback                                                 | Persistent Wayland capture, same viewer/transport/reconnect lifecycle; encoder and performance differ                                                                                         |
| Sound                                | ScreenCaptureKit system output                                                        | PipeWire output monitor; no microphone                                                                                                                                                        |
| Keyboard, pointer, committed text    | Native input helper                                                                   | Wayland virtual keyboard/pointer; same bounded input protocol                                                                                                                                 |
| Cursor shape                         | Native cursor metadata                                                                | Separate cursor image/hotspot and cursor-free video on the supported Hyprland native path; unsupported layouts/backends retain the embedded pointer                                           |
| Monitor selection                    | OS display enumeration                                                                | Compositor output enumeration                                                                                                                                                                 |
| Frame rate and quality               | Shared 30/60 fps and bitrate options                                                  | Same options and adaptive WebRTC path; targets are not a measured fps guarantee                                                                                                               |
| Resolution and phone fit             | CoreGraphics modes, temporary virtual display                                         | Native modes, temporary headless output/mirror, restore-on-exit helper                                                                                                                        |
| Text, rich clipboard, image and sync | Native portable clipboard                                                             | Data-control clipboard, same limits and consent/lease checks                                                                                                                                  |
| Local speaker mute                   | System output mute and restore                                                        | PipeWire playback soft mute preserving the remote monitor signal                                                                                                                              |
| Lock on disconnect                   | Verified native lock shortcut                                                         | Omarchy shell lock IPC plus compositor `secure` acknowledgement; other desktops use logind request plus `LockedHint`; requires a running locker                                               |
| Automatic unlock                     | Native credential channel and system integration                                      | Hyprlock only; current Omarchy Quickshell remains unsupported, as documented in `remote-desktop-credentials.md`                                                                               |
| Physical privacy screen              | Excluded masks on every display, physical-input interception, local exit confirmation | Hyprland 0.56.2 native output masking after the capture copy, physical/virtual input separation, local confirmation and owner watchdog                                                        |
| Desktop navigation                   | Mission Control / system shortcuts                                                    | Capability-gated left/right workspace buttons on the captured monitor and an Omarchy menu button when installed; legacy viewers retain the window picker and temporary empty-workspace toggle |
| PiP, rotation, gestures              | Mobile viewer functionality                                                           | Same viewer functionality, subject to phone/runtime support                                                                                                                                   |

The Omarchy toolbar uses desktop-and-arrow icons and the official Omarchy mark
(https://omarchy.org/brand/omarchy-logo.svg), tinted with the toolbar foreground
in both themes. Left/right navigation includes empty workspaces on the captured
monitor (`r-1` / `r+1`); the menu button uses Omarchy's own `menu toggle`, so a
second press closes it even when the menu was opened locally.

Linux's window picker supplies selection/switching, not macOS Mission Control's
thumbnail animation. Its temporary empty-workspace restore retains the snapshot
when disconnect happens while locked and retries on unlock. This applies to
Hyprland window actions independently of the optional Omarchy menu.
Quickshell auto-unlock remains unavailable under the
existing-system-interface constraint. These differences and the unverified
physical phone scenarios must not be described as complete macOS parity.

The mobile toolbar uses `workspaceNavigation` to replace its first two actions
with left/right desktops (`r-1` / `r+1`, including empty workspaces on the selected
monitor). `omarchyMenu` adds a fifth action, invoking the fixed local
`omarchy menu toggle` entry point. Keyboard and Controls remain available.
Both native iOS and shared mobile chrome size the toolbar for its action count;
the landscape popover stays anchored to Controls. Old hosts keep their original
toolbar, and all new host actions require an active controlling lease.

### Hyprland native privacy integration

`native/remote-desktop/hyprland-privacy` builds only against Hyprland 0.56.2.
Runtime checks the compositor commit and the complete plugin ABI hash before
installing hooks; unknown versions fail closed. Build dependencies are a C++26
compiler, `pkg-config`, matching Hyprland headers and `json-c`. Forge includes the
adapter when matching headers are present. Other builds do not advertise it.
Source-mode builds use the existing per-user native-helper cache. Merely reading
capabilities does not compile/load a plugin or change compositor configuration.

The same version-bound integration repairs Hyprland 0.56.2 cursor export for
compositor-owned cursors. A cursor-only framebuffer read uses the bounded SHM
cursor image after the original permission/source-overlap decision; ordinary
screen reads and denied cursor reads retain the compositor path. The cursor
buffer's stride-returning API is handled separately from client SHM allocation
lengths. Hotspot events are sent before the matching frame is ready, including
shape changes that complete a pending frame before the next monitor commit.
This feeds the existing Mac/mobile cursor overlay protocol, without a new wire
format or mobile native module. Nested-compositor checks cover arrow/text/arrow
image and hotspot changes, cursor permission denial, and privacy plus capture.
Physical phone end-to-end remains a manual validation target.

Software cursors are deferred until after the capture/mirror copy, then drawn
on the local output before its final presentation/privacy mask. Mirrored local
outputs restore the cursor with the desktop's aspect-fit geometry. Explicit
cursor-inclusive screencopy requests still draw a cursor; cursor-free requests
no longer inherit the software cursor from the mirror texture. Hyprland 0.56.2
reports cursor positions in logical coordinates, so the capture helper applies
the selected output scale before normalizing against physical video dimensions.
This prevents host position updates from pulling the phone pointer backwards
after a touchpad gesture on fractional-scale displays.

`linux-capture/test.mjs` covers coordinate normalization and clamping under
ASan/UBSan. The opt-in `linux-capture/cursor.integration.py <plugin.so> <capture>`
starts disposable nested compositors and compares cursor-region pixels at 100%
and 160% scale, for both separated and legacy embedded cursor modes. It never
loads the test plugin into the user's compositor. Additional nested checks
verified the local cursor remains visible, including the phone-fit mirror, and
privacy still shows Cindy locally while preserving the remote desktop image.

The first authorized connection prepares the optional compositor plugin through
`hyprctl` before allocating a lease or temporary output. Hyprland reloads its
configuration when plugins are loaded/unloaded, so preparation waits for that
reload and never runs under an active capture. Privacy toggles only use an
already-prepared matching plugin. No configuration files or system lock behavior
are changed. Mask drawing runs inside the normal final-copy pass, after saving
the unmasked capture/mirror image and before copying to the physical output.
It must not draw after `CHyprOpenGLImpl::end()` has invalidated framebuffer state:
that produced all-black continuous captures on the physical DRM output despite
passing nested-compositor tests. While privacy is active, each rendered output
is fully damaged before rendering so a previous mask cannot enter the next
capture through partial redraw. Text textures explicitly declare their sRGB
color space. No extra frame is scheduled by this redraw rule;
direct scanout is inhibited while owned. All enabled physical outputs, including
mirrors used by phone-fit mode, are covered; headless capture outputs stay unmasked.
The Linux mask embeds the same Cindy illustration and light/dark wordmarks as
`privacyScreenHtml` at build time, with horizontal/vertical layouts. Artwork is
part of the native cache identity; the compositor does not read image paths or
fetch resources. Both themes were visually checked in an isolated compositor,
with continuous remote capture remaining unmasked.
The host waits for first rendered
masks before acknowledging the toggle. Physical input is consumed before normal
bindings/application delivery; injected input can operate the desktop, but is
fenced during local exit confirmation. The initiating press/repeat/release cannot
answer the confirmation. Remote input drains before that confirmation opens.

The six-second compositor watchdog restores local access if the owning app dies
or stops renewing. Lease end, revocation and normal disable stop the mask. A late
start reply retires only its own token. Plugin updates can retire an idle build
atomically; an active owner's plugin is never unloaded. Local IPC uses the
existing same-user compositor trust boundary and never carries passwords.

Validated in an isolated nested Hyprland session: remote capture retained test
content while local output displayed privacy/confirmation; physical input opened
the confirmation, virtual Enter could not answer it, and local cancel/disconnect
worked in both Light and Dark. Watchdog expiry and idle-only retirement passed.
Native input-state tests run under ASan/UBSan. The September 18 black-frame
regression was reproduced on the actual 2560×1600 eDP-2 DRM output at scale 1.6:
old code yielded zero mean and zero standard deviation throughout privacy;
the corrected final-copy path preserved nonblack continuous capture frames.
Real phone end-to-end, touchscreen and other GPU combinations remain manual
validation targets.

The additive `windowActions` capability gates `windowAction` list/activate/desktop
requests. They require the controlling lease; only currently enumerated window
IDs reach fixed dispatchers. Lua and legacy Hyprland dispatcher syntax are probed
without changing settings. Replies after revocation are discarded. Desktop
restoration waits for in-flight actions and does not undo independent local
workspace navigation. Old viewers/hosts retain their existing shortcuts; the
relay and its authorization rules are unchanged.

System PiP requires the native presentation module and host backgroundViewing
capability. New iOS binaries use AVKit readiness; browser receivers require WebKit
support for the video. Native automatic entry is armed in the foreground after the
first frame, with host authorization completed in parallel during Home entry.
Entering releases control. A capture-renderer challenge/pong heartbeat renews
only a view-only lease after host authorization while the viewer reports actual
system PiP presentation.
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
implemented. A Linux pre-login service remains deferred. Do not present this as fully validated
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
lease changes or it leaves the foreground. These explicit text operations do not
retain clipboard history or log its contents. Opt-in synchronization is described below.

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
limited to 4 million pixels on iOS before PNG encoding or incoming PNG decoding,
with an 8 MiB encoded PNG limit. Oversized images are rejected, not downsampled.
Android uses the limits described below.
Each transfer is peer/lease/control-generation
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

### macOS and Windows local cursor overlay

Optional `cursorOverlay` on capabilities, offer and compatibility-frame requests
negotiates cursor-free capture; omitted flags retain the original protocol.
The macOS helper reads the global NSCursor image/hotspot and the public legacy
CGCursorIsVisible symbol, with normalized position within the selected display.
No cursor-hiding call is applied to the user's physical desktop.

Windows advertises the same capability only when its installed native service is
ready. Negotiated capture omits DrawIconEx from the picture and reads the cursor
image, hotspot, visibility and monitor-relative position separately. The existing
viewer moves that raster locally before the next input batch is sent; delayed
host positions do not replace it during active movement. Omitted/false flags
retain the legacy screenshot/video path, including its embedded cursor.

The Windows worker sends bounded premultiplied BGRA only through its authenticated
local broker pipe. Main validates geometry and byte length, converts the raster
to PNG using Electron, and converts physical cursor dimensions/hotspot to desktop
points using the selected monitor's DPI. Only negotiated capture gets the larger
1.75 MB local response budget; the existing remote PNG/frame limits and all input,
owner, console-session and lease checks remain unchanged. Older helpers returning
plain JPEG still work. No new dependencies, persisted pixels, IPC channels, device-link
messages or Mobile native changes are needed.

Legacy Windows AND/XOR cursors are rendered against black and white to recover
transparency. Pixels that invert the background cannot be represented exactly by
a PNG; they use a solid silhouette with a contrasting outline (including I-beams).
Other cursor colors/alpha are retained. Missing or invalid cursor data does not
stop video. Windows overlay capture supports up to 4096px, the requested video
quality and existing 30/60 fps caps; the old compatibility path stays at 1280px.
Highly detailed overlay frames lower JPEG quality/resolution to keep the 1 MB
native JPEG bound, and the capture connection keeps that reduced quality or the
1280px fallback for later frames. This is not a guarantee of the delivered frame rate.

Windows regression coverage: [cursor raster tests](../apps/desktop/native/remote-desktop/windows-host/src/cursor.rs),
[large-frame pipe transfer](../apps/desktop/native/remote-desktop/windows-host/src/pipe.rs),
[capture lifecycle](../apps/desktop/src/main/remote-desktop/__tests__/nativeCapture.test.ts),
[DPI and bounds](../apps/desktop/src/main/remote-desktop/__tests__/windowsCursorFrame.test.ts),
and [immediate viewer movement](../apps/desktop/src/renderer/features/remote-desktop/__tests__/viewerInput.test.ts).
Native cursor tests use system shapes without moving the pointer; compiling these
tests needs cargo feature windows-sys/Win32_UI_Input_KeyboardAndMouse for the
existing input-desktop test module. Actual two-device control, lock/UAC transitions,
Light/Dark viewing and sustained video performance require manual validation.

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

Desktop viewers use the local system pointer instead of drawing this raster.
An optional `shape` hint selects a bounded standard cursor keyword (text, hand,
resize, etc.); size, DPI and accessibility appearance remain owned by the local
OS and do not follow the remote screen zoom. Missing, custom or unknown shapes
fall back to the local arrow. Old viewers ignore the hint and Mobile retains the
raster path. Desktop view-only mode shows the local arrow rather than a second
remote pointer overlay.

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
never automatically retried. Native portable clipboard access and version tracking
require new iOS and Android native builds; older runtimes retain the text fallback.
Android supports text, HTML, HTTP(S) URLs and PNG images (not RTF), limits decoded
clipboard image reads and incoming PNGs to 4 million pixels, with 8 MiB limits on both the source
and encoded PNG. Incoming Base64 length is checked before decoding, and its PNG
header and dimensions before publication. Oversized images are rejected before unbounded encoding or
Base64 copies; images are not downsampled. Android clipboard images
use grant-scoped cache files. Every successful image, text or URL replacement
reclaims unreferenced published images, retaining at most three previous images
(24 MiB) for up to one hour as a read grace period. Current clipboard URIs are
always preserved. Preparation uses unpublished temporary files; failed or cancelled
preparation/publication removes only its own file. Cleanup is best effort when
the clipboard cannot be inspected or the filesystem rejects deletion.
Subsequent successful replacements also reclaim unpublished files left by older
processes once they are over one hour old. Filenames include the process ID and
start time, so current-process preparation survives long suspensions and module
recreation without an active-file registry.

Desktop manual copy, automatic reads and write verification share a 4 million
pixel check before native PNG encoding. PNG buffers over 8 MiB are rejected before
Base64/hash copies. Incoming PNGs have encoded-length, byte and dimension checks
before native decoding. The pixel limit bounds encoding work; Electron still
allocates the PNG buffer before its byte length can be checked.

### Opt-in Mobile clipboard synchronization

On supported peers, the security options can enable clipboard synchronization
while the phone is foregrounded and owns the controlling lease. Every 1.5 seconds
the phone checks local and remote version tokens, reading portable content only
when a version changes. Android uses change notifications and description timestamps
without reading the clipboard body during unchanged polls. Image provider reads,
conversion and file preparation run off the Android main thread; clipboard access
and the final foreground/version check and write run on the main thread.

Synchronization compares content digests to avoid echoing its own writes and
checks the destination version again before writing so it cannot overwrite a
newer local copy. Disabling sync, leaving the foreground, losing control or
disconnecting invalidates pending work. It does not poll in the background,
maintain history or log clipboard contents. Private formats and arbitrary files
remain unsupported; only portable representations are synchronized.

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

Desktop zoom controls share one group: zoom out, fit to window, actual size (1:1),
and zoom in. Fit follows the window size; actual size maps one remote logical
screen unit to one local CSS pixel, independently of video encoding resolution
and local display density. Actual size stays fixed when the window is resized.
Clicking actual size also sizes the window to the remote desktop plus toolbar
and native frame, within the window minimum and the local display work area.
Fullscreen/maximized windows restore first; oversized desktops remain at 1:1
and can be panned inside the screen-limited window.
An overflowing picture can be panned with the middle mouse button or by hovering
within 28 local pixels of a viewport edge. Edge panning accelerates toward the
edge, supports diagonal movement, and stops at the desktop bounds, on pointer
leave or focus loss. Remote hover/drag coordinates follow the moving picture;
view-only sessions pan locally without sending input. Window maximization/fullscreen
uses the native window controls.
Zoom out can go below fit, down to 10% of the smaller of fit and actual size.
Exposed margins use the same fixed-fit, three-segment ambient canvas as Mobile,
with 16px blur, 1.12 overscan and 0.72 opacity. Same-aspect desktops also retain
the backdrop when shrunk; covering the window stops its live redraw loop.
