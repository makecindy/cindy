import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiscordIM } from '../index.js';
import { normalizeDmMessage } from '../inbound.js';
import type { AttachmentLike, StickerLike } from '../inbound.js';
import type { IMHost, IMHostMediaCache, IMMessageEvent, IMStatus } from '../../types.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of createdTempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Discord routing identity', () => {
  it('keeps gateway application id separate from the display tag across bot changes', () => {
    const gateway = makeGateway();
    const im = new DiscordIM(makeHost(), { gatewayFactory: (handlers) => {
      gateway.setHandlers(handlers);
      return gateway;
    } });
    gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    expect(im.getStatus()).toEqual({ kind: 'connected', appId: 'bot#0000' });
    expect(im.botContextId).toBe('app-1');
    gateway.setAppId('app-2');
    expect(im.botContextId).toBe('app-2');
    gateway.setAppId('');
    expect(im.botContextId).toBe('');
  });
});

describe('normalizeDmMessage', () => {
  it('normalizes plain DM text fields', async () => {
    const event = await normalizeDmMessage(message({ content: 'hello' }), {
      contextId: 'app-1',
      download: vi.fn(),
    });

    expect(event).toMatchObject({
      channelName: 'discord',
      senderId: 'user-1',
      chatId: 'dm-1',
      contextId: 'app-1',
      messageId: 'dm-1|msg-1',
      text: 'hello',
      attachments: [],
      unsupported: [],
      threadTs: undefined,
      scopeKey: undefined,
    });
  });

  it('returns null when channel id is missing so the transport suppresses it', async () => {
    // `channelId: ''` flows through the helper because `'' ?? 'dm-1'` is `''`
    // (only null/undefined triggers the default). Asserts an explicit empty
    // string is treated as a missing channel.
    const emptyString = await normalizeDmMessage(
      message({ content: 'hello', channelId: '' }),
      { contextId: 'app-1', download: vi.fn() },
    );
    expect(emptyString).toBeNull();

    // A genuinely channel-less event (no channelId and no channel.id) —
    // e.g. a partial presence update or a guild event leaking past the DM
    // filter — must also be suppressed. The `message()` helper defaults a
    // missing channelId to 'dm-1', so construct the raw object directly.
    const channelLess = await normalizeDmMessage(
      {
        id: 'msg-x',
        content: 'leaked guild text',
        author: { id: 'user-1' },
        attachments: [],
        stickers: [],
      } as Parameters<typeof normalizeDmMessage>[0],
      { contextId: 'app-1', download: vi.fn() },
    );
    expect(channelLess).toBeNull();
  });

  it('classifies octet-stream attachments by extension (image → media store, never file staging)', async () => {
    const download = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const media = makeMedia();
    const files = makeFiles();

    const event = (await normalizeDmMessage(
      message({
        attachments: [
          { id: 'att-o', name: 'scan.JPG', url: 'https://cdn.example/scan', size: 10, contentType: 'application/octet-stream' },
        ],
      }),
      { contextId: 'app-1', download, media, files },
    ))!;

    expect(files.stage).not.toHaveBeenCalled();
    expect(media.cacheImage.mock.calls[0][0]).toEqual(
      expect.objectContaining({ token: 'att-o', mimeType: 'image/jpeg', staging: true }),
    );
    expect(event.attachments).toEqual([expect.objectContaining({ kind: 'image', originalName: 'scan.JPG' })]);
  });

  it('routes image attachments into the host media store (no legacy dir)', async () => {
    const download = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const media = makeMedia();

    const event = (await normalizeDmMessage(
      message({
        attachments: [
          {
            id: 'att-1',
            name: 'photo.png',
            url: 'https://cdn.example/photo.png',
            size: 1024,
            contentType: 'image/png',
          },
        ],
      }),
      { contextId: 'app-1', download, media },
    ))!;

    expect(download).toHaveBeenCalledWith('https://cdn.example/photo.png');
    expect(media.cacheImage).toHaveBeenCalledTimes(1);
    expect(media.cacheImage.mock.calls[0][0]).toEqual({
      integration: 'discord',
      token: 'att-1',
      buffer: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      staging: true,
    });
    expect(event.attachments).toEqual([
      {
        kind: 'image',
        absPath: '/blobs/att-1.png',
        originalName: 'photo.png',
        mimeType: 'image/png',
        url: 'cindy-media://blobs/att-1.png',
      },
    ]);
    expect(event.unsupported).toEqual([]);
  });

  it('routes images → cacheImage, audio/video → cacheMedia, other files → host.files.stage', async () => {
    const download = vi.fn(async (url: string) => new TextEncoder().encode(url));
    const media = makeMedia();
    const files = makeFiles();
    const stagedDiscards: Array<() => Promise<void>> = [];

    const event = (await normalizeDmMessage(
      message({
        attachments: [
          { id: 'att-1', name: 'photo.png', url: 'https://cdn.example/photo.png', size: 1024, contentType: 'image/png' },
          { id: 'att-2', name: 'notes.pdf', url: 'https://cdn.example/notes.pdf', size: 1024, contentType: 'application/pdf' },
          { id: 'att-3', name: 'clip.mp4', url: 'https://cdn.example/clip.mp4', size: 1024, contentType: 'video/mp4' },
          { id: 'att-4', name: 'voice.ogg', url: 'https://cdn.example/voice.ogg', size: 1024, contentType: 'audio/ogg' },
        ],
      }),
      { contextId: 'app-1', download, media, files, stagedDiscards },
    ))!;

    expect(media.cacheImage).toHaveBeenCalledTimes(1);
    expect(media.cacheImage.mock.calls[0][0]).toMatchObject({ integration: 'discord', token: 'att-1', mimeType: 'image/png' });
    expect(files.stage).toHaveBeenCalledTimes(1);
    expect(files.stage.mock.calls[0][0]).toEqual({
      integration: 'discord',
      buffer: new TextEncoder().encode('https://cdn.example/notes.pdf'),
      fileName: 'notes.pdf',
    });
    expect(media.cacheMedia.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ integration: 'discord', token: 'att-3', mimeType: 'video/mp4' }),
      expect.objectContaining({ integration: 'discord', token: 'att-4', mimeType: 'audio/ogg' }),
    ]);
    expect(event.attachments).toEqual([
      {
        kind: 'image',
        absPath: '/blobs/att-1.png',
        originalName: 'photo.png',
        mimeType: 'image/png',
        url: 'cindy-media://blobs/att-1.png',
      },
      { kind: 'file', absPath: '/staged/notes.pdf', originalName: 'notes.pdf', mimeType: 'application/pdf' },
      {
        kind: 'file',
        absPath: '/blobs/att-3.bin',
        originalName: 'clip.mp4',
        mimeType: 'video/mp4',
        url: 'cindy-media://blobs/att-3.bin',
      },
      {
        kind: 'file',
        absPath: '/blobs/att-4.bin',
        originalName: 'voice.ogg',
        mimeType: 'audio/ogg',
        url: 'cindy-media://blobs/att-4.bin',
      },
    ]);
    expect(event.unsupported).toEqual([]);
    // staged file + both cacheMedia entries hand back rollback handles for config switches.
    expect(stagedDiscards).toHaveLength(3);
    await Promise.all(stagedDiscards.map((discard) => discard()));
    expect(files.discards).toHaveLength(1);
    expect(files.discards[0]).toHaveBeenCalledTimes(1);
    expect(media.discards).toHaveLength(2);
    for (const discard of media.discards) expect(discard).toHaveBeenCalledTimes(1);
  });

  it('host.media.cacheImage 抛错:标不支持, 不回落老目录', async () => {
    const download = vi.fn(async () => new Uint8Array([1]));
    const media = makeMedia();
    media.cacheImage.mockRejectedValueOnce(new Error('db not ready'));

    const event = (await normalizeDmMessage(
      message({
        attachments: [
          { id: 'att-1', name: 'photo.png', url: 'https://cdn.example/photo.png', size: 1024, contentType: 'image/png' },
        ],
      }),
      { contextId: 'app-1', download, media },
    ))!;

    expect(download).toHaveBeenCalledTimes(1);
    expect(event.attachments).toEqual([]);
    expect(event.unsupported).toEqual([{ type: 'image', label: 'photo.png' }]);
  });

  it('marks attachments unsupported without downloading when the host lacks the capability', async () => {
    const download = vi.fn(async () => new Uint8Array([1]));
    const attachments: AttachmentLike[] = [
      { id: 'att-1', name: 'photo.png', url: 'https://cdn.example/photo.png', size: 1024, contentType: 'image/png' },
      { id: 'att-2', name: 'notes.pdf', url: 'https://cdn.example/notes.pdf', size: 1024, contentType: 'application/pdf' },
      { id: 'att-3', name: 'clip.mp4', url: 'https://cdn.example/clip.mp4', size: 1024, contentType: 'video/mp4' },
      { id: 'att-4', name: 'voice.ogg', url: 'https://cdn.example/voice.ogg', size: 1024, contentType: 'audio/ogg' },
    ];

    const bare = (await normalizeDmMessage(message({ attachments }), { contextId: 'app-1', download }))!;
    expect(download).not.toHaveBeenCalled();
    expect(bare.attachments).toEqual([]);
    expect(bare.unsupported).toEqual([
      { type: 'image', label: 'photo.png' },
      { type: 'file', label: 'notes.pdf' },
      { type: 'video', label: 'clip.mp4' },
      { type: 'audio', label: 'voice.ogg' },
    ]);

    // host.media without cacheMedia: images still go to the store, audio/video stay unsupported.
    const imageOnlyMedia: IMHostMediaCache = { ...makeMedia(), cacheMedia: undefined };
    const partial = (await normalizeDmMessage(message({ attachments }), {
      contextId: 'app-1',
      download,
      media: imageOnlyMedia,
    }))!;
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith('https://cdn.example/photo.png');
    expect(partial.attachments.map((a) => a.originalName)).toEqual(['photo.png']);
    expect(partial.unsupported).toEqual([
      { type: 'file', label: 'notes.pdf' },
      { type: 'video', label: 'clip.mp4' },
      { type: 'audio', label: 'voice.ogg' },
    ]);
  });

  it('marks a staging failure unsupported instead of falling back to a legacy dir', async () => {
    const download = vi.fn(async () => new Uint8Array([1]));
    const files = makeFiles();
    files.stage.mockRejectedValueOnce(new Error('disk full'));
    const stagedDiscards: Array<() => Promise<void>> = [];

    const event = (await normalizeDmMessage(
      message({
        attachments: [
          { id: 'att-2', name: 'notes.pdf', url: 'https://cdn.example/notes.pdf', size: 1024, contentType: 'application/pdf' },
        ],
      }),
      { contextId: 'app-1', download, files, stagedDiscards },
    ))!;

    expect(event.attachments).toEqual([]);
    expect(event.unsupported).toEqual([{ type: 'file', label: 'notes.pdf' }]);
    expect(stagedDiscards).toEqual([]);
  });

  it('reports a voice message as unsupported audio only when it carries no attachments', async () => {
    const download = vi.fn(async () => new Uint8Array([1]));
    const media = makeMedia();

    const empty = (await normalizeDmMessage(message({ type: 'VoiceMessage' }), {
      contextId: 'app-1',
      download,
      media,
    }))!;
    expect(empty.unsupported).toEqual([{ type: 'audio', label: 'audio message' }]);

    const withClip = (await normalizeDmMessage(
      message({
        type: 'VoiceMessage',
        attachments: [
          { id: 'att-v', name: 'voice-message.ogg', url: 'https://cdn.example/v.ogg', size: 1024, contentType: 'audio/ogg' },
        ],
      }),
      { contextId: 'app-1', download, media },
    ))!;
    expect(withClip.unsupported).toEqual([]);
    expect(withClip.attachments).toEqual([
      expect.objectContaining({ kind: 'file', originalName: 'voice-message.ogg', mimeType: 'audio/ogg' }),
    ]);
    expect(media.cacheMedia).toHaveBeenCalledWith(
      expect.objectContaining({ integration: 'discord', token: 'att-v', mimeType: 'audio/ogg' }),
    );
  });

  it('marks attachments over 50MiB unsupported without downloading', async () => {
    const download = vi.fn();
    const files = makeFiles();

    const event = (await normalizeDmMessage(
      message({
        attachments: [
          {
            id: 'att-1',
            name: 'huge.zip',
            url: 'https://cdn.example/huge.zip',
            size: 51 * 1024 * 1024,
            contentType: 'application/zip',
          },
        ],
      }),
      { contextId: 'app-1', download, files },
    ))!;

    expect(download).not.toHaveBeenCalled();
    expect(files.stage).not.toHaveBeenCalled();
    expect(event.attachments).toEqual([]);
    expect(event.unsupported).toEqual([{ type: 'oversize', label: 'huge.zip' }]);
  });

  it('marks stickers unsupported', async () => {
    const event = (await normalizeDmMessage(
      message({ stickers: [{ id: 'sticker-1', name: 'wave' }] }),
      { contextId: 'app-1', download: vi.fn() },
    ))!;

    expect(event.unsupported).toEqual([{ type: 'sticker', label: 'wave' }]);
  });

  it('uses distinct store tokens for same-name attachments on different messages', async () => {
    const media = makeMedia();
    const download = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return new Uint8Array([1]);
    });

    const [first, second] = await Promise.all([
      normalizeDmMessage(
        message({
          id: 'msg-a',
          attachments: [
            {
              id: 'att-a',
              name: 'image.png',
              url: 'https://cdn.example/a.png',
              size: 1024,
              contentType: 'image/png',
            },
          ],
        }),
        { contextId: 'app-1', download, media },
      ),
      normalizeDmMessage(
        message({
          id: 'msg-b',
          attachments: [
            {
              id: 'att-b',
              name: 'image.png',
              url: 'https://cdn.example/b.png',
              size: 1024,
              contentType: 'image/png',
            },
          ],
        }),
        { contextId: 'app-1', download, media },
      ),
    ]);

    if (!first || !second) throw new Error('expected both messages');
    expect(media.cacheImage.mock.calls.map((c) => c[0].token)).toEqual(['att-a', 'att-b']);
    expect(first.attachments[0]?.absPath).toBe('/blobs/att-a.png');
    expect(second.attachments[0]?.absPath).toBe('/blobs/att-b.png');
    expect(first.attachments[0]?.originalName).toBe('image.png');
    expect(second.attachments[0]?.originalName).toBe('image.png');
  });

  it('uses distinct store tokens for same-name attachments on the same message', async () => {
    const media = makeMedia();
    const download = vi.fn(async () => new Uint8Array([1]));

    const event = (await normalizeDmMessage(
      message({
        id: 'msg-a',
        attachments: [
          { name: 'image.png', url: 'https://cdn.example/1.png', size: 1024, contentType: 'image/png' },
          { name: 'image.png', url: 'https://cdn.example/2.png', size: 1024, contentType: 'image/png' },
        ],
      }),
      { contextId: 'app-1', download, media },
    ))!;

    // Without platform attachment ids the token falls back to `msgId-index`.
    expect(media.cacheImage.mock.calls.map((c) => c[0].token)).toEqual(['msg-a-0', 'msg-a-1']);
    expect(event.attachments.map((a) => a.absPath)).toEqual(['/blobs/msg-a-0.png', '/blobs/msg-a-1.png']);
    expect(event.attachments.map((a) => a.originalName)).toEqual(['image.png', 'image.png']);
  });
});

