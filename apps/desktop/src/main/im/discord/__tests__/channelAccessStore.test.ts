import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const dir = vi.hoisted(() => ({ root: '' }));

vi.mock('electron', () => ({ app: { getPath: () => dir.root } }));
vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) => `${dir.root}/${parts.join('/')}`,
}));

dir.root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-access-store-'));

import { discordChannelAccessStore } from '../channelAccessStore';

afterAll(() => fs.rmSync(dir.root, { recursive: true, force: true }));

const file = () => path.join(dir.root, 'discord-channel-access.json');
let externalMtime = Date.now() + 10_000;
function writeExternal(text: string): void {
  fs.writeFileSync(file(), text);
  const changed = new Date(externalMtime++);
  fs.utimesSync(file(), changed, changed);
}

describe('discord channel access store (phase 1: owner only)', () => {
  it('defaults to no channels', () => {
    expect(discordChannelAccessStore.read()).toEqual({ channels: [] });
  });

  it('persists the allowlist but never member admission, even if a caller or the file asks for it', () => {
    const saved = discordChannelAccessStore.write({
      channels: [
        { guildId: '200000000000000001', channelId: '300000000000000001', allowMembers: true },
        { guildId: 'junk', channelId: '1' },
      ],
    });
    expect(saved).toEqual({ channels: [{ guildId: '200000000000000001', channelId: '300000000000000001' }] });
    expect(discordChannelAccessStore.read()).toEqual(saved);

    // 手改文件把成员准入打开 → 读出来仍然没有。
    const file = path.join(dir.root, 'discord-channel-access.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ channels: [{ guildId: '200000000000000001', channelId: '300000000000000001', allowMembers: true }] }),
    );
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(discordChannelAccessStore.read().channels[0]).not.toHaveProperty('allowMembers');
  });

  it('keeps server-level scope but drops member admission at every level (server, channel, retained selection)', () => {
    const guildId = '200000000000000001';
    const channelId = '300000000000000001';
    const saved = discordChannelAccessStore.write({
      channels: [{ guildId: '200000000000000002', channelId, allowMembers: true }],
      guilds: [
        { guildId, enabled: true, mode: 'all', allowMembers: true, savedChannels: [{ channelId, allowMembers: true }] },
        { guildId: '200000000000000002', enabled: true, mode: 'selected' },
      ],
    });
    expect(saved).toEqual({
      channels: [{ guildId: '200000000000000002', channelId }],
      guilds: [
        { guildId, enabled: true, mode: 'all', savedChannels: [{ channelId }] },
        { guildId: '200000000000000002', enabled: true, mode: 'selected' },
      ],
    });
  });

  it('removes the last guild from the returned value, stored file and subsequent reads', () => {
    discordChannelAccessStore.write({
      channels: [],
      guilds: [{ guildId: '200000000000000001', enabled: true, mode: 'all' }],
    });

    expect(discordChannelAccessStore.write({ channels: [] })).toEqual({ channels: [] });
    expect(fs.existsSync(file())).toBe(false);
    expect(discordChannelAccessStore.read()).toEqual({ channels: [] });
  });

  it.each(['closed', 'deleted'] as const)('observes an externally %s allowlist instead of cached authorization', (change) => {
    const guildId = '200000000000000001';
    discordChannelAccessStore.write({ channels: [], guilds: [{ guildId, enabled: true, mode: 'all' }] });
    const closed = { channels: [], guilds: [{ guildId, enabled: false, mode: 'all' }] };
    if (change === 'closed') writeExternal(JSON.stringify(closed));
    else fs.unlinkSync(file());

    expect(discordChannelAccessStore.read()).toEqual(change === 'closed' ? closed : { channels: [] });
  });

  it.each(['read', 'write'] as const)('fails closed and preserves external corruption when the first operation is %s', (first) => {
    discordChannelAccessStore.write({
      channels: [],
      guilds: [{ guildId: '200000000000000001', enabled: true, mode: 'all' }],
    });
    const corrupted = '{ external invalid configuration';
    writeExternal(corrupted);
    try {
      if (first === 'read') expect(discordChannelAccessStore.read()).toEqual({ channels: [] });
      expect(() => discordChannelAccessStore.write({ channels: [] })).toThrow();
      expect(fs.readFileSync(file(), 'utf8')).toBe(corrupted);
      expect(discordChannelAccessStore.read()).toEqual({ channels: [] });
    } finally {
      writeExternal('{"channels":[]}');
      discordChannelAccessStore.read();
    }
  });
});
