# Teammate communication notifications

Incoming teammate replies carry the teammate's name and avatar in iOS communication
notifications. The OS supplies the Cindy app badge, layout, light/dark styling and
notification-preview privacy behavior. Ordinary task events keep their existing semantics.

## Wire contract and server prerequisite

The client adds optional `NotifyPayload.sender` to `session-done` only:

```ts
sender?: {
  id: string; // 64 hex characters, SHA-256 of device id + Bot id
  avatar?: {
    kind: 'jpeg' | 'symbol' | 'preset';
    value: string;
  };
};
```

The existing `title` supplies the sender name. The existing `collapseId` supplies the
conversation identifier, and `deepLink` retains teammate chat routing. Thumbnail generation
reads only the profile's managed avatar; it has a 150 ms budget and creates no persistent
cache or public URL. Presets are `cindy`, `dash`, and `lizi`; symbols are one grapheme with
at most 32 UTF-16 code units. JPEG base64 is at most 2048 characters and generated at
72×72 or smaller. No avatar value is interpreted as a URL or path on the phone.

The independently maintained server requires these coordinated changes before this feature
can appear on devices:

1. Extend its local `packages/device-link-protocol` with the same optional sender shape.
2. In `device-link-server/src/device-link/notify.ts`, validate and retain the sender on
   `session-done`. Require the 64-character hex identity; whitelist avatar kinds and presets,
   bound symbols and base64, and ignore malformed optional enrichment while preserving the
   valid original notification. Never accept arbitrary URLs or local file paths.
3. In `services/pushSender.ts`, copy a valid sender into APNs custom data and set
   `aps['mutable-content'] = 1`. Keep alert, sound, category, deepLink, collapse and thread id.
4. Measure the final serialized APNs body in UTF-8 against 4096 bytes. If enrichment exceeds
   the budget, remove the avatar first, then sender and mutable-content if necessary, keeping
   the original message deliverable. Include maximum-length CJK/emoji and JSON-escaping cases
   in the server's existing notify and pushSender tests.

The current server strips unknown fields and does not set mutable-content. A client-only
change therefore continues delivering ordinary notifications but cannot activate the new
appearance. Server support is a deployment prerequisite, not evidence supplied by client
type checks or a native compile.

## Native delivery and compatibility

`with-communication-notifications` generates a notification service extension for the
resolved app bundle identifier and records it for EAS signing. The extension donates an
incoming `INSendMessageIntent`, then updates the original notification content. Donation or
update errors and extension expiry deliver the original notification exactly once. No
contacts permission, app-account credentials or network avatar fetch is needed.

Deploy the compatible server first, then the desktop producer and a new signed mobile
installation containing the extension. Old desktops send ordinary payloads; old servers
discard the optional sender; old mobile installations display the original alert.
No database migration or mandatory coordinated upgrade is required for existing delivery.

The native source, plugin configuration and bundled avatar assets change the shared Expo
fingerprint; both platform hashes must be checked when preparing the native release.
Do not publish this as an OTA-only feature or fake compatibility with an older runtime.
Before merge, obtain the repository's explicit cold-release review; before claiming user
delivery, verify a real APNs reply on a signed iPhone installation, including locked/unlocked
preview settings and tapping through to the teammate chat. Simulator compilation alone
does not verify notification-center rendering.

Apple reference: [Implementing communication notifications](https://developer.apple.com/documentation/usernotifications/implementing-communication-notifications).
