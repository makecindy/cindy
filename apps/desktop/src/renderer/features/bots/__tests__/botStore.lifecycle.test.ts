// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/state/newMakerDraft', () => ({
  getDraft: () => ({
    lastByVendor: {
      cc: { model: '', providerId: null, effort: '', fastMode: false },
      codex: { model: '', providerId: null, effort: '', fastMode: false },
      pi: { model: '', providerId: null, effort: '', fastMode: false },
    },
    fastModeByModel: {},
  }),
  getPersistedVendorModel: () => '',
}));

vi.mock('@/lib/modelDefinitions', () => ({
  getDefaultModelForVendor: () => ({ id: 'claude-sonnet-4-6', defaultEffort: 'medium' }),
  getModelsForVendor: () => [],
}));

vi.mock('../botReadState', () => ({
  getBotLastReadAtMap: () => ({}),
  pruneBotReadState: vi.fn(),
  seedMissingBotReadState: vi.fn(),
}));

const bot = {
  id: 'bot-1',
  name: 'Helper',
  description: '',
  avatar: '🤖',
  avatarColor: 'violet',
  enabled: true,
  capabilities: {
    harness: 'claude',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    fastMode: false,
  },
  skills: [],
  sessions: [],
  createdAt: 1,
};

describe('Bot lifecycle deletion during database hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.localStorage.setItem('cindy.bots.v1', JSON.stringify([bot]));
  });

  it('waits for the in-flight hydration fetch before deleting so its stale snapshot cannot recreate the Bot', async () => {
    let dbHasBot = false;
    let releaseHydration!: () => void;
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const list = vi.fn(async () => {
      await hydrationGate;
      dbHasBot = true;
      return dbHasBot ? [bot] : [];
    });
    const runBotLifecycleAction = vi.fn(async () => {
      dbHasBot = false;
      return {
        botId: 'bot-1',
        action: 'delete' as const,
        status: 'deleted' as const,
        affected: {
          sessions: 0,
          routes: 0,
          automations: 0,
          delegations: 0,
          deliveries: 0,
          worktrees: 0,
        },
      };
    });

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        maker: { runBotLifecycleAction },
        localDb: {
          bots: { list },
        },
      },
    });

    const store = await import('../botStore');
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(store.getBotProfiles()).toEqual([]);

    const deletion = store.runBotLifecycleAction({
      botId: 'bot-1',
      action: 'delete',
      confirmName: 'Helper',
    });
    await Promise.resolve();
    expect(runBotLifecycleAction).not.toHaveBeenCalled();

    releaseHydration();
    await deletion;

    expect(runBotLifecycleAction).toHaveBeenCalledOnce();
    expect(store.getBotProfiles()).toEqual([]);
    // Obsolete renderer snapshots are neither read nor used as a writable store.
    expect(JSON.parse(window.localStorage.getItem('cindy.bots.v1') ?? '[]')).toEqual([bot]);
  });
});


describe('Bot profile snapshot ownership', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  it('ignores an older list response after a newer refresh has completed', async () => {
    let release!: (rows: typeof bot[]) => void;
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce([{ ...bot, name: 'Newer profile' }]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { bots: { list } } },
    });
    const store = await import('../botStore');
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()[0]?.name).toBe('Newer profile'));
    release([bot]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getBotProfiles()[0]?.name).toBe('Newer profile');
  });

  it('clears prior-owner data immediately and ignores its late list response', async () => {
    const owner = await import('@/contexts/dataOwnerGeneration');
    owner.setDataOwnerGeneration('owner-a');
    let release!: (rows: typeof bot[]) => void;
    const list = vi.fn()
      .mockResolvedValueOnce([bot])
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce([{ ...bot, id: 'bot-b', name: 'Owner B' }]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { bots: { list } } },
    });
    const store = await import('../botStore');
    await vi.waitFor(() => expect(store.getBotProfiles()).toHaveLength(1));
    store.refreshBotProfiles();
    owner.setDataOwnerGeneration('owner-b');
    expect(store.getBotProfiles()).toEqual([]);
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()[0]?.name).toBe('Owner B'));
    release([bot]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getBotProfiles().map((row) => row.id)).toEqual(['bot-b']);
  });

  it('rejects a prior-owner update without changing the new owner projection', async () => {
    const owner = await import('@/contexts/dataOwnerGeneration');
    owner.setDataOwnerGeneration('owner-a');
    let release!: (row: typeof bot) => void;
    const list = vi.fn().mockResolvedValue([bot]);
    const update = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { bots: { list, update } } },
    });
    const store = await import('../botStore');
    await vi.waitFor(() => expect(store.getBotProfiles()).toHaveLength(1));
    const pending = store.updateBotProfile(bot.id, { name: 'Old owner edit' });
    const rejected = expect(pending).rejects.toThrow('Bot data owner changed');
    owner.setDataOwnerGeneration('owner-b');
    list.mockResolvedValue([{ ...bot, name: 'Owner B' }]);
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()[0]?.name).toBe('Owner B'));
    release({ ...bot, name: 'Old owner edit' });
    await rejected;
    expect(store.getBotProfiles()[0]?.name).toBe('Owner B');
  });
});
