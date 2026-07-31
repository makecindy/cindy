import { describe, expect, it } from 'vitest';

import { throwIpcError } from '../../utils/ipcValidate';
import { invokeGhostAppearanceIpc } from '../appearanceIpcErrorBoundary';

describe('invokeGhostAppearanceIpc', () => {
  it('returns successful mutation results unchanged', async () => {
    await expect(invokeGhostAppearanceIpc(async () => ({ ok: true }))).resolves.toEqual({
      ok: true,
    });
  });

  it('preserves existing structured IPC errors', async () => {
    const operation = () =>
      invokeGhostAppearanceIpc(async () => {
        throwIpcError('NOT_FOUND', 'Skin preset not found');
      });

    await expect(operation()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: '[NOT_FOUND] Skin preset not found',
    });
  });

  it('hides unexpected storage details behind a stable INTERNAL error', async () => {
    const operation = () =>
      invokeGhostAppearanceIpc(async () => {
        throw new Error('EACCES: /Users/private/appearance-skin.v1.json');
      });

    await expect(operation()).rejects.toMatchObject({
      code: 'INTERNAL',
      message: '[INTERNAL] Appearance operation failed',
    });
    await expect(operation()).rejects.not.toThrow('/Users/private');
  });
});
