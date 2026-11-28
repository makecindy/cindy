/**
 * Test value (engineering-conventions §3.2)
 * Basis: P1-1 two-phase async worktree provisioning state machine (fast-path success/failure,
 * async yield, busy-queue immediate yield, failure lock retention + retry, delete/archive abort
 * & orphan cleanup, restart reconciliation + multi-owner isolation).
 * Coverage gap: new production entry createHandoffProvisioningService has no prior tests.
 * Minimal failing input: slow createWorktree crossing fastWaitMs, failing after async handoff,
 * cancelling mid-flight, or restarting with a persisted provisioning entry.
 * Tier: unit (temp dir for JSON store + fake timers; no real git or Electron).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHandoffProvisioningService,
  INTERRUPTED_PROVISIONING_MESSAGE,
  type HandoffProvisioningPorts,
} from '../handoffProvisioning.js';
import type { WorktreeMeta } from '../types.js';
import type { WorktreeProvisioningSnapshot } from '../../../shared/worktreeProvisioning.js';
import type { PrepareHandoffWorktreeResult } from '../../maker-ipc/handoffWorktree.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMeta(sessionId: string, worktreePath = `/repo/.cindy-worktrees/${sessionId}`): WorktreeMeta {
  return {
    sessionId,
    name: `wt-${sessionId}`,
    path: worktreePath,
    baseRepo: '/repo',
    branch: `cindy/wt-${sessionId}`,
    sourceBranch: 'origin/main',
    createdAt: '2026-11-28T00:00:00.000Z',
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createHarness(overrides: Partial<HandoffProvisioningPorts> = {}) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wt-prov-'));
  tempDirs.push(userDataDir);

  let ownerScope = 'owner-a:1';
  let ownerToken: object | null = { id: ownerScope };
  const locks = new Map<string, boolean>();
  const boundWorktrees = new Map<string, WorktreeMeta>();
  const queuedWorkdirs = new Map<string, string>();
  const discarded: Array<{ sessionId: string; path: string }> = [];
  const changes: Array<{ sessionId: string; snapshot: WorktreeProvisioningSnapshot | null }> = [];
  const lifecycles = new Map<string, { state: 'active' | 'terminal' | 'missing'; hasWorktreePath?: boolean }>();

  const ports: HandoffProvisioningPorts = {
    getUserDataDir: () => userDataDir,
    getOwnerScopeKey: () => ownerScope,
    captureOwnerToken: () => ownerToken,
    isOwnerTokenCurrent: (token) => token !== null && token === ownerToken,
    readSessionLifecycle: async (sessionId) => lifecycles.get(sessionId) ?? { state: 'active', hasWorktreePath: false },
    bindWorktreeToSession: async (sessionId, meta) => {
      boundWorktrees.set(sessionId, meta);
      lifecycles.set(sessionId, { state: 'active', hasWorktreePath: true });
    },
    updateQueuedWorkingDir: (sessionId, worktreePath) => {
      queuedWorkdirs.set(sessionId, worktreePath);
    },
    setProvisioningLock: (sessionId, locked) => {
      locks.set(sessionId, locked);
    },
    createWorktree: async ({ sessionId }) => ({ ok: true, sessionId, meta: makeMeta(sessionId) }),
    discardOrphanWorktree: async (sessionId, worktreePath) => {
      discarded.push({ sessionId, path: worktreePath });
    },
    isQueueBusy: async () => false,
    onChanged: (sessionId, snapshot) => {
      changes.push({ sessionId, snapshot });
    },
    fastWaitMs: 3_000,
    now: () => 1_700_000_000_000,
    ...overrides,
  };

  const service = createHandoffProvisioningService(ports);
  return {
    userDataDir,
    service,
    ports,
    locks,
    boundWorktrees,
    queuedWorkdirs,
    discarded,
    changes,
    lifecycles,
    switchOwner(nextScope: string) {
      ownerScope = nextScope;
      ownerToken = { id: nextScope };
      service.onOwnerChanged();
    },
  };
}

describe('handoffProvisioning', () => {
  it('completes fast-path success within threshold without emitting provisioning UI flicker', async () => {
    const h = await createHarness();
    const outcome = await h.service.beginProvisioning({
      sessionId: 's-fast',
      baseRepo: '/repo',
      workingDir: '/repo',
    });

    expect(outcome.state).toBe('ready');
    if (outcome.state !== 'ready') throw new Error('expected ready');
    expect(outcome.meta.path).toBe('/repo/.cindy-worktrees/s-fast');
    expect(h.boundWorktrees.get('s-fast')?.path).toBe('/repo/.cindy-worktrees/s-fast');
    expect(h.locks.get('s-fast')).toBe(false);
    expect(h.service.isBlocked('s-fast')).toBe(false);
    expect(h.changes).toEqual([]);
  });

  it('clears lock and state cleanly on fast-path failure so caller can roll back session row', async () => {
    const h = await createHarness({
      createWorktree: async () => ({ ok: false, message: 'branch conflict' }),
    });

    const outcome = await h.service.beginProvisioning({
      sessionId: 's-fast-fail',
      baseRepo: '/repo',
      workingDir: '/repo',
    });

    expect(outcome).toEqual({ state: 'failed', message: 'branch conflict' });
    expect(h.locks.get('s-fast-fail')).toBe(false);
    expect(h.service.isBlocked('s-fast-fail')).toBe(false);
    expect(h.service.listSnapshots()).toEqual([]);
  });

  it('hands off to background after fastWaitMs, keeps lock until bound, then updates DB/queue and unlocks', async () => {
    vi.useFakeTimers();
    const createGate = deferred<PrepareHandoffWorktreeResult>();
    const onWorktreeBound = vi.fn();

    const h = await createHarness({
      createWorktree: async ({ onNameSelected, onStageChange }) => {
        onNameSelected('eager-turing');
        onStageChange('creating');
        return createGate.promise;
      },
      onWorktreeBound,
    });

    const beginPromise = h.service.beginProvisioning({
      sessionId: 's-slow',
      baseRepo: '/repo',
      workingDir: '/repo',
    });
    await vi.advanceTimersByTimeAsync(3_000);
    const outcome = await beginPromise;

    expect(outcome.state).toBe('provisioning');
    expect(h.locks.get('s-slow')).toBe(true);
    expect(h.service.isBlocked('s-slow')).toBe(true);
    expect(h.service.getSnapshot('s-slow')).toMatchObject({
      sessionId: 's-slow',
      status: 'provisioning',
      name: 'eager-turing',
    });

    // Complete background worktree creation.
    const meta = makeMeta('s-slow', '/repo/.cindy-worktrees/eager-turing');
    createGate.resolve({ ok: true, sessionId: 's-slow', meta });
    await h.service.whenIdle('s-slow');

    expect(h.boundWorktrees.get('s-slow')).toEqual(meta);
    expect(h.queuedWorkdirs.get('s-slow')).toBe('/repo/.cindy-worktrees/eager-turing');
    expect(onWorktreeBound).toHaveBeenCalledWith('s-slow', meta);
    expect(h.locks.get('s-slow')).toBe(false);
    expect(h.service.isBlocked('s-slow')).toBe(false);
    expect(h.service.getSnapshot('s-slow')).toBeNull();
    expect(h.changes.at(-1)).toEqual({ sessionId: 's-slow', snapshot: null });
  });

  it('yields immediately into provisioning when queue is already busy', async () => {
    const createGate = deferred<PrepareHandoffWorktreeResult>();
    const h = await createHarness({
      isQueueBusy: async () => true,
      createWorktree: () => createGate.promise,
    });

    // Must resolve without advancing any timer (fastWaitMs bypassed to 0ms).
    const outcome = await h.service.beginProvisioning({
      sessionId: 's-busy',
      baseRepo: '/repo',
      workingDir: '/repo',
    });

    expect(outcome.state).toBe('provisioning');
    if (outcome.state !== 'provisioning') throw new Error('expected provisioning');
    expect(outcome.snapshot.stage).toBe('queued');
    expect(h.locks.get('s-busy')).toBe(true);

    createGate.resolve({ ok: true, sessionId: 's-busy', meta: makeMeta('s-busy') });
    await h.service.whenIdle('s-busy');
    expect(h.locks.get('s-busy')).toBe(false);
  });

  it('keeps lock held on async failure, redacts secrets, and binds & unlocks on explicit retry', async () => {
    const firstGate = deferred<PrepareHandoffWorktreeResult>();
    const secondGate = deferred<PrepareHandoffWorktreeResult>();
    let callCount = 0;

    const h = await createHarness({
      isQueueBusy: async () => true,
      createWorktree: () => {
        callCount += 1;
        return callCount === 1 ? firstGate.promise : secondGate.promise;
      },
    });

    const outcome = await h.service.beginProvisioning({
      sessionId: 's-fail',
      baseRepo: '/repo',
      workingDir: '/repo',
    });
    expect(outcome.state).toBe('provisioning');

    firstGate.resolve({
      ok: false,
      message: 'git multibox add failed: fatal token sk-ant-api03-secretvalue1234567890 in /Users/dash/secret/repo',
    });
    await h.service.whenIdle('s-fail');

    // Lock MUST stay held so queued messages never drain into baseRepo.
    expect(h.locks.get('s-fail')).toBe(true);
    expect(h.service.isBlocked('s-fail')).toBe(true);
    const failedSnap = h.service.getSnapshot('s-fail');
    expect(failedSnap?.status).toBe('failed');
    expect(failedSnap?.error).not.toContain('sk-ant-api03-secretvalue1234567890');
    expect(failedSnap?.error).not.toContain('/Users/dash');

    // Retry transitions back to provisioning and unlocks upon success.
    const retried = await h.service.retryProvisioning('s-fail');
    expect(retried.ok).toBe(true);
    expect(h.service.getSnapshot('s-fail')?.status).toBe('provisioning');
    expect(h.locks.get('s-fail')).toBe(true);

    secondGate.resolve({ ok: true, sessionId: 's-fail', meta: makeMeta('s-fail') });
    await h.service.whenIdle('s-fail');

    expect(h.locks.get('s-fail')).toBe(false);
    expect(h.service.isBlocked('s-fail')).toBe(false);
    expect(h.boundWorktrees.get('s-fail')?.path).toBe('/repo/.cindy-worktrees/s-fail');
  });

  it('aborts in-flight creation on cancel and discards orphan worktree if session became terminal', async () => {
    const signals: AbortSignal[] = [];
    const gate = deferred<PrepareHandoffWorktreeResult>();
    const h = await createHarness({
      isQueueBusy: async () => true,
      createWorktree: ({ signal }) => {
        signals.push(signal);
        return gate.promise;
      },
    });

    await h.service.beginProvisioning({
      sessionId: 's-cancel',
      baseRepo: '/repo',
      workingDir: '/repo',
    });
    expect(signals[0]?.aborted).toBe(false);

    h.service.cancelProvisioning('s-cancel');
    expect(signals[0]?.aborted).toBe(true);
    expect(h.locks.get('s-cancel')).toBe(false);
    expect(h.service.isBlocked('s-cancel')).toBe(false);

    // Even if git finishes concurrently with ok:true, orphan worktree must be discarded.
    gate.resolve({ ok: true, sessionId: 's-cancel', meta: makeMeta('s-cancel') });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.discarded).toEqual([
      { sessionId: 's-cancel', path: '/repo/.cindy-worktrees/s-cancel' },
    ]);
    expect(h.boundWorktrees.has('s-cancel')).toBe(false);

    // Second scenario: session marked terminal in DB right before worktree finishes.
    const gate2 = deferred<PrepareHandoffWorktreeResult>();
    const h2 = await createHarness({
      isQueueBusy: async () => true,
      createWorktree: () => gate2.promise,
    });
    await h2.service.beginProvisioning({
      sessionId: 's-archived',
      baseRepo: '/repo',
      workingDir: '/repo',
    });
    h2.lifecycles.set('s-archived', { state: 'terminal' });
    gate2.resolve({ ok: true, sessionId: 's-archived', meta: makeMeta('s-archived') });
    await h2.service.whenIdle('s-archived');

    expect(h2.discarded).toEqual([
      { sessionId: 's-archived', path: '/repo/.cindy-worktrees/s-archived' },
    ]);
    expect(h2.boundWorktrees.has('s-archived')).toBe(false);
    expect(h2.locks.get('s-archived')).toBe(false);
  });

  it('reconciles leftover provisioning entries after restart into failed+locked state and preserves foreign owners', async () => {
    const gate = deferred<PrepareHandoffWorktreeResult>();
    const h = await createHarness({
      isQueueBusy: async () => true,
      createWorktree: () => gate.promise,
    });

    await h.service.beginProvisioning({
      sessionId: 's-interrupted',
      baseRepo: '/repo',
      workingDir: '/repo',
    });

    // Simulate process restart with a fresh service instance reading the same userDataDir.
    const restartedLocks = new Map<string, boolean>();
    const ownerBToken = { id: 'owner-b:1' };
    const restartedOtherOwner = createHandoffProvisioningService({
      ...h.ports,
      getOwnerScopeKey: () => 'owner-b:1',
      captureOwnerToken: () => ownerBToken,
      isOwnerTokenCurrent: (t) => t === ownerBToken,
      setProvisioningLock: (sid, locked) => restartedLocks.set(sid, locked),
    });
    await restartedOtherOwner.reconcileForCurrentOwner();
    // Foreign owner must not see or delete owner-a's entry.
    expect(restartedOtherOwner.listSnapshots()).toEqual([]);

    const ownerAToken = { id: 'owner-a:1' };
    const restartedSameOwner = createHandoffProvisioningService({
      ...h.ports,
      getOwnerScopeKey: () => 'owner-a:1',
      captureOwnerToken: () => ownerAToken,
      isOwnerTokenCurrent: (t) => t === ownerAToken,
      setProvisioningLock: (sid, locked) => restartedLocks.set(sid, locked),
    });
    await restartedSameOwner.reconcileForCurrentOwner();

    const snap = restartedSameOwner.getSnapshot('s-interrupted');
    expect(snap).toMatchObject({
      sessionId: 's-interrupted',
      status: 'failed',
      interruptedOnRestart: true,
      error: INTERRUPTED_PROVISIONING_MESSAGE,
    });
    expect(restartedLocks.get('s-interrupted')).toBe(true);
    expect(restartedSameOwner.isBlocked('s-interrupted')).toBe(true);

    // Clean up gate from first harness.
    h.service.cancelProvisioning('s-interrupted');
    gate.resolve({ ok: false, message: 'aborted' });
  });
});
