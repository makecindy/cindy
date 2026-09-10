# Optional remote desktop automatic unlock

## Behavior

Ordinary connections use existing account authorization. An unlocked Mac opens
without a login password or Face ID, including the first connection from a phone.
Mobile places **Security** at the bottom of the remote desktop control panel,
after display settings. Automatic unlock defaults off. Face ID only protects a
saved password; turning automatic unlock off deletes the local saved password.

This implementation targets iOS controlling macOS. It does not add a new server,
identity registry, database migration, or deployment requirement. The existing
relay still authenticates the account and carries messages. Native iOS/macOS
credential code performs no identity-directory HTTP requests or polling.

## Automatic first setup and trust

Only an explicit user action to enable automatic unlock admits a first key. The
existing authenticated same-account connection delivers the Mac public descriptor;
the native signed handshake proves possession of its private key. The native phone
form asks for the Mac login password directly, with no code comparison, QR scan or
Mac confirmation dialog. Successful native password verification stores the secret
and exact Mac public key together. Later connections require the stored key before
any saved-secret read. A changed key fails closed; no silent replacement is allowed.

This follows the existing Cindy contacts-sync trust pattern in
`apps/desktop/src/main/contacts-sync/driver.ts` and `keyStore.ts`: first keys arrive
only over the authenticated account route, with persistent key continuity afterward.
It deliberately trusts the account service and relay at first setup. It does not
claim protection against a malicious relay substituting the very first key, or
against a compromised endpoint. Encryption alone does not establish first identity.

