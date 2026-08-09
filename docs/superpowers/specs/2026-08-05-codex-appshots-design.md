# Codex Appshots for Cindy on macOS

## Status

- Date: 2026-08-05
- State: approved for implementation planning
- Scope: Cindy Desktop on macOS, Codex sessions only
- Baseline: `377c041d` (`fix: preserve Claude provider model routing`)

## Problem

Cindy accepts image attachments, but it cannot create a Codex-style Appshot. An Appshot must
capture the frontmost application window and its macOS accessibility structure, attach both to
a Codex composer, and wait for the user to send them. The feature also needs a global shortcut
that works while Cindy is in the background.

## Goals

1. Capture the frontmost visible window on macOS, including its image, application identity,
   window title, and accessibility structure.
2. Add the capture to a Cindy Codex composer without sending it.
3. Reuse Cindy's image cache, draft attachment, session creation, and Codex input paths.
4. Support a configurable global shortcut. Match Codex's default double-Command gesture and
   use Command-Shift-A when the default cannot be used.
5. Handle macOS permissions and protected content without exposing secrets.

## Non-goals

The first release does not include:

- Windows or Linux capture;
- Appshots in Claude Code or Pi sessions;
- mobile-initiated capture;
- automatic message submission;
- a window picker, region capture, annotation editor, OCR, or capture history;
- a login helper that runs after Cindy has fully quit;
- changes to mobile pairing, remote connections, or ordinary image attachments.

Closing Cindy's window may leave the existing Cindy process running, so the shortcut remains
available. Quitting Cindy stops the shortcut.

## Confirmed User Experience

### Composer entry

Codex composers expose an **Appshot** action in the existing attachment menu. Claude Code and
Pi composers do not show it. The action captures the application that was frontmost when the
user invoked it.

### Global shortcut

Cindy's **Settings > Keyboard Shortcuts** includes **Capture Appshot**. The setting accepts:

- double Command, matching Codex's default gesture;
- double Option or double Shift, matching Codex's modifier-only alternatives;
- a conventional user-recorded key combination.

The initial preference is double Command. Cindy uses Command-Shift-A as the fallback. The
settings row shows the configured shortcut and the shortcut currently active.

Codex and Cindy cannot exclusively register the same passive double-modifier gesture. Cindy
therefore treats the running `com.openai.codex` application as a conflict: it activates the
fallback while Codex runs and retries the configured shortcut after Codex exits. A conventional
shortcut also falls back when macOS rejects its registration. Cindy shows a notification when
it changes the active shortcut. Users may edit both the preferred and fallback shortcuts.

The implementation reuses Cindy's existing macOS key snapshot listener. It must not create a
second keyboard event tap. A shared subscriber dispatches snapshots to voice input and
Appshots, keeping their trigger state independent.

### Capture destination

After capture, Cindy comes to the foreground and displays the Appshot as one attachment card
with the application name, window title, preview, and remove action.

- If the visible composer belongs to a writable Codex session, Cindy attaches there.
- Otherwise, Cindy immediately opens a new local Codex conversation draft and attaches there.
  Cindy preserves the capture in the draft cache; the existing lazy-create flow creates the
  durable session when the user sends the first message. This is Cindy's current new-conversation
  behavior and does not send an empty message merely to allocate a session ID.
- Cindy never attaches an Appshot to a Claude Code or Pi composer.
- Cindy never sends the message automatically.

Repeated shortcut presses while one capture is active do not queue duplicate captures. Cindy
reports that a capture is already in progress.

## Considered Approaches

### 1. Native macOS capture plus existing Cindy attachment flow

A small Swift helper uses macOS window and accessibility APIs. Cindy Main coordinates the
capture, then hands the result to the existing Renderer image cache and draft/session paths.
This gives Codex-style visual and structural context without adding a third-party dependency.

This is the selected approach.

### 2. Electron desktop capture

Electron can capture window images and titles, but it does not provide the accessibility tree
or reliable frontmost focused-window identity. The result would be a screenshot, not an
Appshot.

