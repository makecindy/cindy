import { describe, expect, it, vi } from 'vitest';

import { mergeInteractionTakeoverEntriesByArrival, PermissionQueue } from '../register.js';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

function allow(): InteractionDecision {
  return { kind: 'permission', behavior: 'allow' };
}
function deny(reason = 'denied'): InteractionDecision {
  return { kind: 'permission', behavior: 'deny', reason };
}
function permissionRequest(requestId: string): Extract<InteractionRequest, { kind: 'permission' }> {
  return { kind: 'permission', requestId, toolName: 'Bash', input: {} };
}

describe('PermissionQueue (issue #3092)', () => {
  it('merges displayed and queued interactions by original arrival order', () => {
    const entry = (requestId: string, arrivalSequence: number) => ({
      requestId,
      arrivalSequence,
    });

    expect(
      mergeInteractionTakeoverEntriesByArrival(
        [entry('permission-a', 1), entry('ask-c', 3)],
        [entry('permission-b', 2)],
      ).map((candidate) => candidate.requestId),
    ).toEqual(['permission-a', 'permission-b', 'ask-c']);
  });

  it('runs two permission requests sequentially, not in parallel', async () => {
    // The renderer has a single pending-permission slot, so two parallel
    // permission requests must NOT be broadcast concurrently. This is the
    // root cause of #3092: the second broadcast overwrote the first slot
    // and the first canUseTool Promise hung for the 10-minute timeout.
    const queue = new PermissionQueue();
    let firstStarted = false;
    let firstFinished = false;
    let secondStartedBeforeFirstFinished = false;

    const first = queue.dispatch(async () => {
      firstStarted = true;
      // Simulate an async wait for the user to resolve the card.
      await new Promise((r) => setTimeout(r, 30));
      firstFinished = true;
      return allow();
    });
    // Schedule the second immediately — before the first resolves.
    const second = queue.dispatch(async () => {
      if (!firstFinished) secondStartedBeforeFirstFinished = true;
      return allow();
    });

    await Promise.all([first, second]);

    expect(firstStarted).toBe(true);
    expect(firstFinished).toBe(true);
    expect(secondStartedBeforeFirstFinished).toBe(false);
  });

  it('resolves the second with its own decision after the first', async () => {
    const queue = new PermissionQueue();
    const decisions: Array<'allow' | 'deny'> = [];
    const first = queue.dispatch(async () => {
      decisions.push('allow');
      return allow();
    });
    const second = queue.dispatch(async () => {
      decisions.push('deny');
      return deny();
    });

    const [firstDecision, secondDecision] = await Promise.all([first, second]);

    // Both runs return permission decisions (kind discriminator narrows the
    // InteractionDecision union so .behavior is accessible without a cast).
    expect(firstDecision.kind).toBe('permission');
    expect(secondDecision.kind).toBe('permission');
    if (firstDecision.kind === 'permission') {
      expect(firstDecision.behavior).toBe('allow');
    }
    if (secondDecision.kind === 'permission') {
      expect(secondDecision.behavior).toBe('deny');
    }
    // Ordering must be preserved: each run is queued behind the previous.
    expect(decisions).toEqual(['allow', 'deny']);
  });

  it('does not wedge the queue when a run rejects', async () => {
    // A throwing handler (e.g. broadcast failed) must not poison the chain
    // so subsequent permissions can still run. The rejected promise itself
    // propagates, but the chain recovers.
    const queue = new PermissionQueue();
    const rejected = queue.dispatch(async () => {
      throw new Error('broadcast failed');
    });
    await expect(rejected).rejects.toThrow('broadcast failed');

    const after = queue.dispatch(async () => allow());
    const afterDecision = await after;
    expect(afterDecision.kind).toBe('permission');
    if (afterDecision.kind === 'permission') {
      expect(afterDecision.behavior).toBe('allow');
    }
  });

  it('never invokes a run before the previous one settles even under microtask bursts', async () => {
    // Stress test: queue N synchronous dispatches and assert that only one
    // run body is ever in-flight at a time.
    const queue = new PermissionQueue();
    const N = 10;
    let inFlight = 0;
    let maxInFlight = 0;
    const violations: number[] = [];

    const runs = Array.from({ length: N }, (_, i) =>
      queue.dispatch(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight > 1) violations.push(i);
        // Yield several times so any racing dispatch has a chance to start.
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return allow();
      }),
    );

    await Promise.all(runs);
    expect(violations).toEqual([]);
    expect(maxInFlight).toBe(1);
  });

  it('cancels queued-but-not-started runs without invoking them (session close)', async () => {
    // When a session closes while A is in-flight and B is queued behind it,
    // cancel() must settle B immediately with the terminal decision and NOT
    // run B's broadcast after A settles — otherwise the closed session gets
    // a phantom permission card that hangs for 10 minutes (issue #3092
    // review P1).
    const queue = new PermissionQueue();
    let aReleased: ((() => void) | null) | undefined;
    let bRan = false;
    let cRan = false;

    const a = queue.dispatch(
      () =>
        new Promise((resolve) => {
          aReleased = () => resolve(allow());
        }),
    );
    const b = queue.dispatch(async () => {
      bRan = true;
      return allow();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(aReleased).toBeTypeOf('function');
    // Cancel while A is in-flight and B is queued.
    queue.cancel(deny('session_closed'));
    const c = queue.dispatch(async () => {
      cRan = true;
      return allow();
    });

    // B and C settle immediately with the cancellation decision, without
    // ever invoking their run bodies.
    await expect(b).resolves.toMatchObject({
      kind: 'permission',
      behavior: 'deny',
      reason: 'session_closed',
    });
    await expect(c).resolves.toMatchObject({
      kind: 'permission',
      behavior: 'deny',
      reason: 'session_closed',
    });
    expect(bRan).toBe(false);
    expect(cRan).toBe(false);
    expect(queue.isCancelled()).toBe(true);

    // Releasing A lets it settle normally; B must still not have run.
    aReleased?.();
    await a;
    expect(bRan).toBe(false);
  });

  it('resetForNewTurn drains queued runs but keeps the queue usable for a later turn', async () => {
    // Transient teardown (Stop / turn-idle reconcile / orca disable) must
    // settle queued permissions for the aborted turn, but must NOT poison the
    // session permanently — a subsequent permission on the next turn still has
    // to show its card and run (issue #3092 review P1 / Greptile).
    const queue = new PermissionQueue();
    let aReleased: ((() => void) | null) | undefined;
    let bRan = false;

    const a = queue.dispatch(
      () =>
        new Promise((resolve) => {
          aReleased = () => resolve(allow());
        }),
    );
    const b = queue.dispatch(async () => {
      bRan = true;
      return allow();
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(aReleased).toBeTypeOf('function');

    // Transient reset while A is in-flight and B is queued.
    queue.resetForNewTurn(deny('session_aborted'));
    await expect(b).resolves.toMatchObject({
      kind: 'permission',
      behavior: 'deny',
      reason: 'session_aborted',
    });
    expect(bRan).toBe(false);

    // Release A; it resolves normally.
    aReleased?.();
    await a;

    // A dispatch AFTER reset must run normally (queue is not permanently
    // cancelled), simulating the next user turn.
    let laterRan = false;
    const later = queue.dispatch(async () => {
      laterRan = true;
      return allow();
    });
    await later;
    expect(laterRan).toBe(true);
    expect(queue.isCancelled()).toBe(false);
  });

  it('counts queue wait against the per-request timeout (no N×timeout buildup)', async () => {
    // Two unanswered parallel permissions must not extend the effective cap
    // to 2× timeout: the second one is queued behind the first, and its
    // overall timeout covers wait + execution. We model a first run that
    // never resolves and assert the second dispatch settles denied within
    // ~its timeout, not double.
    vi.useFakeTimers();
    try {
      const queue = new PermissionQueue();
      let releaseA: ((() => void) | null) | undefined;
      // First permission: never resolves (user walked away).
      queue.dispatch(
        () =>
          new Promise((resolve) => {
            releaseA = () => resolve(allow());
          }),
        { timeoutMs: 1000 },
      );
      // Second permission: queued behind A, same timeout. Track whether
      // its run body ever executes — after timeout it must NOT run.
      const start = Date.now();
      let secondRan = false;
      const secondPromise = queue.dispatch(
        async () => {
          secondRan = true;
          return allow();
        },
        { timeoutMs: 1000 },
      );
      let settledAt: number | null = null;
      let settledDecision: InteractionDecision | null = null;
      void secondPromise.then((d) => {
        settledAt = Date.now() - start;
        settledDecision = d;
      });

      // Advance well past one timeout but not two.
      await vi.advanceTimersByTimeAsync(1500);
      expect(settledAt).not.toBeNull();
      // It should have settled around the 1000ms cap (queue wait counted),
      // certainly not near 2000ms.
      expect(settledAt!).toBeLessThan(1500);
      // It settled as a timeout denial, and its run body never executed
      // (no orphan card broadcast after the agent already moved on).
      expect(secondRan).toBe(false);
      expect(settledDecision).toMatchObject({
        kind: 'permission',
        behavior: 'deny',
        reason: 'timeout',
      });

      // Release A and advance: B must still not run even though it has
      // now reached the front of the queue.
      releaseA?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(secondRan).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetForNewTurn serializes the next turn behind an in-flight permission', async () => {
    // Greptile P1: resetForNewTurn must NOT let a new-turn permission
    // broadcast concurrently with the in-flight old permission, or it
    // overwrites the renderer single slot and reintroduces #3092.
    const queue = new PermissionQueue();
    let releaseA: ((() => void) | null) | undefined;
    let aRunning = false;
    let newTurnRan = false;
    let startedWhileAInFlight = false;

    const a = queue.dispatch(
      () =>
        new Promise((resolve) => {
          aRunning = true;
          releaseA = () => {
            aRunning = false;
            resolve(allow());
          };
        }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseA).toBeTypeOf('function');

    // Reset while A is in-flight.
    queue.resetForNewTurn(deny('session_aborted'));

    const newTurn = queue.dispatch(async () => {
      if (aRunning) startedWhileAInFlight = true;
      newTurnRan = true;
      return allow();
    });

    // New turn must not have started yet; it is queued behind A.
    await Promise.resolve();
    await Promise.resolve();
    expect(newTurnRan).toBe(false);

    // Releasing A lets newTurn run, but never concurrently with A.
    releaseA?.();
    await a;
    await newTurn;
    expect(newTurnRan).toBe(true);
    expect(startedWhileAInFlight).toBe(false);
  });

  it('migrates every queued permission without running the Desktop handlers', async () => {
    const queue = new PermissionQueue();
    let releaseA: ((() => void) | null) | undefined;
    const a = queue.dispatch(
      () =>
        new Promise((resolve) => {
          releaseA = () => resolve(allow());
        }),
      { timeoutMs: 1000, takeoverRequest: permissionRequest('req-a'), arrivalSequence: 1 },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseA).toBeTypeOf('function');

    let bRan = false;
    let cRan = false;
    const b = queue.dispatch(
      async () => {
        bRan = true;
        return allow();
      },
      { timeoutMs: 1000, takeoverRequest: permissionRequest('req-b'), arrivalSequence: 2 },
    );
    const c = queue.dispatch(
      async () => {
        cRan = true;
        return allow();
      },
      { timeoutMs: 1000, takeoverRequest: permissionRequest('req-c'), arrivalSequence: 3 },
    );

    const taken = queue.takeForTakeover(deny('session_migrated'));
    expect(taken.map((entry) => entry.requestId)).toEqual(['req-b', 'req-c']);
    expect(taken.map((entry) => entry.arrivalSequence)).toEqual([2, 3]);
    expect(taken.every((entry) => entry.expiresAt !== undefined)).toBe(true);

    taken[0]?.resolve(allow());
    taken[1]?.resolve(deny('user_denied'));
    await expect(b).resolves.toMatchObject({ kind: 'permission', behavior: 'allow' });
    await expect(c).resolves.toMatchObject({
      kind: 'permission',
      behavior: 'deny',
      reason: 'user_denied',
    });
    expect(bRan).toBe(false);
    expect(cRan).toBe(false);

    releaseA?.();
    await a;
  });

  it('fences new Desktop permissions during the channel takeover handoff', async () => {
    const queue = new PermissionQueue();
    let releaseA: ((() => void) | null) | undefined;
    let bRan = false;
    const a = queue.dispatch(
      () =>
        new Promise<InteractionDecision>((resolve) => {
          releaseA = () => resolve(allow());
        }),
      { timeoutMs: 1000, takeoverRequest: permissionRequest('req-a'), arrivalSequence: 1 },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseA).toBeTypeOf('function');

    // The displayed permission A is migrated separately from the queued
    // permission list. A new permission arriving before the channel route is
    // ready must remain behind A instead of broadcasting a second Desktop card.
    expect(queue.takeForTakeover(deny('session_migrated'))).toEqual([]);
    const b = queue.dispatch(
      async () => {
        bRan = true;
        return allow();
      },
      { timeoutMs: 1000, takeoverRequest: permissionRequest('req-b'), arrivalSequence: 2 },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(bRan).toBe(false);

    queue.completeTakeover();
    await Promise.resolve();
    await Promise.resolve();
    expect(bRan).toBe(false);

    releaseA?.();
    await a;
    await b;
    expect(bRan).toBe(true);
  });

  it('keeps the original queued deadline after takeover and ignores a late answer', async () => {
    vi.useFakeTimers();
    try {
      const queue = new PermissionQueue();
      let releaseA: ((() => void) | null) | undefined;
      const a = queue.dispatch(
        () =>
          new Promise((resolve) => {
            releaseA = () => resolve(allow());
          }),
        { timeoutMs: 1000, takeoverRequest: permissionRequest('req-a') },
      );
      await Promise.resolve();
      await Promise.resolve();

      const expectedDeadline = Date.now() + 1000;
      const b = queue.dispatch(async () => allow(), {
        timeoutMs: 1000,
        takeoverRequest: permissionRequest('req-b'),
      });
      await vi.advanceTimersByTimeAsync(400);
      const [taken] = queue.takeForTakeover(deny('session_migrated'));
      expect(taken?.expiresAt).toBe(expectedDeadline);

      await vi.advanceTimersByTimeAsync(600);
      await expect(b).resolves.toMatchObject({
        kind: 'permission',
        behavior: 'deny',
        reason: 'timeout',
      });
      taken?.resolve(allow());
      await expect(b).resolves.toMatchObject({
        kind: 'permission',
        behavior: 'deny',
        reason: 'timeout',
      });

      releaseA?.();
      await a;
    } finally {
      vi.useRealTimers();
    }
  });
});
