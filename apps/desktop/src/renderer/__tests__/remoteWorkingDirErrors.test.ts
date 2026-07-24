import { describe, expect, it, vi } from 'vitest';

import { getRemoteWorkingDirErrorMessage } from '../features/cc-agent/remoteWorkingDirErrors';

describe('getRemoteWorkingDirErrorMessage', () => {
  it.each([
    'REMOTE_WORKDIR_INVALID',
    'REMOTE_WORKDIR_NOT_FOUND',
    'REMOTE_WORKDIR_NOT_DIRECTORY',
    'REMOTE_WORKDIR_UNAVAILABLE',
  ])('maps %s through the shared IPC i18n mapping', (code) => {
    const t = vi.fn((key: string) => `translated:${key}`);

    expect(getRemoteWorkingDirErrorMessage(new Error(`[${code}] details`), t)).toBe(
      `translated:ipcError.${code}`,
    );
    expect(t).toHaveBeenCalledWith(`ipcError.${code}`);
  });

  it('leaves unrelated and unstructured errors to the caller fallback', () => {
    const t = vi.fn((key: string) => key);

    expect(getRemoteWorkingDirErrorMessage(new Error('[INVALID_PARAMS] details'), t)).toBeNull();
    expect(getRemoteWorkingDirErrorMessage(new Error('plain failure'), t)).toBeNull();
    expect(t).not.toHaveBeenCalled();
  });
});
