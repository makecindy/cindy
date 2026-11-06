import { describe, expect, it, vi } from 'vitest';

import {
  createBotCompactRuntimeRefreshCoordinator,
  prepareBotCapabilityEpochBeforeSend,
  refreshBotRuntimeAfterModelSelection,
  replaceBotRuntimeAfterPreflight,
  type BotCompactRuntimeSession,
} from '../botCompactRuntimeRefresh';

describe('profile refresh after model selection', () => {
  it.each([true, false])('keeps the newly bootstrapped handle alive (prior handle: %s)', async (hadRuntime) => {
    let current = hadRuntime ? createSession().session : undefined;
    const next = createSession('bot-session', 'new-codex-thread').session;
    const refresh = vi.fn(async () => 'refreshed' as const);
    await expect(refreshBotRuntimeAfterModelSelection({
      current: () => current,
      select: async () => { current = next; },
      refresh,
    })).resolves.toBe('not-bot');
    expect(current).toBe(next);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps a busy selection queued until the safe boundary', async () => {
    const runtime = createSession();
    runtime.setRunning(true);
    const refresh = vi.fn(async () => 'refreshed' as const);
    const coordinator = createBotCompactRuntimeRefreshCoordinator({ hasPendingInteraction: () => false, refresh });
    await expect(refreshBotRuntimeAfterModelSelection({
      current: () => runtime.session,
      select: async () => {},
      refresh: async (session) => {
        coordinator.noteBoundary(session);
        return coordinator.attempt(session);
      },
    })).resolves.toBe('deferred');
    expect(refresh).not.toHaveBeenCalled();
    runtime.setRunning(false);
    await expect(coordinator.attempt(runtime.session)).resolves.toBe('refreshed');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not refresh or close the current handle when switching fails', async () => {
    const runtime = createSession();
    const refresh = vi.fn(async () => 'refreshed' as const);
    await expect(refreshBotRuntimeAfterModelSelection({
      current: () => runtime.session,
      select: async () => { throw new Error('provider unavailable'); },
      refresh,
    })).rejects.toThrow('provider unavailable');
    expect(refresh).not.toHaveBeenCalled();
  });
});

function createSession(id = 'bot-session', instanceId = 'runtime-1') {
  let running = false;
  let backgroundTasks = 0;
  const session: BotCompactRuntimeSession = {
    id,
    instanceId,
    isTurnRunning: () => running,
    listBackgroundTasks: () => Array.from({ length: backgroundTasks }),
  };
  return {
    session,
    setRunning: (value: boolean) => { running = value; },
    setBackgroundTasks: (value: number) => { backgroundTasks = value; },
  };
}

