import { describe, expect, it, vi } from 'vitest';

import { AuthOwnerChangeShellGate } from '../authOwnerChangeShellGate';

describe('AuthOwnerChangeShellGate', () => {
  it('releases login initialization only after a nested owner change settles', async () => {
    const gate = new AuthOwnerChangeShellGate();
    const settled = vi.fn();

    gate.enter();
    gate.enter();
    const waiting = gate.waitForSettled();
    void waiting.then(settled);
    await Promise.resolve();

    expect(gate.isPending()).toBe(true);
    expect(settled).not.toHaveBeenCalled();

    gate.leave();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    gate.leave();
    await waiting;
    expect(gate.isPending()).toBe(false);
    expect(settled).toHaveBeenCalledOnce();
  });

  it('waits for a replacement transition that starts as the first one releases', async () => {
    const gate = new AuthOwnerChangeShellGate();
    const settled = vi.fn();

    gate.enter();
    void gate.waitForSettled().then(settled);
    gate.leave();
    gate.enter();
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();

    gate.leave();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('settles immediately when no owner change is active', async () => {
    const gate = new AuthOwnerChangeShellGate();

    await expect(gate.waitForSettled()).resolves.toBeUndefined();
    gate.leave();
    expect(gate.isPending()).toBe(false);
  });
});