describe('DiscordIM inbound pipeline', () => {
  it('defers lifecycle preference reads until explicit init', async () => {
    const host = makeHost({
      initialSecrets: [['discord-bot-lifecycle-announcement', 'false']],
    });
    const readSecret = vi.spyOn(host.secrets, 'read');
    const im = new DiscordIM(host);

    expect(readSecret).not.toHaveBeenCalled();

    im.registerIpc();
    await im.init();

    expect(readSecret).toHaveBeenCalledWith('discord-bot-lifecycle-announcement');
    await expect(host.invoke('discordBot:get-status')).resolves.toMatchObject({
      lifecycleAnnouncement: false,
    });
  });

  it('reads the persisted lifecycle preference from IPC before init', async () => {
    const host = makeHost({
      initialSecrets: [['discord-bot-lifecycle-announcement', 'false']],
    });
    const readSecret = vi.spyOn(host.secrets, 'read');
    const im = new DiscordIM(host);

    expect(readSecret).not.toHaveBeenCalled();

    im.registerIpc();

    await expect(host.invoke('discordBot:get-status')).resolves.toMatchObject({
      lifecycleAnnouncement: false,
    });
    expect(readSecret).toHaveBeenCalledWith('discord-bot-lifecycle-announcement');
  });

  it('rolls back a pre-init lifecycle write failure to the persisted preference', async () => {
    const host = makeHost({
      initialSecrets: [['discord-bot-lifecycle-announcement', 'false']],
      write: (name, value, secrets) => {
        if (name === 'discord-bot-lifecycle-announcement') return false;
        secrets.set(name, value);
        return true;
      },
    });
    const im = new DiscordIM(host);
    im.registerIpc();

    await expect(
      host.invoke('discordBot:set-lifecycle-announcement', { enabled: true }),
    ).resolves.toEqual({
      ok: false,
      lifecycleAnnouncement: false,
    });
    expect(host.readSecret('discord-bot-lifecycle-announcement')).toBe('false');
  });

  it('rolls back a post-init lifecycle write failure to the persisted preference', async () => {
    let rejectLifecycleWrites = false;
    const host = makeHost({
      initialSecrets: [['discord-bot-lifecycle-announcement', 'false']],
      write: (name, value, secrets) => {
        if (name === 'discord-bot-lifecycle-announcement' && rejectLifecycleWrites) return false;
        secrets.set(name, value);
        return true;
      },
    });
    const im = new DiscordIM(host);
    im.registerIpc();
    await im.init();

    // Simulate the active account's persisted preference changing after init,
    // leaving the runtime cache stale until the next explicit lifecycle load.
    expect(host.secrets.write('discord-bot-lifecycle-announcement', 'true')).toBe(true);
    rejectLifecycleWrites = true;

    await expect(
      host.invoke('discordBot:set-lifecycle-announcement', { enabled: false }),
    ).resolves.toEqual({
      ok: false,
      lifecycleAnnouncement: true,
    });
    expect(host.readSecret('discord-bot-lifecycle-announcement')).toBe('true');
  });

  it('silently drops non-owner DM messages', async () => {
    const gateway = makeGateway();
    const im = new DiscordIM(makeHost(), {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });
    const handler = vi.fn();
    im.onMessage(handler);

    await im.init();
    await gateway.emitDm(message({ authorId: 'other-user', content: 'ignore me' }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('serializes owner DM normalization before emitting messages', async () => {
    const gateway = makeGateway();
    const media = makeMedia();
    const host = makeHost({ media });
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });
    const firstFetchStarted = deferred();
    const releaseFirstFetch = deferred();
    const allReceived = deferred();
    const received: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        firstFetchStarted.resolve();
        await releaseFirstFetch.promise;
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        };
      }),
    );
    im.onMessage((event) => {
      received.push(event.messageId);
      if (received.length === 2) allReceived.resolve();
    });

    await im.init();
    const firstEmit = gateway.emitDm(
      message({
        id: 'msg-1',
        content: 'see attachment',
        attachments: [
          {
            id: 'att-1',
            name: 'photo.png',
            url: 'https://cdn.example/slow.png',
            size: 1024,
            contentType: 'image/png',
          },
        ],
      }),
    );
    await firstFetchStarted.promise;
    await gateway.emitDm(message({ id: 'msg-2', content: 'follow up' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([]);

    releaseFirstFetch.resolve();
    await allReceived.promise;
    await firstEmit;

    expect(received).toEqual(['dm-1|msg-1', 'dm-1|msg-2']);
    expect(media.cacheImage).toHaveBeenCalledWith(
      expect.objectContaining({ integration: 'discord', token: 'att-1', mimeType: 'image/png' }),
    );
    // The frozen legacy media dir is never written.
    expect(fs.readdirSync(host.paths.discordMediaDir!)).toEqual([]);
  });

  it('times out stalled attachment downloads and unblocks later DMs', async () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    const media = makeMedia();
    const im = new DiscordIM(makeHost({ media }), {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });
    const allReceived = deferred();
    const received: IMMessageEvent[] = [];
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    im.onMessage((event) => {
      received.push(event);
      if (received.length === 2) allReceived.resolve();
    });

    await im.init();
    const firstEmit = gateway.emitDm(
      message({
        id: 'msg-1',
        content: 'see attachment',
        attachments: [
          {
            id: 'att-1',
            name: 'photo.png',
            url: 'https://cdn.example/stalls.png',
            size: 1024,
            contentType: 'image/png',
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const secondEmit = gateway.emitDm(message({ id: 'msg-2', content: 'follow up' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    await allReceived.promise;
    await firstEmit;
    await secondEmit;

    expect(received.map((event) => event.messageId)).toEqual(['dm-1|msg-1', 'dm-1|msg-2']);
    expect(received[0]?.attachments).toEqual([]);
    expect(received[0]?.unsupported).toEqual([{ type: 'download', label: 'photo.png' }]);
    expect(received[1]?.text).toBe('follow up');
    expect(media.cacheImage).not.toHaveBeenCalled();
  });

  it('drops queued DMs captured before a config switch', async () => {
    const gateway = makeGateway();
    const media = makeMedia();
    const files = makeFiles();
    const host = makeHost({ media, files });
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });
    const firstFetchStarted = deferred();
    const releaseFirstFetch = deferred();
    const received: IMMessageEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        firstFetchStarted.resolve();
        await releaseFirstFetch.promise;
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        };
      }),
    );
    im.onMessage((event) => {
      received.push(event);
    });

    im.registerIpc();
    await im.init();
    const firstEmit = gateway.emitDm(
      message({
        id: 'msg-old',
        content: 'old attachment',
        attachments: [
          {
            id: 'att-1',
            name: 'photo.png',
            url: 'https://cdn.example/slow.png',
            size: 1024,
            contentType: 'image/png',
          },
          {
            id: 'att-2',
            name: 'notes.pdf',
            url: 'https://cdn.example/notes.pdf',
            size: 1024,
            contentType: 'application/pdf',
          },
        ],
      }),
    );
    await firstFetchStarted.promise;

    gateway.connect.mockImplementationOnce(async () => {
      gateway.setAppId('app-2');
      gateway.emitStatus({ kind: 'connected', appId: 'app-2' });
    });
    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });
    await gateway.emitDm(message({ id: 'msg-new', content: 'new config message' }));

    expect(received.map((event) => event.messageId)).toEqual(['dm-1|msg-new']);
    expect(received[0]?.contextId).toBe('app-2');

    releaseFirstFetch.resolve();
    await firstEmit;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received.map((event) => event.messageId)).toEqual(['dm-1|msg-new']);
    // The stale DM's staged file is rolled back instead of leaking to the new account.
    expect(files.stage).toHaveBeenCalledTimes(1);
    expect(files.discards[0]).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(host.paths.discordMediaDir!)).toEqual([]);
  });

  it('connects gateway when set-config receives a token', async () => {
    const gateway = makeGateway();
    const host = makeHost();
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });

    expect(gateway.destroy).toHaveBeenCalledOnce();
    expect(gateway.connect).toHaveBeenCalledWith('new-token');
  });

  it('sends the owner a fixed notice after a successful link', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });

    expect(channel.send).toHaveBeenCalledWith('localized:linked');
  });

  it('bounds owner linked notice before returning from set-config', async () => {
    vi.useFakeTimers();
    const noticeStarted = deferred();
    const releaseNotice = deferred();
    const channel = makeChannel('dm-1');
    channel.send.mockImplementationOnce(async (payload: unknown) => {
      expect(payload).toBe('localized:linked');
      noticeStarted.resolve();
      await releaseNotice.promise;
      return { id: 'm-linked' };
    });
    const gateway = makeGateway({ client: makeClient(channel) });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    const linking = host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });
    const onComplete = vi.fn();
    void linking.then(onComplete, onComplete);
    await noticeStarted.promise;

    await vi.advanceTimersByTimeAsync(4_499);
    expect(onComplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await linking;

    expect(onComplete).toHaveBeenCalledOnce();
    expect(host.readSecret('discord-bot-token')).toBe('new-token');
    expect(host.readSecret('discord-owner-user-id')).toBe('user-1');
    expect(gateway.connect).toHaveBeenCalledWith('new-token');

    releaseNotice.resolve();
  });

  it('does not send a stale linked notice after owner changes while DM resolution is pending', async () => {
    vi.useFakeTimers();
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const channel = makeChannel('dm-1');
    const client = {
      users: {
        fetch: vi.fn(async () => {
          fetchStarted.resolve();
          await releaseFetch.promise;
          return { createDM: vi.fn(async () => channel) };
        }),
      },
    };
    const gateway = makeGateway({ client });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    const linking = host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });
    await fetchStarted.promise;
    await vi.advanceTimersByTimeAsync(4_500);
    await linking;
    expect(channel.send).not.toHaveBeenCalled();

    await host.invoke('discordBot:set-config', { ownerUserId: 'user-2' });
    releaseFetch.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('suppresses runtime online notice during a successful link', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });
    await flushMicrotasks();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('localized:linked');
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();
  });

  it('suppresses runtime online notice when connected status arrives after set-config returns', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('localized:linked');

    gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    await flushMicrotasks();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();
  });

  it('resets stale link suppression when init reuses the same instance after dispose', async () => {
    const offlineStarted = deferred();
    const releaseOffline = deferred();
    const channel = makeChannel('dm-1');
    channel.send.mockImplementation(async (payload: unknown) => {
      if (payload === 'localized:offline') {
        offlineStarted.resolve();
        await releaseOffline.promise;
        return { id: 'm-offline' };
      }
      return { id: 'm-notice' };
    });
    const gateway = makeGateway({ client: makeClient(channel) });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });
    expect(channel.send).toHaveBeenCalledWith('localized:linked');

    const disposing = im.dispose();
    await offlineStarted.promise;
    gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    await flushMicrotasks();
    releaseOffline.resolve();
    await disposing;

    channel.send.mockClear();
    await im.init();
    gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    await flushMicrotasks();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('localized:online');
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();
  });

  it('does not repeat runtime online notice after re-link gateway reconnect', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await flushMicrotasks();
    expect(channel.send).toHaveBeenCalledWith('localized:online');
    channel.send.mockClear();

    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('localized:linked');

    gateway.emitStatus({ kind: 'idle' });
    gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    await flushMicrotasks();

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('localized:linked');
  });

  it('sends runtime online notice after saved credentials connect on init', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await flushMicrotasks();

    expect(channel.send).toHaveBeenCalledWith('localized:online');
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();
  });

  it('suppresses all lifecycle notices and clears a dirty marker when disabled', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost({
      initialSecrets: [
        ['discord-bot-token', 'token'],
        ['discord-owner-user-id', 'user-1'],
        ['discord-bot-runtime-active', 'previous-run'],
        ['discord-bot-lifecycle-announcement', 'false'],
      ],
    });
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await flushMicrotasks();
    await im.dispose();

    expect(channel.send).not.toHaveBeenCalled();
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
    await expect(host.invoke('discordBot:get-status')).resolves.toMatchObject({
      lifecycleAnnouncement: false,
    });
  });

  it('invalidates a queued dirty-runtime notice when lifecycle announcements are disabled', async () => {
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const channel = makeChannel('dm-1');
    const client = {
      users: {
        fetch: vi.fn(async () => {
          fetchStarted.resolve();
          await releaseFetch.promise;
          return { createDM: vi.fn(async () => channel) };
        }),
      },
    };
    const gateway = makeGateway({ client });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost({
      initialSecrets: [
        ['discord-bot-token', 'token'],
        ['discord-owner-user-id', 'user-1'],
        ['discord-bot-runtime-active', 'previous-run'],
      ],
    });
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await fetchStarted.promise;

    await host.invoke('discordBot:set-lifecycle-announcement', { enabled: false });
    expect(host.readSecret('discord-bot-lifecycle-announcement')).toBe('false');
    releaseFetch.resolve();
    await flushMicrotasks();
    await im.dispose();

    expect(channel.send).not.toHaveBeenCalled();
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
  });

  it('keeps linked and disconnected confirmations enabled when lifecycle notices are disabled', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost({
      initialSecrets: [
        ['discord-bot-token', 'token'],
        ['discord-owner-user-id', 'user-1'],
        ['discord-bot-runtime-active', 'previous-run'],
        ['discord-bot-lifecycle-announcement', 'false'],
      ],
    });
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });

    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
    await host.invoke('discordBot:disconnect');

    expect(channel.send.mock.calls.map(([payload]) => payload)).toEqual([
      'localized:linked',
      'localized:disconnected',
    ]);
    expect(host.readSecret('discord-bot-lifecycle-announcement')).toBe('false');
  });

  it('rejects an invalid lifecycle announcement payload without changing the preference', async () => {
    const host = makeHost({
      initialSecrets: [['discord-bot-lifecycle-announcement', 'false']],
    });
    const im = new DiscordIM(host);
    im.registerIpc();
    await im.init();

    await expect(host.invoke('discordBot:set-lifecycle-announcement', {}))
      .rejects.toThrow('[INVALID_PARAMS] enabled must be a boolean');
    await expect(host.invoke('discordBot:get-status')).resolves.toMatchObject({
      lifecycleAnnouncement: false,
    });
    expect(host.readSecret('discord-bot-lifecycle-announcement')).toBe('false');
  });

  it('does not leave a dirty runtime marker when an in-flight offline notice is invalidated', async () => {
    const offlineStarted = deferred();
    const releaseOffline = deferred();
    const channel = makeChannel('dm-1');
    channel.send
      .mockResolvedValueOnce({ id: 'm-online' })
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:offline');
        offlineStarted.resolve();
        await releaseOffline.promise;
        return { id: 'm-offline' };
      });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await flushMicrotasks();
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();

    const disposing = im.dispose();
    await offlineStarted.promise;
    await host.invoke('discordBot:set-lifecycle-announcement', { enabled: false });
    await host.invoke('discordBot:set-lifecycle-announcement', { enabled: true });
    releaseOffline.resolve();
    await disposing;

    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
  });

  it('does not repeat runtime online notice on transient gateway reconnect', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await flushMicrotasks();
    expect(channel.send).toHaveBeenCalledWith('localized:online');
    channel.send.mockClear();

    gateway.emitStatus({ kind: 'connecting' });
    gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    await flushMicrotasks();

    expect(channel.send).not.toHaveBeenCalled();
  });

  it('does not queue another runtime online notice while the first notice is in flight', async () => {
    const onlineStarted = deferred();
    const releaseOnline = deferred();
    const channel = makeChannel('dm-1');
    channel.send.mockImplementation(async (payload: unknown) => {
      expect(payload).toBe('localized:online');
      onlineStarted.resolve();
      await releaseOnline.promise;
      return { id: 'm-online' };
    });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await onlineStarted.promise;

    gateway.emitStatus({ kind: 'connecting' });
    gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    await flushMicrotasks();

    expect(channel.send).toHaveBeenCalledTimes(1);

    releaseOnline.resolve();
    await flushMicrotasks();

    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('sends offlineNotice then online on init after a dirty previous runtime', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost({
      initialSecrets: [
        ['discord-bot-token', 'token'],
        ['discord-owner-user-id', 'user-1'],
        ['discord-bot-runtime-active', 'previous-run'],
      ],
    });
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await flushMicrotasks();

    expect(channel.send).toHaveBeenNthCalledWith(1, 'localized:offlineNotice');
    expect(channel.send).toHaveBeenNthCalledWith(2, 'localized:online');
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();
  });

  it('keeps dirty runtime marker until offlineNotice succeeds', async () => {
    const channel = makeChannel('dm-1');
    channel.send
      .mockRejectedValueOnce(new Error('offline notice failed'))
      .mockResolvedValueOnce({ id: 'm-online' })
      .mockResolvedValueOnce({ id: 'm-offline' });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost({
      initialSecrets: [
        ['discord-bot-token', 'token'],
        ['discord-owner-user-id', 'user-1'],
        ['discord-bot-runtime-active', 'previous-run'],
      ],
    });
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await flushMicrotasks();

    expect(channel.send).toHaveBeenNthCalledWith(1, 'localized:offlineNotice');
    expect(channel.send).toHaveBeenNthCalledWith(2, 'localized:online');
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();

    await im.dispose();

    expect(channel.send).toHaveBeenNthCalledWith(3, 'localized:offline');
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();
  });

  it('clears dirty runtime marker when offlineNotice succeeds during dispose', async () => {
    const offlineNoticeStarted = deferred();
    const releaseOfflineNotice = deferred();
    const channel = makeChannel('dm-1');
    channel.send
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:offlineNotice');
        offlineNoticeStarted.resolve();
        await releaseOfflineNotice.promise;
        return { id: 'm-offline-notice' };
      })
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:offline');
        return { id: 'm-offline' };
      });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost({
      initialSecrets: [
        ['discord-bot-token', 'token'],
        ['discord-owner-user-id', 'user-1'],
        ['discord-bot-runtime-active', 'previous-run'],
      ],
    });
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await offlineNoticeStarted.promise;
    const disposing = im.dispose();
    await flushMicrotasks();
    expect(channel.send).toHaveBeenCalledTimes(1);

    releaseOfflineNotice.resolve();
    await disposing;

    expect(channel.send).toHaveBeenNthCalledWith(1, 'localized:offlineNotice');
    expect(channel.send).toHaveBeenNthCalledWith(2, 'localized:offline');
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
  });

  it('resets pending dirty runtime notice when unbinding', async () => {
    const channel = makeChannel('dm-1');
    channel.send
      .mockRejectedValueOnce(new Error('offline notice failed'))
      .mockResolvedValueOnce({ id: 'm-online' })
      .mockResolvedValueOnce({ id: 'm-disconnected' })
      .mockResolvedValueOnce({ id: 'm-linked' });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost({
      initialSecrets: [
        ['discord-bot-token', 'token'],
        ['discord-owner-user-id', 'user-1'],
        ['discord-bot-runtime-active', 'previous-run'],
      ],
    });
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await flushMicrotasks();
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();

    await host.invoke('discordBot:disconnect');
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();

    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });

    expect(channel.send.mock.calls.map(([payload]) => payload)).toEqual([
      'localized:offlineNotice',
      'localized:online',
      'localized:disconnected',
      'localized:linked',
    ]);
  });

  it('sends the owner a fixed notice before disconnecting', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await host.invoke('discordBot:disconnect');

    expect(channel.send).toHaveBeenCalledWith('localized:disconnected');
    const sendOrder = channel.send.mock.invocationCallOrder[0] ?? 0;
    const destroyOrder = gateway.destroy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    expect(sendOrder).toBeGreaterThan(0);
    expect(sendOrder).toBeLessThan(destroyOrder);
  });

  it('bounds owner disconnected notice before clearing credentials when unbinding', async () => {
    vi.useFakeTimers();
    const noticeStarted = deferred();
    const releaseNotice = deferred();
    const channel = makeChannel('dm-1');
    channel.send.mockImplementationOnce(async (payload: unknown) => {
      expect(payload).toBe('localized:disconnected');
      noticeStarted.resolve();
      await releaseNotice.promise;
      return { id: 'm-disconnected' };
    });
    const gateway = makeGateway({ client: makeClient(channel) });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    const disconnecting = host.invoke('discordBot:disconnect');
    await noticeStarted.promise;
    await vi.advanceTimersByTimeAsync(4_500);
    await disconnecting;

    expect(host.readSecret('discord-bot-token')).toBeNull();
    expect(host.readSecret('discord-owner-user-id')).toBeNull();
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
    expect(gateway.destroy).toHaveBeenCalledOnce();

    releaseNotice.resolve();
  });

  it('does not send a stale disconnected notice after timeout and relink', async () => {
    vi.useFakeTimers();
    const fetchStarted = deferred();
    const releaseFetch = deferred();
    const channel = makeChannel('dm-1');
    const client = makeClient(channel);
    client.users.fetch.mockImplementationOnce(async () => {
      fetchStarted.resolve();
      await releaseFetch.promise;
      return { createDM: vi.fn(async () => channel) };
    });
    const gateway = makeGateway({ client });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    const disconnecting = host.invoke('discordBot:disconnect');
    await fetchStarted.promise;
    await vi.advanceTimersByTimeAsync(4_500);
    await disconnecting;

    expect(channel.send).not.toHaveBeenCalled();
    expect(host.readSecret('discord-bot-token')).toBeNull();
    expect(host.readSecret('discord-owner-user-id')).toBeNull();

    const relinking = host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });
    releaseFetch.resolve();
    await relinking;
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.send.mock.calls.map(([payload]) => payload)).toEqual([
      'localized:linked',
    ]);
  });

  it('waits for an in-flight runtime online notice before sending disconnected on unbind', async () => {
    const onlineSent = deferred();
    const releaseOnline = deferred();
    const channel = makeChannel('dm-1');
    channel.send
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:online');
        onlineSent.resolve();
        await releaseOnline.promise;
        return { id: 'm-online' };
      })
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:disconnected');
        return { id: 'm-disconnected' };
      });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await onlineSent.promise;

    const disconnecting = host.invoke('discordBot:disconnect');
    await flushMicrotasks();
    expect(channel.send).toHaveBeenCalledTimes(1);

    releaseOnline.resolve();
    await disconnecting;

    expect(channel.send).toHaveBeenNthCalledWith(1, 'localized:online');
    expect(channel.send).toHaveBeenNthCalledWith(2, 'localized:disconnected');
    const onlineOrder = channel.send.mock.invocationCallOrder[0] ?? 0;
    const disconnectedOrder = channel.send.mock.invocationCallOrder[1] ?? 0;
    expect(onlineOrder).toBeLessThan(disconnectedOrder);
    expect(host.readSecret('discord-bot-token')).toBeNull();
    expect(host.readSecret('discord-owner-user-id')).toBeNull();
  });

  it('drops owner DMs while unbind is waiting on the disconnected notice', async () => {
    const noticeStarted = deferred();
    const releaseNotice = deferred();
    const channel = makeChannel('dm-1');
    channel.send.mockImplementationOnce(async (payload: unknown) => {
      expect(payload).toBe('localized:disconnected');
      noticeStarted.resolve();
      await releaseNotice.promise;
      return { id: 'm-disconnected' };
    });
    const gateway = makeGateway({ client: makeClient(channel) });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });
    const handler = vi.fn();
    im.onMessage(handler);

    im.registerIpc();
    await im.init();
    const disconnecting = host.invoke('discordBot:disconnect');
    await noticeStarted.promise;
    await gateway.emitDm(message({ id: 'msg-during-unbind', content: 'too late' }));

    expect(handler).not.toHaveBeenCalled();
    expect(gateway.destroy).not.toHaveBeenCalled();

    releaseNotice.resolve();
    await disconnecting;
    expect(gateway.destroy).toHaveBeenCalledOnce();
  });

  it('sends runtime offline notice before dispose and clears runtime marker', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await flushMicrotasks();
    channel.send.mockClear();
    await im.dispose();

    expect(channel.send).toHaveBeenCalledWith('localized:offline');
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
    const sendOrder = channel.send.mock.invocationCallOrder[0] ?? 0;
    const destroyOrder = gateway.destroy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    expect(sendOrder).toBeGreaterThan(0);
    expect(sendOrder).toBeLessThan(destroyOrder);
  });

  it('drops owner DMs while dispose is waiting on shutdown notices', async () => {
    const offlineSent = deferred();
    const releaseOffline = deferred();
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });
    const handler = vi.fn();
    im.onMessage(handler);

    await im.init();
    await flushMicrotasks();
    channel.send.mockClear();
    channel.send.mockImplementationOnce(async (payload: unknown) => {
      expect(payload).toBe('localized:offline');
      offlineSent.resolve();
      await releaseOffline.promise;
      return { id: 'm-offline' };
    });

    const disposing = im.dispose();
    await offlineSent.promise;
    await gateway.emitDm(message({ id: 'msg-during-dispose', content: 'too late' }));

    expect(handler).not.toHaveBeenCalled();
    expect(gateway.destroy).not.toHaveBeenCalled();

    releaseOffline.resolve();
    await disposing;
    expect(gateway.destroy).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight runtime online notice before sending offline on dispose', async () => {
    const onlineSent = deferred();
    const releaseOnline = deferred();
    const channel = makeChannel('dm-1');
    channel.send.mockImplementationOnce(async (payload: unknown) => {
      expect(payload).toBe('localized:online');
      onlineSent.resolve();
      await releaseOnline.promise;
      return { id: 'm-online' };
    });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await onlineSent.promise;

    const disposing = im.dispose();
    await flushMicrotasks();
    expect(channel.send).toHaveBeenCalledTimes(1);

    releaseOnline.resolve();
    await disposing;

    expect(channel.send).toHaveBeenNthCalledWith(1, 'localized:online');
    expect(channel.send).toHaveBeenNthCalledWith(2, 'localized:offline');
    const onlineOrder = channel.send.mock.invocationCallOrder[0] ?? 0;
    const offlineOrder = channel.send.mock.invocationCallOrder[1] ?? 0;
    expect(onlineOrder).toBeLessThan(offlineOrder);
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
  });

  it('bounds waiting for an in-flight runtime online notice on dispose', async () => {
    vi.useFakeTimers();
    const onlineSent = deferred();
    const releaseOnline = deferred();
    const channel = makeChannel('dm-1');
    channel.send
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:online');
        onlineSent.resolve();
        await releaseOnline.promise;
        return { id: 'm-online' };
      })
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:offline');
        return { id: 'm-offline' };
      });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await onlineSent.promise;

    const disposing = im.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    await disposing;

    expect(channel.send).toHaveBeenNthCalledWith(1, 'localized:online');
    expect(channel.send).toHaveBeenNthCalledWith(2, 'localized:offline');
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();

    releaseOnline.resolve();
  });

  it('resets stale in-flight runtime online notice before reconnecting on init', async () => {
    vi.useFakeTimers();
    const staleOnlineStarted = deferred();
    const releaseStaleOnline = deferred();
    const freshOnlineStarted = deferred();
    const channel = makeChannel('dm-1');
    channel.send
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:online');
        staleOnlineStarted.resolve();
        await releaseStaleOnline.promise;
        return { id: 'm-stale-online' };
      })
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:offline');
        return { id: 'm-offline' };
      })
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:online');
        freshOnlineStarted.resolve();
        return { id: 'm-online' };
      });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await staleOnlineStarted.promise;

    const disposing = im.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    await disposing;

    await im.init();
    gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    await freshOnlineStarted.promise;

    expect(channel.send).toHaveBeenNthCalledWith(1, 'localized:online');
    expect(channel.send).toHaveBeenNthCalledWith(2, 'localized:offline');
    expect(channel.send).toHaveBeenNthCalledWith(3, 'localized:online');

    releaseStaleOnline.resolve();
  });

  it('uses one shutdown notice budget for online wait and offline notice on dispose', async () => {
    vi.useFakeTimers();
    const onlineSent = deferred();
    const offlineSent = deferred();
    const releaseOnline = deferred();
    const releaseOffline = deferred();
    const channel = makeChannel('dm-1');
    channel.send
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:online');
        onlineSent.resolve();
        await releaseOnline.promise;
        return { id: 'm-online' };
      })
      .mockImplementationOnce(async (payload: unknown) => {
        expect(payload).toBe('localized:offline');
        offlineSent.resolve();
        await releaseOffline.promise;
        return { id: 'm-offline' };
      });
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await onlineSent.promise;

    let disposed = false;
    const disposing = im.dispose().then(() => {
      disposed = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await offlineSent.promise;
    expect(disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(4_499);
    expect(disposed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await disposing;

    expect(channel.send).toHaveBeenNthCalledWith(1, 'localized:online');
    expect(channel.send).toHaveBeenNthCalledWith(2, 'localized:offline');
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();
    expect(gateway.destroy).toHaveBeenCalledOnce();

    releaseOnline.resolve();
    releaseOffline.resolve();
  });

  it('keeps runtime marker when runtime offline notice fails', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    await im.init();
    await flushMicrotasks();
    channel.send.mockRejectedValueOnce(new Error('network down'));
    await im.dispose();

    expect(channel.send).toHaveBeenLastCalledWith('localized:offline');
    expect(host.readSecret('discord-bot-runtime-active')).toBeTruthy();
  });

  it('does not send runtime offline notice when unbinding manually', async () => {
    const channel = makeChannel('dm-1');
    const gateway = makeGateway({ client: makeClient(channel) });
    gateway.connect.mockImplementationOnce(async () => {
      gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
    });
    const host = makeHost();
    const im = new DiscordIM(host, {
      ownerNoticeText: (phase) => `localized:${phase}`,
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await im.init();
    await flushMicrotasks();
    channel.send.mockClear();
    await host.invoke('discordBot:disconnect');

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith('localized:disconnected');
    expect(host.readSecret('discord-bot-runtime-active')).toBeNull();
  });

  it('reports an error and skips gateway connect when credentials cannot be stored', async () => {
    const gateway = makeGateway();
    const host = makeHost({ write: vi.fn(() => false) });
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    const result = await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'user-1',
    });

    expect(result).toEqual({
      status: {
        kind: 'error',
        reason: '无法安全保存凭证(系统安全存储不可用)',
      },
      ownerUserId: 'user-1',
    });
    expect(gateway.destroy).not.toHaveBeenCalled();
    expect(gateway.connect).not.toHaveBeenCalled();
  });

  it('keeps existing secrets when encrypted storage is unavailable', async () => {
    const gateway = makeGateway();
    const write = vi.fn(() => true);
    const host = makeHost({ isAvailable: () => false, write });
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    const result = await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'new-owner',
    });

    expect(result).toEqual({
      status: {
        kind: 'error',
        reason: '无法安全保存凭证(系统安全存储不可用)',
      },
      ownerUserId: null,
    });
    expect(write).not.toHaveBeenCalled();
    expect(host.readSecret('discord-bot-token')).toBe('token');
    expect(host.readSecret('discord-owner-user-id')).toBe('user-1');
    expect(gateway.destroy).not.toHaveBeenCalled();
    expect(gateway.connect).not.toHaveBeenCalled();
  });

  it('restores previous secrets when the second credential write fails', async () => {
    const gateway = makeGateway();
    const host = makeHost({
      write: (name, value, secrets) => {
        if (name === 'discord-owner-user-id' && value === 'new-owner') return false;
        secrets.set(name, value);
        return true;
      },
    });
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    const result = await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'new-owner',
    });

    expect(result).toEqual({
      status: {
        kind: 'error',
        reason: '无法安全保存凭证(系统安全存储不可用)',
      },
      ownerUserId: 'user-1',
    });
    expect(host.readSecret('discord-bot-token')).toBe('token');
    expect(host.readSecret('discord-owner-user-id')).toBe('user-1');
    expect(gateway.destroy).not.toHaveBeenCalled();
    expect(gateway.connect).not.toHaveBeenCalled();
  });

  it('removes newly written secrets when a first-time credential save fails', async () => {
    const gateway = makeGateway();
    const host = makeHost({
      initialSecrets: [],
      write: (name, value, secrets) => {
        if (name === 'discord-owner-user-id' && value === 'new-owner') return false;
        secrets.set(name, value);
        return true;
      },
    });
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    await host.invoke('discordBot:set-config', {
      token: 'new-token',
      ownerUserId: 'new-owner',
    });

    expect(host.readSecret('discord-bot-token')).toBeNull();
    expect(host.readSecret('discord-owner-user-id')).toBeNull();
    expect(gateway.destroy).not.toHaveBeenCalled();
    expect(gateway.connect).not.toHaveBeenCalled();
  });

  it('restores previous secrets and reconnects the previous gateway when login fails', async () => {
    const gateway = makeGateway();
    gateway.connect
      .mockRejectedValueOnce(Object.assign(new Error('bad token'), { code: 'TokenInvalid' }))
      .mockImplementationOnce(async () => {
        gateway.emitStatus({ kind: 'connected', appId: 'bot#0000' });
      });
    const host = makeHost();
    const im = new DiscordIM(host, {
      gatewayFactory: (handlers) => {
        gateway.setHandlers(handlers);
        return gateway;
      },
    });

    im.registerIpc();
    const result = await host.invoke('discordBot:set-config', {
      token: 'bad-token',
      ownerUserId: 'new-owner',
    });

    expect(result).toEqual({
      status: {
        kind: 'connected',
        appId: 'bot#0000',
      },
      saveErrorStatus: {
        kind: 'error',
        reason: 'Discord authentication failed: invalid bot token',
      },
      ownerUserId: 'user-1',
    });
    expect(host.readSecret('discord-bot-token')).toBe('token');
    expect(host.readSecret('discord-owner-user-id')).toBe('user-1');
    expect(gateway.destroy).toHaveBeenCalledOnce();
    expect(gateway.connect).toHaveBeenNthCalledWith(1, 'bad-token');
    expect(gateway.connect).toHaveBeenNthCalledWith(2, 'token');

    await expect(host.invoke('discordBot:get-status')).resolves.toEqual({
      status: {
        kind: 'connected',
        appId: 'bot#0000',
      },
      ownerUserId: 'user-1',
      lifecycleAnnouncement: true,
    });
  });
});

