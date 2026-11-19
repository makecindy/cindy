import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { shouldPreserveRuntimeFallbackAutoResume } from '../maker-ipc/interruptedTurnAutoResume';
import { modelGroupCandidateKey, type ModelGroupCandidate } from '../../shared/modelGroups';
import { computeModelGroupSwitchOffer } from '../model-groups/switchOffer';
import { createPendingAgentSwitchRegistry } from '../maker-ipc/sessionAgentSwitchHandler';

const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
// canApplyAutomaticRuntimeSelection is in sessionRuntimeSelectionLanding.ts (register.ts calls its factory
// where it defined it); its port and import keep the names injected below.
const landingSource = readFileSync(new URL('../maker-ipc/sessionRuntimeSelectionLanding.ts', import.meta.url), 'utf8')
  .replace(/\r\n?/g, '\n');
const guard = landingSource.slice(
  landingSource.indexOf('  const canApplyAutomaticRuntimeSelection ='),
  landingSource.indexOf('  return canApplyAutomaticRuntimeSelection;'),
);
// The fallback body is in sessionRuntimeFallback.ts; its ports and imports keep the names injected below.
// A Windows checkout has CRLF line endings; the slice below finds multi-line markers.
const fallbackSource = readFileSync(new URL('../maker-ipc/sessionRuntimeFallback.ts', import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
const fallbackBodyStart = fallbackSource.indexOf('  return async (\n    sessionId: string,') + '  return '.length;
const fallback = `const maybeApplySessionRuntimeFallback = ${fallbackSource.slice(fallbackBodyStart, fallbackSource.lastIndexOf('\n}'))}`;

function harness() {
  const pending = createPendingAgentSwitchRegistry();
  let generation = 0;
  const current = { agentDeviceId: null as string | null, agentKind: 'codex', model: 'current', providerId: 'openai', effort: 'high', fastMode: false };
  const candidate = { ...current, agentKind: 'claude-code', model: 'fallback' };
  const readCandidate = vi.fn(async (): Promise<{ isBot: boolean; candidate: typeof candidate | null; routeLocked?: boolean }> => ({ isBot: true, candidate }));
  const switchAgent = vi.fn(async () => ({ switched: true, engineReady: true }));
  const accept = vi.fn();
  const withLock = vi.fn(async (_id: string, task: () => Promise<unknown>) => task());
  const apply = vi.fn(async (_id: string, _model: string): Promise<{ deferred: boolean; superseded: boolean; generation?: number; persistedRoute?: true; contextWindowConfirmationRequired?: number }> => ({ deferred: false, superseded: false }));
  const cancel = vi.fn(() => true);
  const clearCredential = vi.fn();
  const pendingCredential = vi.fn(() => ({ model: 'next', providerId: 'openai' }));
  const failed = vi.fn(() => true);
  const readSessionAgentDeviceId = vi.fn<(sessionId: string) => Promise<string | null>>(async () => null);
  const query = { from: () => query, where: () => query, limit: async () => [{ status: 'active' }] };
  const groupCandidate = vi.fn(async (): Promise<{ candidate: typeof candidate; bindCommittedRoute?: (profile: typeof candidate) => void } | null> => null);
  const deps = {
    agentSwitchPending: pending,
    sessionRuntimeGenerationMatches: (_id: string, expected?: number) => expected === undefined || expected === generation,
    captureSessionRuntimeControlOwnerEpoch: () => 'owner',
    sessionRuntimeControlOwnerEpochMatches: () => true,
    readSessionRuntimeProfiles: async () => ({ effective: current, control: { generation, pending: null } }),
    hasExplicitSessionTaskModel: async () => false,
    readBotFallbackCandidate: readCandidate,
    readSessionRuntimeFallbackSettings: () => ({ enabled: true }),
    readModelGroupFallbackCandidate: groupCandidate,
    maker: { getSession: () => current },
    pendingSessionRuntimeFallbackRebuilds: new WeakMap(),
    withSendToSessionLock: withLock,
    performSessionAgentSwitch: switchAgent,
    agentSwitchDeps: {},
    acceptSessionRuntimeMutation: accept,
    applySessionRuntimeSelection: apply,
    cancelPendingSessionRuntimeMutation: cancel,
    getPendingCredentialSwitchTarget: pendingCredential,
    clearPendingCredentialSwitchForSession: clearCredential,
    broadcastSessionRuntimeProjection: vi.fn(async () => {}),
    recordFailedSessionRuntimeFallbackCandidate: failed,
    readSessionAgentDeviceId,
    getDbClient: () => ({ drizzle: { select: () => query } }),
    sessions: { status: 'status', id: 'id' }, eq: vi.fn(),
    runtimeSelectionRequiresModelWindowConfirmation: (result: { contextWindowConfirmationRequired?: number }) => result.contextWindowConfirmationRequired !== undefined,
    isRemoteModelSwitchRouteChangeError: () => false,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const js = transpileModule(`${guard}\n${fallback}\nreturn { run: maybeApplySessionRuntimeFallback, allowed: canApplyAutomaticRuntimeSelection };`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const runtime = new Function(...Object.keys(deps), js)(...Object.values(deps));
  const pick = () => {
    pending.set('session', { sameAgentSelection: true, targetAgentKind: 'codex', model: 'chosen', providerId: 'xd' });
    generation += 1;
  };
  return { run: runtime.run, allowed: runtime.allowed, pending, pick, groupCandidate, readCandidate, switchAgent, accept, withLock, apply, cancel, clearCredential, pendingCredential, failed, readSessionAgentDeviceId, current, candidate, generation: () => generation };
}

describe('automatic runtime selection respects the user send boundary', () => {
  it('never replaces the route of an ordinary task whose agent runs on another computer with a local candidate', async () => {
    const h = harness();
    h.readSessionAgentDeviceId.mockResolvedValue('device-b');
    h.readCandidate.mockResolvedValue({ isBot: false, candidate: null });
    expect(await h.run('session', 1, 1, true)).toMatchObject({ session: null, outcome: 'exhausted' });
    expect(await h.run('session', 1, 1, false)).toMatchObject({ session: null, outcome: 'unchanged' });
    expect(h.readCandidate).toHaveBeenCalledTimes(2);
    expect(h.switchAgent).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('keeps a non-group input on the ordinary recovery path even in a bound task', async () => {
    const h = harness();
    h.readCandidate.mockResolvedValue({ isBot: false, candidate: null });
    expect(await h.run('session', 1, 1)).toMatchObject({ outcome: 'unchanged' });
    expect(h.groupCandidate).not.toHaveBeenCalled();
  });

  // Unit: a group supplies the next model to the existing session transaction.
  it.each([false, true])('uses the session switch for a group candidate (cross-harness=%s)', async crossHarness => {
    const h = harness();
    h.readCandidate.mockResolvedValue({ isBot: false, candidate: null });
    const bindCommittedRoute = vi.fn();
    h.groupCandidate.mockResolvedValue({ bindCommittedRoute, candidate: crossHarness ? h.candidate : { ...h.current, model: 'second' } });
    expect(await h.run('session', 1, 1, true, undefined, { accountUnavailable: false, hasImages: false })).toMatchObject({ outcome: 'switched' });
    expect(h.switchAgent).toHaveBeenCalledTimes(crossHarness ? 1 : 0);
    expect(h.apply).toHaveBeenCalledTimes(crossHarness ? 0 : 1);
    expect(bindCommittedRoute).toHaveBeenCalledTimes(crossHarness ? 1 : 0);
  });

  // Unit, model-groups §6.1: after two failed connections the automatic and banner
  // pickers must still see C, even when Pi persisted B over the original session row.
  it('keeps the manual offer and the next automatic hop after persisting a same-harness switch', async () => {
    const h = harness();
    const candidates: ModelGroupCandidate[] = ['A', 'B', 'C'].map(id => ({
      agentKind: 'pi', providerId: id, model: id,
    }));
    const selection = { type: 'route' as const, id: 'group' };
    let row = candidates[0];
    let pickedKey = modelGroupCandidateKey(row);
    const unavailable = new Set<string>();
    const visited = new Set<string>();
    const deps = {
      readBinding: () => ({ selection, pickedKey, at: 1 }),
      readSession: async () => ({ ...row, source: 'desktop' }),
      isShared: () => false, hasGoal: async () => false, now: () => 1,
      config: () => ({ routes: [{ id: 'group', name: 'group', strategy: 'order' as const, candidates }] }),
      candidateFacts: async () => candidates.map(c => ({
        available: !unavailable.has(c.providerId), modelName: c.model, sourceName: c.providerId, windows: null,
      })),
    };
    h.readCandidate.mockResolvedValue({ isBot: false, candidate: null });
    h.groupCandidate.mockImplementation(async () => {
      if (pickedKey !== modelGroupCandidateKey(row)) return null;
      const offer = await computeModelGroupSwitchOffer(deps, 'session', {
        current: row, visited, accountUnavailable: true,
        recordUnavailable: c => visited.add(modelGroupCandidateKey(c)),
      });
      if (!offer) return null;
      const next = candidates.find(c => c.model === offer.model)!;
      return {
        candidate: { ...h.current, ...next, agentDeviceId: null },
        bindCommittedRoute: (profile) => {
          pickedKey = modelGroupCandidateKey({ agentKind: 'pi', model: profile.model, providerId: profile.providerId });
        },
      };
    });
    const failAndSwitch = async (from: number) => {
      Object.assign(h.current, row);
      unavailable.add(row.providerId);
      h.apply.mockImplementationOnce(async (_id, model) => {
        row = candidates.find(c => c.model === model)!;
        return { deferred: false, superseded: false, persistedRoute: true };
      });
      return h.run('session', from + 1, from + 1, true, undefined, { accountUnavailable: true, hasImages: false });
    };
    expect(await failAndSwitch(0)).toMatchObject({ outcome: 'switched' });
    expect(await computeModelGroupSwitchOffer(deps, 'session')).toMatchObject({ model: 'C' });
    expect(await failAndSwitch(1)).toMatchObject({ outcome: 'switched' });
    expect(h.apply.mock.calls.map(([, model]) => model)).toEqual(['B', 'C']);
    expect(pickedKey).toBe(modelGroupCandidateKey(candidates[2]));
  });

  // Unit: the ordered group must continue when B fails before the switch commits.
  it('tries C after a rejected B and binds only the committed harness', async () => {
    const h = harness();
    const bindCommittedRoute = vi.fn();
    const third = { ...h.candidate, model: 'third' };
    h.readCandidate.mockResolvedValue({ isBot: false, candidate: null });
    h.groupCandidate.mockResolvedValueOnce({ candidate: h.candidate, bindCommittedRoute })
      .mockResolvedValueOnce({ candidate: third, bindCommittedRoute });
    h.switchAgent.mockResolvedValueOnce({ switched: false, engineReady: false });
    expect(await h.run('session', 1, 1, true, undefined, { accountUnavailable: false, hasImages: false })).toMatchObject({ outcome: 'switched' });
    expect(h.failed).toHaveBeenCalledWith('session', 0, h.candidate);
    expect(bindCommittedRoute.mock.calls).toEqual([[third]]);
  });

  it('stops after a committed harness switch whose engine failed to start', async () => {
    const h = harness();
    h.switchAgent.mockResolvedValue({ switched: true, engineReady: false });
    expect(await h.run('session', 1, 1, true)).toMatchObject({ outcome: 'failed' });
    expect(h.accept).toHaveBeenCalledWith(expect.objectContaining({ profile: h.candidate }));
    expect(h.readCandidate).toHaveBeenCalledOnce();
    expect(h.failed).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('reports chain exhaustion distinctly from a switched runtime', async () => {
    const h = harness();
    h.readCandidate.mockResolvedValue({ isBot: true, candidate: null });
    expect(await h.run('session', 1, 1, true)).toMatchObject({ outcome: 'exhausted' });
    expect(h.switchAgent).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('reports a Bot without any other route as unchanged, not exhausted', async () => {
    const h = harness();
    h.readCandidate.mockResolvedValue({ isBot: true, candidate: null, routeLocked: true });
    expect(await h.run('session', 1, 1, true)).toMatchObject({ session: null, outcome: 'unchanged' });
    expect(h.switchAgent).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('skips a failed candidate once and reaches the next configured route', async () => {
    const h = harness();
    const next = { ...h.candidate, model: 'next', providerId: 'other' };
    h.readCandidate.mockResolvedValueOnce({ isBot: true, candidate: h.candidate })
      .mockResolvedValue({ isBot: true, candidate: next });
    h.switchAgent.mockRejectedValueOnce(new Error('Failed to start agent'));
    expect(await h.run('session', 1, 1, true)).toMatchObject({ outcome: 'switched' });
    expect(h.failed).toHaveBeenCalledWith('session', 0, h.candidate);
    expect(h.switchAgent).toHaveBeenCalledTimes(2);
    expect(h.accept).toHaveBeenCalledWith(expect.objectContaining({ profile: next }));
    expect(h.pending.get('session')).toBeUndefined();
  });

  it('returns a failed result when the last candidate cannot start', async () => {
    const h = harness();
    h.readCandidate.mockResolvedValueOnce({ isBot: true, candidate: h.candidate })
      .mockResolvedValue({ isBot: true, candidate: null });
    h.switchAgent.mockRejectedValue(new Error('Failed to start agent'));
    expect(await h.run('session', 1, 1, true)).toMatchObject({ outcome: 'failed' });
    expect(h.switchAgent).toHaveBeenCalledOnce();
    expect(h.pending.get('session')).toBeUndefined();
  });

  it('does not claim a superseded same-harness selection succeeded', async () => {
    const h = harness();
    h.readCandidate.mockResolvedValue({ isBot: true, candidate: { ...h.current, model: 'next' } });
    h.apply.mockResolvedValue({ deferred: false, superseded: true });
    expect(await h.run('session', 1, 1, true)).toMatchObject({ outcome: 'superseded' });
    expect(h.apply).toHaveBeenCalledWith('session', 'next', 'openai', expect.anything(),
      expect.objectContaining({ source: 'fallback', sessionLockHeld: true }));
  });

  it('withdraws its own deferred fallback instead of sending through a pending route', async () => {
    const h = harness();
    h.readCandidate.mockResolvedValue({ isBot: true, candidate: { ...h.current, model: 'next' } });
    h.apply.mockResolvedValue({ deferred: true, superseded: false, generation: 1 });
    expect(await h.run('session', 1, 1, true)).toMatchObject({ outcome: 'failed' });
    expect(h.cancel).toHaveBeenCalledWith('session', 1);
    expect(h.clearCredential).toHaveBeenCalledWith('session', { wake: false });
  });

  it('does not clear a newer credential intent when deferred fallback was superseded', async () => {
    const h = harness();
    h.readCandidate.mockResolvedValue({ isBot: true, candidate: { ...h.current, model: 'next' } });
    h.apply.mockResolvedValue({ deferred: true, superseded: false, generation: 1 });
    h.cancel.mockReturnValue(false);
    expect(await h.run('session', 1, 1, true)).toMatchObject({ outcome: 'failed' });
    expect(h.clearCredential).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after the same-harness route lock is acquired', async () => {
    const h = harness();
    let current = true;
    h.readCandidate.mockResolvedValue({ isBot: true, candidate: { ...h.current, model: 'next' } });
    h.withLock.mockImplementationOnce(async (_id: string, run: () => Promise<unknown>) => { current = false; return run(); });
    expect(await h.run('session', 1, 1, true, () => current)).toMatchObject({ outcome: 'superseded' });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('rejects a new automatic request even when it read the generation after the user selected', async () => {
    const h = harness();
    h.pick();
    expect(h.allowed('session', h.generation())).toBe(false);
    await h.run('session', 2, 1);
    expect(h.readCandidate).not.toHaveBeenCalled();
    expect(h.pending.get('session')?.model).toBe('chosen');
  });

  it('rechecks a user selection that arrived while fallback waited for the route lock', async () => {
    const h = harness();
    h.withLock.mockImplementationOnce(async (_id: string, task: () => Promise<unknown>) => {
      h.pick();
      return task();
    });
    await h.run('session', 2, 1);
    expect(h.switchAgent).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.pending.get('session')?.model).toBe('chosen');
  });

  it('rejects stale work after the user selection has been cleared', () => {
    const h = harness();
    const observed = h.generation();
    h.pick();
    h.pending.clear('session');
    expect(h.allowed('session', observed)).toBe(false);
    expect(h.allowed('session', h.generation())).toBe(true);
  });

  it('retains a selection accepted before candidate lookup fails', async () => {
    const h = harness();
    h.readCandidate.mockImplementationOnce(async () => {
      h.pick();
      throw new Error('candidate lookup failed');
    });
    await h.run('session', 2, 1);
    expect(h.switchAgent).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.pending.get('session')?.model).toBe('chosen');
  });

  it('commits an uncontested fallback inside the existing route lock', async () => {
    const h = harness();
    h.withLock.mockImplementationOnce(async (_id: string, task: () => Promise<unknown>) => {
      const result = await task();
      expect(h.accept).toHaveBeenCalledTimes(1);
      return result;
    });
    await h.run('session', 2, 1);
    expect(h.switchAgent).toHaveBeenCalledTimes(1);
    h.pick();
    expect(h.pending.get('session')?.model).toBe('chosen');
  });

});

it.each(['device-b', 'share:one'])('applies a same-engine fallback at %s without a no-op agent switch', async agentDeviceId => {
  const h = harness();
  h.current.agentDeviceId = agentDeviceId;
  h.readSessionAgentDeviceId.mockResolvedValue(agentDeviceId);
  h.readCandidate.mockResolvedValue({ isBot: true, candidate: { ...h.current, model: 'next', providerId: 'other' } });
  expect(await h.run('session', 1, 1, true)).toMatchObject({ outcome: 'switched' });
  expect(h.switchAgent).not.toHaveBeenCalled();
  expect(h.apply).toHaveBeenCalledWith('session', 'next', 'other', expect.anything(),
    expect.objectContaining({ source: 'fallback', sessionLockHeld: true }));
  expect(h.failed).not.toHaveBeenCalled();
});

// Execute the production close predicate: the old Session is a lease for one
// scheduled recovery attempt, even when the replacement uses another harness.
const preserveFallback = source.slice(
  source.indexOf('function shouldPreserveSessionRuntimeFallbackAutoResume('),
  source.indexOf('export function stopActiveGoalTurnForClear('),
);
const preserveFallbackJs = transpileModule(`${preserveFallback}\nreturn shouldPreserveSessionRuntimeFallbackAutoResume;`, {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

function closeHarness() {
  const session = { id: 'session' };
  const leases = new WeakMap<object, number>([[session, 7]]);
  const guard = vi.fn(() => true);
  const bookkeeping = vi.fn(() => true);
  const pending = vi.fn(() => true);
  const token = vi.fn(() => 7);
  const scheduled = vi.fn(() => true);
  const deps = {
    shouldPreserveRuntimeFallbackAutoResume,
    pendingSessionRuntimeFallbackRebuilds: leases,
    interruptedTurnAutoResumeGuard: { isCurrentAttempt: guard },
    autoResumeBookkeeping: { isCurrentAttempt: bookkeeping, hasLiveSchedule: scheduled },
    agentInputCoordinatorHolder: { isAutoResumePending: pending, getAutoResumeAttemptToken: token },
  };
  const preserve = new Function(...Object.keys(deps), preserveFallbackJs)(...Object.values(deps));
  return { session, leases, guard, bookkeeping, pending, token, scheduled, preserve };
}

describe('runtime fallback close handoff', () => {
  it.each(['requested', 'runtime-refresh', 'agent-switch'])('preserves the active attempt during %s', (reason) => {
    const h = closeHarness();
    expect(h.preserve(h.session, reason)).toBe(true);
    expect(h.guard).toHaveBeenCalledWith('session', 7);
    expect(h.bookkeeping).toHaveBeenCalledWith('session', 7);
  });

  it('does not transfer a lease to another Session with the same id', () => {
    const h = closeHarness();
    expect(h.preserve({ id: h.session.id }, 'agent-switch')).toBe(false);
  });

  it.each(['unexpected', 'deleted'])('does not preserve unrelated close reason %s', (reason) => {
    const h = closeHarness();
    expect(h.preserve(h.session, reason)).toBe(false);
  });

  it.each(['guard', 'bookkeeping', 'pending', 'scheduled'] as const)('does not revive recovery after %s was cleared', (field) => {
    const h = closeHarness();
    h[field].mockReturnValue(false);
    expect(h.preserve(h.session, 'agent-switch')).toBe(false);
  });

  it('does not preserve an attempt replaced by a newer input', () => {
    const h = closeHarness();
    h.token.mockReturnValue(8);
    expect(h.preserve(h.session, 'agent-switch')).toBe(false);
  });
});
