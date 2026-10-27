import { describe, expect, it, vi } from 'vitest';
import { withSendToSessionLock } from '../sendToSessionLock';
import { createScheduledModelScope } from '../scheduledModelSelection';
import { createBotModelRouteApplier, createBotModelRouteReconciler } from '../botModelRouteReconciler';
import type { BotModelRoute } from '../../../shared/botModelChain';
import { acceptSessionRuntimeMutation, cancelPendingSessionRuntimeMutation, clearSessionRuntimeControlState,
  getSessionRuntimeControlSnapshot, type SessionRuntimeProfile } from '../sessionRuntimeControl';

function harness() {
  let owner = 'owner-a';
  const state: { chain: BotModelRoute[]; current: SessionRuntimeProfile; hasRuntimeOverride: boolean; followsCindyDefault?: boolean; next?: SessionRuntimeProfile } = {
    chain: [{ harness: 'codex' as const, model: 'luna', providerId: 'xd', effort: 'medium', fastMode: false }],
    current: { agentKind: 'pi' as const, model: 'glm', providerId: 'xd', effort: 'high', fastMode: false },
    hasRuntimeOverride: false,
  };
  const read = vi.fn<Parameters<typeof createBotModelRouteReconciler>[0]['read']>(async () => state);
  const apply = vi.fn<Parameters<typeof createBotModelRouteReconciler>[0]['apply']>(async () => undefined);
  const onSelectionAccepted = vi.fn(async (_id: string) => {});
  const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => owner, read, apply, onSelectionAccepted });
  return { state, read, apply, reconcile, onSelectionAccepted, changeOwner: () => { owner = 'owner-b'; } };
}