function message(overrides: {
  id?: string;
  content?: string;
  authorId?: string;
  channelId?: string;
  attachments?: AttachmentLike[];
  stickers?: StickerLike[];
  type?: string;
} = {}) {
  return {
    id: overrides.id ?? 'msg-1',
    content: overrides.content ?? '',
    author: { id: overrides.authorId ?? 'user-1' },
    channelId: overrides.channelId ?? 'dm-1',
    attachments: overrides.attachments ?? [],
    stickers: overrides.stickers ?? [],
    ...(overrides.type ? { type: overrides.type } : {}),
  };
}

const createdTempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-inbound-'));
  createdTempDirs.push(dir);
  return dir;
}

/** Fake cindy-media store: images → `/blobs/<token>.png`, other media → `/blobs/<token>.bin`. */
function makeMedia() {
  const discards: Array<ReturnType<typeof vi.fn>> = [];
  return {
    discards,
    cacheImage: vi.fn(async ({ token }: { token: string; buffer: Uint8Array; mimeType: string; integration: string }) => ({
      absPath: `/blobs/${token}.png`,
      url: `cindy-media://blobs/${token}.png`,
    })),
    cacheMedia: vi.fn(async ({ token, mimeType }: { token: string; buffer: Uint8Array; mimeType: string; integration: string }) => {
      const discard = vi.fn(async () => {});
      discards.push(discard);
      return {
        absPath: `/blobs/${token}.bin`,
        url: `cindy-media://blobs/${token}.bin`,
        mimeType,
        discard,
      };
    }),
    getCachedImage: vi.fn(async () => null),
    resolveMediaUrl: vi.fn(() => null),
  };
}

