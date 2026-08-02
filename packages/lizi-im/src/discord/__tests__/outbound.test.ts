import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DiscordIM, type DiscordIMOptions } from '../index.js';
import { createDmResolver, sendChunked } from '../outbound.js';
import type { IMHost } from '../../types.js';

describe('discord outbound helpers', () => {
  it('sends 3000 chars in two chunks and returns the first encoded id', async () => {
    const channel = makeChannel('dm-1');

    const result = await sendChunked(channel, 'x'.repeat(3000));

    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ firstMessageId: 'dm-1|m1' });
  });

  it('evicts failed DM resolutions so a later retry can recover', async () => {
    const channel = makeChannel('dm-1');
    const client = {
      users: {
        fetch: vi
          .fn()
          .mockRejectedValueOnce(new Error('temporary failure'))
          .mockResolvedValueOnce({ createDM: vi.fn(async () => channel) }),
      },
    };
    const resolveDm = createDmResolver(client);

    await expect(resolveDm('user-1')).rejects.toThrow('temporary failure');
    await expect(resolveDm('user-1')).resolves.toBe(channel);
    expect(client.users.fetch).toHaveBeenCalledTimes(2);
  });

  it('binds each resolver to its own client instance', async () => {
    const oldChannel = makeChannel('old-dm');
    const newChannel = makeChannel('new-dm');
    const oldClient = makeClient(oldChannel);
    const newClient = makeClient(newChannel);

    await expect(createDmResolver(oldClient)('user-1')).resolves.toBe(oldChannel);
    await expect(createDmResolver(newClient)('user-1')).resolves.toBe(newChannel);
    expect(oldClient.users.fetch).toHaveBeenCalledTimes(1);
    expect(newClient.users.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('DiscordIM outbound', () => {
  it('sendText sends plain text without rewriting content', async () => {
    const channel = makeChannel('dm-1');
    const im = makeIm(channel);

    const result = await im.sendText('user-1', '**raw**');

    expect(channel.send).toHaveBeenCalledWith('**raw**');
    expect(result).toEqual({ messageId: 'dm-1|m1' });
  });

  it('allows files exactly at the 8MiB boundary', async () => {
    const file = tempFile(8 * 1024 * 1024);
    const channel = makeChannel('dm-1');
    const im = makeIm(channel);

    const result = await im.sendFile('user-1', file, 'boundary.bin');

    expect(result).toEqual({ ok: true, messageId: 'dm-1|m1' });
    expect(channel.send).toHaveBeenCalledWith({
      files: [{ attachment: file, name: 'boundary.bin' }],
    });
  });

  it('rejects files over 8MiB before upload', async () => {
    const file = tempFile(8 * 1024 * 1024 + 1);
    const channel = makeChannel('dm-1');
    const im = makeIm(channel);

    await expect(im.sendFile('user-1', file)).resolves.toEqual({
      ok: false,
      reason: 'TOO_LARGE',
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('maps upload 413 errors to TOO_LARGE', async () => {
    const file = tempFile(1);
    const channel = makeChannel('dm-1');
    channel.send.mockRejectedValueOnce(Object.assign(new Error('Payload Too Large'), { status: 413 }));
    const im = makeIm(channel);

    await expect(im.sendFile('user-1', file)).resolves.toEqual({
      ok: false,
      reason: 'TOO_LARGE',
    });
  });

  it('maps missing and empty files', async () => {
    const channel = makeChannel('dm-1');
    const im = makeIm(channel);
    const empty = tempFile(0);

    await expect(im.sendFile('user-1', '/tmp/does-not-exist-discord')).resolves.toEqual({
      ok: false,
      reason: 'NOT_FOUND',
    });
    await expect(im.sendFile('user-1', empty)).resolves.toEqual({
      ok: false,
      reason: 'EMPTY',
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('batches sendMarkdownText resolved images by attachment count', async () => {
    const files = Array.from({ length: 11 }, () => tempFile(1));
    const channel = makeChannel('dm-1');
    const im = makeIm(channel, {
      resolveImageUrl: imageResolver(files),
    });

    const result = await im.sendMarkdownText(
      'user-1',
      ['hello', ...files.map((_, index) => `![img](xdt-image://${index})`)].join('\n'),
    );

    expect(result).toEqual({ messageId: 'dm-1|m1' });
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(fileAttachments(channel.send.mock.calls[0]?.[0])).toEqual(files.slice(0, 10));
    expect(fileAttachments(channel.send.mock.calls[1]?.[0])).toEqual(files.slice(10));
  });

  it('batches streaming image uploads by request size', async () => {
    const sevenMiB = 7 * 1024 * 1024;
    const files = Array.from({ length: 4 }, () => tempFile(sevenMiB));
    const channel = makeChannel('dm-1');
    const im = makeIm(channel);

    const handle = await im.startStreamingText('user-1');
    if (!handle.addExtraImageAbsPath) throw new Error('streaming handle cannot attach images');
    for (const file of files) {
      handle.addExtraImageAbsPath(file);
    }
    await handle.finalize('done');

    expect(channel.send).toHaveBeenCalledTimes(3);
    expect(channel.send).toHaveBeenNthCalledWith(1, '…');
    expect(fileAttachments(channel.send.mock.calls[1]?.[0])).toEqual(files.slice(0, 3));
    expect(fileAttachments(channel.send.mock.calls[2]?.[0])).toEqual(files.slice(3));
  });

  it('reactToMessage returns null on reaction failure', async () => {
    const channel = makeChannel('dm-1');
    channel.messages.fetch.mockResolvedValueOnce({
      react: vi.fn(async () => {
        throw new Error('reaction failed');
      }),
      edit: vi.fn(async () => {}),
      reactions: {
        resolve: vi.fn(() => ({
          users: { remove: vi.fn(async () => {}) },
        })),
      },
    });
    const im = makeIm(channel);

    await expect(im.reactToMessage?.('dm-1|m1', '👀')).resolves.toBeNull();
  });
});

function makeIm(
  channel: ReturnType<typeof makeChannel>,
  opts: Omit<DiscordIMOptions, 'gatewayFactory'> = {},
): DiscordIM {
  return new DiscordIM(makeHost(), {
    ...opts,
    gatewayFactory: () => ({
      client: makeClient(channel) as never,
      appId: 'app-1',
      botTag: 'bot#0000',
      connect: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    }),
  });
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

function makeHost(): IMHost {
  return {
    paths: { feishuMediaDir: tempDir(), discordMediaDir: tempDir() },
    secrets: {
      write: () => true,
      read: () => null,
      remove: () => {},
      isAvailable: () => true,
    },
    ipc: {
      throwIpcError: (code, message) => {
        throw new Error(`[${code}] ${message}`);
      },
      handle: () => {},
      broadcast: () => {},
    },
    httpPostForm: async () => ({ status: 200, body: {} }),
    createLogger: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    }),
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'discord-outbound-'));
}

function tempFile(size: number): string {
  const file = path.join(tempDir(), `file-${size}.bin`);
  fs.writeFileSync(file, Buffer.alloc(size));
  return file;
}

function imageResolver(files: string[]): (url: string) => string {
  return (url) => {
    const index = Number(url.replace('xdt-image://', ''));
    const file = files[index];
    if (!file) throw new Error(`missing image for ${url}`);
    return file;
  };
}

function fileAttachments(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || !('files' in payload)) {
    return [];
  }
  return (payload.files as Array<{ attachment: string }>).map((file) => file.attachment);
}
