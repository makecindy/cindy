# @cindy/im

Pure-Node IM transport package. Provides a `BaseIM` abstraction and ready-to-use Feishu, Discord, Telegram, WeCom, and DingTalk channel implementations for hosts that want to expose an IM bot interface — chat on these channels, work happens in the host.

This package is **fully decoupled from any application** — host code injects every capability the package can't provide on its own (encrypted storage, IPC bridge, file paths, optional logger). Designed to be lifted out of this repo as a standalone npm package.

## Design constraints

- **Zero runtime dependencies** outside what the IM protocols actually require:
  - `@larksuiteoapi/node-sdk` (Feishu WebSocket + REST)
  - `discord.js` (Discord gateway + REST)
  - `dingtalk-stream` (DingTalk Stream)
  - `@wecom/aibot-node-sdk` (WeCom AI bot SDK)
- **No** `electron`, `@cindy/maker-core`, `@cindy/mcps`, `drizzle-orm`, `@paralleldrive/cuid2`, or workspace-internal packages
- **No** imports from `apps/**` (enforced by the source directory boundary; verified by ESLint `no-restricted-imports` rule on `electron`)
- **Pure transport / connection layer** — knows nothing about agents, sessions, business cards, model selection, or DB. Host owns all of those and uses the package's outbound API to drive the channels.

## Architecture

```
              ┌──────────────────────────┐
              │  Your host (apps/desktop │
              │   or any other Node app) │
              └────────────┬─────────────┘
        IMHost adapter │   │  BaseIM API (init / dispose /
        (host → pkg)   │   │   onMessage / sendText / ...)
                       ▼   ▼
               ┌──────────────────┐
               │     @cindy/im      │
               │  ┌────────────┐  │
               │  │  BaseIM    │  │   abstract
               │  └─────▲──────┘  │
               │  ┌─────┴──────┐  │
               │  │ FeishuIM   │  │   concrete (uses @larksuiteoapi/node-sdk)
               │  └────────────┘  │
               └──────────────────┘
```

## Quick start

```ts
import { createIM, createFeishuIM, type IMHost } from '@cindy/im';

// 1. Build an IMHost — this is the ONLY surface the package depends on.
const host: IMHost = {
  paths: {
    feishuMediaDir: '/path/to/your/app/data/feishu-media',
  },
  secrets: {
    isAvailable: () => true,
    write(name, plaintext) { /* persist encrypted */ return true; },
    read(name) { /* return decrypted or null */ return null; },
    remove(name) { /* delete */ },
  },
  ipc: {
    throwIpcError(code, message) { throw new Error(`[${code}] ${message}`); },
    handle(channel, handler) { /* bind invoke handler — used for Settings UI */ },
    broadcast(channel, payload) { /* push to all UI windows */ },
  },
  async httpPostForm(url, form) {
    const response = await fetch(url, { method: 'POST', body: form });
    return { status: response.status, body: await response.json() };
  },
  // optional:
  // createLogger(scope) { return /* your logger */; },
};

// 2. Instantiate channels and aggregate.
const feishuIm = createFeishuIM(host);
const im = createIM([feishuIm]);

// 3. Lifecycle.
im.registerIpc();           // sync — register Settings UI handlers
await im.init();            // async — auto-connect if creds saved
// ... app runs ...
await im.dispose();         // async — graceful shutdown (sends offline notice)

// 4. Subscribe to inbound messages and card-button presses.
feishuIm.onMessage((event) => {
  // event.text, event.attachments, event.unsupported, event.senderId, event.messageId, ...
  // Decide what to do — invoke an LLM, run a tool, etc.
});
feishuIm.onCardAction((event) => {
  // event.buttonId, event.payload — your card schema
});

// 5. Outbound — send to a user any time, not just in reply.
const openId = 'ou_xxxx...';
await feishuIm.sendText(openId, 'Hello!');
const handle = await feishuIm.startStreamingText(openId);
handle.append('streaming chunk');
await handle.finalize('final text with **markdown**');
await feishuIm.sendInteractiveCard(openId, {
  title: 'Pick one',
  body: 'Body text',
  buttons: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
});
await feishuIm.sendFile(openId, '/abs/path/to/file.pdf');

// 6. Owner — the first p2p sender is claimed automatically (TOFU).
// Clear credentials via Settings to reset it.
```

## Public API

See `src/index.ts` for the full export surface. Highlights:

| Export | Purpose |
|---|---|
| `BaseIM` | Abstract base — extend to add a new channel |
| `createIM(channels)` | Aggregate facade with `init / dispose / registerIpc` |
| `createFeishuIM(host)` | Concrete Feishu channel |
| `createDiscordIM` / `createTelegramIM` / `createWecomIM` / `createDingTalkIM` | Other concrete channel factories |
| `FeishuIM` | Class — exposes inbound subscriptions + outbound API |
| `IMHost` | Capabilities the host must provide |
| `IMMessageEvent` | Inbound message payload (text + attachments + unsupported + ack id) |
| `IMCardActionEvent` | Inbound card button press |
| `IMStatus` | Connection status union |
| `InteractiveCardSpec` | Outbound card spec |
| `StreamingTextHandle` | Throttled streaming text handle |

## Channel-specific behavior (feishu)

- **p2p only.** Group / topic chats are dropped at the WS layer. Outbound API takes a single `openId: string` (no chat_id).
- **TOFU owner by default.** The first p2p sender becomes the persisted owner; later senders are dropped unless public guest access is configured. Clearing credentials resets the owner.
- **`xdt-image://` / `xdt-file://` rewrite in streaming text.** The `startStreamingText` handle's `finalize` step uploads any `xdt-image://` references to feishu (mediaDir-resolved) and inlines them as `img` elements in the final card; `xdt-file://` references are sent as separate file messages and stripped from the card body. Mid-stream patches show friendly placeholders.
- **Conflict detection.** Multi-device occupancy of the same App ID is detected via WS reconnect heuristics (legacy SDK behavior) and surfaces as a `'feishuBot:conflict'` push to `host.ipc.broadcast` callers.
- **Lifecycle announcements.** On connect / graceful disconnect, an "online" / "offline" text is sent to the first whitelisted open_id (best-effort, 1.5 s timeout on stop).

## Renderer / UI compatibility

The IPC channel names registered by `registerIpc()` are stable strings (`feishuBot:get-state`, `feishuBot:save`, `feishuBot:clear`, `feishuBot:status-change`, `feishuBot:conflict`) so existing renderer code that targets the legacy "feishuBot" namespace works unchanged. Host's `IMHost.ipc` adapter is the only thing that needs to bridge these to the host's UI transport.

## Testing

```bash
pnpm -F @cindy/im run build   # tsc --noEmit
pnpm -F @cindy/im run lint    # eslint (no-restricted-imports enforces no electron)
pnpm -F @cindy/im run test    # vitest
```

## Adding a new channel

1. Create `src/{channel}/` directory with `index.ts` exposing a class extending `BaseIM`
2. Add a `createXxxIM(host)` factory
3. Re-export both from `src/index.ts`
4. Channel implementation has full freedom — its own dependencies, its own inbound/outbound primitives, its own card shape — as long as the `BaseIM` lifecycle contract is honoured and any new host needs are added to the `IMHost` interface
