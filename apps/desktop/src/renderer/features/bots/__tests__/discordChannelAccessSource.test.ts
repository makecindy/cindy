import { describe, expect, it, vi } from 'vitest';

import { DiscordChannelAccessUnsupportedError } from '@/hooks/useDiscordChannelAccess';

import { discordChannelAccessSourceFor, type BotImConnectionApi } from '../botImConnectionClient';

const payload = (over: Record<string, unknown> = {}) => ({
  connectionId: 'conn',
  accessVersion: 2,
  online: true,
  guilds: [],
  access: { channels: [] },
  ...over,
});

describe('discordChannelAccessSourceFor', () => {
  it('reads and saves through the connection id only', async () => {
    const api = {
      listDiscordChannels: vi.fn(async () => payload()),
      setDiscordChannelAccess: vi.fn(async (input: { access: unknown }) => payload({ access: input.access })),
    } as unknown as BotImConnectionApi;
    const source = discordChannelAccessSourceFor(api, 'conn');
    expect(await source.load()).toMatchObject({ online: true, access: { channels: [] } });
    const next = { channels: [], guilds: [{ guildId: '1', enabled: true, mode: 'all' as const }] };
    expect(await source.save(next)).toEqual(next);
    expect(api.setDiscordChannelAccess).toHaveBeenCalledWith({ id: 'conn', access: next });
  });

  it('refuses a computer that does not report the server-level access version, before anything can be written', async () => {
    const api = {
      listDiscordChannels: vi.fn(async () => payload({ accessVersion: undefined })),
      setDiscordChannelAccess: vi.fn(),
    } as unknown as BotImConnectionApi;
    await expect(discordChannelAccessSourceFor(api, 'conn').load()).rejects.toBeInstanceOf(
      DiscordChannelAccessUnsupportedError,
    );
    expect(api.setDiscordChannelAccess).not.toHaveBeenCalled();
  });
});
