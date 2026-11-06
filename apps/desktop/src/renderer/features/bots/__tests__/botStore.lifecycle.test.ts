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
  it('ignores an older list response after a newer refresh has completed', async () => {
    let release!: (rows: typeof bot[]) => void;
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce([{ ...bot, name: 'Newer profile' }]);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { localDb: { bots: { list } } },
    });
    const hydrating = store.ensureBotProfilesLoaded();
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()[0]?.name).toBe('Newer profile'));
    release([bot]);
    await hydrating;
    expect(store.getBotProfiles()[0]?.name).toBe('Newer profile');
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
    owner.setDataOwnerGeneration('owner-b');
    expect(store.getBotProfiles()).toEqual([]);
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()[0]?.name).toBe('Owner B'));
    release([bot]);
    await previousHydration;
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

  // Unit regression: recovery must not publish a stale profile across deletion or account changes.
  it('refreshes one recovered profile and invalidates pending confirmations and reads at deletion start', async () => {
    owner.setDataOwnerGeneration('owner-a');
    let releaseGet!: (row: typeof bot) => void;
    let finishDelete!: (value: unknown) => void;
    const list = vi.fn().mockResolvedValue([bot]);
    const get = vi.fn().mockResolvedValueOnce({ ...bot, name: 'Restored' })
      .mockImplementationOnce(() => new Promise(resolve => { releaseGet = resolve; }));
    const runBotLifecycleAction = vi.fn(() => new Promise(resolve => { finishDelete = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: { list, get } }, maker: { runBotLifecycleAction } } });
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()).toHaveLength(1));
    expect(await store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id))).toBe(true);
    expect(store.getBotProfiles()[0]?.name).toBe('Restored');
    const confirmation = store.captureBotRecovery(bot.id);
    const pending = store.refreshRecoveredBot(bot.id, confirmation);
    const deletion = store.runBotLifecycleAction({ botId: bot.id, action: 'delete', confirmName: bot.name });
    expect(confirmation()).toBe(false);
    const duringDelete = store.captureBotRecovery(bot.id);
    await vi.waitFor(() => expect(runBotLifecycleAction).toHaveBeenCalled());
    finishDelete({ status: 'deleted' });
    await deletion;
    releaseGet(bot);
    expect(await pending).toBe(false);
    expect(confirmation()).toBe(false);
    expect(duringDelete()).toBe(false);
    expect(store.getBotProfiles()).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('waits for an existing list before recovery and rejects a list started during the read', async () => {
    let releaseList!: (rows: typeof bot[]) => void;
    let releaseGet!: (row: typeof bot) => void;
    const list = vi.fn().mockImplementationOnce(() => new Promise(resolve => { releaseList = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseList = resolve; }));
    const get = vi.fn(() => new Promise(resolve => { releaseGet = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: { list, get } } } });
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const first = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
    expect(get).not.toHaveBeenCalled();
    releaseList([bot]);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    releaseGet({ ...bot, name: 'Recovered' });
    expect(await first).toBe(true);
    const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    releaseList([{ ...bot, name: 'List result' }]);
    await vi.waitFor(() => expect(store.getBotProfiles()[0]?.name).toBe('List result'));
    releaseGet({ ...bot, name: 'Late recovery' });
    expect(await pending).toBe(false);
    expect(store.getBotProfiles()[0]?.name).toBe('List result');
  });

  // Unit regression: an old recovery read must not undo a settings save for the same profile.
  it('does not overwrite a profile update completed during the recovery read', async () => {
    let release!: (row: typeof bot) => void;
    const get = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const update = vi.fn().mockResolvedValue({ ...bot, name: 'Saved' });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: {
      list: vi.fn().mockResolvedValue([bot]), get, update,
    } } } });
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()).toHaveLength(1));
    const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
    await store.updateBotProfile(bot.id, { name: 'Saved' });
    release(bot);
    expect(await pending).toBe(false);
    expect(store.getBotProfiles()[0]?.name).toBe('Saved');
  });

  // Unit regression: a late recovery read must not undo a completed roster pin.
  // Existing write-generation coverage does not exercise setBotPinned; the minimal race is
  // get pending, pin succeeds, then the old get resolves (unit tier).
  it('does not overwrite a pin completed during the recovery read', async () => {
    let release!: (row: typeof bot) => void;
    const get = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const update = vi.fn().mockResolvedValue({ ...bot, pinnedAt: 30 });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: {
      list: vi.fn().mockResolvedValue([bot]), get, update,
    } } } });
    store.refreshBotProfiles();
    await store.ensureBotProfilesLoaded();
    const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
    await store.setBotPinned(bot.id, true);
    release(bot);
    expect(await pending).toBe(false);
    expect(store.getBotProfiles()[0]?.pinnedAt).toBe(30);
  });

  // Unit: a pending optimistic write must survive an older recovery read (existing tests settle the write first).
  it('refuses recovery while a profile write is pending', async () => {
    let finish!: (row: typeof bot) => void;
    const get = vi.fn().mockResolvedValue(bot);
    const update = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: {
      list: vi.fn().mockResolvedValue([bot]), get, update,
    } } } });
    store.refreshBotProfiles();
    await store.ensureBotProfilesLoaded();
    const write = store.updateBotProfile(bot.id, { name: 'Saved' });
    expect(await store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id))).toBe(false);
    expect(store.getBotProfiles()[0]?.name).toBe('Saved');
    finish({ ...bot, name: 'Saved' });
    await write;
  });

  // Unit: a write started after the read remains optimistic when the old read finishes first.
  it('rejects a recovery result while a later write is pending', async () => {
    let release!: (row: typeof bot) => void;
    let finish!: (row: typeof bot) => void;
    const get = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const update = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: {
      list: vi.fn().mockResolvedValue([bot]), get, update,
    } } } });
    store.refreshBotProfiles();
    await store.ensureBotProfilesLoaded();
    const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
    const write = store.updateBotProfile(bot.id, { name: 'Saved' });
    release(bot);
    expect(await pending).toBe(false);
    expect(store.getBotProfiles()[0]?.name).toBe('Saved');
    finish({ ...bot, name: 'Saved' });
    await write;
  });

  // Unit regression: a recovery read started during a write must not undo its completion or rollback.
  it.each(['success', 'failure'] as const)('rejects a recovery read predating write %s', async (outcome) => {
    let releaseGet!: (row: typeof bot) => void;
    let finishWrite!: (row: typeof bot) => void;
    let failWrite!: (error: Error) => void;
    const get = vi.fn(() => new Promise(resolve => { releaseGet = resolve; }));
    const update = vi.fn(() => new Promise((resolve, reject) => { finishWrite = resolve; failWrite = reject; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: {
      list: vi.fn().mockResolvedValue([bot]), get, update,
    } } } });
    store.refreshBotProfiles();
    await store.ensureBotProfilesLoaded();
    const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
    const write = store.updateBotProfile(bot.id, { name: 'Saved' });
    if (outcome === 'success') {
      finishWrite({ ...bot, name: 'Saved' });
      await write;
    } else {
      const rejected = expect(write).rejects.toThrow('write failed');
      failWrite(new Error('write failed'));
      await rejected;
    }
    releaseGet({ ...bot, name: 'Stale' });
    expect(await pending).toBe(false);
    expect(store.getBotProfiles()[0]?.name).toBe(outcome === 'success' ? 'Saved' : bot.name);
  });

  it('keeps the latest write authoritative when an older write finishes during recovery', async () => {
    const writes: Array<(row: typeof bot) => void> = [];
    let releaseGet!: (row: typeof bot) => void;
    const update = vi.fn(() => new Promise(resolve => { writes.push(resolve); }));
    const get = vi.fn(() => new Promise(resolve => { releaseGet = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: {
      list: vi.fn().mockResolvedValue([bot]), get, update,
    } } } });
    store.refreshBotProfiles();
    await store.ensureBotProfilesLoaded();
    const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
    const older = store.updateBotProfile(bot.id, { name: 'Older' });
    const newer = store.updateBotProfile(bot.id, { name: 'Newer' });
    writes[0]({ ...bot, name: 'Older' });
    await older;
    writes[1]({ ...bot, name: 'Newer' });
    await newer;
    releaseGet(bot);
    expect(await pending).toBe(false);
    expect(store.getBotProfiles()[0]?.name).toBe('Newer');
  });

  it('times out waiting for hydration without starting a later recovery read', async () => {
    let release!: (rows: typeof bot[]) => void;
    const list = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const get = vi.fn();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: { list, get } } } });
    store.refreshBotProfiles();
    vi.useFakeTimers();
    try {
      const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
      const rejected = expect(pending).rejects.toThrow('Bot refresh timed out');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      release([bot]);
      await store.ensureBotProfilesLoaded();
      expect(get).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('shares the ten-second deadline between hydration and the recovery read', async () => {
    let releaseList!: (rows: typeof bot[]) => void;
    let releaseGet!: (row: typeof bot) => void;
    const list = vi.fn(() => new Promise(resolve => { releaseList = resolve; }));
    const get = vi.fn(() => new Promise(resolve => { releaseGet = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: { list, get } } } });
    store.refreshBotProfiles();
    vi.useFakeTimers();
    try {
      const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
      const rejected = expect(pending).rejects.toThrow('Bot refresh timed out');
      await vi.advanceTimersByTimeAsync(6_000);
      releaseList([bot]);
      await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(4_000);
      await rejected;
      releaseGet({ ...bot, name: 'Late recovery' });
      await Promise.resolve();
      expect(store.getBotProfiles()[0]?.name).toBe(bot.name);
      expect(list).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('times out a stalled single-profile read without applying its late result', async () => {
    let release!: (row: typeof bot) => void;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: {
      list: vi.fn().mockResolvedValue([bot]), get: vi.fn(() => new Promise(resolve => { release = resolve; })),
    } } } });
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()).toHaveLength(1));
    vi.useFakeTimers();
    try {
      const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
      const rejected = expect(pending).rejects.toThrow('Bot refresh timed out');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      release({ ...bot, name: 'Late recovery' });
      await Promise.resolve();
      expect(store.getBotProfiles()[0]?.name).toBe(bot.name);
    } finally { vi.useRealTimers(); }
  });

  it('drops a recovered profile when the account changes during its read', async () => {
    owner.setDataOwnerGeneration('owner-a');
    let release!: (row: typeof bot) => void;
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { bots: {
      list: vi.fn().mockResolvedValue([bot]), get: vi.fn(() => new Promise(resolve => { release = resolve; })),
    } } } });
    store.refreshBotProfiles();
    await vi.waitFor(() => expect(store.getBotProfiles()).toHaveLength(1));
    const pending = store.refreshRecoveredBot(bot.id, store.captureBotRecovery(bot.id));
    owner.setDataOwnerGeneration('owner-b');
    release(bot);
    expect(await pending).toBe(false);
    expect(store.getBotProfiles()).toEqual([]);
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