Research reference: [OpenSSH's accept-new policy](https://man.openbsd.org/ssh_config#StrictHostKeyChecking)
likewise distinguishes accepting new host keys automatically from refusing changed
keys. This is a policy precedent, not a claim that the two protocols are identical.

Existing saved pins are preserved. Disabling and re-enabling automatic unlock does not
replace a changed key for an existing target. A replacement computer must be
registered with a new device identity. Older experimental secrets without a pin
are not automatically used. Mac admission continues to require existing account
and device authorization, the Mac password, and the native attempt limiter.

## Password protection

The signed NativeChannel handshake binds realm, account, both device IDs, fresh
session entropy and ephemeral keys. Encrypted packets retain replay/expiry checks.
Private keys and passwords do not enter JavaScript or relay storage. iOS stores
secrets device-only, with optional current-biometric-enrollment protection. Settings
and pins are scoped to account, region, controller installation and target device;
secrets additionally bind the Mac key fingerprint and OS user record.

Biometric protection changes preserve the pin and replace the secret atomically.
Offline deletion needs no network. Unavailable biometrics do not silently weaken
existing protected items. When an invalidated secret no longer exists, setup can
use the current password-only default. Cancellation and target/account changes
invalidate the pending operation. Media retries do not repeatedly prompt Face ID.

The Mac helper authenticates its parent before processing commands. Its login
Keychain identity is nonextractable and restricted to the helper executable. A
locked/unavailable key is not replaced. Password verification and actual lock-screen
interaction run natively; password correctness alone is not proof of OS unlock.

## Validation boundary

Local tests cover descriptor account/region/target isolation, pin replacement
rejection, an encrypted exchange without a directory, replay rejection, and actual
Mac Keychain reload/sign/export-refusal. A host integration test prepares a local
identity without an account token or identity service. JS tests cover native
pairing transport, ordinary desktop bypass, offline deletion, UI placement and
focus cancellation.

First setup on physical devices, Face ID success/cancellation, real locked-Mac unlock,
Light/Dark visual inspection, and signed production-helper operation while locked
remain acceptance work. Source tests and signed builds do not establish those facts.
The earlier repository-wide gate still has recorded Desktop failures outside the
remote-desktop targeted suites; no release-ready full gate is claimed.

The abandoned companion-server experiment is not required and has not been deployed.

## Development helper signing

Local Mac previews require `CINDY_REMOTE_CREDENTIALS_SIGNING_IDENTITY` to contain
the exact 40-digit certificate fingerprint from `security find-identity -v -p
codesigning`. Use an Apple Development or Developer ID certificate; ad-hoc signing
is rejected. This developer-only environment setting does not change packaged
signing or add a user setting. Keep the same certificate across local rebuilds.
The helper is signed with a stable identifier and verified before entering the
build cache; cached executables are verified before use.

An identity created by an older ad-hoc helper may require one macOS Keychain
approval after switching to the signed build. Preserve that key and all saved pins;
do not reset the Keychain or broaden its ACL. Setup/signing calls have a bounded
50-second allowance within the existing remote desktop transport budget, and
background status polling pauses during those calls. Ordinary remote desktop
connections do not depend on this helper or on that authorization.

## Setup diagnostics

Mobile records fixed setup stages, completion/failure, elapsed time and allowlisted
error codes through its existing opt-in local debug journal. Action arguments,
native replies, passwords, tokens, descriptors and device/account identifiers are
never passed to that journal. These events are not added to upload summaries.

Host status queries before the first encrypted ready packet must return no
authorization without closing the pending channel. Previously that normal query
called `requireConfirmed`, then closed the channel on failure; the first packet
therefore failed as expired immediately after a successful offer exchange.
The regression test probes status before ready, completes the handshake, and
confirms commands still require password authentication. Truly expired or closed
channels remain rejected.

Mac lock-screen preparation uses a bounded IOPM user-activity assertion to wake
the display. A collapsed own-account presentation may receive one non-secret,
Return wake event after verifying its own-account label and absence of a field.
The kernel PID/UID/start timestamp replaces unavailable NSWorkspace launch dates.
The secure field is validated before writing, independently of the submit button,
which can appear only after text insertion. Modern flat window layouts are accepted.
Submission still requires the same signed process, console account, window and
secure field, plus an enabled same-parent submit button; the button is revalidated
immediately before one AXPress. Recovery dialogs, user-selection and unknown password fields fail closed.

The `cindy-remote-unlock-inspect --prepare` diagnostic exercises wake and field
preparation without accepting any password or submitting login. On the test Mac,
this probe reaches `fieldReady: true`; a separately cleared, never-submitted test
value confirms the submit button appears after insertion. Actual password submission
and successful system unlock remain distinct physical acceptance checks.

### Saved-password reconnect diagnosis

A deliberate reconnect or a foreground return after releasing the viewer in the
background resets the optional automatic-unlock attempt. Media recovery and iOS
`inactive` overlays retain suppression, so a cancelled Face ID request is not
repeated by network retries. This changes only the local phone attempt flag, not
any Device Link transport or other controller.

Phone-native failures distinguish inactive application, concurrent authentication,
missing saved password, changed saved binding, and fixed Keychain read failure
categories. Local diagnostics whitelist these codes; passwords, binding values,
and OS error descriptions are never logged. Existing saved passwords and pins are
preserved. On-device confirmation of saved-password retrieval remains required.

### Face ID bound to automatic unlock

Face ID is hidden while automatic unlock is off. New setups first verify and
save the Mac password without biometrics. Only after native confirmation succeeds,
the phone reveals the Face ID option and requests biometric permission and
verification by default. Failure or cancellation retains automatic unlock with
Face ID off; users can enable it later. No permission is requested after a failed
password attempt. Media reconnects do not rerun this setup sequence.

Face ID enabling uses the native policy evaluation before rewriting the saved
item with Keychain `biometryCurrentSet`. Existing protected records are preserved;
UI changes only reflect confirmed native settings. Previously authorized iOS apps
show verification rather than another permission dialog.

After successful native biometric evaluation or protected password retrieval, the
phone may complete while iOS is foreground-inactive (for example during its
biometric overlay). New operations still require active state. Completion checks
reject background or changed owner/session; waiting for active is not required.
This preserves Keychain authentication without mistaking a foreground overlay for
cancellation. Native operation exclusion remains in force across evaluation/read.

Disabling automatic unlock deletes the secret but retains its non-secret host pin
and biometric preference. A later setup reads that preference before saving its
new password, so an explicit Face ID opt-out is not overwritten by the default.
No previous preference means opt-in by default after successful password setup.
Manual and default Face ID setting changes have dedicated, redacted log stages.

On the observed collapsed macOS lock screen, clicks and Space did not reveal the
field; one non-secret Return did. Preparation permits this only with no password
field and a verified own-account label in the same signed loginwindow. This wake
key is a system input event, so it is not atomic against a simultaneous manual
unlock. Password characters are never sent as keyboard events. Expanded layouts
can hide FocusedUser; password delivery still requires matching console/session
UIDs, signed loginwindow identity and exact secure-field/window continuity. Any
visible mismatching account label, selector or actual recovery dialog remains rejected.

Passive forgotten-password help can appear alongside the normal secure login
field. The presence of ResetPasswordTitle/ResetUsingRecoveryButton alone does not
reject that field; actual modal recovery and user-selection still fail. The only
submit action remains LUIBUTTON_GO and recovery buttons are never invoked. The
current Mac preparation probe succeeds with this passive help visible.

### Lock on explicit remote exit

The Security panel includes a separate, default-off lock-on-exit preference. It is
a non-secret phone-local boolean override per computer, independent of saved
passwords and Face ID. Explicit Back/disconnect and route unmount send
`stop.lockScreen: true` only when the host advertises `lockOnExit`. Ordinary stop,
media recovery, display changes, background pauses and Face ID inactivity retain
their original behavior. Network loss or force-quitting the phone cannot promise
delivery of an exit command. Old hosts retain normal stop behavior.

The existing authenticated Device Link request is bound to its exact peer and
lease. The host blocks replacement starts during the bounded lock operation,
releases held input, then the validated native helper sends the fixed macOS lock
shortcut and confirms the current console session is locked. No password, Face ID,
server endpoint or account-wide setting is involved. Lock failure is visible on
the phone; only macOS currently advertises this optional capability.

### Stable mobile controls

Control, Display and Security share one viewport-sized panel with persistent
navigation and exit controls. Page changes reset the scroll position; progress
updates do not remount the page. Busy indicators replace icons in fixed accessory
slots, and asynchronous notices follow the settings rather than moving their
rows. Native switch slots reserve their width before native layout completes.

iOS uses system segmented controls for input and keyboard modes and native
navigation buttons, including system glass when available. Keyboard content may
change height within its viewport limit; the stable-height contract applies to
the settings panel and asynchronous feedback, not to different keyboard layouts.
Light/Dark use the same geometry and semantic colors. Automated layout-contract
checks do not replace physical-device visual acceptance.
