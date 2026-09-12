[简体中文](README.zh_CN.md) · **English**

# Cindy Passport BLE

## What is AI Passport?

[AI Passport](https://ai-passport.folotoy.cn) is FoloToy's open-source wearable device with a screen, buttons, microphone and speaker. Community firmware gives it different applications. This companion turns it into a Cindy task reader and voice-reply device.

- [Independent Cindy firmware and releases](https://github.com/lengjingxu/cindy-passport)
- [AI Passport official community](https://ai-passport.folotoy.cn)
- [AI Passport official hardware and source](https://github.com/FoloToy/ai-passport)

## Connect to Cindy

The matching ESP32-C3 firmware connects to Cindy on macOS. Enable it in Settings → Shortcuts → Accessories → Cindy Passport. Select a discovered device and enter its displayed pairing code if macOS asks. The menu-bar control remains available. Bluetooth access is required; the default is off. The owner-scoped `passport-settings.json` stores only explicit overrides. Reset removes the override; `CINDY_PASSPORT_BLE=1` sets the development default. Other platforms show an unsupported state.

Development uses the normal isolated wrapper:

```sh
pnpm restart:desktop:remote --region=global --isolated=@worktree
```

Development requires Xcode command-line tools; packaged builds include the Swift helper. Selected device IDs are scoped to the profile and data owner in UserDefaults. Disconnect clears automatic connection, not macOS/NimBLE bond keys. No Wi-Fi or HTTP substitution occurs.

The active local task catalog filters archived and worker sessions. Up to eight tasks are ranked waiting, error, running, completed. Observed completed/error states remain in memory after the activity overlay clears them, capped at 100; adapter stop clears history. Busy tasks may fill all eight slots. Remote mirrored tasks and sidebar ordering are not reproduced.

The task list shows status. UP/DOWN selects a task and OK opens it. In task details, UP/DOWN pages through the latest visible Cindy reply; OK records a voice reply and another OK stops for transcription. After transcription, Passport displays the text: UP discards it and records again, DOWN cycles its pages, and OK confirms sending to that original task. Holding OK exits and cancels an unconfirmed recording.

Audio uses 16 kHz mono, fixed 16 kbit/s Opus and 40 ms frames. Complete audio is decoded to PCM in memory and routed through Cindy's currently selected voice-input service and ASR model. Managed Cindy voice and explicitly configured providers reuse their existing credentials and connection paths. Configuration or account changes abort the recording; Passport does not choose another model.

Main only releases hardware-confirmed text to the original local task. The renderer submits it through Cindy's normal input queue without replacing an existing composer draft, then acknowledges acceptance. Each confirmation is claimed once. Confirmations not collected by Cindy within 15 seconds return to review. Leaving the page clears device tracking without undoing an already claimed message. Rejected sends return to hardware review and require another confirmation; disconnects invalidate pending approvals. No raw audio or transcription is logged. Task replies respect clear and rewind visibility boundaries and are paged within the existing fixed-size snapshots.

Service `C1DC0001-51C4-499D-A186-4621A4938301`: authenticated RX `8302`, authenticated read/notify TX `8303`, voice indicate `8304`. Task protocol remains v1: uint16LE length, version, count, then 40/80/16/192-byte NUL-padded UTF-8 fields. Voice v1: kind:u8, token:u32LE, sequence:u16LE; start=1 (40-byte ID), audio=2 (1–120 encoded bytes), finish=3, cancel=4. Sequence begins at zero and increments for every audio frame; terminal packets carry the next sequence. Maximum 752 frames and 45 seconds elapsed, including the firmware's silent encoder flush. Firmware/client must both support voice; older firmware still supports task snapshots.

Ogg Opus positions use the fixed 48 kHz clock: each 40 ms packet advances 1,920 samples, regardless of the 16 kHz input. After changing main-process voice code, restart the desktop through the development wrapper; renderer hot reload does not replace the running packet validator.

Host tests and builds do not prove physical recording quality, no-PSRAM memory headroom, permissions, reconnect or Chinese display quality. These require the updated board firmware and manual acceptance. No physical flashing is performed by the build.

Device controls use TX notifications: `version=2:u8, action:u8, taskId:40 bytes, recordingToken:u32LE` (46 bytes, ATT MTU at least 49). Actions 1–6 are open, previous page, next page, re-record, confirm and cancel. Review actions must match the task and recording token. Snapshot status uses `draft:<8-hex-token>` for review, `retry:<8-hex-token>` for rejected sends, `asr:<8-hex-token>` during transcription and `error:<8-hex-token>` on transcription failure. Tokens are not displayed on the device. Reply pages carry `[page/count]` followed by three short rows. Update firmware and desktop together.

Unexpected helper exits retry up to five times with increasing delays. A helper that runs for at least one minute resets the retry budget. After repeated startup failures, disable and re-enable the accessory to retry.