describe('permanent Bot model selection', () => {
  // Real companion automation failed before queued dispatch because its ordinary
  // send reconciler switched back to the profile. Cover that consumer's decision,
  // including cold startup and companions following the global default (unit tier).
  it.each([false, true])('preserves an automation route across repeated sends and restart (default=%s)', async (followsCindyDefault) => {
    const h = harness();
    const state = { ...h.state, followsCindyDefault, scheduledModelBaseline: JSON.stringify({ ...h.state.current, scopeId: 'automation' }) as string | null };
    const deps = { ownerEpoch: () => 'owner', read: async () => state, apply: h.apply };
    const reconcile = createBotModelRouteReconciler(deps);
    await reconcile('canonical');
    await reconcile('canonical');
    await createBotModelRouteReconciler(deps)('canonical');
    expect(h.apply).not.toHaveBeenCalled();
    state.scheduledModelBaseline = null;
    await reconcile('canonical');
    expect(h.apply).toHaveBeenCalledWith('canonical', expect.objectContaining({ model: 'luna' }), state.current);
  });
  // Capability grants apply to the next ordinary turn, including after restart.
  // The temporary automation route must not choose a different Harness catalog.
  it('previews the saved route without restoring or consuming it', async () => {
    const h = harness();
    const baseline = { ...h.state.current, agentKind: 'claude-code' as const, model: 'saved-model' };
    const state = { ...h.state, scheduledModelBaseline: JSON.stringify({ ...baseline, scopeId: 'automation' }) };
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'owner', read: async () => state, apply: h.apply });
    expect(await reconcile.preview('canonical')).toEqual(baseline);
    const draft = [{ harness: 'codex' as const, model: 'new-choice', providerId: 'xd', effort: 'medium', fastMode: false }];
    expect(await reconcile.preview('canonical', draft)).toMatchObject({ agentKind: 'codex', model: 'new-choice' });
    expect(await reconcile.preview('canonical')).toEqual(baseline);
    await reconcile('canonical');
    expect(h.apply).not.toHaveBeenCalled();
    expect(state.scheduledModelBaseline).toBe(JSON.stringify({ ...baseline, scopeId: 'automation' }));
  });
  it('lands a saved companion choice even when it equals the temporary automation route', async () => {
    const h = harness();
    const state = { ...h.state, scheduledModelBaseline: JSON.stringify({ ...h.state.current, scopeId: 'automation' }) as string | null };
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'owner', read: async () => state, apply: h.apply, onSelectionAccepted: h.onSelectionAccepted });
    await reconcile('canonical');
    state.chain = [{ harness: 'pi', model: 'glm', providerId: 'xd', effort: 'high', fastMode: false }];
    await reconcile.profileChanged('canonical');
    // The landing callback must retire the old saved preference even for a no-op
    // runtime switch, so the next ordinary message cannot resurrect the old model.
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.onSelectionAccepted).toHaveBeenCalledExactlyOnceWith('canonical', state.scheduledModelBaseline);
  });
  it('stops a send instead of retaining the old runtime model when no enabled default remains', async () => {
    const h = harness();
    h.state.chain = [];
    await expect(h.reconcile('canonical')).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(h.apply).not.toHaveBeenCalled();
    expect(await h.reconcile.preview('canonical')).toBeNull();
  });
  it('replaces an automatic runtime route when the Bot follows Cindy default', async () => {
    const h = harness();
    const state = { ...h.state, hasRuntimeOverride: true, followsCindyDefault: true };
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'owner', read: async () => state, apply: h.apply });
    await expect(reconcile.preview('canonical')).resolves.toMatchObject({ model: 'luna', agentKind: 'codex' });
    await reconcile('canonical');
    expect(h.apply).toHaveBeenCalledWith('canonical', expect.objectContaining({ model: 'luna' }), state.current);
  });
  it('replaces a pending non-default route even when the live model still equals Cindy default', async () => {
    const h = harness();
    const current = { agentKind: 'codex' as const, model: 'luna', providerId: 'xd', effort: 'medium' as const, fastMode: false };
    const state = { ...h.state, current, next: { ...current, model: 'sol' }, hasRuntimeOverride: true, followsCindyDefault: true };
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'owner', read: async () => state, apply: h.apply });
    await reconcile('canonical');
    expect(h.apply).toHaveBeenCalledWith('canonical', current, current);
  });
  it('reads a changed default after acquiring the ordinary send lock without deadlocking a lock holder', async () => {
    const h = harness();
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'owner', read: h.read, apply: h.apply, withSessionLock: withSendToSessionLock });
    let release!: () => void;
    let inside!: () => Promise<void>;
    const holder = withSendToSessionLock('queued-model', async () => {
      inside = () => reconcile('queued-model', true);
      await new Promise<void>(resolve => { release = resolve; });
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const waiting = reconcile('queued-model');
    h.state.chain[0]!.model = 'updated-default';
    // The lock holder can reconcile without waiting for the request behind it.
    await inside();
    expect(h.apply).toHaveBeenCalledWith('queued-model', expect.objectContaining({ model: 'updated-default' }), h.state.current);
    release();
    await holder;
    await waiting;
    expect(h.apply.mock.calls.every(([, route]) => route.model === 'updated-default')).toBe(true);
  });
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
  expect(h.onSelectionAccepted).toHaveBeenCalledOnce();
});
it('selecting the current route cancels a different pending route instead of leaving it queued', async () => {
  const h = harness();
  h.state.chain = [{ harness: 'pi', model: 'glm', providerId: 'xd', effort: 'high', fastMode: false }];
  h.state.next = { ...h.state.current, agentKind: 'codex', model: 'obsolete' };
  h.state.hasRuntimeOverride = true;
  await h.reconcile.profileChanged('canonical');
  expect(h.apply).toHaveBeenCalledWith('canonical', h.state.current, h.state.current);
});

it('applies the latest saved selection even when the superseded switch fails', async () => {
  const h = harness();
  let fail!: (error: Error) => void;
  h.apply.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { fail = reject; }));
  const first = h.reconcile.profileChanged('canonical');
  await vi.waitFor(() => expect(h.apply).toHaveBeenCalledOnce());
  h.state.chain = [{ ...h.state.chain[0]!, model: 'working-model' }];
  h.state.hasRuntimeOverride = true;
  const second = h.reconcile.profileChanged('canonical');
  fail(new Error('Old provider unavailable'));
  await Promise.all([first, second]);
  expect(h.apply).toHaveBeenCalledTimes(2);
  expect(h.apply).toHaveBeenLastCalledWith('canonical', expect.objectContaining({ model: 'working-model' }), h.state.current);
  expect(h.onSelectionAccepted).toHaveBeenCalledOnce();
});

