import { describe, expect, it, vi } from 'vitest';

import { createWorkerCreationPrefsSyncHandler } from '../workerCreationPrefsSyncHandler.js';

describe('worker creation prefs sync IPC boundary', () => {
  it('rejects an untrusted sender before parsing or mutating the process-wide cache', () => {
    const denied = new Error('[PERMISSION_DENIED] untrusted renderer');
    const assertTrustedSender = vi.fn(() => {
      throw denied;
    });
    const setWorkerPermissionMode = vi.fn();
    const handler = createWorkerCreationPrefsSyncHandler({
      assertTrustedSender,
      setWorkerPermissionMode,
    });

    expect(() =>
      handler({ sender: 'webview' }, { workerPermissionMode: 'bypassPermissions' }),
    ).toThrow(denied);
    expect(setWorkerPermissionMode).not.toHaveBeenCalled();
  });

  it('accepts only supported permission modes from a trusted renderer', () => {
    const assertTrustedSender = vi.fn();
    const setWorkerPermissionMode = vi.fn();
    const handler = createWorkerCreationPrefsSyncHandler({
      assertTrustedSender,
      setWorkerPermissionMode,
    });

    handler({ sender: 'app' }, { workerPermissionMode: 'bypassPermissions' });
    handler({ sender: 'app' }, { workerPermissionMode: 'root' });
    handler({ sender: 'app' }, null);

    expect(assertTrustedSender).toHaveBeenCalledTimes(3);
    expect(setWorkerPermissionMode).toHaveBeenCalledTimes(1);
    expect(setWorkerPermissionMode).toHaveBeenCalledWith('bypassPermissions');
  });
});

// Unit: trusted IPC must mirror only the active owner's route, after sender admission.
// Previous tests covered permission only; stale owner stamps must not change model routing.
it('fences route snapshots by sender and active owner generation', () => {
  const setSelection = vi.fn();
  const owner = { dataOwnerId: 'owner', ownerGeneration: 2 };
  const route = { agent: 'pi', model: 'test-model', effort: 'high', fast: false, providerId: 'test', agentDeviceId: null };
  let trusted = true;
  const handler = createWorkerCreationPrefsSyncHandler({
    assertTrustedSender: () => { if (!trusted) throw new Error('untrusted'); },
    setWorkerPermissionMode: vi.fn(), getActiveOwner: () => owner, setSelection,
  });
  handler({}, { workerPermissionMode: 'auto', ownerStamp: owner, selection: route });
  expect(setSelection).toHaveBeenLastCalledWith(route, owner);
  handler({}, { workerPermissionMode: 'auto', ownerStamp: { ...owner, ownerGeneration: 1 }, selection: null });
  handler({}, { workerPermissionMode: 'auto', ownerStamp: { ...owner, dataOwnerId: 'other' }, selection: null });
  trusted = false;
  expect(() => handler({}, { workerPermissionMode: 'auto', ownerStamp: owner, selection: null })).toThrow('untrusted');
  expect(setSelection).toHaveBeenCalledTimes(1);
});
