import { describe, expect, it, vi } from 'vitest';
import { createBotModelRouteReconciler } from '../botModelRouteReconciler';
import type { BotModelRoute } from '../../../shared/botModelChain';
import type { SessionRuntimeProfile } from '../sessionRuntimeControl';

function harness() {
  let owner = 'owner-a';
  const state: { chain: BotModelRoute[]; current: SessionRuntimeProfile; hasRuntimeOverride: boolean; next?: SessionRuntimeProfile } = {
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
  it('reads paused profiles only for previews and does not consume their pending model edits', async () => {
    const h = harness();
    let paused = true;
    const read = vi.fn(async (_id: string, purpose: 'apply' | 'preview') =>
      paused && purpose !== 'preview' ? null : h.state);
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'owner', read, apply: h.apply });
    await expect(reconcile.preview('canonical')).resolves.toMatchObject({ agentKind: 'codex' });
    const draft: BotModelRoute[] = [{ ...h.state.chain[0]!, harness: 'claude' }];
    await expect(reconcile.preview('canonical', draft)).resolves.toMatchObject({ agentKind: 'claude-code' });
    await reconcile('canonical');
    expect(h.apply).not.toHaveBeenCalled();
    paused = false;
    h.state.chain = draft;
    await reconcile('canonical');
    expect(h.apply).toHaveBeenCalledWith('canonical', expect.objectContaining({ agentKind: 'claude-code' }), h.state.current);
  });
  it('previews the preserved effective or pending fallback without changing the runtime', async () => {
    const h = harness();
    h.state.hasRuntimeOverride = true;
    expect(await h.reconcile.preview('canonical')).toEqual(h.state.current);
    h.state.next = { ...h.state.current, agentKind: 'claude-code', model: 'pending' };
    expect(await h.reconcile.preview('canonical')).toEqual(h.state.next);
    expect(h.apply).not.toHaveBeenCalled();
  });
  it('previews a draft and then saved chain without consuming the next-send change', async () => {
    const h = harness();
    h.state.hasRuntimeOverride = true;
    await h.reconcile('canonical');
    const draft: BotModelRoute[] = [{ ...h.state.chain[0]!, harness: 'claude', model: 'new-primary' }];
    const expected = expect.objectContaining({ agentKind: 'claude-code', model: 'new-primary' });
    expect(await h.reconcile.preview('canonical', draft)).toEqual(expected);
    expect(h.apply).not.toHaveBeenCalled();
    expect(await h.reconcile.preview('canonical')).toEqual(h.state.current);
    h.state.chain = draft;
    expect(await h.reconcile.preview('canonical', draft)).toEqual(expected);
    expect(h.apply).not.toHaveBeenCalled();
    await h.reconcile('canonical');
    expect(h.apply).toHaveBeenCalledWith('canonical', expected, h.state.current);
    h.state.next = { ...h.state.current, model: 'new-fallback' };
    expect(await h.reconcile.preview('canonical', draft)).toEqual(h.state.next);
  });
  it('invalidates fallback when a later chain candidate changes, even with the same primary', async () => {
    const h = harness();
    h.state.hasRuntimeOverride = true;
    await h.reconcile('canonical');
    const draft: BotModelRoute[] = [...h.state.chain, { ...h.state.chain[0]!, harness: 'pi', model: 'secondary' }];
    expect(await h.reconcile.preview('canonical', draft)).toMatchObject({ agentKind: 'codex', model: 'luna' });
    expect(h.apply).not.toHaveBeenCalled();
  });
  it('normalizes draft chains the same way as the persisted profile', async () => {
    const h = harness();
    h.state.hasRuntimeOverride = true;
    await h.reconcile('canonical');
    expect(await h.reconcile.preview('canonical', [...h.state.chain, ...h.state.chain])).toEqual(h.state.current);
    expect(h.apply).not.toHaveBeenCalled();
  });
  it('rejects an owner change during a preview', async () => {
    const h = harness();
    h.read.mockImplementationOnce(async () => { h.changeOwner(); return h.state; });
    await expect(h.reconcile.preview('canonical')).rejects.toThrow('owner changed');
    expect(h.apply).not.toHaveBeenCalled();
  });
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

it('applies an explicit settings save immediately even while an earlier fallback is effective', async () => {
  const h = harness();
  h.state.hasRuntimeOverride = true;
  await h.reconcile.profileChanged('canonical');
  expect(h.apply).toHaveBeenCalledWith('canonical', expect.objectContaining({ model: 'luna', agentKind: 'codex' }), h.state.current);
});
it('finishes at the newest settings selection when another save arrives during switching', async () => {
  const h = harness();
  let finish!: () => void;
  h.apply.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
  const first = h.reconcile.profileChanged('canonical');
  await vi.waitFor(() => expect(h.apply).toHaveBeenCalledOnce());
  h.state.chain = [{ ...h.state.chain[0]!, model: 'newest-model' }];
  h.state.hasRuntimeOverride = true;
  const second = h.reconcile.profileChanged('canonical');
  finish();
  await Promise.all([first, second]);
  expect(h.apply).toHaveBeenCalledTimes(2);
  expect(h.apply).toHaveBeenLastCalledWith('canonical', expect.objectContaining({ model: 'newest-model' }), h.state.current);
});
it('selecting the current route cancels a different pending route instead of leaving it queued', async () => {
  const h = harness();
  h.state.chain = [{ harness: 'pi', model: 'glm', providerId: 'xd', effort: 'high', fastMode: false }];
  h.state.next = { ...h.state.current, agentKind: 'codex', model: 'obsolete' };
  h.state.hasRuntimeOverride = true;
  await h.reconcile.profileChanged('canonical');
  expect(h.apply).toHaveBeenCalledWith('canonical', h.state.current, h.state.current);
});