it('does not retry a superseded failed switch after the account owner changes', async () => {
  const h = harness();
  let fail!: (error: Error) => void;
  h.apply.mockImplementationOnce(() => new Promise<undefined>((_resolve, reject) => { fail = reject; }));
  const first = h.reconcile.profileChanged('canonical');
  await vi.waitFor(() => expect(h.apply).toHaveBeenCalledOnce());
  h.state.chain = [{ ...h.state.chain[0]!, model: 'new-model' }];
  const second = h.reconcile.profileChanged('canonical');
  h.changeOwner();
  const results = Promise.allSettled([first, second]);
  fail(new Error('Old provider unavailable'));
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(h.apply).toHaveBeenCalledOnce();
  expect(h.onSelectionAccepted).not.toHaveBeenCalled();
});

// Regression: changing only the account location must still move the runtime.
it('reconciles shared-to-local and local-to-shared selections of the same model', async () => {
  const h = harness();
  const local = { agentKind: 'codex' as const, model: 'luna', providerId: 'xd', effort: 'medium' as const, fastMode: false };
  h.state.current = local;
  h.state.chain[0]!.agentDeviceId = 'share:one';
  await h.reconcile('canonical');
  expect(h.apply).toHaveBeenLastCalledWith('canonical', { ...local, agentDeviceId: 'share:one' }, local);
  h.state.current = { ...local, agentDeviceId: 'share:one' };
  delete h.state.chain[0]!.agentDeviceId;
  await h.reconcile.profileChanged('canonical');
  expect(h.apply).toHaveBeenLastCalledWith('canonical', local, h.state.current);
});

// #6759: exercise the production reconciler before scope.restore, as IM sends do.
// A restart can lose the override marker while retaining a fallback baseline.
// Existing save tests did not cover ordinary reconciliation that applies a route.
function automationHarness() {
  const h = harness();
  const original = { ...h.state.current, model: 'runtime-fallback' };
  let baseline: string | null = JSON.stringify({ ...original, scopeId: 'automation' });
  h.apply.mockImplementation(async (_id, route) => {
    h.state.current = { ...route, effort: route.effort as SessionRuntimeProfile['effort'] };
  });
  h.onSelectionAccepted.mockImplementation(async () => { baseline = null; });
  const scope = createScheduledModelScope({
    read: async () => ({ profile: h.state.current, baseline }),
    write: async (_id, value) => { baseline = value ? JSON.stringify(value) : null; },
    apply: async (_id, profile) => {
      const { agentKind, model, providerId, effort, fastMode } = profile;
      h.state.current = { agentKind, model, providerId, effort, fastMode };
    },
    isBusy: () => false, createId: () => 'unused',
  });
  return { ...h, original, scope, baseline: () => baseline };
}

it.each(['restart', 'changed-chain', 'pending-route', 'follow-default'] as const)(
  'restores the saved fallback after ordinary IM preparation: %s', async scenario => {
    const h = automationHarness();
    const primary = { agentKind: 'codex' as const, model: 'luna', providerId: 'xd', effort: 'medium' as const, fastMode: false };
    if (scenario === 'changed-chain') {
      h.state.current = primary;
      await h.reconcile('canonical');
      h.state.chain[0].model = 'changed-default';
    }
    h.state.current = { ...primary, model: 'automation-model' };
    if (scenario === 'pending-route') {
      h.state.current = primary;
      h.state.next = { ...primary, model: 'pending-automation' };
    }
    if (scenario === 'follow-default') {
      h.state.hasRuntimeOverride = true;
      h.state.followsCindyDefault = true;
    }
    const baseline = h.baseline();
    await h.reconcile('canonical');
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.onSelectionAccepted).not.toHaveBeenCalled();
    expect(h.baseline()).toBe(baseline);
    await h.scope.restore('canonical', 'automation');
    expect(h.state.current).toEqual(h.original);
    expect(h.baseline()).toBeNull();
  },
);

