import { describe, expect, it, vi } from 'vitest';
import { createSharedTaskContextUsageGuard } from '../sharedTaskContextUsage.js';
import type { SharedTaskPeerCapture } from '../../device-link/sharedTaskDispatch.js';

const capture: SharedTaskPeerCapture = {
  author: { sharedTaskId: 'sharedTask', sessionId: 'task', memberId: 'member', accountId: 'guest', displayName: 'Guest' },
  isCurrent: () => true,
  authorize: () => true,
};

describe('shared task context usage cold-start authority', () => {
  it.each(['ask', 'bypassPermissions'])('uses only the host snapshot, preserving host mode %s', async (permissionMode) => {
    const guard = createSharedTaskContextUsageGuard(capture, 'task');
    const malicious = { permissionMode: 'bypassPermissions', workingDir: '/private', remoteHostId: 'other-host',
      extraDirs: ['/secrets'], writableDirs: ['/'], vendorOptions: { executable: 'untrusted' } };
    const host = { permissionMode, workingDir: '/task', remoteHostId: 'task-host',
      extraDirs: ['/allowed'], writableDirs: ['/task'], model: 'saved-model', planMode: false };
    const resolved = await guard.resolveCreateOpts(malicious, async () => host);
    expect(resolved).toEqual(host);
    expect(resolved).not.toHaveProperty('vendorOptions');
  });

  it('does not even read guest option getters and permits host-driven cold queries without wire options', async () => {
    const guard = createSharedTaskContextUsageGuard(capture, 'task');
    const malicious = Object.defineProperty({}, 'workingDir', { enumerable: true, get() { throw new Error('wire touched'); } });
    const host = { workingDir: '/task' };
    expect(await guard.resolveCreateOpts(malicious, async () => host)).toBe(host);
    expect(await guard.resolveCreateOpts(undefined, async () => host)).toBe(host);
  });

  it('fails closed when host state cannot be read', async () => {
    const guard = createSharedTaskContextUsageGuard(capture, 'task');
    await expect(guard.resolveCreateOpts({ workingDir: '/untrusted' }, async () => { throw new Error('DB unavailable'); }))
      .rejects.toThrow('DB unavailable');
  });

  it('rejects cross-task and revoked requests before reading the task', async () => {
    const read = vi.fn(async () => ({}));
    for (const guard of [
      createSharedTaskContextUsageGuard(capture, 'other-task'),
      createSharedTaskContextUsageGuard({ ...capture, isCurrent: () => false }, 'task'),
      createSharedTaskContextUsageGuard({ ...capture, authorize: () => false }, 'task'),
    ]) await expect(guard.resolveCreateOpts({}, read)).rejects.toThrow('PERMISSION_DENIED');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects revocation during the DB read and again before a delayed bootstrap side effect', async () => {
    let current = true;
    const guard = createSharedTaskContextUsageGuard({ ...capture, isCurrent: () => current }, 'task');
    await expect(guard.resolveCreateOpts({}, async () => { current = false; return {}; })).rejects.toThrow('PERMISSION_DENIED');
    current = true;
    await guard.resolveCreateOpts({}, async () => ({}));
    current = false;
    const start = vi.fn();
    expect(() => { guard.assertCurrent(); start(); }).toThrow('PERMISSION_DENIED');
    expect(start).not.toHaveBeenCalled();
  });

  it('preserves ordinary local and same-account remote options without a DB lookup', async () => {
    const guard = createSharedTaskContextUsageGuard(undefined, 'task');
    const read = vi.fn(async () => ({}));
    const wire = { workingDir: '/owner-task' };
    expect(await guard.resolveCreateOpts(wire, read)).toBe(wire);
    expect(await guard.resolveCreateOpts(undefined, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(guard.assertCurrent).not.toThrow();
  });
});
