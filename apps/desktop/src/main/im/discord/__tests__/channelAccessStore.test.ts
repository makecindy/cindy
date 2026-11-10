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
});
