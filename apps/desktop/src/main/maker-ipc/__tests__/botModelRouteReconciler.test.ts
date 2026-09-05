import { describe, expect, it, vi } from 'vitest';
import { createBotModelRouteReconciler } from '../botModelRouteReconciler';

function harness() {
  let owner = 'owner-a';
  const state = {
    chain: [{ harness: 'codex' as const, model: 'luna', providerId: 'xd', effort: 'medium', fastMode: false }],
    current: { agentKind: 'pi' as const, model: 'glm', providerId: 'xd', effort: 'high', fastMode: false },
    hasRuntimeOverride: false,
  };
  const read = vi.fn(async () => state);
  const apply = vi.fn(async () => undefined);
  const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => owner, read, apply });
  return { state, read, apply, reconcile, changeOwner: () => { owner = 'owner-b'; } };
}

describe('permanent Bot model selection', () => {
  it('applies the configured harness before the first send after restart', async () => {
    const h = harness();
    await h.reconcile('canonical');
    expect(h.apply).toHaveBeenCalledWith('canonical', expect.objectContaining({ agentKind: 'codex', model: 'luna' }), h.state.current);
  });
  it('preserves an automatic runtime override while the configured chain stays unchanged', async () => {
    const h = harness();
    h.state.hasRuntimeOverride = true;
    await h.reconcile('canonical');
    await h.reconcile('canonical');
    expect(h.apply).not.toHaveBeenCalled();
    h.state.chain[0].model = 'new-model';
    await h.reconcile('canonical');
    expect(h.apply).toHaveBeenCalledOnce();
  });
  it('does not interfere with ordinary or frozen background tasks', async () => {
    const apply = vi.fn();
    await createBotModelRouteReconciler({ ownerEpoch: () => 'a', read: async () => null, apply })('other');
    expect(apply).not.toHaveBeenCalled();
  });
  it('coalesces simultaneous sends and retries a failed selection', async () => {
    const h = harness();
    h.apply.mockRejectedValueOnce(new Error('unavailable'));
    const result = await Promise.allSettled([h.reconcile('canonical'), h.reconcile('canonical')]);
    expect(result.map(r => r.status)).toEqual(['rejected', 'rejected']);
    expect(h.apply).toHaveBeenCalledOnce();
    await h.reconcile('canonical');
    expect(h.apply).toHaveBeenCalledTimes(2);
  });
  it('rejects an owner change during the read before changing any runtime', async () => {
    const h = harness();
    h.read.mockImplementationOnce(async () => { h.changeOwner(); return h.state; });
    await expect(h.reconcile('canonical')).rejects.toThrow('owner changed');
    expect(h.apply).not.toHaveBeenCalled();
  });
});
