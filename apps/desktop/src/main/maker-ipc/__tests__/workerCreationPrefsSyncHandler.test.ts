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
