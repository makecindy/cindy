---
id: voice-input
title: Using voice input (dictation)
summary: Dictate with the global shortcut, the composer mic button, or by holding the composer; configure voice service, language, microphone, shortcut, refinement, dictionary, voiceprint filter, and sounds in Settings > Voice Input.
tab: voice-input
---
Voice input lets you dictate instead of typing. The recognized text goes into the Cindy composer you're typing in, or, when another app is in front, is typed into that app's focused text field.

**Starting and stopping:**

- **Global shortcut** — default **Option+Space** (shown as Alt+Space) on macOS and **Ctrl+Shift+Space** on Windows. **Hold** it, speak, and release to finish. Or **tap** it once to keep recording hands-free, then press it again to finish. It works even when Cindy isn't the active app. On Linux the global shortcut isn't supported yet; use the in-app voice input button.
- **Composer mic button** — click **Start voice input** in the message composer; click again to stop.
- **Hold the composer** — press and hold the left mouse button inside the composer for a moment to start; release to stop and insert the text.
- Recording starts right away when you trigger it. Audio captured while the recognition service is still connecting is kept (about 60 seconds is buffered) and sent once it connects, so the beginning of your speech isn't lost.
- Outside Cindy, a small overlay shows the live transcript. **Finish and input** inserts it; **Close and discard** cancels. If Cindy can't type into the current app, the overlay keeps the text with a **Copy** button.

**Settings > Voice Input:**

- **Service source → Voice service** — **Cindy official service** (default; uses your Cindy sign-in) or **Custom voice service** (choose a recognition model that uses its own credentials, or **Custom realtime ASR** with your own WebSocket URL, model, and API key; **Test connection** checks it). When you're not signed in, use a custom service.
- **Basics:**
  - **Language** — **Auto** (default) / Simplified Chinese / Traditional Chinese / English / Japanese / Korean / Spanish. The China edition defaults to Simplified Chinese. There's no free-form locale field.
  - **Microphone** — **Auto** (system default) or a specific device.
  - **Shortcut** — click to record a new one: a key combination, a standalone F1–F24 key, or (macOS) holding Left/Right Command, Option, Control, or Fn. **Clear** removes it. Cindy rejects shortcuts that conflict with system or common editing shortcuts.
- **Refinement:**
  - **Voice refinement** (on by default) — cleans up punctuation, terminology, and spoken phrasing. Turn it off to use the raw recognition result.
  - **Refinement rules** — editable instructions for your preferred style (they guide cleanup only; the model won't answer or expand content).
  - **Custom dictionary** — add names, product terms, and jargon, optionally with **Often misheard as** variants; **Import CSV** (one term per row) adds many at once. Filter by **All** / **Auto-added** / **Manual**.
  - **Auto-learning** (on by default) — when you correct dictated words by hand, Cindy records candidates and adds them to the dictionary after repeated evidence. Learning from edits in other apps is macOS-only.
  - **Sync across my devices** (on by default) — merges your dictionary between your computers that are online at the same time, device to device, without storing it on a server.
- **Preferences:**
  - **Mute during voice input** (on by default) — temporarily mutes system audio and restores it afterwards. The start cue finishes before muting, and capture isn't interrupted. Not supported on Linux.
  - **Fast voice activation** (off by default) — keeps the microphone ready briefly after use so recording starts about 100 ms sooner; the mic is released after 30 minutes without use.
  - **Sound cues** (on by default) — short sounds when voice input starts and ends.
- **Voiceprint filter → Recognize my voice** (off by default) — record your voiceprint (read three short passages) so only your voice is transcribed. The first use downloads a recognition model. **Strictness**: Relaxed / Standard / Strict. The voiceprint stays encrypted on this computer.
- **Usage** — duration, count, and estimated cost, plus **Recent transcripts** you can copy or delete.

**Permissions (macOS):**

- **Microphone** — required. The page shows **Granted** or a **Grant** button.
- **Shortcut listener** (Input Monitoring) — needed only for Fn, standalone Command / Option / Control, and standalone F1–F24 shortcuts. Regular key combinations don't need it.
- **Automatic input** (Accessibility) — lets voice input type into other apps, read nearby text for refinement context, and learn from your edits there.

**Notes:**

- If Cindy reports "Too many voice requests", wait a moment before trying again.
- If the shortcut can't be registered (for example, another app or input method already uses it), the page shows a warning; pick a different shortcut.
- If the connection drops mid-dictation, the text recognized so far is kept — in the composer, or in the overlay with a copy button — instead of being discarded. That text isn't refined.
