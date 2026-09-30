# Viewer aspect ratio prototype

The new **Match Current View** action uses the controller's usable picture area
to choose independent width/height, with an even-pixel 1920-pixel long-edge limit.
Mobile excludes its toolbar from the measured area. Desktop uses the viewer
content area. Resizing is explicit: rotating the phone or changing window size
does not continually reconfigure the remote computer.

On Mobile, after matching, the action becomes **Restore Computer Screen Ratio**
while the current viewport still matches. Rotating to a different ratio offers
**Match Current View** again. Restore removes the temporary display, waits for
the original monitor mode to return, and renegotiates video/control on the same
lease. This uses the optional `viewerDisplayRestore` capability; older hosts
continue to offer matching only.

## Current scope

- **macOS source-development hosts only** advertise `viewerDisplay`. Packaged
  hosts and Windows/Linux retain the existing display-mode behavior.
- Both Mobile and Desktop viewers expose the action only for capable hosts.
  The same authenticated, controlling lease is required. No new relay kind,
  server change, IPC channel, credential access or Mobile native dependency.
- A temporary virtual display becomes the mirror source for the selected
  existing display, so the current desktop is shown instead of an empty extended
  desktop. This changes the local monitor's layout too; large application windows
  may require resizing. Existing mirror sets are not supported by this prototype.
- The helper retains the virtual display only for the lease. Explicit exit,
  expiry, revocation and helper failure dispose it. EOF/SIGTERM restore the source
  display mode. Original window positions are not snapshotted or restored.
  A new lease waits for the prior temporary display's restoration before reading
  its geometry, including takeover. A failed restoration can be retried by the
  next start; it never creates a lease from unconfirmed geometry.
- Resizing preserves the lease and input sequence; old video/input are stopped,
  queued old-geometry input is discarded, and the viewer negotiates video and
  reacquires control on the confirmed new display. Shared Device Link connections
  are not restarted.
- Failure ends only this remote-desktop lease and restores its temporary display.
  The viewer's existing recovery remains responsible for reconnecting.
- On hosts advertising both viewer-display capabilities, the resolution dropdown
  resizes the temporary display without ending the lease for dimensions within
  320–2560 per edge. Larger system modes (such as 4K) retain the legacy mode-ID
  path and its existing reconnect/persistent-mode behavior. Exiting a temporary
  display completes before a legacy mode write, so cleanup cannot overwrite it.
  Mode enumeration and native mode-ID writes use the lease's original source
  monitor; video and input use the current capture display. Exiting a temporary
  display restores the original monitor mode. The list still includes all macOS-reported modes,
  including different aspect ratios such as 800 × 600; filtering the list to the
  matched ratio is not implemented in this prototype.

## Native dependency

`CGVirtualDisplay` is a private CoreGraphics interface, resolved at runtime.
Chromium's [virtual display test implementation](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/display/mac/test/virtual_display_util_mac.mm)
is the reference for its interface shape. No new third-party binary or package is
installed. The helper is compiled from source by the development host. Enabling
it in packaged releases requires a separate supported-OS, signing and packaging
decision and validation; this prototype deliberately does not advertise it there.

## Try it

Start the development host from this worktree using the repository's Desktop
development instructions. Connect using this worktree's Mobile or Desktop viewer,
take control, then open **Controls → Display → Match Current View** (Mobile) or
the viewer's controls panel (Desktop). Rotate/resize and apply again to change
the target ratio. Disconnect to restore the original monitor resolution.

The [interactive HTML preview](design-previews/remote-desktop-viewer-aspect/index.html)
uses sample content and does not touch the computer display.

Explicit native integration check (temporarily changes the main monitor layout):

```sh
node apps/desktop/scripts/viewer-display-native-smoke.mjs
```

The check compiles in an OS temporary directory, verifies 900 × 1600 and
1600 × 900 on the same virtual display, ends the helper, and compares the complete
online display list and geometry against the initial snapshot. It does not
capture pixels or inject input, and is not in the ordinary unit suite.

Real Mobile-to-Mac video/input, multiple monitors, HiDPI, lock/sleep and signed
packaged execution still require device testing. Native mode readback and unit
tests are not evidence that those end-to-end paths have passed.

## Validation in this worktree

- 238 focused tests passed across the protocol/session, host lifecycle, Desktop
  viewer, Mobile screen, viewport and RTC suites.
- Desktop and Mobile `typecheck`, and device-link's `build` (`tsc --noEmit`) passed.
- The shared package's full `build` reports eight existing diagnostics in
  `brandIdentity.test.ts`, `composerPalette.test.ts`, `historyView.test.ts` and
  `workRunGrouping.ts`. An unmodified HEAD archive produced the same eight
  diagnostics, with no added or removed errors.
- Native smoke passed both orientations and restoration. A separate real
  Electron process also exercised the production `createViewerDisplay` adapter
  at 888 × 1920 and 1920 × 888, and verified the original Electron screen snapshot
  (bounds, scale factor and display count) after disposal.
- The HTML preview was exercised in Chromium in Light/Dark and both orientations;
  Light/Dark portrait screenshots were visually inspected. This is sample-content
  preview evidence, not native Mobile screenshots.
- Five-language i18n consistency, terminology and generated-viewer synchronization
  checks passed. No release was made.
- The physical iPhone Air now has a separately signed Cindy Aspect test app with
  an embedded JS bundle; app launch was verified. Full video/input acceptance
  remains separate from installation and startup.