### 3. Cindy-owned screen-selection overlay

A custom overlay could select a region or window. It would add multi-display, Retina scaling,
focus, animation, and permission complexity while still requiring a native accessibility
collector. The confirmed workflow captures the frontmost window directly, so the overlay adds
no required value.

## Architecture

```text
global shortcut or Codex attachment action
  -> Appshot capture coordinator in Desktop Main
  -> macOS native helper
       -> frontmost application and focused window
       -> PNG window capture
       -> bounded accessibility text
  -> validated Appshot result
  -> Cindy image cache and Appshot inbox
  -> current Codex composer or new Codex draft
  -> existing Codex message input path when the user sends
```

### macOS native helper

The helper owns macOS-specific work:

1. Read `NSWorkspace.shared.frontmostApplication` before Cindy activates.
2. Resolve the application's focused accessibility window and its corresponding Core Graphics
   window ID. Prefer a visible layer-zero window and reject desktop elements, transparent
   windows, and degenerate bounds.
3. Capture only that window as PNG through the supported macOS window-capture API.
4. Traverse the focused window's accessibility hierarchy and produce deterministic text.
5. Return metadata as JSON and write the PNG into a private temporary capture directory.

Desktop Main creates the temporary directory, passes its exact path to the helper, validates
the returned file, ingests it into Cindy's existing image cache, and removes the temporary
directory. The helper never chooses an arbitrary output path.

The first release caps accessibility capture at 2,000 nodes, 16 levels, 512 KiB of UTF-8 text,
or 1.5 seconds, whichever comes first. The result includes a truncation marker when a cap is
reached. Each node may include role, label, title, value, description, enabled state, selected
state, and focused state when macOS exposes them. Empty attributes are omitted.

### Main-process coordinator

The coordinator provides one capture operation and one status stream. It:

- serializes capture attempts with a single in-flight guard;
- captures before activating Cindy;
- validates helper JSON, PNG signature, maximum image size, and temporary file location;
- maps native failures to stable user-facing error codes;
- emits the validated result only to Cindy windows;
- records status and error codes without logging image bytes, accessibility text, window title,
  or application content.

The coordinator accepts capture requests only on macOS. Renderer IPC callers cannot provide a
PID, window ID, or output path; the native helper resolves the frontmost target. This prevents
an untrusted Renderer payload from turning the helper into an arbitrary process or file reader.
The helper and coordinator reject a PNG larger than 100 MiB before Cindy ingests it, matching
Cindy's existing maximum for externally supplied images.

### Renderer Appshot inbox

The Renderer receives a completed capture through a small Appshot inbox. The inbox performs one
of two existing operations:

- add the attachment to the current Codex composer's attachment state; or
- route to the new-Codex draft and let `rehomeDraftAttachments` move the image after lazy session
  creation.

The inbox must consume each capture ID once. Window reloads may restore an unconsumed item, but
must not duplicate one already attached.

### Attachment contract

An Appshot remains an image attachment with additional typed metadata:

```ts
interface AppshotMetadata {
  schemaVersion: 1
  captureId: string
  capturedAt: string
  applicationName: string
  bundleIdentifier: string | null
  windowTitle: string | null
  accessibilityText: string | null
  accessibilityTruncated: boolean
  accessibilityUnavailableReason?: 'permission' | 'unsupported' | 'timeout'
}
```

`AttachedFile` and the persisted image reference carry this optional metadata. Existing image
renderers ignore it. The Codex composer renders an Appshot card when it exists.

When the user sends, the existing image attachment supplies the visual input. Cindy also adds a
text block with this shape, escaping attribute values and content:

```text
<appshot app="Application" bundle-identifier="com.example.app" window-title="Window">
Window: "Window", App: Application.
<accessibility-tree>
...bounded accessibility text...
</accessibility-tree>
</appshot>
```

The Main input boundary rejects Appshot metadata for non-Codex sessions even if a caller bypasses
the Renderer UI. Ordinary images keep their current payload and behavior.

## Permissions and Privacy

