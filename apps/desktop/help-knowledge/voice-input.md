---
id: voice-input
title: Using voice input (dictation)
summary: Push-to-talk dictation that inserts ASR text into the focused composer; configure shortcut, mic, language, refinement, and dictionary in Settings > Voice Input.
tab: voice-input
---
Voice input lets you dictate instead of typing. Hold a shortcut, talk, release — the recognized text is inserted into whichever composer has focus.

**Activation:**

- Default shortcut: **Alt+Space** on macOS, **Ctrl+Shift+Space** on Windows. The shortcut is customizable on macOS and Windows. On Linux, global voice shortcuts are not supported yet (the setting is hidden).
- The shortcut is **global** — it works even when Cindy isn't the focused app, so you can dictate into the composer from anywhere.
- It's **push-and-hold**: press to start listening, release to stop and submit.

**Settings:**

- **Microphone** — pick a specific device or leave on "auto" (system default).
- **Language** — auto / 中文 (zh-CN) / English / 日本語 / 한국어. Those are the supported recognition locales — there's no free-form locale field.
- **Refinement** — optional LLM post-process that cleans up the raw ASR text (fixes punctuation, removes ums, joins fragments). You can write a custom refinement prompt to bias it toward your preferences.
- **Mute system audio while recording** — toggle; reduces feedback / echo from your speakers picking up onto the mic. On by default.
- **Fast activation** — toggle; keeps the mic warm so press-to-talk has lower latency at the cost of slightly more background mic usage. Off by default.
- **Interaction sound** — a short sound cue when dictation starts / stops. On by default.

**Dictionary (improves recognition of your terms):**

- **Manual entries** — type terms you want recognized (people's names, product names, jargon).
- **Learned entries** — when you edit the text shortly after dictation lands in the composer, the external-edit inspector picks up your corrections and feeds them back as automatic dictionary entries. Both manual and learned entries feed the refinement pass.

**Permissions (macOS):**

- **Microphone** — required; the page prompts the OS dialog if you haven't granted it.
- **Input Monitoring** and **Accessibility** — may be required depending on how the global shortcut is captured. The page shows each permission's status (granted / denied / unknown) so you know what to grant in System Settings.

**Notes:**

- Push-and-hold is the primary activation mode; **Fast activation** changes the warm-up behavior, not the trigger itself.
- If the global shortcut fails to register (e.g. it's already taken by another app like an IME), you'll see a warning in the page; pick a different shortcut.
- If the connection drops mid-dictation, the text recognized up to that point is kept — it lands in the composer (or stays in the overlay with a copy button) alongside the error, instead of being discarded. That salvaged text is raw ASR output: refinement needs the connection that just failed, so it is skipped.
