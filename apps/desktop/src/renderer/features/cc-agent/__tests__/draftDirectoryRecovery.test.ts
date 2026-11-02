import { describe, expect, it, vi } from 'vitest';
import { createIpcError } from '../../../../shared/ipc-errors';
import { DraftDirectoryRecovery, type DraftDirectoryRecoveryContext } from '../draftDirectoryRecovery';

// #7395: actual recovery entry, picker results and owner/selection races.
// No existing recovery controller covered cancellation or stale native dialogs.
// Minimal input: one expired grant and two virtual directory identifiers.
// Tier: unit; these identifiers never enter the host filesystem.
function fixture() {
  let context: DraftDirectoryRecoveryContext = {
    scopeId: 'draft', ownerId: 'owner', ownerGeneration: 1,
    workingDir: '/virtual/project', writableDirs: ['/virtual/one', '/virtual/two'],
    remoteHostId: null, deviceLinkDeviceId: null, agentDeviceId: null,
  };
  const pick = vi.fn(async ({ defaultPath }: { defaultPath: string }): Promise<{ success: boolean; path: string | null }> => ({ success: true, path: defaultPath }));
  const recovery = new DraftDirectoryRecovery(() => context, pick);
  const error = createIpcError('WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED', 'Picker proof required');
  const fail = () => recovery.capture(error, recovery.captureContext());
  return { recovery, pick, fail, error, context: () => context,
    change: (patch: Partial<DraftDirectoryRecoveryContext>) => { context = { ...context, ...patch }; } };
}

describe('new-task directory reauthorization', () => {
  it('reselects every original directory with the same scope and leaves submission to the user', async () => {
    const f = fixture();
    expect(f.fail()).toBe(true);
    await f.recovery.reselect();
    expect(f.pick.mock.calls.map(([options]) => options)).toEqual([
      { defaultPath: '/virtual/one', writableGrantScope: 'draft' },
      { defaultPath: '/virtual/two', writableGrantScope: 'draft' },
    ]);
    expect(f.recovery.getSnapshot()?.phase).toBe('ready');
    expect(f.context().writableDirs).toEqual(['/virtual/one', '/virtual/two']);
  });

  it.each(['PRECONDITION_FAILED', 'INTERNAL'] as const)('does not turn %s into picker recovery', (code) => {
    const f = fixture();
    expect(f.recovery.capture(createIpcError(code, 'Other failure'), f.context())).toBe(false);
    expect(f.recovery.getSnapshot()).toBeNull();
  });

  it('retains the directory list when the last picker is cancelled', async () => {
    const f = fixture();
    f.pick.mockResolvedValueOnce({ success: true, path: '/virtual/one' });
    f.pick.mockResolvedValueOnce({ success: true, path: null });
    f.fail();
    await f.recovery.reselect();
    expect(f.recovery.getSnapshot()?.phase).toBe('cancelled');
    expect(f.context().writableDirs).toEqual(['/virtual/one', '/virtual/two']);
  });

  it('does not replace the original list or continue after a different selection', async () => {
    const f = fixture();
    f.pick.mockResolvedValue({ success: true, path: '/virtual/other' });
    f.fail();
    await f.recovery.reselect();
    expect(f.recovery.getSnapshot()?.phase).toBe('mismatch');
    expect(f.pick).toHaveBeenCalledTimes(1);
    expect(f.context().writableDirs).toEqual(['/virtual/one', '/virtual/two']);
  });

  it.each([
    { ownerGeneration: 2 }, { scopeId: 'other-draft' }, { workingDir: '/virtual/other' },
    { writableDirs: ['/virtual/two'] }, { deviceLinkDeviceId: 'other-device' },
  ])('ignores a late picker after context changes: %j', async (patch) => {
    const f = fixture();
    let finish!: (value: { success: boolean; path: string }) => void;
    f.pick.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.fail();
    const pending = f.recovery.reselect();
    f.change(patch);
    finish({ success: true, path: '/virtual/one' });
    await pending;
    expect(f.pick).toHaveBeenCalledTimes(1);
    expect(f.recovery.getSnapshot()?.phase).not.toBe('ready');
    expect(f.recovery.isSelecting()).toBe(false);
  });

  it('opens only one picker on double activation and ignores a cancelled flow result', async () => {
    const f = fixture();
    let finish!: (value: { success: boolean; path: string }) => void;
    f.pick.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.fail();
    const first = f.recovery.reselect();
    await f.recovery.reselect();
    expect(f.pick).toHaveBeenCalledTimes(1);
    f.recovery.clear();
    finish({ success: true, path: '/virtual/one' });
    await first;
    expect(f.recovery.getSnapshot()).toBeNull();
  });

  it('allows fresh recovery when a reselected grant expires again; picker exceptions retain the draft', async () => {
    const f = fixture();
    f.fail();
    await f.recovery.reselect();
    f.fail();
    f.pick.mockRejectedValueOnce(new Error('Native picker unavailable'));
    await f.recovery.reselect();
    expect(f.recovery.getSnapshot()?.phase).toBe('failed');
    expect(f.context().writableDirs).toEqual(['/virtual/one', '/virtual/two']);
  });

  it('does not use the local picker for remote paths, but permits local files with a remote agent', () => {
    const f = fixture();
    f.change({ remoteHostId: 'ssh-host' });
    expect(f.fail()).toBe(false);
    f.change({ remoteHostId: null, deviceLinkDeviceId: 'remote-desktop' });
    expect(f.fail()).toBe(false);
    f.change({ deviceLinkDeviceId: null, agentDeviceId: 'agent-computer' });
    expect(f.fail()).toBe(true);
  });
});