Appshots use three macOS permission classes:

- **Screen Recording** captures the window image.
- **Accessibility** reads the UI hierarchy.
- **Input Monitoring** is required for double-modifier global shortcuts; a conventional
  Electron global shortcut does not require it.

Cindy requests a permission only after the user invokes Appshots or selects a shortcut that
needs it. Permission guidance reuses the existing Computer Use and modifier-shortcut settings
paths.

Screen Recording is required. Without it, Cindy creates no attachment and offers the relevant
System Settings page. Accessibility may degrade independently: Cindy may attach the screenshot
with a visible **UI structure unavailable** warning and an authorization action.

The helper applies these privacy rules before returning data:

- `AXSecureTextField` nodes retain only their role and the label **Secure text field**;
- values of nodes marked protected by macOS are omitted;
- image bytes, accessibility text, and window titles stay in local attachment storage until the
  user sends the message;
- diagnostics and telemetry contain no captured content;
- removing an unsent Appshot uses the existing private attachment cleanup behavior.

Sending an Appshot is the user's explicit decision to send its image and structural text to the
selected Codex provider.

## Errors and Degraded Results

The coordinator returns stable outcomes:

| Outcome | Behavior |
| --- | --- |
| Screen Recording permission missing | No attachment; show permission action |
| Accessibility permission missing | Attach image with structural-context warning |
| Input Monitoring permission missing | Keep manual composer action; show shortcut permission action |
| No frontmost visible window | No attachment; show concise error |
| Target window closes during capture | No attachment; show concise error |
| Protected or blank capture | No attachment; explain that macOS or the application blocked capture |
| Accessibility traversal times out | Attach image with truncated or unavailable marker |
| Preferred shortcut conflict | Activate fallback and show the effective shortcut |
| Preferred and fallback both conflict | Disable global trigger; preserve manual Appshot action and settings repair path |
| Capture already in progress | Ignore duplicate request and report current capture |

## Testing and Acceptance

### Automated checks

Tests cover these boundaries with no more than ten focused test groups:

1. shortcut preference, conflict, fallback, persistence, and restoration;
2. double-modifier snapshots dispatch independently to voice input and Appshots;
3. helper-result validation rejects malformed JSON, paths outside the private temporary root,
   non-PNG data, and oversized output;
4. accessibility serialization redacts secure values and enforces node, depth, byte, and time
   limits;
5. capture results attach once to an active Codex composer;
6. no active Codex composer routes the item into a new local Codex draft;
7. non-Codex session input rejects Appshot metadata;
8. sending builds one image input and one escaped Appshot context block;
9. permission and target-window failures produce the specified degraded result or error;
10. ordinary image attachment and Claude provider-routing regression tests remain green.

The touched TypeScript modules must retain at least 80% line coverage. The native helper exposes
a deterministic self-test mode for accessibility serialization and validation that requires no
macOS permission prompt.

### Manual macOS checks

The test build verifies:

- Safari, Finder, a text editor, and Cindy as frontmost targets;
- Retina and non-Retina displays, multiple displays, and a window partly outside a display;
- full permissions, screenshot-only permission, and no permissions;
- secure text fields and protected windows;
- Cindy in foreground, background, and with all windows closed;
- current Codex composer, current non-Codex composer, and no existing session;
- Codex running causes Cindy to use the fallback shortcut;
- custom shortcuts survive restart and report conflicts;
- Appshots remain unsent until the user submits the message.

The release candidate must pass the existing Desktop and maker-core targeted suites, build with
Node 22, and produce a separate Cindy.app. Testing must not replace `/Applications/Cindy.app`.

## Compatibility

The feature requires no database migration. Cindy persists the optional Appshot object inside
the existing versioned JSON image-reference payload. Older Cindy versions may display an
Appshot as an ordinary image and ignore its metadata. Current mobile clients may display the
image but do not expose capture controls.

The implementation must not alter the saved Claude provider fix at `377c041d`, provider
credentials, phone pairing, remote connections, or existing Cindy installation data.
