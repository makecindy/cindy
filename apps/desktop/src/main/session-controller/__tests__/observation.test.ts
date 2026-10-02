import { describe, expect, it, vi } from 'vitest';
import { projectSessionActivity } from '@cindy/maker-shared/session-activity';
import { diagnoseSessionSnapshot, isObservedActiveSession } from '@cindy/maker-shared/session-controller';
import { createSessionObservationService, type SessionObservationDeps } from '../observation.js';
import type { SessionOperationScope } from '../controller.js';

function fixture() {
  const state = { owner: 'owner-1', generation: 1, instance: 'instance-1', loaded: true };
  const runtime = { get instanceId() { return state.instance; }, getTurnGeneration: () => state.generation,
    isTurnRunning: () => true, getWatchdogObservation: () => ({ state: 'pending-interaction', timeoutMs: 100,
      remainingMs: 80, pendingInteractions: 1, terminalErrorDraining: false }) };
  const profile = { agentKind: 'codex' as const, model: 'test-model', providerId: 'test', effort: 'medium' as const, fastMode: false };
  const deps: SessionObservationDeps = {
    deviceId: () => 'device-a', ownerEpoch: () => state.owner, now: () => 1000,
    getRuntime: () => state.loaded ? runtime : null,
    listRuntimeIds: () => state.loaded ? ['task'] : [],
    readActivity: async id => projectSessionActivity({ sessionId: id, running: true, source: 'live', recordStatus: 'active' }),
    readRemoteHostId: async () => 'ssh-host',
    readSelection: async () => ({ generation: 1, baseline: profile, effective: profile, pending: null, appliesAt: null }),
    readQueue: async () => ({ paused: false, pendingCount: 0, restoring: false }),
    readInteractions: () => [], capabilities: async () => [{ operation: 'requestStop', supported: true }],
  };
  const scope: SessionOperationScope = { assertCurrent: vi.fn(), authorize: vi.fn(async () => {}), allows: async () => true };
  return { state, deps, scope, read: () => createSessionObservationService(deps).inspect(scope, 'task') };
}

describe('Session observations', () => {
  it('keeps durable record status distinct from a live turn', async () => {
    const f = fixture();
    f.deps.readActivity = async id => projectSessionActivity({ sessionId: id, recordStatus: 'archived', terminal: 'error', running: true });
    const result = await f.read();
    expect(result.activity.recordStatus).toBe('archived');
    expect(result.activity.phase).toBe('error');
    expect(isObservedActiveSession(result)).toBe(true);
  });
  it('marks a replacement with the same generation stale', async () => {
    const f = fixture();
    f.deps.readQueue = async () => { f.state.instance = 'replacement'; return { paused: false, pendingCount: 0, restoring: false }; };
    const result = await f.read();
    expect(result.freshness).toBe('stale');
    expect(isObservedActiveSession(result)).toBe(false);
    expect(diagnoseSessionSnapshot(result, null, [{ operation: 'send', supported: true }]).availableControls).toEqual([]);
  });
  it('rejects account changes during a slow read', async () => {
    const f = fixture();
    f.deps.readQueue = async () => { f.state.owner = 'owner-2'; return { paused: false, pendingCount: 0, restoring: false }; };
    await expect(f.read()).rejects.toMatchObject({ code: 'OWNER_SCOPE_CHANGED' });
  });
  it('keeps cold records cold and does not claim an active runtime', async () => {
    const f = fixture(); f.state.loaded = false;
    const result = await f.read();
    expect(result.runtimeLoaded).toBe(false);
    expect(result.remoteHostId).toBe('ssh-host');
    expect(result.execution).toBeNull();
    expect(result.activity.currentTurnActive).toBe(false);
  });
  it('projects existing watchdog and denies ungranted recovery suggestions', async () => {
    const f = fixture(); f.scope.allows = async () => false;
    const result = await createSessionObservationService(f.deps).diagnose(f.scope, 'task');
    expect(result.watchdog?.state).toBe('pending-interaction');
    expect(result.conditions).toContain('watchdog-suspended');
    expect(result.availableControls).toEqual([]);
  });
  it('never promotes an offline last observation to currently running', async () => {
    const snapshot = { ...await fixture().read(), connection: 'offline' as const, freshness: 'stale' as const };
    expect(isObservedActiveSession(snapshot)).toBe(false);
    const diagnosis = diagnoseSessionSnapshot(snapshot, null, [{ operation: 'send', supported: true }]);
    expect(diagnosis.conditions).toContain('offline');
    expect(diagnosis.conditions).not.toContain('active-turn');
    expect(diagnosis.availableControls).toEqual([]);
  });
  it('separates sleep, confirmed turn stall, recovery and ordinary terminal error without actions', async () => {
    const current = await fixture().read();
    const base = { state: 'armed', timeoutMs: 100, remainingMs: 50, pendingInteractions: 0, terminalErrorDraining: false };
    expect(diagnoseSessionSnapshot(current, { ...base, suspendGapObserved: true }, []).conditions).toContain('sleep-gap');
    const failed = { ...current, activity: { ...current.activity, phase: 'error' as const } };
    const stalled = diagnoseSessionSnapshot(failed, { ...base, terminalReason: 'turn_no_event_timeout', recovering: true }, []);
    expect(stalled.conditions).toEqual(expect.arrayContaining(['turn-stalled', 'recovering']));
    expect(stalled.conditions).not.toContain('idle'); expect(stalled.availableControls).toEqual([]);
    expect(diagnoseSessionSnapshot(failed, base, []).conditions).toContain('terminal-error');
  });
  it('lists only authorized live instances and rechecks each target after reading', async () => {
    const f = fixture();
    f.deps.listRuntimeIds = () => ['hidden', 'task'];
    f.scope.allows = vi.fn(async (_operation, ids) => ids?.[0] === 'task');
    const result = await createSessionObservationService(f.deps).listActive(f.scope);
    expect(result.map(snapshot => snapshot.target.sessionId)).toEqual(['task']);
    expect(f.scope.allows).toHaveBeenCalledTimes(3);
  });
  it('does not publish an instance replaced during the list read', async () => {
    const f = fixture();
    f.deps.readQueue = async () => { f.state.instance = 'new'; return { paused: false, pendingCount: 0, restoring: false }; };
    expect(await createSessionObservationService(f.deps).listActive(f.scope)).toEqual([]);
  });
});