/** Fake host file staging: `/staged/<fileName>` with a per-file discard spy. */
function makeFiles() {
  const discards: Array<ReturnType<typeof vi.fn>> = [];
  return {
    discards,
    stage: vi.fn(async ({ fileName }: { integration: string; buffer: Uint8Array; fileName: string }) => {
      const discard = vi.fn(async () => {});
      discards.push(discard);
      return { absPath: `/staged/${fileName}`, discard };
    }),
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface TestHost extends IMHost {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  readSecret(name: string): string | null;
}

function makeHost(options: {
  initialSecrets?: [string, string][];
  isAvailable?: () => boolean;
  write?: (name: string, value: string, secrets: Map<string, string>) => boolean;
  media?: IMHost['media'];
  files?: IMHost['files'];
} = {}): TestHost {
  const secrets = new Map<string, string>(options.initialSecrets ?? [
    ['discord-bot-token', 'token'],
    ['discord-owner-user-id', 'user-1'],
  ]);
  const handlers = new Map<string, (payload?: unknown) => Promise<unknown> | unknown>();

  return {
    paths: { feishuMediaDir: tempDir(), discordMediaDir: tempDir() },
    secrets: {
      write: (name, value) => {
        if (options.write) return options.write(name, value, secrets);
        secrets.set(name, value);
        return true;
      },
      read: (name) => secrets.get(name) ?? null,
      remove: (name) => {
        secrets.delete(name);
      },
      isAvailable: options.isAvailable ?? (() => true),
    },
    ipc: {
      throwIpcError: (code, message) => {
        throw new Error(`[${code}] ${message}`);
      },
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
      broadcast: () => {},
    },
    ...(options.media ? { media: options.media } : {}),
    ...(options.files ? { files: options.files } : {}),
    httpPostForm: async () => ({ status: 200, body: {} }),
    invoke: async (channel, payload) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`missing handler: ${channel}`);
      return handler(payload);
    },
    readSecret: (name) => secrets.get(name) ?? null,
  };
}