describe('Bot compact runtime refresh coordinator', () => {
  it('keeps the live runtime open when frozen resource preflight fails', async () => {
    const calls: string[] = [];
    await expect(replaceBotRuntimeAfterPreflight({
      preflight: async () => {
        calls.push('preflight');
        throw Object.assign(new Error('resource drift'), {
          code: 'BOT_RUNTIME_RESOURCE_DRIFT',
        });
      },
      isCurrentOwner: () => true,
      close: async () => { calls.push('close'); },
      bootstrap: async () => { calls.push('bootstrap'); },
    })).rejects.toMatchObject({ code: 'BOT_RUNTIME_RESOURCE_DRIFT' });
    expect(calls).toEqual(['preflight']);
  });

  it('rechecks ownership after preflight and swaps only in the safe order', async () => {
    const calls: string[] = [];
    await expect(replaceBotRuntimeAfterPreflight({
      preflight: async () => { calls.push('preflight'); },
      isCurrentOwner: () => {
        calls.push('owner');
        return true;
      },
      close: async () => { calls.push('close'); },
      bootstrap: async () => {
        calls.push('bootstrap');
        return 'new-runtime';
      },
    })).resolves.toBe('new-runtime');
    expect(calls).toEqual(['preflight', 'owner', 'close', 'bootstrap']);

    await expect(replaceBotRuntimeAfterPreflight({
      preflight: async () => undefined,
      isCurrentOwner: () => false,
      close: async () => { throw new Error('must not close'); },
      bootstrap: async () => 'unreachable',
    })).rejects.toThrow('owner changed');
  });

  it('waits for the final idle boundary instead of refreshing at compact_boundary', async () => {
    const h = createSession();
    let hasInteraction = false;
    const refresh = vi.fn(async () => 'refreshed' as const);
    const coordinator = createBotCompactRuntimeRefreshCoordinator({
      hasPendingInteraction: () => hasInteraction,
      refresh,
      now: () => 100,
    });

    h.setRunning(true);
    coordinator.noteBoundary(h.session);
    expect(refresh).not.toHaveBeenCalled();
    await expect(coordinator.attempt(h.session)).resolves.toBe('deferred');

    h.setRunning(false);
    hasInteraction = true;
    await expect(coordinator.attempt(h.session)).resolves.toBe('deferred');
    hasInteraction = false;
    h.setBackgroundTasks(1);
    await expect(coordinator.attempt(h.session)).resolves.toBe('deferred');

    h.setBackgroundTasks(0);
    await expect(coordinator.attempt(h.session)).resolves.toBe('refreshed');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(coordinator.hasPending(h.session.id)).toBe(false);
  });

  it('is scoped to the exact runtime instance and ignores late events from the old one', async () => {
    const oldRuntime = createSession('bot-session', 'runtime-old');
    const replacement = createSession('bot-session', 'runtime-new');
    const refresh = vi.fn(async () => 'refreshed' as const);
    const coordinator = createBotCompactRuntimeRefreshCoordinator({
      hasPendingInteraction: () => false,
      refresh,
    });

    coordinator.noteBoundary(oldRuntime.session);
    await expect(coordinator.attempt(replacement.session)).resolves.toBe('not-bot');
    expect(refresh).not.toHaveBeenCalled();
    await expect(coordinator.attempt(oldRuntime.session)).resolves.toBe('refreshed');
  });

  it('deduplicates concurrent settle signals and keeps a failed refresh pending for retry', async () => {
    const h = createSession();
    let resolveRefresh!: (value: 'refreshed') => void;
    const refresh = vi.fn(() => new Promise<'refreshed'>((resolve) => {
      resolveRefresh = resolve;
    }));
    const coordinator = createBotCompactRuntimeRefreshCoordinator({
      hasPendingInteraction: () => false,
      refresh,
    });
    coordinator.noteBoundary(h.session);

    const first = coordinator.attempt(h.session);
    const second = coordinator.attempt(h.session);
    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh('refreshed');
    await expect(Promise.all([first, second])).resolves.toEqual(['refreshed', 'refreshed']);

    const retry = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('refreshed');
    const retryCoordinator = createBotCompactRuntimeRefreshCoordinator({
      hasPendingInteraction: () => false,
      refresh: retry,
    });
    retryCoordinator.noteBoundary(h.session);
    await expect(retryCoordinator.attempt(h.session)).resolves.toBe('deferred');
    expect(retryCoordinator.hasPending(h.session.id)).toBe(true);
    await expect(retryCoordinator.attempt(h.session)).resolves.toBe('refreshed');
    expect(retryCoordinator.hasPending(h.session.id)).toBe(false);
  });

  it('clears only the matching closed runtime', () => {
    const oldRuntime = createSession('bot-session', 'runtime-old');
    const otherRuntime = createSession('bot-session', 'runtime-new');
    const coordinator = createBotCompactRuntimeRefreshCoordinator({
      hasPendingInteraction: () => false,
      refresh: async () => 'refreshed',
    });
    coordinator.noteBoundary(oldRuntime.session);
    coordinator.clearForClosedSession(otherRuntime.session);
    expect(coordinator.hasPending(oldRuntime.session.id)).toBe(true);
    coordinator.clearForClosedSession(oldRuntime.session);
    expect(coordinator.hasPending(oldRuntime.session.id)).toBe(false);
  });
});

