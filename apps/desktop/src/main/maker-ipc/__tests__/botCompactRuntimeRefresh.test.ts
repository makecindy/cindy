import { describe, expect, it, vi } from 'vitest';

import {
  createBotCompactRuntimeRefreshCoordinator,
  replaceBotRuntimeAfterPreflight,
  type BotCompactRuntimeSession,
} from '../botCompactRuntimeRefresh';

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