it.each([true, false])('invalidates the automation baseline after an explicit save (already current: %s)', async alreadyCurrent => {
  const h = automationHarness();
  const permanent = { agentKind: 'codex' as const, model: 'luna', providerId: 'xd', effort: 'medium' as const, fastMode: false };
  h.state.current = alreadyCurrent ? permanent : { ...permanent, model: 'temporary-model' };
  if (alreadyCurrent) {
    await h.reconcile('canonical');
    expect(h.baseline()).not.toBeNull();
  }
  await h.reconcile.profileChanged('canonical');
  await h.scope.restore('canonical', 'automation');
  expect(h.state.current).toEqual(permanent);
  expect(h.baseline()).toBeNull();
  expect(h.onSelectionAccepted).toHaveBeenCalledOnce();
  expect(h.apply).toHaveBeenCalledTimes(alreadyCurrent ? 0 : 1);
});

it('retains the baseline and retries an explicit save whose staging failed', async () => {
  const h = automationHarness();
  const baseline = h.baseline();
  h.apply.mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(h.reconcile.profileChanged('canonical')).rejects.toThrow('provider unavailable');
  expect(h.onSelectionAccepted).not.toHaveBeenCalled();
  expect(h.baseline()).toBe(baseline);
  await h.reconcile('canonical');
  expect(h.onSelectionAccepted).toHaveBeenCalledOnce();
  await h.scope.restore('canonical', 'automation');
  expect(h.state.current.model).toBe('luna');
});

it('retries an accepted save whose baseline cleanup failed, even when the route already matches', async () => {
  const h = automationHarness();
  const baseline = h.baseline();
  h.onSelectionAccepted.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(h.reconcile.profileChanged('canonical')).rejects.toThrow('storage unavailable');
  expect(h.baseline()).toBe(baseline);
  await h.reconcile('canonical');
  expect(h.apply).toHaveBeenCalledOnce();
  await h.scope.restore('canonical', 'automation');
  expect(h.state.current.model).toBe('luna');
  expect(h.baseline()).toBeNull();
});

it('keeps the baseline when a newer explicit save fails after an ordinary reconcile was in flight', async () => {
  const h = automationHarness();
  const baseline = h.baseline();
  let finish!: () => void;
  h.apply.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const ordinary = h.reconcile('canonical');
  await vi.waitFor(() => expect(h.apply).toHaveBeenCalledOnce());
  h.state.chain[0].model = 'new-permanent';
  h.apply.mockRejectedValueOnce(new Error('new provider unavailable'));
  const explicit = h.reconcile.profileChanged('canonical');
  const results = Promise.allSettled([ordinary, explicit]);
  finish();
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(h.onSelectionAccepted).not.toHaveBeenCalled();
  expect(h.baseline()).toBe(baseline);
  await h.reconcile('canonical');
  expect(h.onSelectionAccepted).toHaveBeenCalledOnce();
  await h.scope.restore('canonical', 'automation');
  expect(h.state.current.model).toBe('new-permanent');
});

// A paused Bot is absent from the production apply reader, but its settings
// can still save a permanent selection. Resume must accept that selection
// before the next IM restores a surviving automation baseline.
it.each([true, false])('retains a paused save until resume (already current: %s)', async alreadyCurrent => {
  const h = automationHarness();
  let paused = true;
  h.read.mockImplementation(async (_id, purpose) => paused && purpose === 'apply' ? null : h.state);
  h.state.hasRuntimeOverride = true;
  if (alreadyCurrent) {
    h.state.current = { agentKind: 'codex', model: 'luna', providerId: 'xd', effort: 'medium', fastMode: false };
  }
  const baseline = h.baseline();
  await h.reconcile.profileChanged('canonical');
  await h.reconcile('canonical');
  await h.reconcile.preview('canonical');
  expect(h.apply).not.toHaveBeenCalled();
  expect(h.onSelectionAccepted).not.toHaveBeenCalled();
  expect(h.baseline()).toBe(baseline);
  paused = false;
  await h.reconcile('canonical');
  await h.scope.restore('canonical', 'automation');
  expect(h.state.current.model).toBe('luna');
  expect(h.baseline()).toBeNull();
  expect(h.onSelectionAccepted).toHaveBeenCalledOnce();
  expect(h.apply).toHaveBeenCalledTimes(alreadyCurrent ? 0 : 1);
});