function makeGateway(options: { client?: unknown } = {}) {
  let onDmMessage: ((m: never) => void) | null = null;
  let onStatus: ((s: IMStatus) => void) | null = null;
  let appId = 'app-1';
  const client = options.client ?? null;
  return {
    get client() {
      return client as never;
    },
    get appId() {
      return appId;
    },
    botTag: 'bot#0000',
    connect: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    setHandlers(handlers: { onStatus: (s: IMStatus) => void; onDmMessage: (m: never) => void }) {
      onStatus = handlers.onStatus;
      onDmMessage = handlers.onDmMessage;
    },
    setAppId(nextAppId: string) {
      appId = nextAppId;
    },
    emitStatus(status: IMStatus) {
      onStatus?.(status);
    },
    async emitDm(m: unknown) {
      onDmMessage?.(m as never);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function makeClient(channel: ReturnType<typeof makeChannel>) {
  return {
    user: { id: 'bot-1' },
    users: {
      fetch: vi.fn(async () => ({
        createDM: vi.fn(async () => channel),
      })),
    },
    channels: {
      fetch: vi.fn(async () => channel),
    },
  };
}

function makeChannel(id: string) {
  let next = 1;
  return {
    id,
    send: vi.fn(async (...args: [unknown]) => {
      void args;
      return { id: `m${next++}` };
    }),
    messages: {
      fetch: vi.fn(async () => ({
        react: vi.fn(async () => {}),
        edit: vi.fn(async () => {}),
        reactions: {
          resolve: vi.fn(() => ({
            users: { remove: vi.fn(async () => {}) },
          })),
        },
      })),
    },
  };
}
