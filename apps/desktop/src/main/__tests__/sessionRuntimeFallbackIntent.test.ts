import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createPendingAgentSwitchRegistry } from '../maker-ipc/sessionAgentSwitchHandler';

const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
const guard = source.slice(
  source.indexOf('  const canApplyAutomaticRuntimeSelection ='),
  source.indexOf('  cancelPendingAgentSwitchHolder ='),
);
const fallback = source.slice(
  source.indexOf('  const maybeApplySessionRuntimeFallback = async ('),
  source.indexOf('  const sessionControlService = createSessionControlService({'),
);

function harness() {
  const pending = createPendingAgentSwitchRegistry();
  let generation = 0;
  const current = { agentKind: 'codex', model: 'current', providerId: 'openai', effort: 'high', fastMode: false };
  const candidate = { ...current, agentKind: 'claude-code', model: 'fallback' };
  const readCandidate = vi.fn(async (): Promise<{ isBot: boolean; candidate: typeof candidate | null }> => ({ isBot: true, candidate }));
  const switchAgent = vi.fn(async () => ({ switched: true, engineReady: true }));
  const accept = vi.fn();
  const withLock = vi.fn(async (_id: string, task: () => Promise<unknown>) => task());
  const apply = vi.fn(async (): Promise<{ deferred: boolean; superseded: boolean; generation?: number; contextWindowConfirmationRequired?: number }> => ({ deferred: false, superseded: false }));
  const cancel = vi.fn(() => true);
  const clearCredential = vi.fn();
  const pendingCredential = vi.fn(() => ({ model: 'next', providerId: 'openai' }));
  const failed = vi.fn(() => true);
  const query = { from: () => query, where: () => query, limit: async () => [{ status: 'active' }] };
  const deps = {
    agentSwitchPending: pending,
    sessionRuntimeGenerationMatches: (_id: string, expected?: number) => expected === undefined || expected === generation,
    captureSessionRuntimeControlOwnerEpoch: () => 'owner',
    sessionRuntimeControlOwnerEpochMatches: () => true,
    readSessionRuntimeProfiles: async () => ({ effective: current, control: { generation, pending: null } }),
    readBotFallbackCandidate: readCandidate,
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
  return { ...runtime, pending, pick, readCandidate, switchAgent, accept, withLock, apply, cancel, clearCredential, pendingCredential, failed, current, candidate, generation: () => generation };
}

describe('automatic runtime selection respects the user send boundary', () => {
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

  it('uses the same guard before every automatic same-engine mutation can write or reconcile', () => {
    const start = source.indexOf('  const handleSetModel = async (');
    const body = source.slice(start, source.indexOf('      const routeExplicit =', start));
    expect(body).toMatch(/internalOptions.source !== 'user' &&\s*!canApplyAutomaticRuntimeSelection\(sessionId, internalOptions.expectedGeneration\)/);
    expect(body).toContain('return { deferred: false, superseded: true };');
  });
});
