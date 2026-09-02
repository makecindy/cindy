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
  channel: 'local',
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

describe('Bot lifecycle deletion during legacy hydration', () => {
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
    expect(JSON.parse(window.localStorage.getItem('cindy.bots.v1') ?? '[]')).toEqual([]);
  });
});
