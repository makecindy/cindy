import { describe, expect, it, vi } from 'vitest';
import { quiesceSessionBeforeWorktreeRecycle } from '../sessionRemovalOperations';
describe('quiesceSessionBeforeWorktreeRecycle', () => {
  it('closes the Agent only after checking removal and then revalidates', async () => {
    const order: string[] = [];
    expect(await quiesceSessionBeforeWorktreeRecycle('a', {
      isOwnerCurrent: () => true,
      isSessionStillRemovable: async () => { order.push('check'); return true; },
      closeSession: async () => { order.push('close'); },
    })).toBe(true);
    expect(order).toEqual(['check', 'close', 'check']);
  });
  it('does not close a restored task', async () => {
    const closeSession = vi.fn();
    expect(await quiesceSessionBeforeWorktreeRecycle('a', { isOwnerCurrent: () => true, isSessionStillRemovable: async () => false, closeSession })).toBe(false);
    expect(closeSession).not.toHaveBeenCalled();
  });
  it('does not recycle a task restored while Agent close settles', async () => {
    expect(await quiesceSessionBeforeWorktreeRecycle('a', {
      isOwnerCurrent: () => true,
      isSessionStillRemovable: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      closeSession: async () => {},
    })).toBe(false);
  });
  it('propagates an Agent close failure', async () => {
    await expect(quiesceSessionBeforeWorktreeRecycle('a', {
      isOwnerCurrent: () => true, isSessionStillRemovable: async () => true,
      closeSession: async () => { throw new Error('still running'); },
    })).rejects.toThrow('still running');
  });
  it('does not close after an account switch during the eligibility read', async () => {
    let current = true; const closeSession = vi.fn();
    expect(await quiesceSessionBeforeWorktreeRecycle('a', {
      isOwnerCurrent: () => current,
      isSessionStillRemovable: async () => { current = false; return true; }, closeSession,
    })).toBe(false);
    expect(closeSession).not.toHaveBeenCalled();
  });
});
