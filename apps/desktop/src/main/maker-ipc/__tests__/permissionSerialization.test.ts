import { describe, expect, it, vi } from 'vitest';

import { serializePermissionDispatch } from '../register.js';
import type { InteractionDecision } from '@cindy/maker-core';

function allow(): InteractionDecision {
  return { kind: 'permission', behavior: 'allow' };
}
function deny(): InteractionDecision {
  return { kind: 'permission', behavior: 'deny' };
}
function newChain(): { current: Promise<InteractionDecision> } {
  return {
    current: Promise.resolve({
      kind: 'permission',
      behavior: 'deny',
      reason: 'seed',
    }),
  };
}

describe('serializePermissionDispatch (issue #3092)', () => {
  it('runs two permission requests sequentially, not in parallel', async () => {
    // The renderer has a single pending-permission slot, so two parallel
    // permission requests must NOT be broadcast concurrently. This is the
    // root cause of #3092: the second broadcast overwrote the first slot
    // and the first canUseTool Promise hung for the 10-minute timeout.
    const chain = newChain();
    let firstStarted = false;
    let firstFinished = false;
    let secondStartedBeforeFirstFinished = false;

    const first = serializePermissionDispatch(chain, async () => {
      firstStarted = true;
      // Simulate an async wait for the user to resolve the card.
      await new Promise((r) => setTimeout(r, 30));
      firstFinished = true;
      return allow();
    });
    // Schedule the second immediately — before the first resolves.
    const second = serializePermissionDispatch(chain, async () => {
      if (!firstFinished) secondStartedBeforeFirstFinished = true;
      return allow();
    });

    await Promise.all([first, second]);

    expect(firstStarted).toBe(true);
    expect(firstFinished).toBe(true);
    expect(secondStartedBeforeFirstFinished).toBe(false);
  });

  it('resolves the second with its own decision after the first', async () => {
    const chain = newChain();
    const decisions: Array<'allow' | 'deny'> = [];
    const first = serializePermissionDispatch(chain, async () => {
      decisions.push('allow');
      return allow();
    });
    const second = serializePermissionDispatch(chain, async () => {
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
    const chain = newChain();
    const rejected = serializePermissionDispatch(chain, async () => {
      throw new Error('broadcast failed');
    });
    await expect(rejected).rejects.toThrow('broadcast failed');

    const after = serializePermissionDispatch(chain, async () => allow());
    const afterDecision = await after;
    expect(afterDecision.kind).toBe('permission');
    if (afterDecision.kind === 'permission') {
      expect(afterDecision.behavior).toBe('allow');
    }
  });

  it('never invokes a run before the previous one settles even under microtask bursts', async () => {
    // Stress test: queue N synchronous dispatches and assert that only one
    // run body is ever in-flight at a time.
    const chain = newChain();
    const N = 10;
    let inFlight = 0;
    let maxInFlight = 0;
    const violations: number[] = [];

    const runs = Array.from({ length: N }, (_, i) =>
      serializePermissionDispatch(chain, async () => {
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
});
