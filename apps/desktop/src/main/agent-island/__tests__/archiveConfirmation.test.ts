import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmIslandArchive } from '../archiveConfirmation.js';

const h = vi.hoisted(() => ({ preview: vi.fn(), list: vi.fn(), invoke: vi.fn(), confirm: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox: h.confirm } }));
vi.mock('../../i18n.js', () => ({ t: (key: string) =>
  key.endsWith('scheduleName') ? '「{{name}}」' : key.includes('scheduleWarning') ? 'scheduleWarning {{names}}' : key,
}));
vi.mock('../../worktree/WorktreeManager.js', () => ({ getRemovalPreview: h.preview }));
vi.mock('../../scheduler-host/index.js', () => ({ getScheduleStorageIfInitialized: () => ({ list: h.list }) }));
vi.mock('../../device-link/index.js', () => ({ remoteInvoke: h.invoke }));

// Production archive preflight entry. Existing renderer preflight tests cannot
// protect a native main-process entry from bypassing dirty/schedule confirmation.
describe('island archive confirmation (unit)', () => {
  beforeEach(() => {
    h.preview.mockReset().mockResolvedValue({ hasWorktree: false, dirty: false });
    h.list.mockReset().mockResolvedValue([]);
    h.invoke.mockReset();
    h.confirm.mockReset().mockResolvedValue({ response: 1 });
  });
  afterEach(() => vi.useRealTimers());

  it('archives a clean ordinary task without prompting', async () => {
    h.list.mockResolvedValue([
      { targetSessionId: 's1', status: 'paused', name: 'paused' },
      { targetSessionId: 's1', status: 'active', persistentSession: true, name: 'persistent' },
    ]);
    expect(await confirmIslandArchive('s1', null)).toBe(true);
    expect(h.preview).toHaveBeenCalledWith('s1');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('shows dirty worktree and bound automation warnings before accepting', async () => {
    h.preview.mockResolvedValue({ hasWorktree: true, dirty: true });
    h.list.mockResolvedValue([{ targetSessionId: 's1', status: 'active', name: 'Nightly' }]);
    h.confirm.mockResolvedValue({ response: 0 });
    expect(await confirmIslandArchive('s1', null)).toBe(true);
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('dirtyWorktreeWarning'), defaultId: 1, cancelId: 1,
    }));
    expect(h.confirm.mock.calls[0][0].detail).toContain('Nightly');
  });

  it('treats an unknown worktree as requiring confirmation and preserves cancellation', async () => {
    h.preview.mockRejectedValue(new Error('unavailable'));
    expect(await confirmIslandArchive('s1', null)).toBe(false);
    expect(h.confirm).toHaveBeenCalledOnce();
  });

  it('reads preflights from the task owner and presents the confirmation locally', async () => {
    h.invoke.mockImplementation(async (_device, channel) => ({ ok: true,
      result: channel === 'worktree:removal-preview' ? { hasWorktree: false, dirty: false }
        : [{ targetSessionId: 's1', status: 'active', name: 'Remote nightly' }],
    }));
    expect(await confirmIslandArchive('s1', 'studio')).toBe(false);
    expect(h.invoke).toHaveBeenCalledWith('studio', 'worktree:removal-preview', ['s1']);
    expect(h.confirm.mock.calls[0][0].detail).toContain('Remote nightly');
    expect(h.preview).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
  });

  it('bounds a cold schedule read to 1500ms without blocking a clean task', async () => {
    vi.useFakeTimers();
    h.list.mockReturnValue(new Promise(() => {}));
    const pending = confirmIslandArchive('s1', null);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBe(true);
    expect(h.confirm).not.toHaveBeenCalled();
  });
});
