import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addBotProfile,
  addBotProfileAndWait,
  getBotProfiles,
  removeBotProfile,
  setCanonicalBotSession,
  updateBotProfile,
} from '../botStore';

describe('bot profile store', () => {
  const createdIds: string[] = [];

  afterEach(() => {
    for (const id of createdIds.splice(0)) removeBotProfile(id);
  });

  it('creates a Bot profile without a fake Session projection', () => {
    const bot = addBotProfile({
      name: 'Telegram release helper',
      channel: 'telegram',
      description: 'Release notes',
    });
    createdIds.push(bot.id);

    expect(bot.sessions).toHaveLength(0);
    expect(bot.canonicalSessionId).toBeUndefined();
  });

  it('creates new Bots hands-on by default, and never with memory turned off', () => {
    const bot = addBotProfile({ name: 'Fresh teammate', channel: 'local', description: '' });
    createdIds.push(bot.id);

    // 产品裁决 2026-08-18:默认放手做;记忆恒开。
    expect(bot.capabilities.permissions).toBe('trusted');
    expect(bot.capabilities.memory).toBe(true);
  });

  it('replaces the optimistic Bot with the authoritative profile returned by main', async () => {
    const create = vi.fn(async (input: { id: string }) => ({
      id: input.id,
      name: 'Hermes identity bot',
      description: 'Authoritative profile',
      identitySource: '# SOUL\nYou are the real Bot identity.',
      userContextSource: '# USER\nChris',
      avatar: '🪽',
      avatarColor: 'blue',
      enabled: true,
      status: 'active',
      currentVersion: 1,
      createdAt: 123,
      skills: ['research'],
      capabilities: {
        harness: 'claude',
        model: 'claude-sonnet-4-6',
        permissions: 'ask',
      },
      channels: [{ id: `${input.id}:local`, kind: 'local', enabled: true }],
      sessions: [],
    }));
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      electronAPI: { localDb: { bots: { create } } },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    try {
      const bot = await addBotProfileAndWait({
        name: 'Draft name',
        channel: 'local',
        description: '',
        identitySource: '# SOUL\nPersistent release steward.',
        userContextSource: '# USER\nWorks with the release team.',
        avatar: '🛠️',
        avatarColor: 'blue',
        skills: ['research'],
        capabilities: { automation: true, sessionControlMode: 'coordinate' },
      });
      createdIds.push(bot.id);
      expect(bot).toMatchObject({
        name: 'Hermes identity bot',
        identitySource: '# SOUL\nYou are the real Bot identity.',
        userContextSource: '# USER\nChris',
        avatar: '🪽',
      });
      expect(getBotProfiles().find((item) => item.id === bot.id)).toMatchObject({
        identitySource: '# SOUL\nYou are the real Bot identity.',
      });
      // 新建默认改成 trusted 之后,**读**到的 profile 仍以 main 的值为准:
      // 已存在的伙伴不会因为默认值变了就被悄悄升成信任。
      expect(bot.capabilities.permissions).toBe('ask');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          identitySource: '# SOUL\nPersistent release steward.',
          userContextSource: '# USER\nWorks with the release team.',
          avatar: '🛠️',
          avatarColor: 'blue',
          skills: ['research'],
          capabilities: expect.objectContaining({
            automation: true,
            sessionControlMode: 'coordinate',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps one canonical projection and archives the previous one', () => {
    const bot = addBotProfile({ name: 'History helper', channel: 'local', description: '' });
    createdIds.push(bot.id);

    setCanonicalBotSession(bot.id, { id: 'session-1', title: 'History helper', updatedAt: 1 });
    setCanonicalBotSession(bot.id, { id: 'session-2', title: 'History helper', updatedAt: 2 });

    const current = getBotProfiles().find((item) => item.id === bot.id);
    expect(current?.canonicalSessionId).toBe('session-2');
    expect(current?.sessions.filter((item) => item.kind === 'chat')).toHaveLength(1);
    expect(current?.sessions.find((item) => item.id === 'session-1')).toMatchObject({
      kind: 'history',
      status: 'archived',
    });
  });

  it('returns the persisted Bot profile when updating only the selected Bot', async () => {
    const first = addBotProfile({ name: 'First', channel: 'local', description: '' });
    const second = addBotProfile({ name: 'Second', channel: 'slack', description: '' });
    createdIds.push(first.id, second.id);

    const updated = await updateBotProfile(first.id, { name: 'Renamed', enabled: false });

    expect(updated).toMatchObject({
      id: first.id,
      name: 'Renamed',
      enabled: false,
    });

    expect(getBotProfiles().find((bot) => bot.id === first.id)).toMatchObject({
      name: 'Renamed',
      enabled: false,
    });
    expect(getBotProfiles().find((bot) => bot.id === second.id)?.name).toBe('Second');

    removeBotProfile(first.id);
    expect(getBotProfiles().some((bot) => bot.id === first.id)).toBe(false);
    expect(getBotProfiles().some((bot) => bot.id === second.id)).toBe(true);
  });
});