describe('capability refresh input admission', () => {
  const botChat = { role: 'canonical', source: 'bot', status: 'active', workingDir: '/virtual/bot' };

  it.each([undefined, { ...botChat, role: 'delegation' }, { ...botChat, source: 'desktop' }])(
    'does not block ordinary or delegated input after mid-turn compaction (%j)', async row => {
      const h = createSession();
      h.setRunning(true);
      const refresh = vi.fn(async () => 'not-bot' as const);
      const preflight = vi.fn(async () => true);
      const coordinator = createBotCompactRuntimeRefreshCoordinator({ hasPendingInteraction: () => false, refresh });
      coordinator.noteBoundary(h.session);
      const admit = () => prepareBotCapabilityEpochBeforeSend(h.session, {
        readSession: async () => row, preflight, coordinator,
      });
      await expect(admit()).resolves.toBe('not-bot');
      expect(refresh).not.toHaveBeenCalled();
      expect(preflight).not.toHaveBeenCalled();
      // The task's normal idle callback can retire the marker without replacing it.
      h.setRunning(false);
      await expect(coordinator.attempt(h.session)).resolves.toBe('not-bot');
      expect(coordinator.hasPending(h.session.id)).toBe(false);
      await expect(admit()).resolves.toBe('not-bot');
    },
  );

  it.each(['canonical', 'group'])('keeps %s refresh blocked while busy and recovers at idle', async role => {
    const h = createSession();
    let interaction = false;
    const refresh = vi.fn(async () => 'refreshed' as const);
    const preflight = vi.fn(async () => true);
    const coordinator = createBotCompactRuntimeRefreshCoordinator({ hasPendingInteraction: () => interaction, refresh });
    const admit = () => prepareBotCapabilityEpochBeforeSend(h.session, {
      readSession: async () => ({ ...botChat, role }), preflight, coordinator,
    });
    h.setRunning(true);
    await expect(admit()).resolves.toBe('deferred');
    h.setRunning(false);
    interaction = true;
    await expect(admit()).resolves.toBe('deferred');
    interaction = false;
    h.setBackgroundTasks(1);
    await expect(admit()).resolves.toBe('deferred');
    expect(refresh).not.toHaveBeenCalled();
    h.setBackgroundTasks(0);
    await expect(admit()).resolves.toBe('refreshed');
    expect(refresh).toHaveBeenCalledOnce();
    expect(preflight).toHaveBeenCalledOnce();
  });

  it('keeps failed refresh retryable without treating failure as permission to send', async () => {
    const h = createSession();
    const refresh = vi.fn().mockRejectedValueOnce(new Error('preflight unavailable')).mockResolvedValue('refreshed');
    const coordinator = createBotCompactRuntimeRefreshCoordinator({ hasPendingInteraction: () => false, refresh });
    const admit = () => prepareBotCapabilityEpochBeforeSend(h.session, {
      readSession: async () => botChat, preflight: async () => true, coordinator,
    });
    await expect(admit()).resolves.toBe('deferred');
    expect(coordinator.hasPending(h.session.id)).toBe(true);
    await expect(admit()).resolves.toBe('refreshed');
    expect(coordinator.hasPending(h.session.id)).toBe(false);
  });

  it('does not let a retired instance marker block the current unchanged runtime', async () => {
    const old = createSession();
    const current = createSession(old.session.id, 'replacement');
    const refresh = vi.fn(async () => 'refreshed' as const);
    const coordinator = createBotCompactRuntimeRefreshCoordinator({ hasPendingInteraction: () => false, refresh });
    coordinator.noteBoundary(old.session);
    await expect(prepareBotCapabilityEpochBeforeSend(current.session, {
      readSession: async () => botChat, preflight: async () => false, coordinator,
    })).resolves.toBe('not-bot');
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['same-instance', 'replacement'] as const)('preserves newer refresh work when an old callback settles (%s)', async kind => {
    const old = createSession();
    const next = kind === 'same-instance' ? old : createSession(old.session.id, 'replacement');
    let finish!: (outcome: 'refreshed') => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue('refreshed');
    const coordinator = createBotCompactRuntimeRefreshCoordinator({ hasPendingInteraction: () => false, refresh });
    coordinator.noteBoundary(old.session);
    const first = coordinator.attempt(old.session);
    coordinator.noteBoundary(next.session);
    const second = coordinator.attempt(next.session);
    finish('refreshed');
    await first;
    await second;
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1][0]).toBe(next.session);
    expect(coordinator.hasPending(next.session.id)).toBe(false);
  });

  it('does not clear a newer boundary unless its own refresh succeeds', async () => {
    const h = createSession();
    let finish!: (outcome: 'refreshed') => void;
    const coordinator = createBotCompactRuntimeRefreshCoordinator({ hasPendingInteraction: () => false,
      refresh: () => new Promise(resolve => { finish = resolve; }),
    });
    coordinator.noteBoundary(h.session);
    const first = coordinator.attempt(h.session);
    coordinator.noteBoundary(h.session);
    finish('refreshed');
    await first;
    expect(coordinator.hasPending(h.session.id)).toBe(true);
    // Closing cancels pending work; the old callback cannot recreate it.
    const second = coordinator.attempt(h.session);
    coordinator.clearForClosedSession(h.session);
    finish('refreshed');
    await second;
    expect(coordinator.hasPending(h.session.id)).toBe(false);
    await expect(coordinator.attempt(h.session)).resolves.toBe('not-bot');
  });
});