it('retries a paused save after its first resumed route fails without losing the baseline', async () => {
  const h = automationHarness();
  h.state.hasRuntimeOverride = true;
  h.read.mockResolvedValueOnce(null);
  const baseline = h.baseline();
  await h.reconcile.profileChanged('canonical');
  h.apply.mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(h.reconcile('canonical')).rejects.toThrow('provider unavailable');
  expect(h.baseline()).toBe(baseline);
  expect(h.onSelectionAccepted).not.toHaveBeenCalled();
  await h.reconcile('canonical');
  await h.scope.restore('canonical', 'automation');
  expect(h.state.current.model).toBe('luna');
  expect(h.baseline()).toBeNull();
});

// A profile commit may precede its in-process refresh callback. A failed
// compare-and-set must reread the durable save, even without profileChanged.
it('rereads a newer durable save when acceptance loses its database compare-and-set', async () => {
  const h = harness();
  let baseline = JSON.stringify({ ...h.state.current, scopeId: 'automation', pendingBotProfileVersion: 2 });
  const accepted = vi.fn(async (_id: string, expected?: string | null) => {
    if (expected !== baseline) return false;
    baseline = '';
    return true;
  });
  const reconcile = createBotModelRouteReconciler({
    ownerEpoch: () => 'owner', read: async () => ({ ...h.state, scheduledModelBaseline: baseline }),
    onSelectionAccepted: accepted,
    apply: async (_id, route) => {
      h.state.current = { ...route, effort: route.effort as SessionRuntimeProfile['effort'] };
      if (route.model === 'luna') {
        h.state.chain = [{ ...h.state.chain[0]!, model: 'newest-model' }];
        baseline = JSON.stringify({ ...h.state.current, scopeId: 'automation', pendingBotProfileVersion: 3 });
      }
    },
  });
  await reconcile('canonical');
  expect(h.state.current.model).toBe('newest-model');
  expect(accepted).toHaveBeenCalledTimes(2);
  expect(baseline).toBe('');
});

// #7241 / #7177, unit tier: the real runtime control queues a same-Harness
// selection outside the Harness-switch registry. Earlier tests only rejected
// staging itself; they did not exercise successful staging that remains pending.
it.each(['same-engine', 'cross-engine'] as const)('keeps accepted recovery until a deferred %s choice lands', async kind => {
  const sessionId = `pending-bot-route-${kind}`;
  const current: SessionRuntimeProfile = { agentKind: 'codex', model: 'old', providerId: 'xd', effort: 'medium', fastMode: false };
  let baseline: string | null = JSON.stringify({ ...current, scopeId: 'legacy', pendingBotProfileVersion: 2 });
  const original = baseline;
  let deferred = true;
  let harnessPending = false;
  let effective = current;
  const apply = createBotModelRouteApplier({
    stage: async (_id, route) => {
      const profile: SessionRuntimeProfile = { ...route, effort: 'medium' };
      if (kind === 'same-engine') acceptSessionRuntimeMutation({ sessionId, source: 'agent', profile, deferred });
      else harnessPending = deferred;
      if (!deferred) effective = profile;
    },
    isIdle: () => !deferred,
    applyPendingSwitch: async () => {},
    hasPendingSwitch: () => harnessPending,
    onApplied: async () => { baseline = null; },
  });
  const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'owner',
    read: async () => ({ chain: [{ harness: kind === 'same-engine' ? 'codex' : 'pi',
      model: 'saved', providerId: 'xd', effort: 'medium', fastMode: false }],
      current: effective, hasRuntimeOverride: true, scheduledModelBaseline: baseline }),
    apply, onSelectionAccepted: async () => { baseline = null; },
  });
  try {
    await expect(reconcile(sessionId)).rejects.toThrow('Saved companion route is still pending');
    expect(baseline).toBe(original);
    // A failed safe-boundary apply cancels its pending mutation, not the saved
    // permanent choice. The next reconciliation must still be able to retry.
    const pending = getSessionRuntimeControlSnapshot(sessionId).pending;
    if (pending) cancelPendingSessionRuntimeMutation(sessionId, pending.generation);
    harnessPending = false;
    expect(effective.model).toBe('old');
    expect(baseline).toBe(original);
    deferred = false;
    await reconcile(sessionId);
    expect(effective.model).toBe('saved');
    expect(baseline).toBeNull();
  } finally {
    clearSessionRuntimeControlState(sessionId);
  }
});
