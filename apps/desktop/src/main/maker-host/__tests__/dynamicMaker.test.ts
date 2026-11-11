import { describe, expect, it, vi } from 'vitest';
import type { Maker } from '@cindy/maker-core';

import { createDynamicMaker } from '../dynamic-maker.js';
import { createBotModelRouteReconciler } from '../../maker-ipc/botModelRouteReconciler.js';
import type { BotModelRoute } from '../../../shared/botModelChain.js';

describe('createDynamicMaker', () => {
  it('routes an already captured method to the current Maker instance', () => {
    const first = { listAvailableAgents: vi.fn(() => ['first']) };
    const second = { listAvailableAgents: vi.fn(() => ['second']) };
    let current = first;
    const facade = createDynamicMaker(() => current as unknown as Maker);
    const captured = facade.listAvailableAgents;

    expect(captured()).toEqual(['first']);
    current = second;
    expect(captured()).toEqual(['second']);
    expect(first.listAvailableAgents).toHaveBeenCalledTimes(1);
    expect(second.listAvailableAgents).toHaveBeenCalledTimes(1);
  });

  it('reads non-function properties from the current Maker instance', () => {
    const first = { makerMemory: { owner: 'first' } };
    const second = { makerMemory: { owner: 'second' } };
    let current = first;
    const facade = createDynamicMaker(() => current as unknown as Maker);

    expect((facade.makerMemory as unknown as { owner: string }).owner).toBe('first');
    current = second;
    expect((facade.makerMemory as unknown as { owner: string }).owner).toBe('second');
  });

  it('keeps a capability resolver usable across account replacement without retaining route bookkeeping', async () => {
    const chain: BotModelRoute[] = [
      { harness: 'claude', model: 'primary', providerId: null, effort: '', fastMode: false },
    ];
    const first = { getSessionMeta: vi.fn(async () => ({ agentKind: 'claude-code' as const, model: 'primary' })) };
    const second = { getSessionMeta: vi.fn(async () => ({ agentKind: 'pi' as const, model: 'fallback' })) };
    let current: typeof first | typeof second = first;
    let owner = 'first';
    let boundaryPending = false;
    const facade = createDynamicMaker(() => {
      if (boundaryPending) throw new Error('Account boundary pending');
      return current as unknown as Maker;
    });
    const apply = vi.fn();
    const reconciler = createBotModelRouteReconciler({
      ownerEpoch: () => owner,
      read: async (sessionId) => {
        const meta = await facade.getSessionMeta(sessionId);
        if (!meta) return null;
        return {
          chain,
          current: { agentKind: meta.agentKind, model: meta.model, providerId: null, effort: null, fastMode: false },
          hasRuntimeOverride: true,
        };
      },
      apply,
    });
    // IPC installs this callback once; subsequent calls use the replacement Maker.
    const resolve = async () => (await reconciler.preview('canonical'))?.agentKind ?? null;
    await reconciler('canonical');
    expect(await resolve()).toBe('claude-code');
    chain[0] = { ...chain[0]!, harness: 'codex' };
    expect(await resolve()).toBe('codex');

    first.getSessionMeta.mockImplementationOnce(async () => {
      owner = 'second';
      boundaryPending = true;
      return { agentKind: 'claude-code', model: 'primary' };
    });
    await expect(resolve()).rejects.toThrow('owner changed');
    await expect(resolve()).rejects.toThrow('Account boundary pending');
    const firstOwnerReads = first.getSessionMeta.mock.calls.length;

    current = second;
    boundaryPending = false;
    // A reused ID with another owner's fallback must not inherit the first
    // owner's configured-chain history and override that fallback with Codex.
    expect(await resolve()).toBe('pi');
    await reconciler('canonical');
    expect(await resolve()).toBe('pi');
    expect(first.getSessionMeta).toHaveBeenCalledTimes(firstOwnerReads);
    expect(second.getSessionMeta).toHaveBeenCalledTimes(3);
    expect(apply).not.toHaveBeenCalled();
  });
});
