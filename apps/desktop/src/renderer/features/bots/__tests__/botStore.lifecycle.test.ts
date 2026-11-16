// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../botStore';
import * as owner from '@/contexts/dataOwnerGeneration';

vi.mock('@/state/newMakerDraft', () => {
  const snapshot = () => ({
    vendor: 'cc',
    lastByVendor: {
      cc: { model: '', providerId: null, effort: '', fastMode: false },
      codex: { model: '', providerId: null, effort: '', fastMode: false },
      pi: { model: '', providerId: null, effort: '', fastMode: false },
    },
    fastModeByModel: {},
  });
  return { getDraft: snapshot, getDraftForPreferenceSync: snapshot, getPersistedVendorModel: () => '' };
});

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

let fixtureGeneration = 0;
beforeEach(() => {
  window.localStorage.clear();
  owner.setDataOwnerGeneration(`bot-lifecycle-${++fixtureGeneration}`);
});

describe('Bot lifecycle deletion during database hydration', () => {
  beforeEach(() => {
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

    const hydrating = store.ensureBotProfilesLoaded();
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
    await Promise.all([hydrating, deletion]);

    expect(runBotLifecycleAction).toHaveBeenCalledOnce();
    expect(store.getBotProfiles()).toEqual([]);
    // Obsolete renderer snapshots are neither read nor used as a writable store.
    expect(JSON.parse(window.localStorage.getItem('cindy.bots.v1') ?? '[]')).toEqual([bot]);
  });
});


describe('Bot profile snapshot ownership', () => {
  // Unit regression: profile/message/turn-stop events can arrive during one slow
  // list. Previous ownership tests allowed overlapping reads and missed the IPC
  // amplification. Keep one read and one successor, never publish the stale page.
  it('coalesces refresh bursts into one successor and publishes the final profile', async () => {
    let release!: (rows: typeof bot[]) => void;
    let releaseNext!: (rows: typeof bot[]) => void;
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseNext = resolve; }))
      .mockResolvedValueOnce([{ ...bot, name: 'Final profile' }]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { bots: { list } } },
    });
    const hydrating = store.ensureBotProfilesLoaded();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    for (let i = 0; i < 20; i++) store.refreshBotProfiles();
    expect(list).toHaveBeenCalledOnce();
    release([bot]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(store.getBotProfiles()).toEqual([]);
    // Continued events during the successor still retain at most one next read.
    for (let i = 0; i < 20; i++) store.refreshBotProfiles();
    expect(list).toHaveBeenCalledTimes(2);
    releaseNext([{ ...bot, name: 'Intermediate profile' }]);
    await hydrating;
    expect(list).toHaveBeenCalledTimes(3);
    expect(store.getBotProfiles()[0]?.name).toBe('Final profile');
  });

  it('does not retry a failed read without a new refresh', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([bot]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true, value: { localDb: { bots: { list } } },
    });
    await store.ensureBotProfilesLoaded();
    await Promise.resolve();
    expect(list).toHaveBeenCalledOnce();
    expect(store.getBotProfiles()).toEqual([]);
    await store.ensureBotProfilesLoaded(true);
    expect(list).toHaveBeenCalledTimes(2);
    expect(store.getBotProfiles()[0]?.id).toBe(bot.id);
  });

  it('clears prior-owner data immediately and ignores its late list response', async () => {
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
    await store.ensureBotProfilesLoaded();
    expect(store.getBotProfiles()).toHaveLength(1);
    const previousHydration = store.ensureBotProfilesLoaded(true);
    // A pending old-owner successor must be discarded at the boundary too.
    store.refreshBotProfiles();
    expect(list).toHaveBeenCalledTimes(2);
    owner.setDataOwnerGeneration('owner-b');
    expect(store.getBotProfiles()).toEqual([]);
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()[0]?.name).toBe('Owner B'));
    release([bot]);
    await previousHydration;
    expect(list).toHaveBeenCalledTimes(3);
    expect(store.getBotProfiles().map((row) => row.id)).toEqual(['bot-b']);
  });

  it('loads the signed-in owner projection on demand after the startup hydration missed it', async () => {
    owner.setDataOwnerGeneration(null);
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('database not ready'))
      .mockResolvedValue([bot]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { bots: { list } } },
    });
    await store.ensureBotProfilesLoaded();
    expect(list).toHaveBeenCalledOnce();
    owner.setDataOwnerGeneration('owner-a');
    // Sign-in clears the projection without reloading it; nothing is listening outside Bots views.
    expect(store.getBotProfiles()).toEqual([]);
    await expect(store.ensureBotProfilesLoaded()).resolves.toMatchObject([{ id: 'bot-1' }]);
    expect(list).toHaveBeenCalledTimes(2);
    // Already loaded: a plain entry does not re-read, an explicit refresh does.
    await store.ensureBotProfilesLoaded();
    expect(list).toHaveBeenCalledTimes(2);
    await store.ensureBotProfilesLoaded(true);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('rejects a prior-owner update without changing the new owner projection', async () => {
    owner.setDataOwnerGeneration('owner-a');
    let release!: (row: typeof bot) => void;
    const list = vi.fn().mockResolvedValue([bot]);
    const update = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { bots: { list, update } } },
    });
    await store.ensureBotProfilesLoaded();
    expect(store.getBotProfiles()).toHaveLength(1);
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
