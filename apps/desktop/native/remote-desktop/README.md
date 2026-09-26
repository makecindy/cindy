# Remote desktop native helpers

## Windows capture

On a DWM-composited desktop, capture uses SRCCOPY without CAPTUREBLT. The latter
can cause physical cursor hide/redraw flicker during rapid GDI capture (see
[python-mss issue 179](https://github.com/BoboTiG/python-mss/issues/179)). The legacy
flag remains for non-composited capture. A native integration test creates a
small owned no-activate layered window and verifies its known pixel remains in
the capture, without saving desktop content. Driver-specific cursor appearance
still requires real remote-session verification.

Cindy does not save a Windows password or register a credential provider.
Unlocking a locked session uses the existing remote keyboard on the Windows
logon desktop.

## Windows input desktop access

The Windows helper explicitly attaches its input thread to `OpenInputDesktop`.
The handle requests `DESKTOP_JOURNALPLAYBACK` together with its existing
read/write/switch rights: Windows requires this access for `SendInput` on the
attached desktop, even though Cindy installs no journaling hooks. Without the
right, attachment succeeds and the helper prints `ready`, but its first input
is rejected with Win32 `ERROR_ACCESS_DENIED` (5). This affects controllers on
any OS; it is a Windows host issue, not a Mac-to-Windows wire-format difference.

The desktop ACL, process token, UIPI and secure-desktop service boundary still
apply. This does not elevate the helper or bypass UAC. An input failure releases
control while keeping the viewer lease and video; viewers observe the resulting
`controlling:false` on the existing heartbeat.
An input-desktop transition is reported separately as `desktop_changed` after
held inputs are released. The SYSTEM broker retires that worker before forwarding
the signal. Main keeps the authorized viewer/control grant and creates a fresh
input connection without replaying old batches or reading a saved password.
Windows lock/unlock events proactively initiate the same bounded recovery;
explicit stop, revocation and genuine input failures do not restore control.

`desktop::tests::binding_and_rechecking_preserve_input_access` is an explicit
native integration check for an unlocked, interactive Windows session. It uses
zero relative movement (no clicks, typing or pointer displacement) to verify
binding, rechecking and restoration. Run the Windows crate's `cargo test` with a
task-specific `--target-dir` outside the checkout. It is separate from Node unit
tests and does not prove lock/UAC or physical cross-device behavior.

## Windows service installation and authorization

The packaged settings action installs a separate protected host/input pair, keeps
the application's custom location, and persists the approved installation and
Windows user rather than a process ID. Application code is protected in place
after UAC; unrelated data and parent directories keep their permissions.
Source Dev instead compiles a checkout/runtime-bound variant on explicit setup.
It trusts the approved development code and leaves source/node_modules editable;
no runtime flag enables this policy in packaged helpers. Native updates keep the
same checkout-scoped service name and require an explicit administrator update.
The full contract and remaining installed-service validation are documented in
[`docs/remote-desktop.md`](../../../../docs/remote-desktop.md#windows-system-service-implementation-awaiting-windows-runtime-validation).

Run native behavior checks without installing a service or prompting for UAC:

Desktop TypeScript/unit checks do not compile this Rust crate. Before delivering
changes to the Windows host, run its native tests in both default and
`--features development` configurations, then run the Dev preparation flow that
builds the release host, input helper and Node addon. The development build must
set `CINDY_DESKTOP_DEV_APP` and `CINDY_DESKTOP_DEV_EXECUTABLE` to its exact checkout
and Electron paths. A passing Node test suite alone is not a successful native build.

The public service pipe grants interactive clients data, synchronization and
read-attributes access. Windows `CreateFileW` checks `FILE_READ_ATTRIBUTES` even
when a client requests only data access; omitting it leaves the service running
but rejects connections with Win32 error 5. Do not substitute generic write access,
which would also grant creation of pipe server instances. Run the service-pipe
regression from an interactive, non-SYSTEM Windows account: it exercises the
production ACL, probe exchange and rejection of a second client-created server.

```text
cargo test --locked --manifest-path apps/desktop/native/remote-desktop/windows-host/Cargo.toml --bin cindy-windows-desktop-host --target-dir <unique-temporary-directory> -- --test-threads=1
```

The file-lock regression uses real Windows handles: metadata-only opens do not
enforce sharing restrictions. Code pins request read-data/list-directory access
and reject outstanding writers, so changing an ACL cannot leave an old writer
able to modify approved code. Setup snapshots and restores those ACLs when
installation fails or the service is removed, and a later install keeps the
first captured restore record. Protected records are replaced in place so a
crash cannot delete the previous restore file before the new one is committed.
Restore pins the application path and captured
tree without DELETE sharing and applies nested objects first. Protection covers
every file under `resources/tools` and `resources/cindy-updater-runtime`,
including Main-loaded extraResource addons. Ancestor pins open parents before
the leaf. Packaged setup keeps the verified Main handle and the captured
tree pins through hardening, applying ACLs through those handles.
Packaged payload copies verify
Authenticode and copy through an exclusive handle; packaged setup also
Authenticode-checks Main against the helper before recording approval, taking
the signer from the PKCS#7 message rather than CryptQueryObject's context
pointer. The directory-permission test
also verifies that the exact-object ACL setter does not propagate into unrelated
child data.

## macOS input helper trust boundary

The input helper authenticates its caller before inspecting any command or
requesting Accessibility permission. Node's macOS stdio socket pairs carry kernel
audit tokens; stdin, stdout and stderr must all belong to the direct Main parent
and the current user. A regular pipe, redirected channel, missing identity or
failed signature check exits with status 77 without returning clipboard content.

Packaged builds require an Apple-signed, hardened Cindy Main executable in the
same application bundle and with the helper's signing team. The application must
seal the exact helper bytes in its signed resources. This prevents transplanting
the helper into an older signed application with weaker Electron fuses. The
existing package configuration disables RunAsNode, NODE_OPTIONS and CLI inspector
arguments and enforces the sealed ASAR. Input batches and the watchdog recheck
the audit-token-bound process; loss of its identity releases held inputs and exits.
Existing Main remote-control permissions, leases and system TCC checks still apply.

Source development is a different trust boundary: generic Electron loads writable
JavaScript and exposes debugging facilities. `inputHost.ts` explicitly compiles a
development variant bound to that Electron executable's path and designated code
requirement, retaining kernel channel checks. This does **not** protect against
arbitrary code already running in that development runtime. Its cache identity is
stable across Main restarts. Neither CLI arguments nor environment variables can
enable this variant in a packaged helper; failed production authentication never
falls back to it. Ad-hoc/unsigned packaged builds fail closed and are not a
substitute for the development workflow or a properly signed distribution.

The native tests exercise real audit-token and Security APIs without posting
events, reading selections or prompting for permissions. They cover ordinary
process calls to every production command, channel redirection, forged runtime
development flags, stale audit tokens, and signed-resource helper replacement.
The resource fixture is ad-hoc signed: it verifies resource sealing, **not** the
production Apple/team acceptance path. A signed application launch and TCC flow
must still be checked during release validation.

# Desktop capture process boundary

Main creates one hidden, sandboxed capture renderer per media offer. It uses a
separate in-memory session, dedicated preload and separate build entry. Packaged
assets are served only by `cindy-desktop-capture://capture/`; the page cannot load
chat/Markdown, navigate, open windows or use arbitrary HTTP/WebSocket requests.
WebRTC remains the media transport. The main application preload exposes only
remote-desktop settings/status/stop, never source IDs or raw frame reads.

The owner lifecycle is `absent → starting → active → destroyed`. All capture IPC
requires the exact Main-created webContents, its top-level frame and document URL.
Main owns the single-use display grant and existing lease/offer generation. Stop,
revocation, replacement and offer failure clear authority before destroying the
window; late ready, source enumeration or replies cannot revive the old owner.
Unexpected capture process failure ends only its desktop lease. ICE retries keep
the existing process; there is no process restart loop or shared relay reset.
This surface deliberately does not follow reusable UI-window hide semantics:
destroying the renderer is necessary to end independently created media streams.

The app session rejects both `getDisplayMedia` and legacy desktop capture. In
Electron 41 those requests use `media` with an empty `mediaTypes` list; physical
microphone/camera requests remain allowed. The capture session admits that empty
media request only from its own exact main frame, then the display handler checks
the lease and consumes its grant. Native fallback reads are gated by the same
owner, lease and generation and remain in Main/native helpers.

Validation covers cancellation during readiness/enumeration, foreign and child
frame IPC, offer versus ICE timeout, forced destruction, and stale-owner events.
Electron 41.10.3 was also exercised with the production capture bundle/preload and
custom scheme: synthetic WebFrameMain video/audio → WebRTC answer/received track,
main-page capture rejection, fake microphone capture, and webContents destruction.
Mixed microphone/legacy-desktop requests were rejected by Chromium's bad-IPC
validation before our permission callback. These synthetic tests do not replace
real system audio, Windows lock/UAC or mobile cross-NAT release validation.
